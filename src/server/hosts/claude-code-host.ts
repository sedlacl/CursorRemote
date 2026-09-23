import { randomUUID } from 'crypto';
import type { ExtensionFileBridge } from '../extension-file-bridge.js';
import type { BackgroundTask, ChatTab, CommandResult, MessageAttachment } from '../types.js';
import {
  BaseChatHost,
  type ChatApprovalRequest,
  type ChatHostCapabilities,
  type ChatHostId,
  type ChatTabRef,
} from './chat-host.js';
import { ClaudeWebviewClient } from './claude-webview-client.js';
import { outcomeToTasks, readBackgroundTasks } from './claude-background-tasks.js';
import type { VsCodeBridgeCommand, VsCodeCommandArg } from '../../shared/vscode-command-bridge.js';

/** How long to wait before re-sweeping CDP targets for a Claude panel. */
const DISCOVERY_THROTTLE_MS = 15_000;

/**
 * Selectors verified against Claude Code 2.1.278 by `scripts/probe-claude-code.ts`.
 *
 * All of them are `role` / `aria-label`, never the generated CSS module classes
 * beside them (`messageInput_cKsPxg`, `sessionItem_OOQiHg`), which change on
 * every extension bump.
 */
const SEL = {
  input: '[role="textbox"][aria-label="Message input"]',
  send: '[aria-label="Send message"]',
  newSession: '[aria-label="New session"]',
  sessionRow: '[id^="sessions-list-row-"]',
} as const;

/** `sessions-list-row-<uuid>` → `<uuid>` */
const SESSION_ROW_ID_PREFIX = 'sessions-list-row-';

/**
 * Tab id scheme. The two prefixes must stay distinct: a webview name is also a
 * UUID, and handing one to `claude-vscode.editor.open` as a session id would
 * silently open the wrong thing.
 */
const SESSION_TAB_PREFIX = 'claude:session:';
const PANEL_TAB_PREFIX = 'claude:panel:';

/**
 * Chat header chrome, verified on 2.1.278: the header row holds the session
 * title followed by these two controls. The title is whatever is not chrome.
 */
const HEADER_CHROME_LABELS = ['Session history', 'New session'];

/**
 * The `anthropic.claude-code` panel as a {@link ChatHost}.
 *
 * Two control surfaces, because neither alone is enough:
 *
 *  - **VS Code commands** through the extension bridge for chrome the webview
 *    does not expose — opening/focusing a session by id, accepting or rejecting
 *    a proposed diff in the editor.
 *  - **CDP into the webview** for everything inside the panel — typing into the
 *    message input, pressing permission controls, Stop.
 *
 * The private host↔webview `postMessage` protocol is not usable from here: only
 * a webview's owner may post to it, so `activate_session` / `interrupt` /
 * `tool_permission_response` are out of reach and we drive the DOM instead.
 *
 * Claude Code runs both as a side panel and as a full editor tab in the main
 * window. Nothing here assumes one or the other.
 */
export class ClaudeCodeHost extends BaseChatHost {
  readonly id: ChatHostId = 'claude-code';

  /**
   * `backgroundTasks` / `stopBackgroundTask` are false and stay false: the
   * session's task Map lives in the extension host process, not in the webview,
   * so CDP cannot reach it (see claude-background-tasks.ts). `setMode` /
   * `setModel` are false until the pickers' menus are probed — the trigger
   * buttons are known, the menu items are not.
   */
  readonly capabilities: ChatHostCapabilities = {
    sendMessage: true,
    newChat: true,
    switchTab: true,
    chatApproval: true,
    editorDiff: true,
    stopTurn: true,
    backgroundTasks: false,
    stopBackgroundTask: false,
    setMode: false,
    setModel: false,
  };

  private readonly webview: ClaudeWebviewClient;
  private readonly bridge: ExtensionFileBridge;
  private readonly claudeVersion: string | null;
  private tabs: ChatTab[] = [];
  private backgroundTasks: BackgroundTask[] = [];
  private lastDiscoveryAt = 0;

  constructor(options: {
    cdpUrl: string;
    bridge: ExtensionFileBridge;
    /** Installed Claude Code version, for the background-tasks schema gate. */
    claudeVersion?: string | null;
  }) {
    super();
    this.webview = new ClaudeWebviewClient(options.cdpUrl);
    this.bridge = options.bridge;
    this.claudeVersion = options.claudeVersion ?? null;
  }

  isAvailable(): boolean {
    return this.webview.isConnected();
  }

