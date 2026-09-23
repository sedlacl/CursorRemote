import type {
  BackgroundTask,
  ChatHostCapabilities,
  ChatHostId,
  ChatTab,
  CommandResult,
  CursorState,
  MessageAttachment,
} from '../types.js';

export type { ChatHostCapabilities, ChatHostId };

/**
 * Every backend the relay knows about. Adding one (e.g. `codex`) means: extend
 * {@link ChatHostId}, list it here, implement {@link ChatHost} and register it
 * in `index.ts`. Nothing in the relay or the client branches on the id.
 */
export const CHAT_HOST_IDS: readonly ChatHostId[] = ['cursor', 'claude-code'];

export function isChatHostId(value: unknown): value is ChatHostId {
  return typeof value === 'string' && (CHAT_HOST_IDS as readonly string[]).includes(value);
}

export const NO_CAPABILITIES: ChatHostCapabilities = {
  sendMessage: false,
  newChat: false,
  switchTab: false,
  closeTab: false,
  chatApproval: false,
  approveAll: false,
  editorDiff: false,
  stopTurn: false,
  backgroundTasks: false,
  stopBackgroundTask: false,
  setMode: false,
  setModel: false,
  planModel: false,
  clickAction: false,
  loadHistory: false,
  subagents: false,
};

/**
 * State fields that describe *one conversation* — the one in the active tab.
 *
 * The extractor fills them from the Cursor composer. When another host owns
 * the active tab, every one of them is reset to {@link neutralConversationState}
 * before the host's own view is applied, so nothing Cursor extracted (its mode,
 * its questionnaire, its stop selector, …) leaks into another backend's tab.
 * A new field that is conversation-scoped belongs in this list.
 */
export type ConversationStateKey =
  | 'messages'
  | 'agentStatus'
  | 'agentActivityText'
  | 'agentActivityLive'
  | 'agentActivitySource'
  | 'pendingApprovals'
  | 'inputAvailable'
  | 'composerInputAvailable'
  | 'mode'
  | 'model'
  | 'composerQueue'
  | 'questionnaire'
  | 'backgroundTasks'
  | 'subagents'
  | 'agentChanges'
  | 'agentStopSelectorPath'
  | 'agentStopAvailable'
  | 'agentStopSource'
  | 'exploratoryUi';

export type ConversationState = Pick<CursorState, ConversationStateKey>;

/** A conversation with nothing in it and no controls — the base of any host view. */
export function neutralConversationState(): ConversationState {
  return {
    messages: [],
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    pendingApprovals: [],
    inputAvailable: false,
    composerInputAvailable: false,
    mode: { current: '', available: [] },
    model: { current: '', currentId: '' },
    composerQueue: { items: [] },
    questionnaire: null,
    backgroundTasks: [],
    subagents: { runningCount: 0, summary: '', items: [] },
    agentChanges: { fileCount: 0, reviewAvailable: false, undoAllAvailable: false },
    agentStopSelectorPath: '',
    agentStopAvailable: false,
    agentStopSource: 'none',
    exploratoryUi: null,
  };
}

/** What a non-native host publishes for its active tab. */
export interface HostConversationView extends Partial<ConversationState> {
  /** Tab id the view belongs to; becomes `activeComposerId`. */
  composerId?: string;
}

/** Tab identity as the client knows it; hosts resolve it to their own handle. */
export interface ChatTabRef {
  composerId: string;
  title: string;
  selectorPath?: string;
  source?: 'open' | 'sidebar';
}

export interface ChatApprovalRequest {
  commandId: string;
  /** Approval id from the extracted state, when the host uses one. */
  approvalId?: string;
  selectorPath?: string;
  /** Which control of the approval to press. */
  action?: 'approve' | 'approve_all' | 'reject';
}

export interface LoadHistoryRequest {
  commandId: string;
  composerId?: string;
  /** Scroll steps for hosts that page history by scrolling. */
  times: number;
}

/**
 * The adapter seam between the relay and a concrete IDE agent.
 *
 * The relay resolves the host that owns the command's tab (or the active tab)
 * through {@link ChatHostRegistry}, checks the matching capability, and calls
 * the method here. It never calls a backend-specific executor and never
 * branches on the host id. Anything a host cannot do returns
 * {@link unsupported} rather than throwing.
 */
export interface ChatHost {
  readonly id: ChatHostId;

  /** Short human name for errors and logs ("Cursor", "Claude Code"). */
  readonly label: string;

  /** Capabilities as currently known — may tighten after a failed probe. */
  readonly capabilities: ChatHostCapabilities;

  /** True when the host has a live connection and can accept commands. */
  isAvailable(): boolean;

  /** Poll the backend; called on a timer by `index.ts`. Optional. */
  refresh?(): Promise<void>;

