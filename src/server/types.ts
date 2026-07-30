import type { GitStatusInfo } from '../shared/extension-bridge.js';
import type { GitScmSnapshot } from '../shared/git-scm.js';

// Core relay state and chat element typings.
export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

/** Raw DOM element snapshot — what was actually in the DOM, independent of parsing. */
export interface RawElement {
  flatIndex: number;
  /** Native conversation pair; stable across virtualized history windows. */
  turnIndex?: number;
  /** Native row position inside the pair. */
  turnOrder?: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  /** Key CSS class/element indicators found on this wrapper. */
  indicators: string[];
  /** First ~120 chars of textContent. */
  textPreview: string;
  /** What ChatElement type the parser decided this was (or 'skipped'). */
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  /** Per-element DOM inventory — raw attributes and indicator classes for every [data-flat-index]. */
  elements: RawElement[];
  /** Activity-related elements NOT inside any [data-flat-index] wrapper. */
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
}

export type ComposerQueueActionType = 'send' | 'remove' | 'edit';

export interface ComposerQueueAction {
  type: ComposerQueueActionType;
  label: string;
  selectorPath: string;
}

export interface ComposerQueueItem {
  id: string;
  text: string;
  actions?: ComposerQueueAction[];
}

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  /** e.g. "2 Queued" from toolbar header */
  queueLabel?: string;
}

export interface QuestionnaireOption {
  letter: string;
  label: string;
  isFreeform: boolean;
  isSelected?: boolean;
  selectorPath: string;
}

export interface QuestionnaireQuestion {
  number: string;
  text: string;
  options: QuestionnaireOption[];
  isActive: boolean;
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  activeIndex: number;
  totalLabel: string;
  skipSelectorPath: string;
  continueSelectorPath: string;
  continueDisabled: boolean;
}

export interface BackgroundTask {
  id: string;
  label: string;
  detail?: string;
  expandSelectorPath?: string;
  stopSelectorPath?: string;
}

export type SubagentStatus = 'running' | 'completed' | 'waiting' | 'error' | 'unknown';

export type SubagentStopKind = 'cardStop' | 'toolbarStop' | 'singleJobAfterExpand';

/** Stable server-side stop target descriptor; resolved at command time. */
export interface SubagentStopDescriptor {
  kind: SubagentStopKind;
  matchTitle: string;
  matchModel?: string;
  toolCallId?: string;
  messageId?: string;
  composerId?: string;
}

export interface SubagentItemCapabilities {
  openSelectorPath?: string;
  toolbarExpandSelectorPath?: string;
  matchTitle: string;
  matchModel?: string;
  stop?: SubagentStopDescriptor;
  /** @deprecated Short-lived fallback when resolver misses; never sent to client. */
  legacyStopSelectorPath?: string;
}

export interface SubagentItem {
  id: string;
  title: string;
  model?: string;
  status: SubagentStatus;
  statusText?: string;
  /** Card open action is available in the current DOM snapshot. */
  openAvailable: boolean;
  /** Matched toolbar stop action is available for this subagent. */
  stopAvailable: boolean;
  /** Server-only selector targets; stripped before socket emit. */
  _capabilities?: SubagentItemCapabilities;
}

/** Multitask workers are distinct from background terminals/tools. */
export interface SubagentState {
  runningCount: number;
  /** Cursor toolbar summary, e.g. "1 subagent running". */
  summary: string;
  items: SubagentItem[];
}

/** Agent-authored file changes shown in Cursor's composer toolbar (not Git SCM). */
export interface AgentChangesState {
  fileCount: number;
  reviewAvailable: boolean;
  undoAllAvailable: boolean;
  reviewSelectorPath?: string;
  undoAllSelectorPath?: string;
}

/** Exploratory Cursor chrome not yet fully extracted — populated after CDP probe. */
export interface CloudWidget {
  id: string;
  label: string;
  detail?: string;
  selectorPath?: string;
}

export interface SubagentTrayItem {
  id: string;
  label: string;
  status?: string;
  selectorPath?: string;
}

export interface ExploratoryUiChrome {
  stickyTitle: string | null;
  cloudWidgets: CloudWidget[];
  subagentTrays: SubagentTrayItem[];
}

export interface ActiveConversationContext {
  kind: 'orchestrator' | 'subagent';
  composerId: string;
  depth: number;
  parentComposerId?: string;
  parentWindowId?: string;
  parentTitle?: string;
  rootOrchestratorComposerId?: string;
  returnToParentAvailable: boolean;
  composerInputAvailable: boolean;
}