  listTabs(): ChatTab[] {
    return this.tabs;
  }

  listBackgroundTasks(): BackgroundTask[] {
    return this.backgroundTasks;
  }

  /**
   * Attach to an open Claude panel, if there is one. Safe to call repeatedly.
   *
   * Discovery sweeps CDP targets, so while no panel is open it is throttled —
   * otherwise a user who never opens Claude would pay for a full sweep on every
   * extractor tick.
   */
  async ensureConnected(): Promise<boolean> {
    if (this.webview.isConnected()) {
      // Staying attached to a surface the user has switched away from would
      // send messages into a session nobody is watching. Cheap check, one
      // evaluate; re-discovery only happens once it actually goes hidden.
      if (await this.webview.isTargetVisible()) return true;
      this.lastDiscoveryAt = 0;
    }

    const now = Date.now();
    if (now - this.lastDiscoveryAt < DISCOVERY_THROTTLE_MS) return false;
    this.lastDiscoveryAt = now;

    const connected = await this.webview.ensureConnected();
    if (!connected) {
      this.tabs = [];
      this.backgroundTasks = [];
    }
    return connected;
  }

  /** Discover now regardless of the throttle — for an explicit user action. */
  async reconnectNow(): Promise<boolean> {
    this.lastDiscoveryAt = 0;
    return this.ensureConnected();
  }

  disconnect(): void {
    this.webview.disconnect();
    this.tabs = [];
    this.backgroundTasks = [];
  }

  /**
   * Refresh this host's contribution to the merged state.
   *
   * Runs on the extractor tick so Claude tabs reach the client through the
   * existing `state:patch` — no extra poller, and `/tasks` is never run.
   */
  async refresh(): Promise<void> {
    if (!(await this.ensureConnected())) return;

    this.tabs = await this.readTabs();

    const outcome = await readBackgroundTasks(this.webview, this.claudeVersion);
    this.backgroundTasks = outcomeToTasks(outcome);
    this.capabilities.backgroundTasks = outcome.status === 'ok';
  }

  /** Session rows from the session-list surface, when one is open. */
  private async readSessionListTabs(): Promise<ChatTab[]> {
    if (!(await this.webview.ensureSessionList())) return [];

    let raw: unknown;
    try {
      raw = await this.webview.evaluateInSessionList(`(d) => {
        return Array.from(d.querySelectorAll(${JSON.stringify(SEL.sessionRow)}))
          .slice(0, 40)
          .map(el => ({
            id: el.id,
            title: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
          }));
      }`);
    } catch {
      return [];
    }

    if (!Array.isArray(raw)) return [];
    return raw
      .map((row): ChatTab | null => toSessionTab(row as { id?: unknown; title?: unknown }))
      .filter((tab): tab is ChatTab => tab !== null);
  }

  /**
   * Claude sessions as chat tabs.
   *
   * Preferred source is the session-list surface: it renders one row per
   * session carrying the real session id (`sessions-list-row-<uuid>`), which is
   * exactly what `claude-vscode.editor.open` takes, so `switch_tab` can reach
   * any of them. With no session list open, the chat view still yields the one
   * session it is showing, titled from its header.
   */
  private async readTabs(): Promise<ChatTab[]> {
    const fromList = await this.readSessionListTabs();
    if (fromList.length > 0) return fromList;

    let raw: unknown;
    try {
      raw = await this.webview.evaluateInPanel(`(d) => {
        const rows = Array.from(d.querySelectorAll(${JSON.stringify(SEL.sessionRow)}));
        if (rows.length > 0) {
          return {
            kind: 'list',
            sessions: rows.slice(0, 40).map(el => ({
              id: el.id,
              title: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
            })),
          };
        }
        const input = d.querySelector(${JSON.stringify(SEL.input)});
        if (!input) return { kind: 'none' };

        // Header row: session title, then fixed chrome. Take the first labelled
        // control in that row that is not one of the known chrome buttons.
        // Anchor on the header's fixed chrome rather than on a y-range: the
        // transcript scrolls, so its buttons pass through any viewport band.
        const anchor = d.querySelector(${JSON.stringify(SEL.newSession)});
        if (!anchor) return { kind: 'chat', title: '' };
        const anchorY = anchor.getBoundingClientRect().y;
        const chrome = ${JSON.stringify(HEADER_CHROME_LABELS)};
        const titled = Array.from(d.querySelectorAll('button, [role="button"]'))
          .map(el => {
            const r = el.getBoundingClientRect();
            // The title control is labelled by its text; the chrome buttons
            // beside it are icon-only and labelled by aria-label.
            const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
            return { label: label, y: r.y, w: r.width };
          })
          .filter(c => c.label && c.w > 0 && Math.abs(c.y - anchorY) <= 2)
          .sort((a, b) => a.y - b.y)
          .find(c => chrome.indexOf(c.label) === -1);
        return { kind: 'chat', title: (titled ? titled.label : '').slice(0, 80) };
      }`);
    } catch {
      // A panel that is mid-reload keeps its previous tabs rather than blinking
      // out of the tab bar.
      return this.tabs;
    }

    const target = this.webview.getTarget();
    const panelId = `${PANEL_TAB_PREFIX}${target?.webviewName || target?.id || 'unknown'}`;

    if (isListResult(raw)) {
      return raw.sessions
        .map((session): ChatTab | null => toSessionTab(session))
        .filter((tab): tab is ChatTab => tab !== null);
    }

    if (isChatResult(raw)) {
      return [{
        composerId: panelId,
        title: cleanSessionTitle(raw.title) || 'Claude Code',
        isActive: false,
        status: '',
        selectorPath: '',
        source: 'open',
        workStatus: 'idle',
        host: 'claude-code',
      }];
    }

    return [];
  }

