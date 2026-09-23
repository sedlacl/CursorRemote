import { randomUUID } from 'crypto';
import type { ExtensionFileBridge } from '../extension-file-bridge.js';
import type { AgentStatus, BackgroundTask, ChatElement, ChatTab, CommandResult, MessageAttachment } from '../types.js';
import {
  claudeRowsToMessages,
  claudeTranscriptStatus,
  type ClaudeTranscriptRead,
} from './claude-transcript.js';
import {
  BaseChatHost,
  type ChatApprovalRequest,
  type ChatHostCapabilities,
  type ChatHostId,
  type ChatTabRef,
  type HostConversationView,
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
  sessionRow: '[id^="sessions-list-row-"]',
} as const;

/** `sessions-list-row-<uuid>` → `<uuid>` */
const SESSION_ROW_ID_PREFIX = 'sessions-list-row-';

/** Retry an empty Session history read. A successful read is kept until the open surfaces change. */
const HISTORY_RETRY_MS = 20_000;

/** Header title and the model pill, shared by the connected chat and the other surface. */
const SURFACE_META_JS = `(d) => {
  const anchor = d.querySelector('[aria-label="New session"]');
  let title = '';
  if (anchor) {
    const anchorY = anchor.getBoundingClientRect().y;
    const chrome = ['Session history', 'New session'];
    const titled = Array.from(d.querySelectorAll('button, [role="button"]'))
      .map(el => {
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        return { label: label, y: r.y, w: r.width };
      })
      .filter(c => c.label && c.w > 0 && Math.abs(c.y - anchorY) <= 2)
      .find(c => chrome.indexOf(c.label) === -1);
    title = titled ? titled.label : '';
  }
  if (!title) {
    // Editor tabs have no header row; the title Cursor shows on the tab is
    // the session's summary signal.
    outer: for (const el of d.querySelectorAll('*')) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber'));
      let fiber = key ? el[key] : null;
      for (let i = 0; i < 30 && fiber; i++, fiber = fiber.return) {
        const s = fiber.memoizedProps && fiber.memoizedProps.session;
        // lastConfirmedSessionId marks the chat's own session, not a
        // session-manager row.
        const summary = s && s.lastConfirmedSessionId && s.summary && s.summary.value;
        if (typeof summary === 'string' && summary.trim()) {
          title = summary.trim();
          break outer;
        }
      }
    }
  }
  const modelBtn = Array.from(d.querySelectorAll('button, [role="button"]')).find(el =>
    /opus|sonnet|haiku|switch model/i.test(((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')))
  );
  const model = modelBtn ? (modelBtn.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  return { title: title.slice(0, 80), model: model.slice(0, 80) };
}`;

/** Visible Stop button → the session object its React tree closes over. */
const CLAUDE_SESSION_OF_STOP_JS = `
  function sessionOf(stop) {
    const fiberKey = Object.keys(stop).find((k) => k.startsWith('__reactFiber'));
    let fiber = fiberKey ? stop[fiberKey] : null;
    for (let i = 0; i < 20 && fiber; i++) {
      const props = fiber.memoizedProps;
      if (props && props.session && typeof props.session.interrupt === 'function') return props.session;
      fiber = fiber.return;
    }
    return null;
  }
  function findStop(d) {
    return Array.from(d.querySelectorAll('button, [role="button"]')).reverse().find((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return /^stop$/i.test((el.getAttribute('aria-label') || '').trim());
    }) || null;
  }
`;

const CLAUDE_STOP_JS = `(d) => {
  ${CLAUDE_SESSION_OF_STOP_JS}
  const stop = findStop(d);
  if (!stop) return { ok: false };
  const session = sessionOf(stop);
  if (session) {
    session.interrupt();
    return { ok: true };
  }
  stop.click();
  return { ok: true };
}`;

const CLAUDE_END_STUCK_TURN_JS = `(d) => {
  ${CLAUDE_SESSION_OF_STOP_JS}
  const stop = findStop(d);
  if (!stop) return false;
  const session = sessionOf(stop);
  if (session && session.busy && session.busy.value && typeof session.endTurn === 'function') {
    session.endTurn();
    return true;
  }
  return false;
}`;

/**
 * Tab id scheme. The two prefixes must stay distinct: a webview name is also a
 * UUID, and handing one to `claude-vscode.editor.open` as a session id would
 * silently open the wrong thing.
 */
