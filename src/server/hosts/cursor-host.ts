import { resolveApprovalActionSelector } from '../approval-registry.js';
import type { CommandExecutor } from '../command-executor.js';
import type { CursorStorageHistory } from '../cursor-storage-history.js';
import { waitForFreshExtraction } from '../extraction-wait.js';
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
  type HostConversationView,
  type LoadHistoryRequest,
} from './chat-host.js';

/**
 * The Cursor composer as a {@link ChatHost}.
 *
 * Delegates to {@link CommandExecutor} and the Cursor DOM extractor. It is the
 * primary host: the extracted state is its own, so it publishes no
 * conversation view. Everything Cursor-specific the relay used to do inline —
 * resolving approval selectors from the extracted registry, paging history
 * from Cursor's storage DB — lives here, so the relay stays host-agnostic.
 */
export class CursorHost extends BaseChatHost {
  readonly id: ChatHostId = 'cursor';

  override get label(): string {
    return 'Cursor';
  }

  readonly capabilities: ChatHostCapabilities = {
    sendMessage: true,
    newChat: true,
    switchTab: true,
    closeTab: true,
    chatApproval: true,
    approveAll: true,
    // Cursor diffs are approved inside the transcript, not through an editor command.
    editorDiff: false,
    stopTurn: true,
    backgroundTasks: true,
    stopBackgroundTask: true,
    setMode: true,
    setModel: true,
    planModel: true,
    clickAction: true,
    loadHistory: true,
    subagents: true,
  };

  private readonly executor: CommandExecutor;
  private readonly stateManager: StateManager;
  private readonly storageHistory: CursorStorageHistory | null;

  constructor(
    executor: CommandExecutor,
    stateManager: StateManager,
    storageHistory: CursorStorageHistory | null = null,
  ) {
    super();
    this.executor = executor;
    this.stateManager = stateManager;
    this.storageHistory = storageHistory;
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

  /** Native to the extraction — nothing to overlay. */
  override conversationView(): HostConversationView | null {
    return null;
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

  closeTab(commandId: string, tab: ChatTabRef): Promise<CommandResult> {
    return this.executor.closeTab(commandId, tab.title, tab.composerId || undefined, tab.source);
  }

  approve(request: ChatApprovalRequest): Promise<CommandResult> {
    const selectorPath = this.approvalSelector(request, request.action ?? 'approve');
    if (!selectorPath) return Promise.resolve(this.approvalGone(request.commandId));
    return this.executor.clickApproval(request.commandId, selectorPath);
  }

  approveAll(commandId: string): Promise<CommandResult> {
    return this.executor.approveAll(commandId);
  }

  reject(request: ChatApprovalRequest): Promise<CommandResult> {
    const selectorPath = this.approvalSelector(request, 'reject');
    if (!selectorPath) return Promise.resolve(this.approvalGone(request.commandId));
    return this.executor.reject(request.commandId, selectorPath);
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

  setMode(commandId: string, modeId: string): Promise<CommandResult> {
    return this.executor.setMode(commandId, modeId);
  }

  setModel(commandId: string, modelId: string): Promise<CommandResult> {
    return this.executor.setModel(commandId, modelId);
  }

  getModelOptions(commandId: string): Promise<CommandResult> {
    return this.executor.getModelOptions(commandId);
  }

  getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.executor.getPlanModelOptions(commandId, selectorPath);
  }

  setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
    return this.executor.setPlanModel(commandId, selectorPath, planModelId);
  }

  clickAction(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.executor.clickAction(commandId, selectorPath);
  }

  /**
   * Older messages: Cursor's storage DB first, then scrolling the composer up
   * and back down to the live tail (a single scrollTop jump, no wheel burst).
   */
  async loadHistory(request: LoadHistoryRequest): Promise<CommandResult> {
    const { commandId, times } = request;
    const countBefore = this.stateManager.getCurrentState().messages.length;
    const composerId = request.composerId || this.stateManager.getCurrentState().activeComposerId;

    if (composerId && this.storageHistory) {
      try {
        const stored = await this.storageHistory.loadComposerHistory(composerId);
        if (stored && stored.loadedBubbles > 0) {
          const merged = this.stateManager.mergeStoredHistory(stored.messages);
          console.log(
            `[cursor-host] load_history storage: composer=${composerId.slice(0, 8)} ` +
            `headers=${stored.totalHeaders} loaded=${stored.loadedBubbles} added=${merged.addedCount}`
          );
          return {
            commandId,
            ok: true,
            data: {
              addedCount: merged.addedCount,
              totalCount: merged.totalCount,
              source: 'cursor_storage',
              loadedBubbles: stored.loadedBubbles,
              totalHeaders: stored.totalHeaders,
            },
          };
        }
      } catch (err) {
        console.warn(
          `[cursor-host] load_history storage fallback: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const genBefore = this.stateManager.generation;
    const scrollResult = await this.executor.scrollChatUp(commandId, times);
    if (!scrollResult.ok) return scrollResult;

    await waitForFreshExtraction(this.stateManager, genBefore, 6000);
    const countAfterScroll = this.stateManager.getCurrentState().messages.length;

    const bottomGen = this.stateManager.generation;
    await this.executor.scrollChatToBottom(`${commandId}-bottom`);
    await waitForFreshExtraction(this.stateManager, bottomGen, 3000);

    return {
      commandId,
      ok: true,
      data: {
        addedCount: Math.max(0, countAfterScroll - countBefore),
        totalCount: this.stateManager.getCurrentState().messages.length,
      },
    };
  }

  /** Escape hatch for Cursor-only commands the shared interface does not cover. */
  getExecutor(): CommandExecutor {
    return this.executor;
  }

  /** Explicit selector, else the one resolved from the extracted approval registry. */
  private approvalSelector(
    request: ChatApprovalRequest,
    action: 'approve' | 'approve_all' | 'reject',
  ): string | undefined {
    if (request.selectorPath) return request.selectorPath;
    if (!request.approvalId) return undefined;
    return resolveApprovalActionSelector(
      this.stateManager.getApprovalRegistry(),
      request.approvalId,
      action,
    );
  }

  private approvalGone(commandId: string): CommandResult {
    return { commandId, ok: false, error: 'Approval action no longer available' };
  }
}