export interface CursorState {
  connected: boolean;
  /** Health of DOM extraction independent from the CDP websocket connection. */
  extractorStatus: ExtractorStatus;
  /** Timestamp of the last successful extraction in ms since epoch. */
  lastExtractionAt: number | null;
  /** Number of consecutive failed extraction attempts since the last success. */
  consecutiveExtractionFailures: number;
  /** Most recent extraction error, or null after a successful extraction/reset. */
  lastExtractionError: string | null;
  agentStatus: AgentStatus;
  /** Live activity label; null means explicitly cleared on the wire. */
  agentActivityText: string | null;
  /** True only when the server believes work is actively in progress right now. */
  agentActivityLive: boolean;
  /** Provenance of the current activity signal, for transports/debugging. */
  agentActivitySource: ActivitySource;
  messages: ChatElement[];
  /** Approvals for the active window+composer only (context-local). */
  pendingApprovals: Approval[];
  /** Cross-window approval notifications for header UI; no executable selectors. */
  globalApprovalNotifications: GlobalApprovalNotification[];
  inputAvailable: boolean;
  /** True when the active composer bar exposes a real chat input (scoped, not global editor textarea). */
  composerInputAvailable: boolean;
  /** Active chat hierarchy context for subagent navigation UI. */
  activeConversationContext: ActiveConversationContext | null;
  chatTabs: ChatTab[];
  /** data-composer-id of the active composer in the extracted DOM. Stable
   *  across windows that share an agent via Cursor's global rail; differs
   *  for two genuinely different agents that happen to share a tab title. */
  activeComposerId: string;
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  /** Prompts queued in composer toolbar (outside transcript). */
  composerQueue: ComposerQueueState;
  /** Agent questionnaire widget (multiple-choice questions). */
  questionnaire: Questionnaire | null;
  /** Background shell/tool tasks visible in Cursor's composer. */
  backgroundTasks: BackgroundTask[];
  /** Cursor Multitask workers; never merged into backgroundTasks. */
  subagents: SubagentState;
  /** Agent-authored changes from the composer toolbar, separate from extension gitStatus. */
  agentChanges: AgentChangesState;
  /** Git/source-control summary provided by the extension host for the owner workspace. */
  gitStatus: GitStatusInfo | null;
  /** File-level git snapshot for mobile SCM review (active window). */
  gitScm: GitScmSnapshot | null;
  /** Best-known stop/cancel action for the active agent, if Cursor exposes one. */
  agentStopSelectorPath: string;
  /** True only when a real Stop control exists in Cursor DOM right now. */
  agentStopAvailable: boolean;
  /** Provenance of the active stop control. */
  agentStopSource: 'composer' | 'background_task' | 'none';
  /** Optional exploratory chrome (sticky title, cloud widgets, subagent trays). */
  exploratoryUi: ExploratoryUiChrome | null;
  _rawSignals?: RawSignals;
}

export type ChatTabWorkStatus = 'running' | 'completed' | 'idle';

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  status: string;
  selectorPath: string;
  /** `open` = editor tab bar; `sidebar` = agent list in the sidebar. */
  source: 'open' | 'sidebar';
  /** Agent work state mirrored from Cursor sidebar / composer DOM. */
  workStatus: ChatTabWorkStatus;
}

