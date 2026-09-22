import type {
  BackgroundTask,
  ChatHostId,
  ChatTab,
  CommandResult,
  MessageAttachment,
} from '../types.js';

export type { ChatHostId };

export const CHAT_HOST_IDS: readonly ChatHostId[] = ['cursor', 'claude-code'];

export function isChatHostId(value: unknown): value is ChatHostId {
  return typeof value === 'string' && (CHAT_HOST_IDS as readonly string[]).includes(value);
}

/**
 * What a host can actually do right now.
 *
 * Declared per host rather than probed at call time so the UI can hide or
 * disable controls instead of firing commands that will fail. Everything a
 * probe has not confirmed stays `false` — fail closed, per the adapter plan.
 */
export interface ChatHostCapabilities {
  sendMessage: boolean;
  newChat: boolean;
  switchTab: boolean;
  /** Approve/reject a tool permission prompt inside the chat transcript. */
  chatApproval: boolean;
  /** Accept/reject a proposed diff in the editor (not in the transcript). */
  editorDiff: boolean;
  /** Interrupt the main turn. */
  stopTurn: boolean;
  /** Host can enumerate background tasks (Claude: verified `backgroundTasks` Map). */
  backgroundTasks: boolean;
  /** Host can stop an individual background task. */
  stopBackgroundTask: boolean;
  setMode: boolean;
  setModel: boolean;
}

export const NO_CAPABILITIES: ChatHostCapabilities = {
  sendMessage: false,
  newChat: false,
  switchTab: false,
  chatApproval: false,
  editorDiff: false,
  stopTurn: false,
  backgroundTasks: false,
  stopBackgroundTask: false,
  setMode: false,
  setModel: false,
};

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
}

/**
 * The adapter seam between the relay and a concrete IDE agent.
 *
 * Both `CursorHost` and `ClaudeCodeHost` implement it; the relay routes a
 * command by the active tab's `host` field and never branches on the host id
 * itself. Anything a host cannot do returns {@link unsupported} rather than
 * throwing, so an unsupported action surfaces as a normal command error.
 */
export interface ChatHost {
  readonly id: ChatHostId;

  /** Capabilities as currently known — may tighten after a failed probe. */
  readonly capabilities: ChatHostCapabilities;

  /** True when the host has a live connection and can accept commands. */
  isAvailable(): boolean;

  /** Tabs this host contributes to the merged `chatTabs` list. */
  listTabs(): ChatTab[];

  /** Background tasks this host can see. Fail-closed: `[]` when unverified. */
  listBackgroundTasks(): BackgroundTask[];

  sendMessage(
    commandId: string,
    text: string | undefined,
    attachments: MessageAttachment[],
  ): Promise<CommandResult>;

  newChat(commandId: string): Promise<CommandResult>;

  switchTab(commandId: string, tab: ChatTabRef): Promise<CommandResult>;

  approve(request: ChatApprovalRequest): Promise<CommandResult>;

  reject(request: ChatApprovalRequest): Promise<CommandResult>;

  /** Interrupt the main turn (not a background task). */
  stopTurn(commandId: string): Promise<CommandResult>;

  /** Accept a proposed diff in the editor, where the host exposes one. */
  acceptEditorDiff(commandId: string): Promise<CommandResult>;

  /** Reject a proposed diff in the editor, where the host exposes one. */
  rejectEditorDiff(commandId: string): Promise<CommandResult>;

  /** Stop one background task; only implemented when a verified stop exists. */
  stopBackgroundTask(commandId: string, taskId: string): Promise<CommandResult>;
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

  abstract isAvailable(): boolean;

  listTabs(): ChatTab[] {
    return [];
  }

  listBackgroundTasks(): BackgroundTask[] {
    return [];
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

  approve(request: ChatApprovalRequest): Promise<CommandResult> {
    return Promise.resolve(unsupported(request.commandId, this.id, 'approve'));
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
}
