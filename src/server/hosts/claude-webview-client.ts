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
  /**
   * Whether this surface is currently on screen.
   *
   * VS Code flips the webview document's `visibilityState` when a panel is
   * hidden, which is the only signal that distinguishes the session the user is
   * looking at from other sessions kept alive in the background. Without it a
   * message can be typed into a session nobody is watching.
   */
  visible: boolean;
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

/**
 * Classifies the inner frame by what it renders, and reports whether the
 * surface is on screen. Visibility is read from the outer shell document,
 * because that is what the webview host toggles.
 */
const VIEW_PROBE_JS = `
  (() => {
    const visible = document.visibilityState === 'visible';
    const f = document.getElementById('active-frame');
    const d = f && f.contentDocument;
    if (!d) return { view: 'unknown', visible: visible };
    if (d.querySelector('[role="textbox"][aria-label="Message input"]')) return { view: 'chat', visible: visible };
    if (d.querySelector('[id^="sessions-list-row-"]')) return { view: 'session-list', visible: visible };
    return { view: 'unknown', visible: visible };
  })()
`;

/** Is the connected surface still the one on screen? */
const VISIBILITY_JS = `document.visibilityState === 'visible'`;

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
      const { view, visible } = await this.classify(candidate.webSocketDebuggerUrl!);
      found.push({
        id: candidate.id,
        url: candidate.url,
        wsUrl: candidate.webSocketDebuggerUrl!,
        webviewName: parseQueryParam(candidate.url, 'id'),
        purpose: parseQueryParam(candidate.url, 'purpose'),
        view,
        visible,
      });
    }

    // Visible chat surfaces first: commands must reach the session the user is
    // actually looking at, not whichever one the CDP listing happened to place
    // first. Several Claude sessions stay alive as background targets.
    found.sort((a, b) => targetRank(a) - targetRank(b));
    this.knownTargets = found;
    return found;
  }

  private async classify(wsUrl: string): Promise<{ view: ClaudeWebviewView; visible: boolean }> {
    const probe = new CdpClient();
    try {
      await probe.connect(wsUrl, 4000);
      const raw = (await probe.evaluate(VIEW_PROBE_JS, 6000)) as
        | { view?: string; visible?: boolean }
        | null;
      const view = raw?.view === 'chat' || raw?.view === 'session-list' ? raw.view : 'unknown';
      return { view, visible: raw?.visible === true };
    } catch {
      return { view: 'unknown', visible: false };
    } finally {
      probe.disconnect();
    }
  }

  /**
   * Whether the connected surface is still on screen. False also when the
   * connection is gone, so callers can treat it as "re-discover".
   */
  async isTargetVisible(): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    try {
      return (await client.evaluate(VISIBILITY_JS, 4000)) === true;
    } catch {
      return false;
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
      chosen = found.find(t => t.view === 'chat' && t.visible)
        ?? found.find(t => t.view === 'chat')
        ?? found[0]
        ?? null;
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
      `[claude-webview] Connected to ${chosen.id.slice(0, 8)} `
      + `(view=${chosen.view}, visible=${chosen.visible}, purpose=${chosen.purpose || 'editor'})`,
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
   * One-shot evaluate against a Claude webview that is not the connected chat.
   * Used to title the other open surface without stealing the live connection.
   */
  async probeInner(wsUrl: string, fn: string, timeoutMs = 8000): Promise<unknown> {
    const probe = new CdpClient();
    try {
      await probe.connect(wsUrl, 4000);
      const result = await probe.evaluate(inPanel(fn), timeoutMs);
      if (isNoFrame(result)) return null;
      return result;
    } catch {
      return null;
    } finally {
      probe.disconnect();
    }
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

/**
 * Lower sorts first.
 *
 * Both chats can be on screen at once. The side panel (`purpose=webviewView`)
 * wins the initial connection; the editor stays in the list as its own tab.
 */
export function claudeTargetRank(target: { view: string; purpose: string; visible: boolean }): number {
  if (target.view === 'chat') {
    const sidebar = target.purpose === 'webviewView';
    if (target.visible && sidebar) return 0;
    if (target.visible) return 1;
    if (sidebar) return 2;
    return 3;
  }
  if (target.view === 'session-list') return target.visible ? 4 : 5;
  return 6;
}

function targetRank(target: ClaudeWebviewTarget): number {
  return claudeTargetRank(target);
}

function parseQueryParam(url: string, name: string): string {
  const match = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
  return match ? decodeURIComponent(match[1]) : '';
}