export interface ModeInfo {
  current: string;
  available: { id: string; label: string; icon: string }[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type ExtractorStatus = 'idle' | 'waiting' | 'ok' | 'stale';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'running_subagents'
  | 'waiting_approval'
  | 'waiting_question'
  | 'waiting_user_input'
  | 'error';

export type ActivitySource =
  | 'none'
  | 'shimmer'
  | 'loading_tool'
  | 'loading_indicator'
  | 'tail_thought'
  | 'subagents';

export type ChatElement =
  | HumanMessage
  | AssistantMessage
  | ToolCallElement
  | ThoughtBlock
  | PlanBlock
  | TodoListBlock
  | RunCommand
  | LoadingIndicator;

export interface TranscriptOrder {
  flatIndex: number;
  /** Authoritative global header position loaded from Cursor storage. */
  historyIndex?: number;
  /** Native `data-pair-index`; preferred for chronological sorting when present. */
  turnIndex?: number;
  /** Native virtual-row `data-index` within `turnIndex`. */
  turnOrder?: number;
}

export interface HumanMessage extends TranscriptOrder {
  type: 'human';
  id: string;
  text: string;
  mentions: { name: string; mentionType: string }[];
  /** Quoted / reply preview from composer (e.g. ProseMirror blockquote). */
  quoted?: { text: string };
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

/** Native web/Telegram rendering: structured code or diff (no mirrored Monaco HTML). */
export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  /** Flat joined text (search, fallback, simple pre) */
  code: string;
  /** Present when blockKind === 'diff'; line-level add/rem/ctx from live Monaco DOM */
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface AssistantMessage extends TranscriptOrder {
  type: 'assistant';
  id: string;
  text: string;
  html: string;
  codeBlocks: CodeBlockItem[];
}

export interface ToolCallElement extends TranscriptOrder {
  type: 'tool';
  id: string;
  toolCallId: string;
  status: 'loading' | 'completed';
  action: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  /** Structured diff/code for edit tools; web client renders natively */
  diffBlock?: CodeBlockItem;
}

export interface ThoughtBlock extends TranscriptOrder {
  type: 'thought';
  id: string;
  duration: string;
  action?: string;
  detail?: string;
  /** Cursor step-group: umbrella row (e.g. Explored) vs inner thinking row */
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  selectorPath: string;
}

export interface PlanBlock extends TranscriptOrder {
  type: 'plan';
  id: string;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  /** Raw markdown HTML from `.composer-create-plan-text .markdown-root` (web client). */
  descriptionHtml?: string;
  todos?: PlanTodo[];
  /** Hidden todo rows behind "N more" in Cursor (estimated). */
  todosMoreCount?: number;
  model?: string;
  /** Click to open plan-scoped model dropdown in Cursor. */
  modelDropdownSelectorPath?: string;
  actions?: PlanAction[];
}

export interface PlanModelOption {
  id: string;
  label: string;
  selected?: boolean;
}

export interface PlanFullData {
  todos: PlanTodo[];
  body: string;
  bodyHtml: string;
}

export interface TodoListBlock extends TranscriptOrder {
  type: 'todo_list';
  id: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow';
  selectorPath: string;
}

export interface RunCommand extends TranscriptOrder {
  type: 'run_command';
  id: string;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
}

export interface LoadingIndicator extends TranscriptOrder {
  type: 'loading';
  id: string;
  text?: string;
}

export interface Approval {
  id: string;
  description: string;
  /** Human-readable card title when distinct from command. */
  title?: string;
  /** Shell command awaiting approval. */
  command?: string;
  /** Auto-review / smart-mode block reason text. */
  reason?: string;
  /** Policy label, e.g. Auto-review. */
  mode?: string;
  /** data-composer-id of the owning chat composer. */
  composerId?: string;
  /** Active chat tab title when extracted. */
  chatTitle?: string;
  /** Owning Cursor window target id (filled server-side). */
  windowId?: string;
  actions: ApprovalAction[];
}

/** Client-safe approval notification without action selectors. */
export interface GlobalApprovalNotification {
  id: string;
  windowId: string;
  windowTitle: string;
  composerId: string;
  chatTitle: string;
  summary: string;
  title?: string;
  command?: string;
  reason?: string;
  mode?: string;
  timestamp: number;
}

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all';
  selectorPath: string;
}

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

export interface MessageAttachment {
  mimeType: string;
  /** Base64-encoded file bytes (no data: URL prefix). */
  data: string;
  name?: string;
}

export interface CommandPayload {
  commandId: string;
  type: 'send_message' | 'approve' | 'reject' | 'approve_all' | 'switch_tab' | 'close_tab' | 'new_chat' | 'set_mode' | 'set_model' | 'click_action' | 'stop_agent' | 'open_subagent' | 'stop_subagent' | 'return_to_parent' | 'get_plan_full' | 'get_plan_model_options' | 'set_plan_model' | 'load_history' | 'open_source_control' | 'open_transcript_link' | 'kill_server' | 'navigate_to_approval';
  /** Scroll steps in Cursor IDE when loading older chat history (load_history). */
  times?: number;
  text?: string;
  attachments?: MessageAttachment[];
  approvalId?: string;
  actionType?: string;
  selectorPath?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  planLabel?: string;
  planModelId?: string;
  tabTitle?: string;
  tabSource?: 'open' | 'sidebar';
  /** Raw href from assistant transcript link (internal only). */
  linkHref?: string;
  /** Visible anchor text for title-based fallback when opening by composerId fails. */
  linkLabel?: string;
  windowId?: string;
  /** Stable subagent id from extracted state (`subagents.items[].id`). */
  subagentId?: string;
}

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface ServerConfig {
  cdpUrl: string;
  serverPort: number;
  serverHost: string;
  pollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  webappPassword: string;
  /** Optional Bearer token for agent access to /debug/* when WEBAPP_PASSWORD is set. */
  diagnosticToken: string;
  windowTitleQualifier: boolean;
  dataDir: string;
  cursorStateDbPath?: string;
  telegram: TelegramConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  preRegisteredUsers: number[];
  impl: 'grammy' | 'raw';
}