  async sendMessage(
    commandId: string,
    text: string | undefined,
    attachments: MessageAttachment[],
  ): Promise<CommandResult> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      return { commandId, ok: false, error: 'Message must include text' };
    }
    if (attachments.length > 0) {
      return {
        commandId,
        ok: false,
        error: 'Attachments are not supported on the Claude Code host yet',
      };
    }
    if (!(await this.ensureConnected())) {
      return { commandId, ok: false, error: 'Claude Code panel is not connected' };
    }

    let focused: unknown;
    try {
      focused = await this.webview.evaluateInPanel(`(d) => {
        const input = d.querySelector(${JSON.stringify(SEL.input)});
        if (!input) return false;
        input.scrollIntoView({ block: 'center', behavior: 'instant' });
        input.focus();
        return d.activeElement === input;
      }`);
    } catch (err) {
      return { commandId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (focused !== true) {
      return { commandId, ok: false, error: 'Claude Code message input not found or not focusable' };
    }

    const client = this.webview.getClient();
    if (!client) {
      return { commandId, ok: false, error: 'Claude Code panel is not connected' };
    }

    // Input.insertText + Enter, like the Cursor composer. Assigning innerText
    // does not notify the editor's state. Input events dispatch at page level
    // and land in the focused element, which is inside the inner frame.
    await client.typeText(trimmed);
    await client.pressKey('Enter', 'Enter', 13);
    return { commandId, ok: true };
  }

  async newChat(commandId: string): Promise<CommandResult> {
    return this.runCommand(commandId, 'claude-vscode.newConversation', []);
  }

  async switchTab(commandId: string, tab: ChatTabRef): Promise<CommandResult> {
    const sessionId = parseSessionId(tab.composerId);
    if (!sessionId) {
      // A panel-derived tab carries no session id; focusing the panel is the
      // most that can honestly be done.
      return this.runCommand(commandId, 'claude-vscode.focus', []);
    }

    // `editor.open(sessionId?, initialPrompt?, viewColumn?, _, fullEditor?, opts)`
    // — initialPrompt stays null: it only prefills, it does not send.
    const result = await this.runCommand(commandId, 'claude-vscode.editor.open', [
      sessionId,
      null,
      null,
      null,
      null,
      { programmatic: true },
    ]);
    if (result.ok) {
      // The surface that just gained focus may be a different webview target.
      await this.webview.connect();
    }
    return result;
  }

  async approve(request: ChatApprovalRequest): Promise<CommandResult> {
    return this.clickPermission(request, 'approve');
  }

  async reject(request: ChatApprovalRequest): Promise<CommandResult> {
    return this.clickPermission(request, 'reject');
  }

  async stopTurn(commandId: string): Promise<CommandResult> {
    if (!(await this.ensureConnected())) {
      return { commandId, ok: false, error: 'Claude Code panel is not connected' };
    }

    // The Stop control replaces Send in the prompt box while a turn runs, so it
    // exists only when there is something to stop. `/tasks` is never used.
    try {
      const clicked = await this.webview.evaluateInPanel(`(d) => {
        const controls = Array.from(d.querySelectorAll('button, [role="button"]'));
        for (const el of controls) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
          if (/\\b(stop|interrupt)\\b/.test(label)) {
            el.click();
            return true;
          }
        }
        return false;
      }`);
      return clicked === true
        ? { commandId, ok: true }
        : { commandId, ok: false, error: 'Stop control not visible — no turn is running' };
    } catch (err) {
      return { commandId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async acceptEditorDiff(commandId: string): Promise<CommandResult> {
    return this.runCommand(commandId, 'claude-vscode.acceptProposedDiff', []);
  }

  async rejectEditorDiff(commandId: string): Promise<CommandResult> {
    return this.runCommand(commandId, 'claude-vscode.rejectProposedDiff', []);
  }

  private async clickPermission(
    request: ChatApprovalRequest,
    kind: 'approve' | 'reject',
  ): Promise<CommandResult> {
    if (!(await this.ensureConnected())) {
      return { commandId: request.commandId, ok: false, error: 'Claude Code panel is not connected' };
    }

    const pattern = kind === 'approve'
      ? String.raw`\b(yes|allow|approve|accept)\b`
      : String.raw`\b(no|deny|reject|don.t allow)\b`;

    try {
      const clicked = await this.webview.evaluateInPanel(`(d) => {
        const re = new RegExp(${JSON.stringify(pattern)}, 'i');
        const controls = Array.from(d.querySelectorAll('button, [role="button"]'));
        // Bottom-most match: the live permission prompt sits at the end of the
        // transcript, below older resolved ones.
        let match = null;
        for (const el of controls) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
          if (re.test(label)) match = el;
        }
        if (!match) return false;
        match.scrollIntoView({ block: 'center', behavior: 'instant' });
        match.click();
        return true;
      }`);

      return clicked === true
        ? { commandId: request.commandId, ok: true }
        : {
          commandId: request.commandId,
          ok: false,
          error: `No visible ${kind} control in the Claude transcript`,
        };
    } catch (err) {
      return {
        commandId: request.commandId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runCommand(
    commandId: string,
    command: VsCodeBridgeCommand,
    args: VsCodeCommandArg[],
  ): Promise<CommandResult> {
    const result = await this.bridge.requestVsCodeCommand({
      requestId: randomUUID(),
      command,
      args,
      requestedAt: Date.now(),
    });
    return result.ok
      ? { commandId, ok: true, data: result.value }
      : { commandId, ok: false, error: result.error ?? `${command} failed` };
  }
}

/** One `sessions-list-row-<uuid>` element as a chat tab, or null if malformed. */
function toSessionTab(row: { id?: unknown; title?: unknown }): ChatTab | null {
  const rawId = typeof row.id === 'string' ? row.id : '';
  if (!rawId.startsWith(SESSION_ROW_ID_PREFIX)) return null;
  const id = rawId.slice(SESSION_ROW_ID_PREFIX.length);
  if (!id) return null;

  return {
    composerId: `${SESSION_TAB_PREFIX}${id}`,
    title: cleanSessionTitle(typeof row.title === 'string' ? row.title : '') || 'Claude session',
    isActive: false,
    status: '',
    selectorPath: '',
    source: 'open',
    workStatus: 'idle',
    host: 'claude-code',
  };
}

interface ListResult {
  kind: 'list';
  sessions: { id: string; title: string }[];
}

interface ChatResult {
  kind: 'chat';
  title: string;
}

function isListResult(value: unknown): value is ListResult {
  return typeof value === 'object'
    && value !== null
    && (value as ListResult).kind === 'list'
    && Array.isArray((value as ListResult).sessions);
}

function isChatResult(value: unknown): value is ChatResult {
  return typeof value === 'object'
    && value !== null
    && (value as ChatResult).kind === 'chat';
}

/**
 * Session rows render their relative timestamp inside the same element, so a
 * raw `textContent` reads "Claude code adapter implementacenow".
 */
export function cleanSessionTitle(raw: string): string {
  return raw.replace(/(now|\d+\s*[smhdw])$/i, '').trim();
}

/**
 * `claude:session:<uuid>` yields a session id; `claude:panel:<webviewName>`
 * yields null. A webview name is also a UUID, so the prefix — not the shape —
 * is what decides. Passing a webview id to `editor.open` would open the wrong
 * session, or none.
 */
export function parseSessionId(composerId: string): string | null {
  if (!composerId.startsWith(SESSION_TAB_PREFIX)) return null;
  const rest = composerId.slice(SESSION_TAB_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest)
    ? rest
    : null;
}
