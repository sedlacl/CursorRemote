import { CdpClient } from '../cdp-client.js';

/**
 * Discovery and connection management for `anthropic.claude-code` webviews.
 *
 * The workbench page that the main CDP bridge connects to does not contain the
 * Claude DOM — the panel is a `vscode-webview://` target with its own CDP
 * endpoint. This class keeps a second {@link CdpClient} on that target,
 * mirroring how `window-monitor` already runs parallel clients.
 *
 * Two facts, both confirmed by `scripts/probe-claude-code.ts`, shape everything
 * here:
 *
 *  1. **Targets are identified by URL.** Every Claude webview target carries
 *     `extensionId=Anthropic.claude-code` in its query string, so no connection
 *     or DOM fingerprinting is needed to find them. `purpose` is deliberately
 *     NOT filtered: Claude Code runs both as a side panel (`webviewView`) and
 *     as a full editor tab in the main window, and both must be found.
 *  2. **The real DOM is one frame down.** The target's document is VS Code's
 *     webview shell; the extension's UI lives in a nested same-origin iframe,
 *     `#active-frame`. Every DOM read or write has to go through its
 *     `contentDocument` — querying the outer document finds nothing.
 *
 * Claude Code shows two different surfaces through this same mechanism: the
 * chat view (message input, transcript) and a session-list-only view. They are
 * told apart by what the inner frame actually contains.
 */

export type ClaudeWebviewView = 'chat' | 'session-list' | 'unknown';

export interface ClaudeWebviewTarget {
  id: string;
  url: string;
  wsUrl: string;
  /** `id=` query param — the same value the workbench iframe carries as `name`. */
  webviewName: string;
  /** `webviewView` for the side panel; absent/other when opened as an editor tab. */
  purpose: string;
  view: ClaudeWebviewView;
}

interface CDPTargetJson {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Query-string marker every Claude Code webview target carries. */
const CLAUDE_EXTENSION_MARKER = 'extensionId=Anthropic.claude-code';

/**
 * Wraps an expression so it evaluates against the inner Claude frame.
 *
 * `fn` is a function body taking `(d, w)` — the inner document and window.
 * Returns `{ __noFrame: true }` when the shell has no `#active-frame` yet,
 * which happens briefly while a panel is still loading.
 */
export function inPanel(fn: string): string {
  return `
    (() => {
      const f = document.getElementById('active-frame');
      if (!f) return { __noFrame: true };
      const d = f.contentDocument;
      const w = f.contentWindow;
      if (!d) return { __noFrame: true };
      return (${fn})(d, w);
    })()
  `;
}

/** True when an {@link inPanel} result means the inner frame was missing. */
export function isNoFrame(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as { __noFrame?: boolean }).__noFrame === true;
}

/** Classifies the inner frame by what it actually renders. */
const VIEW_PROBE_JS = inPanel(`(d) => {
  if (d.querySelector('[role="textbox"][aria-label="Message input"]')) return 'chat';
  if (d.querySelector('[id^="sessions-list-row-"]')) return 'session-list';
  return 'unknown';
}`);

export class ClaudeWebviewClient {
  private readonly cdpUrl: string;
  private client: CdpClient | null = null;
  private target: ClaudeWebviewTarget | null = null;
  private knownTargets: ClaudeWebviewTarget[] = [];
  /**
   * Second connection, to the session-list surface when one is open.
   *
   * Commands go to the chat view, but only the session list enumerates every
   * session with its real id — which is what `claude-vscode.editor.open` takes.
   * Holding both beats reconnecting on every extractor tick.
   */
  private listClient: CdpClient | null = null;
  private listTarget: ClaudeWebviewTarget | null = null;

  constructor(cdpUrl: string) {
    this.cdpUrl = cdpUrl;
  }

  getClient(): CdpClient | null {
    return this.client?.isConnected() ? this.client : null;
  }

  getTarget(): ClaudeWebviewTarget | null {
    return this.target;
  }

  /** All Claude targets seen by the last {@link discover}. */
  getKnownTargets(): ClaudeWebviewTarget[] {
    return this.knownTargets;
  }

  isConnected(): boolean {
    return this.client?.isConnected() === true;
  }