const SESSION_TAB_PREFIX = 'claude:session:';
const PANEL_TAB_PREFIX = 'claude:panel:';
const HISTORY_TAB_PREFIX = 'claude:history:';

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
    // No probed close control for a Claude session tab.
    closeTab: false,
    chatApproval: true,
    approveAll: false,
    editorDiff: true,
    stopTurn: true,
    backgroundTasks: false,
    stopBackgroundTask: false,
    setMode: false,
    setModel: false,
    planModel: false,
    // The published state carries no Claude selector paths to click.
    clickAction: false,
    loadHistory: false,
    subagents: false,
  };

  override get label(): string {
    return 'Claude Code';
  }

  private readonly webview: ClaudeWebviewClient;
  private readonly bridge: ExtensionFileBridge;
  private readonly claudeVersion: string | null;
  private tabs: ChatTab[] = [];
  private backgroundTasks: BackgroundTask[] = [];
  private transcript: ChatElement[] = [];
  private transcriptAgentStatus: AgentStatus = 'idle';
  /** Model pill of the connected surface, e.g. "Opus 5 (1M) Medium". */
  private transcriptModel = '';
  private lastDiscoveryAt = 0;
  private lastSurfaceScanAt = 0;
  private lastHistoryAt = 0;
  private historySurfaceKey = '';
  private historyCache: ChatTab[] = [];
  private surfaceMeta = new Map<string, { title: string; model: string; at: number }>();

  constructor(options: {
    cdpUrl: string;
    bridge: ExtensionFileBridge;
    /** Installed Claude Code version, for the background-tasks schema gate. */
    claudeVersion?: string | null;
    /** Workbench target the relay is attached to. Claude webviews outside it are ignored. */
    getWindowTargetId?: () => string;
  }) {
    super();
    this.webview = new ClaudeWebviewClient(
      options.cdpUrl,
      options.getWindowTargetId ?? (() => ''),
    );
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
   * Last transcript read from the visible Claude chat.
   *
   * `composerId` is the tab the panel is showing this transcript under, so the
   * relay can drop the Cursor composer id while that tab is active.
   */
  transcriptOverlay(): {
    composerId: string;
    messages: ChatElement[];
    agentStatus: AgentStatus;
    model: string;
  } | null {
    const tab = this.tabs.find(item => item.isActive && item.source === 'open')
      ?? this.tabs.find(item => item.source === 'open');
    if (!tab) return null;
    return {
      composerId: tab.composerId,
      messages: this.transcript,
      agentStatus: this.transcriptAgentStatus,
      model: this.transcriptModel,
    };
  }

  /**
   * The Claude session's conversation, applied over a neutral base while a
   * Claude tab is active — nothing the Cursor extractor read about the
   * composer beside it (mode, questionnaire, stop selector, …) survives.
   *
   * Mode is left empty: the permission-mode pill exists, but its menu is not
   * probed, so it is neither read nor offered (`setMode: false`).
   */
  override conversationView(): HostConversationView {
    const overlay = this.transcriptOverlay();
    const agentStatus = overlay?.agentStatus ?? 'idle';
    const running = agentStatus === 'generating';
    return {
      composerId: overlay?.composerId,
      messages: overlay?.messages ?? [],
      model: { current: overlay?.model || 'Claude', currentId: 'claude' },
      agentStatus,
      agentActivityLive: running,
      // The header Stop follows the Claude turn; `stop_agent` routes to stopTurn().
      agentStopAvailable: running,
      agentStopSelectorPath: running ? 'claude:stop' : '',
      agentStopSource: running ? 'composer' : 'none',
      inputAvailable: true,
      composerInputAvailable: true,
    };
  }

  /**
   * Attach to an open Claude panel, if there is one. Safe to call repeatedly.
   *
   * Discovery sweeps CDP targets, so while no panel is open it is throttled —
   * otherwise a user who never opens Claude would pay for a full sweep on every
   * extractor tick.
   */
  async ensureConnected(): Promise<boolean> {
    if (this.webview.prepareForActiveWindow()) this.lastDiscoveryAt = 0;
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
      this.transcript = [];
      this.transcriptAgentStatus = 'idle';
      this.transcriptModel = '';
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
    this.transcript = [];
    this.transcriptAgentStatus = 'idle';
    this.transcriptModel = '';
    this.historyCache = [];
    this.historySurfaceKey = '';
    this.surfaceMeta.clear();
  }

  /**
   * Refresh this host's contribution to the merged state.
   *
   * Runs on the extractor tick so Claude tabs reach the client through the
   * existing `state:patch` — no extra poller, and `/tasks` is never run.
   */
  async refresh(): Promise<void> {
    if (!(await this.ensureConnected())) return;

    const now = Date.now();
    if (now - this.lastSurfaceScanAt >= DISCOVERY_THROTTLE_MS) {
      this.lastSurfaceScanAt = now;
      await this.webview.discover();
    }

    this.tabs = await this.readTabs();
    await this.readTranscript();

    const outcome = await readBackgroundTasks(this.webview, this.claudeVersion);
    this.backgroundTasks = outcomeToTasks(outcome);
    this.capabilities.backgroundTasks = outcome.status === 'ok';
  }

  /**
   * Visible chat transcript. CSS module classes are hashed per build, so this
   * uses only `data-transcript-message` and `aria-label` (probed 2026-09-23).
   */
  private async readTranscript(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.webview.evaluateInPanel(`(d) => {
        const region = d.querySelector('[role="region"][aria-label="Claude Code conversation"]');
        if (!region) return { running: false, items: [] };
        const running = Array.from(d.querySelectorAll('button, [role="button"]')).some((el) => {
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          return /\\b(stop|interrupt)\\b/i.test(label);
        });
        const nodes = Array.from(region.querySelectorAll('[data-transcript-message]')).slice(-60);
        const items = nodes.map((el) => {
          const clone = el.cloneNode(true);
          // The row starts with an h3 screen-reader heading ("You: …") that
          // repeats the visible message. Hashed visually-hidden classes are
          // not stable; the heading tag is.
          for (const b of Array.from(clone.querySelectorAll('button, [role="button"], h3'))) b.remove();
          return {
            aria: (el.getAttribute('aria-label') || '').trim(),
            testid: el.getAttribute('data-testid') || '',
            busy: el.getAttribute('aria-busy') === 'true',
            text: (clone.innerText || clone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000),
          };
        });
        return { running, items };
      }`);
    } catch {
      return;
    }
    if (!isTranscriptRead(raw)) return;
    this.transcript = claudeRowsToMessages(raw.items);
    this.transcriptAgentStatus = claudeTranscriptStatus(raw.running);
  }

  /** Session rows from the session-list surface, when one is open. */
  private async readSessionRows(where: 'list' | 'chat'): Promise<{ id: string; title: string }[]> {
    const evalFn = where === 'list'
      ? this.webview.evaluateInSessionList.bind(this.webview)
      : this.webview.evaluateInPanel.bind(this.webview);
    if (where === 'list' && !(await this.webview.ensureSessionList())) return [];

    let raw: unknown;
    try {
      raw = await evalFn(`(d) => {
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
    return raw.flatMap(row => {
      if (typeof row !== 'object' || row === null) return [];
      const id = (row as { id?: unknown }).id;
      const title = (row as { title?: unknown }).title;
      if (typeof id !== 'string' || !id) return [];
      return [{ id, title: typeof title === 'string' ? title : '' }];
    });
  }

  /**
   * Open surfaces (side panel and editor) plus session history.
   *
   * Each chat webview is its own tab. History rows carry a session id when
   * they have one; numeric popover rows are switched by clicking the row.
   */
  private async readTabs(): Promise<ChatTab[]> {
    let surfaces: ChatTab[];
    try {
      surfaces = await this.readSurfaceTabs();
    } catch {
      return this.tabs;
    }
    const history = await this.readHistoryTabs(surfaces);
    const tabs = [...surfaces, ...history];
    if (tabs.length > 0 && !tabs.some(tab => tab.isActive)) {
      const firstOpen = tabs.find(tab => tab.source === 'open');
      if (firstOpen) firstOpen.isActive = true;
    }
    return tabs;
  }

  private chatTargets() {
    const known = this.webview.getKnownTargets().filter(target => target.view === 'chat');
    const current = this.webview.getTarget();
    if (current?.view === 'chat' && !known.some(target => target.id === current.id)) {
      return [current, ...known];
    }
    return known;
  }

  private async readSurfaceTabs(): Promise<ChatTab[]> {
    const chats = this.chatTargets();
    const both = chats.some(chat => claudePlacement(chat.purpose) === 'sidebar')
      && chats.some(chat => claudePlacement(chat.purpose) === 'editor');
    const connected = this.webview.getTarget();
    const tabs: ChatTab[] = [];

    for (const chat of chats) {
      const placement = claudePlacement(chat.purpose);
      const cached = this.surfaceMeta.get(chat.id);
      const stale = !cached || Date.now() - cached.at > DISCOVERY_THROTTLE_MS;
      const isConnected = connected?.id === chat.id;
      if (isConnected || stale) {
        const meta = await this.readSurfaceMeta(chat.wsUrl, isConnected);
        if (meta) {
          const previous = this.surfaceMeta.get(chat.id);
          this.surfaceMeta.set(chat.id, {
            title: meta.title || previous?.title || '',
            model: meta.model || previous?.model || '',
            at: Date.now(),
          });
        }
      }
      const meta = this.surfaceMeta.get(chat.id);
      if (isConnected && meta?.model) this.transcriptModel = meta.model;
      const base = cleanSessionTitle(meta?.title || '')
        || (placement === 'sidebar' ? 'Claude panel' : 'Claude editor');
      const title = both
        ? `${base} · ${placement === 'sidebar' ? 'panel' : 'editor'}`
        : base;
      tabs.push({
        composerId: claudePanelComposerId(placement, chat.webviewName || chat.id),
        title,
        isActive: isConnected,
        status: '',
        selectorPath: '',
        source: 'open',
        workStatus: 'idle',
        host: 'claude-code',
      });
    }
    return tabs;
  }

  private async readSurfaceMeta(
    wsUrl: string,
    connected: boolean,
  ): Promise<{ title: string; model: string } | null> {
    const raw = connected
      ? await this.webview.evaluateInPanel(SURFACE_META_JS).catch(() => null)
      : await this.webview.probeInner(wsUrl, SURFACE_META_JS);
    return parseSurfaceMeta(raw);
  }

  private async readHistoryTabs(surfaces: ChatTab[]): Promise<ChatTab[]> {
    const fromManager = (await this.readSessionRows('list'))
      .map(row => toHistoryTab(row))
      .filter((tab): tab is ChatTab => tab !== null);
    const visible = (await this.readSessionRows('chat'))
      .map(row => toHistoryTab(row))
      .filter((tab): tab is ChatTab => tab !== null);

    await this.refreshHistoryIfNeeded();

    const byId = new Map<string, ChatTab>();
    for (const tab of [...fromManager, ...this.historyCache, ...visible]) {
      if (!byId.has(tab.composerId)) byId.set(tab.composerId, tab);
    }

    const openTitles = new Set(
      surfaces.map(tab => surfaceBaseTitle(tab.title).toLowerCase()),
    );
    return [...byId.values()].filter(tab => !openTitles.has(tab.title.trim().toLowerCase()));
  }

  /**
   * Open Session history once per set of visible chats. Repeating it on the
   * poll would toggle the popover in the IDE.
   */
  private async refreshHistoryIfNeeded(): Promise<void> {
    const surfaceKey = this.chatTargets().map(chat => chat.id).sort().join('|');
    const surfacesChanged = surfaceKey !== this.historySurfaceKey;
    const retryEmpty = this.historyCache.length === 0 && Date.now() - this.lastHistoryAt >= HISTORY_RETRY_MS;
    if (!surfacesChanged && !retryEmpty) return;
    this.lastHistoryAt = Date.now();
    this.historySurfaceKey = surfaceKey;
    const popped = await this.snapshotHistoryPopover();
    if (popped && popped.length > 0) this.historyCache = popped;
  }

  /**
   * Session history is a popover. Open it, read the rows, then dismiss it.
   * Rows already on screen are left alone.
   */
  private async snapshotHistoryPopover(): Promise<ChatTab[] | null> {
    if (!this.webview.isConnected()) return null;
    try {
      const opened = await this.webview.evaluateInPanel(`(d) => {
        if (d.querySelector(${JSON.stringify(SEL.sessionRow)})) return 'already';
        const history = Array.from(d.querySelectorAll('button, [role="button"]'))
          .find(el => (el.getAttribute('aria-label') || '') === 'Session history');
        if (!history) return false;
        history.click();
        return true;
      }`);
      if (opened === false) return null;
      if (opened === true) await delay(300);
      const rows = await this.readSessionRows('chat');
      if (opened === true) await this.dismissHistory();
      return rows
        .map(row => toHistoryTab(row))
        .filter((tab): tab is ChatTab => tab !== null);
    } catch {
      return null;
    }
  }

  private async dismissHistory(): Promise<void> {
    const client = this.webview.getClient();
    if (!client) return;
    await client.pressKey('Escape', 'Escape', 27);
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
    // Open in Primary Editor. `newConversation` and `editor.open` follow the
    // preferred location and can land in the side panel instead.
    const known = new Set(
      this.webview.getKnownTargets().filter(target => target.view === 'chat').map(target => target.id),
    );
    const result = await this.runCommand(commandId, 'claude-vscode.primaryEditor.open', []);
    if (result.ok) await this.attachEditor(known);
    return result;
  }

  async switchTab(commandId: string, tab: ChatTabRef): Promise<CommandResult> {
    const panel = parseClaudePanelId(tab.composerId);
    if (panel) return this.focusSurface(commandId, panel);

    const historyIndex = parseHistoryIndex(tab.composerId);
    if (historyIndex !== null) return this.openHistoryRow(commandId, historyIndex);

    const sessionId = parseSessionId(tab.composerId);
    if (!sessionId) {
      return this.runCommand(commandId, 'claude-vscode.focus', []);
    }

    // From the editor, force the primary editor. From the side panel, let
    // `editor.open` follow the sidebar preference so the session stays there.
    if (this.placementOfConnected() === 'editor') {
      const result = await this.runCommand(commandId, 'claude-vscode.primaryEditor.open', [sessionId, null]);
      if (result.ok) await this.attachPlacement('editor');
      return result;
    }

    const result = await this.runCommand(commandId, 'claude-vscode.editor.open', [
      sessionId,
      null,
      null,
      null,
      null,
      { programmatic: true },
    ]);
    if (result.ok) await this.attachPlacement('sidebar');
    return result;
  }

  private placementOfConnected(): ClaudePlacement {
    const target = this.webview.getTarget();
    return target ? claudePlacement(target.purpose) : 'sidebar';
  }

  private async focusSurface(
    commandId: string,
    panel: { placement: ClaudePlacement; webviewName: string },
  ): Promise<CommandResult> {
    await this.webview.discover();
    const target = this.chatTargets().find(chat =>
      claudePlacement(chat.purpose) === panel.placement
      && (chat.webviewName === panel.webviewName || chat.id === panel.webviewName)
    );
    if (!target) {
      return { commandId, ok: false, error: 'Claude surface is not open' };
    }
    const connected = await this.webview.connect(target);
    if (!connected) {
      return { commandId, ok: false, error: 'Claude surface is not connected' };
    }
    await this.readTranscript();
    return { commandId, ok: true };
  }

  private async attachEditor(knownIds: Set<string>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(attempt === 0 ? 400 : 700);
      await this.webview.discover();
      const editors = this.chatTargets().filter(chat => claudePlacement(chat.purpose) === 'editor');
      const created = editors.find(chat => !knownIds.has(chat.id));
      const match = created ?? (attempt === 2 ? (editors.find(chat => chat.visible) ?? editors[0]) : undefined);
      if (!match) continue;
      await this.webview.connect(match);
      await this.readTranscript();
      return;
    }
  }

  private async attachPlacement(placement: ClaudePlacement): Promise<void> {
    await delay(400);
    await this.webview.discover();
    const chats = this.chatTargets().filter(chat => claudePlacement(chat.purpose) === placement);
    const match = chats.find(chat => chat.visible) ?? chats[0];
    if (!match) return;
    await this.webview.connect(match);
    await this.readTranscript();
  }

  private async openHistoryRow(commandId: string, rowKey: string): Promise<CommandResult> {
    if (!(await this.ensureConnected())) {
      return { commandId, ok: false, error: 'Claude Code panel is not connected' };
    }
    const rowId = `${SESSION_ROW_ID_PREFIX}${rowKey}`;
    try {
      const clicked = await this.webview.evaluateInPanel(`(d) => {
        const rowId = ${JSON.stringify(rowId)};
        const clickRow = () => {
          const row = d.getElementById(rowId);
          if (!row) return false;
          row.click();
          return true;
        };
        if (clickRow()) return 'clicked';
        const history = Array.from(d.querySelectorAll('button, [role="button"]'))
          .find(el => (el.getAttribute('aria-label') || '') === 'Session history');
        if (history) history.click();
        return clickRow() ? 'clicked' : 'opened';
      }`);
      if (clicked === 'opened') {
        await delay(250);
        const second = await this.webview.evaluateInPanel(`(d) => {
          const row = d.getElementById(${JSON.stringify(rowId)});
          if (!row) return false;
          row.click();
          return true;
        }`);
        await this.dismissHistory();
        if (second !== true) {
          return { commandId, ok: false, error: 'Session history row not found' };
        }
      } else if (clicked !== 'clicked') {
        return { commandId, ok: false, error: 'Session history row not found' };
      } else {
        await this.dismissHistory();
      }
      await this.readTranscript();
      return { commandId, ok: true };
    } catch (err) {
      return { commandId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

    // Stop is a submit button whose React onClick calls session.interrupt().
    // A DOM click() does not run that handler. A dead webview connection also
    // leaves busy set, so if interrupt does not clear it, end the turn locally.
    try {
      const clicked = await this.webview.evaluateInPanel(CLAUDE_STOP_JS);
      if (!isStopClick(clicked) || !clicked.ok) {
        return { commandId, ok: false, error: 'Stop control not visible — no turn is running' };
      }
      await delay(500);
      await this.webview.evaluateInPanel(CLAUDE_END_STUCK_TURN_JS).catch(() => false);
      return { commandId, ok: true };
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

/**
 * A history row. UUID ids become `claude:session:`; numeric popover ids
 * (`sessions-list-row-0`) become `claude:history:` and are opened by a click.
 */
function toHistoryTab(row: { id: string; title: string }): ChatTab | null {
  if (!row.id.startsWith(SESSION_ROW_ID_PREFIX)) return null;
  const rest = row.id.slice(SESSION_ROW_ID_PREFIX.length);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest);
  const index = /^\d+$/.test(rest);
  if (!uuid && !index) return null;

  return {
    composerId: uuid ? `${SESSION_TAB_PREFIX}${rest}` : `${HISTORY_TAB_PREFIX}${rest}`,
    title: cleanSessionTitle(row.title) || 'Claude session',
    isActive: false,
    status: '',
    selectorPath: '',
    source: 'sidebar',
    workStatus: 'idle',
    host: 'claude-code',
  };
}

function parseSurfaceMeta(value: unknown): { title: string; model: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const title = (value as { title?: unknown }).title;
  const model = (value as { model?: unknown }).model;
  return {
    title: typeof title === 'string' ? title : '',
    model: typeof model === 'string' ? model : '',
  };
}

/** Drop the " · panel" / " · editor" suffix added when both surfaces are open. */
function surfaceBaseTitle(title: string): string {
  return title.replace(/ · (panel|editor)$/, '').trim();
}

function isTranscriptRead(value: unknown): value is ClaudeTranscriptRead {
  if (typeof value !== 'object' || value === null) return false;
  const items = (value as ClaudeTranscriptRead).items;
  return Array.isArray(items);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isStopClick(value: unknown): value is { ok: boolean } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean';
}

export type ClaudePlacement = 'sidebar' | 'editor';

/** `webviewView` is the side panel. Anything else is an editor tab. */
export function claudePlacement(purpose: string): ClaudePlacement {
  return purpose === 'webviewView' ? 'sidebar' : 'editor';
}

export function claudePanelComposerId(placement: ClaudePlacement, webviewName: string): string {
  return `${PANEL_TAB_PREFIX}${placement}:${webviewName}`;
}

export function parseClaudePanelId(
  composerId: string,
): { placement: ClaudePlacement; webviewName: string } | null {
  const match = /^claude:panel:(sidebar|editor):(.+)$/.exec(composerId);
  if (!match?.[2]) return null;
  return { placement: match[1] as ClaudePlacement, webviewName: match[2] };
}

/** `claude:history:<n>` is a popover row with no session uuid. */
export function parseHistoryIndex(composerId: string): string | null {
  if (!composerId.startsWith(HISTORY_TAB_PREFIX)) return null;
  const rest = composerId.slice(HISTORY_TAB_PREFIX.length);
  return /^\d+$/.test(rest) ? rest : null;
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
