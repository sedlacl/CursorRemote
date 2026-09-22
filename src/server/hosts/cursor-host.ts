import type { CommandExecutor } from '../command-executor.js';
import type { StateManager } from '../state-manager.js';
import type {
  BackgroundTask,
  ChatTab,
  CommandResult,
  MessageAttachment,
} from '../types.js';
import {
  BaseChatHost,
  type ChatApprovalRequest,
  type ChatHostCapabilities,
  type ChatHostId,
  type ChatTabRef,
} from './chat-host.js';

/**
 * The Cursor composer as a {@link ChatHost}.
 *
 * Pure delegation: every behaviour already lives in {@link CommandExecutor} and
 * the Cursor DOM extractor. This class exists so the relay can route by tab
 * host instead of calling the executor directly, which is what lets
 * `ClaudeCodeHost` slot in beside it.
 */
export class CursorHost extends BaseChatHost {
  readonly id: ChatHostId = 'cursor';

  readonly capabilities: ChatHostCapabilities = {
    sendMessage: true,
    newChat: true,
    switchTab: true,
    chatApproval: true,
    // Cursor diffs are approved inside the transcript, not through an editor command.
    editorDiff: false,
    stopTurn: true,
    backgroundTasks: true,
    stopBackgroundTask: true,
    setMode: true,
    setModel: true,
  };

  private readonly executor: CommandExecutor;
  private readonly stateManager: StateManager;

  constructor(executor: CommandExecutor, stateManager: StateManager) {
    super();
    this.executor = executor;
    this.stateManager = stateManager;
  }

  isAvailable(): boolean {
    return this.stateManager.getCurrentState().connected;
  }

  listTabs(): ChatTab[] {
    return this.stateManager
      .getCurrentState()
      .chatTabs.filter(tab => (tab.host ?? 'cursor') === 'cursor');
  }

  listBackgroundTasks(): BackgroundTask[] {
    return this.stateManager.getCurrentState().backgroundTasks;
  }

  sendMessage(
    commandId: string,
    text: string | undefined,
    attachments: MessageAttachment[],
  ): Promise<CommandResult> {
    return this.executor.sendMessage(commandId, text, attachments);
  }

  newChat(commandId: string): Promise<CommandResult> {
    return this.executor.newChat(commandId);
  }

  switchTab(commandId: string, tab: ChatTabRef): Promise<CommandResult> {
    return this.executor.switchTab(
      commandId,
      tab.title,
      tab.selectorPath,
      tab.composerId,
      tab.source,
    );
  }

  approve(request: ChatApprovalRequest): Promise<CommandResult> {
    return this.executor.clickApproval(request.commandId, request.selectorPath ?? '');
  }

  reject(request: ChatApprovalRequest): Promise<CommandResult> {
    return this.executor.reject(request.commandId, request.selectorPath ?? '');
  }

  stopTurn(commandId: string): Promise<CommandResult> {
    const state = this.stateManager.getCurrentState();
    const selectorPath = state.agentStopSelectorPath
      || state.backgroundTasks.find(task => task.stopSelectorPath)?.stopSelectorPath
      || '';
    if (!selectorPath) {
      return Promise.resolve({
        commandId,
        ok: false,
        error: 'Stop button not available',
      });
    }
    return this.executor.clickAction(commandId, selectorPath);
  }

  stopBackgroundTask(commandId: string, taskId: string): Promise<CommandResult> {
    const task = this.stateManager
      .getCurrentState()
      .backgroundTasks.find(t => t.id === taskId);
    if (!task?.stopSelectorPath) {
      return Promise.resolve({
        commandId,
        ok: false,
        error: `No stop control for background task ${taskId}`,
      });
    }
    return this.executor.clickAction(commandId, task.stopSelectorPath);
  }

  /** Escape hatch for Cursor-only commands the shared interface does not cover. */
  getExecutor(): CommandExecutor {
    return this.executor;
  }
}