  /**
   * List Claude webview targets, classifying each by its inner frame.
   *
   * Identification is by URL, so the sweep only connects to targets in order to
   * tell a chat view from a session list — never to work out whether a target
   * belongs to Claude at all.
   */
  async discover(): Promise<ClaudeWebviewTarget[]> {
    let targets: CDPTargetJson[];
    try {
      const resp = await fetch(`${this.cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return [];
      targets = (await resp.json()) as CDPTargetJson[];
    } catch {
      return [];
    }
    if (!Array.isArray(targets)) return [];

    const candidates = targets.filter(
      t => typeof t.url === 'string'
        && t.url.includes(CLAUDE_EXTENSION_MARKER)
        && !!t.webSocketDebuggerUrl,
    );

    const found: ClaudeWebviewTarget[] = [];
    for (const candidate of candidates) {
      const view = await this.classify(candidate.webSocketDebuggerUrl!);
      found.push({
        id: candidate.id,
        url: candidate.url,
        wsUrl: candidate.webSocketDebuggerUrl!,
        webviewName: parseQueryParam(candidate.url, 'id'),
        purpose: parseQueryParam(candidate.url, 'purpose'),
        view,
      });
    }

    // Chat views first — that is what commands need.
    found.sort((a, b) => viewRank(a.view) - viewRank(b.view));
    this.knownTargets = found;
    return found;
  }

  private async classify(wsUrl: string): Promise<ClaudeWebviewView> {
    const probe = new CdpClient();
    try {
      await probe.connect(wsUrl, 4000);
      const view = await probe.evaluate(VIEW_PROBE_JS, 6000);
      return view === 'chat' || view === 'session-list' ? view : 'unknown';
    } catch {
      return 'unknown';
    } finally {
      probe.disconnect();
    }
  }

  /**
   * Connect to a Claude chat webview. With no target given, discovers and takes
   * the best one. Returns false when no Claude chat surface is open.
   */
  async connect(target?: ClaudeWebviewTarget): Promise<boolean> {
    let chosen = target ?? null;
    if (!chosen) {
      const found = await this.discover();
      chosen = found.find(t => t.view === 'chat') ?? found[0] ?? null;
    }
    if (!chosen) {
      this.disconnect();
      return false;
    }

    if (this.client?.isConnected() && this.target?.id === chosen.id) {
      return true;
    }

    this.disconnect();
    const client = new CdpClient();
    try {
      await client.connect(chosen.wsUrl, 6000);
    } catch {
      client.disconnect();
      return false;
    }

    client.on('disconnected', () => {
      if (this.client === client) {
        this.client = null;
        this.target = null;
      }
    });

    this.client = client;
    this.target = chosen;
    console.log(
      `[claude-webview] Connected to ${chosen.id.slice(0, 8)} (view=${chosen.view}, purpose=${chosen.purpose || 'editor'})`,
    );
    return true;
  }

  /**
   * Attach to a session-list surface if one is open. Returns false when the
   * user has no session list visible, which is a normal state, not an error.
   */
  async ensureSessionList(): Promise<boolean> {
    if (this.listClient?.isConnected()) return true;

    const candidate = this.knownTargets.find(t => t.view === 'session-list');
    if (!candidate) {
      this.disconnectSessionList();
      return false;
    }

    const client = new CdpClient();
    try {
      await client.connect(candidate.wsUrl, 6000);
    } catch {
      client.disconnect();
      return false;
    }

    client.on('disconnected', () => {
      if (this.listClient === client) {
        this.listClient = null;
        this.listTarget = null;
      }
    });

    this.listClient = client;
    this.listTarget = candidate;
    return true;
  }

  /** Evaluate against the session-list surface's inner frame. */
  async evaluateInSessionList(fn: string, timeoutMs = 10000): Promise<unknown> {
    if (!this.listClient?.isConnected()) {
      throw new Error('Claude Code session list is not connected');
    }
    const result = await this.listClient.evaluate(inPanel(fn), timeoutMs);
    if (isNoFrame(result)) {
      throw new Error('Claude Code session list frame is not mounted yet');
    }
    return result;
  }

  private disconnectSessionList(): void {
    if (this.listClient) {
      this.listClient.disconnect();
      this.listClient = null;
    }
    this.listTarget = null;
  }

  /** Reconnect when the panel was closed and reopened (target id changes). */
  async ensureConnected(): Promise<boolean> {
    if (this.client?.isConnected()) return true;
    return this.connect();
  }

  /**
   * Evaluate a `(d, w) => …` function body against the inner Claude frame.
   * Throws when no panel is connected or the inner frame is not mounted.
   */
  async evaluateInPanel(fn: string, timeoutMs = 10000): Promise<unknown> {
    const client = this.getClient();
    if (!client) throw new Error('Claude Code panel is not connected');
    const result = await client.evaluate(inPanel(fn), timeoutMs);
    if (isNoFrame(result)) {
      throw new Error('Claude Code webview frame is not mounted yet');
    }
    return result;
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.target = null;
    this.disconnectSessionList();
  }
}

function viewRank(view: ClaudeWebviewView): number {
  return view === 'chat' ? 0 : view === 'session-list' ? 1 : 2;
}

function parseQueryParam(url: string, name: string): string {
  const match = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
  return match ? decodeURIComponent(match[1]) : '';
}