  /** Tabs this host contributes to the merged `chatTabs` list. */
  listTabs(): ChatTab[];

  /** Background tasks this host can see. Fail-closed: `[]` when unverified. */
  listBackgroundTasks(): BackgroundTask[];

  /**
   * The conversation state of this host's active tab, applied over a neutral
   * base while this host is active. `null` means the host is *native* to the
   * extracted state (Cursor) and nothing is replaced.
   */
  conversationView(): HostConversationView | null;

  sendMessage(
    commandId: string,
    text: string | undefined,
    attachments: MessageAttachment[],
  ): Promise<CommandResult>;

  newChat(commandId: string): Promise<CommandResult>;

  switchTab(commandId: string, tab: ChatTabRef): Promise<CommandResult>;

  closeTab(commandId: string, tab: ChatTabRef): Promise<CommandResult>;

  approve(request: ChatApprovalRequest): Promise<CommandResult>;

  approveAll(commandId: string): Promise<CommandResult>;

  reject(request: ChatApprovalRequest): Promise<CommandResult>;

  /** Interrupt the main turn (not a background task). */
  stopTurn(commandId: string): Promise<CommandResult>;

  /** Accept a proposed diff in the editor, where the host exposes one. */
  acceptEditorDiff(commandId: string): Promise<CommandResult>;

  /** Reject a proposed diff in the editor, where the host exposes one. */
  rejectEditorDiff(commandId: string): Promise<CommandResult>;

  /** Stop one background task; only implemented when a verified stop exists. */
  stopBackgroundTask(commandId: string, taskId: string): Promise<CommandResult>;

  setMode(commandId: string, modeId: string): Promise<CommandResult>;

  setModel(commandId: string, modelId: string): Promise<CommandResult>;

  getModelOptions(commandId: string): Promise<CommandResult>;

  getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult>;

  setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult>;

  /** Press a control by a selector path this host published in state. */
  clickAction(commandId: string, selectorPath: string): Promise<CommandResult>;

  loadHistory(request: LoadHistoryRequest): Promise<CommandResult>;
}

/** Uniform "this host does not do that" result. */
export function unsupported(
  commandId: string,
  host: ChatHostId,
  operation: string,
): CommandResult {
  return {
    commandId,
    ok: false,
    error: `${operation} is not supported by the ${host} host`,
  };
}

/** Base class that answers every optional operation with {@link unsupported}. */
export abstract class BaseChatHost implements ChatHost {
  abstract readonly id: ChatHostId;
  abstract readonly capabilities: ChatHostCapabilities;

  get label(): string {
    return this.id;
  }

  abstract isAvailable(): boolean;

  listTabs(): ChatTab[] {
    return [];
  }

  listBackgroundTasks(): BackgroundTask[] {
    return [];
  }

  /**
   * Non-native by default: a host that forgets to publish a view shows an
   * empty conversation rather than the Cursor composer's.
   */
  conversationView(): HostConversationView | null {
    return {};
  }

  sendMessage(
    commandId: string,
    _text: string | undefined,
    _attachments: MessageAttachment[],
  ): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'send_message'));
  }

  newChat(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'new_chat'));
  }

  switchTab(commandId: string, _tab: ChatTabRef): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'switch_tab'));
  }

  closeTab(commandId: string, _tab: ChatTabRef): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'close_tab'));
  }

  approve(request: ChatApprovalRequest): Promise<CommandResult> {
    return Promise.resolve(unsupported(request.commandId, this.id, 'approve'));
  }

  approveAll(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'approve_all'));
  }

  reject(request: ChatApprovalRequest): Promise<CommandResult> {
    return Promise.resolve(unsupported(request.commandId, this.id, 'reject'));
  }

  stopTurn(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'stop'));
  }

  acceptEditorDiff(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'accept_diff'));
  }

  rejectEditorDiff(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'reject_diff'));
  }

  stopBackgroundTask(commandId: string, _taskId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'stop_background_task'));
  }

  setMode(commandId: string, _modeId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'set_mode'));
  }

  setModel(commandId: string, _modelId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'set_model'));
  }

  getModelOptions(commandId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'get_model_options'));
  }

  getPlanModelOptions(commandId: string, _selectorPath: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'get_plan_model_options'));
  }

  setPlanModel(commandId: string, _selectorPath: string, _planModelId: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'set_plan_model'));
  }

  clickAction(commandId: string, _selectorPath: string): Promise<CommandResult> {
    return Promise.resolve(unsupported(commandId, this.id, 'click_action'));
  }

  loadHistory(request: LoadHistoryRequest): Promise<CommandResult> {
    return Promise.resolve(unsupported(request.commandId, this.id, 'load_history'));
  }
}
