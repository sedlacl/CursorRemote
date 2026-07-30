import { EventEmitter } from 'events';
import type { ChatElement, CursorState, CursorWindow, Approval, GlobalApprovalNotification } from './types.js';
import type { GitSnapshotPushPayload, GitStatusInfo, GitWindowSnapshot } from '../shared/extension-bridge.js';
import type { GitScmSnapshot } from '../shared/git-scm.js';
import type { GitSnapshotStoreDiagnostics } from '../shared/diagnostics.js';
import { AGENT_ACTIVITY_STALE_MS, BACKGROUND_TASKS_STALE_MS } from './activity-stale.js';
import { filterActionableApprovals } from './approval-filter.js';
import {
  enrichActiveWindowApprovals,
  filterContextLocalApprovals,
  type ResolvedApprovalTarget,
} from './approval-registry.js';
import { mergeMessages } from './message-history.js';
import { getHistoryScopeKey } from '../shared/history-scope.js';
import { ConversationRelationRegistry } from './conversation-relation-registry.js';
import { buildActiveConversationContext } from './conversation-context.js';

export function findGitSnapshotForTitle(
  windowTitle: string,
  snapshots: Map<string, GitWindowSnapshot>,
): GitWindowSnapshot | undefined {
  if (!windowTitle) return undefined;
  const exact = snapshots.get(windowTitle);
  if (exact) return exact;

  const normalizedTitle = windowTitle.toLowerCase();
  for (const [key, snapshot] of snapshots) {
    if (key.toLowerCase() === normalizedTitle) return snapshot;
  }

  const titleBase = windowTitle.split(' ')[0]?.toLowerCase();
  if (!titleBase) return undefined;
  for (const [key, snapshot] of snapshots) {
    const keyBase = key.split(' ')[0]?.toLowerCase();
    if (keyBase === titleBase) return snapshot;
  }
  return undefined;
}

export function resolveGitSnapshotForActiveWindow(
  activeWindowTitle: string | undefined,
  snapshots: Map<string, GitWindowSnapshot>,
): GitWindowSnapshot | undefined {
  if (activeWindowTitle) {
    const matched = findGitSnapshotForTitle(activeWindowTitle, snapshots);
    if (matched) return matched;
  }

  if (snapshots.size === 1) {
    return snapshots.values().next().value;
  }

  return undefined;
}

function emptyState(): CursorState {
  return {
    connected: false,
    extractorStatus: 'idle',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    globalApprovalNotifications: [],
    inputAvailable: false,
    composerInputAvailable: false,
    activeConversationContext: null,
    chatTabs: [],
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
    backgroundTasks: [],
    subagents: { runningCount: 0, summary: '', items: [] },
    agentChanges: {
      fileCount: 0,
      reviewAvailable: false,
      undoAllAvailable: false,
    },
    gitStatus: null,
    gitScm: null,
    agentStopSelectorPath: '',
    agentStopAvailable: false,
    agentStopSource: 'none',
    exploratoryUi: null,
  };
}

export class StateManager extends EventEmitter {
  private currentState: CursorState = emptyState();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Partial<CursorState> | null = null;
  private debounceMs: number;
  private consecutiveNulls = 0;
  private readonly nullWarningThreshold = 10;
  private _generation = 0;
  /** When the current activity string first appeared (unchanged since). */
  private activityStableSince: number | null = null;
  private activityStableText: string | undefined = undefined;
  /**
   * After staleness clears `agentActivityText`, the DOM often keeps sending the same
   * string every poll; suppress that exact label until it changes or clears (Telegram
   * does not re-post activity when the snapshot is otherwise unchanged).
   */
  private activitySuppressedMatch: string | undefined = undefined;
  private backgroundTasksLastSeen: CursorState['backgroundTasks'] = [];
  private backgroundTasksLastSeenAt = 0;
  private historyScope = '';
  private messageHistory: ChatElement[] = [];
  private gitWindowSnapshots = new Map<string, GitWindowSnapshot>();
  private activeGitWindowKey: string | null = null;
  private lastGitPushAt: number | null = null;
  private lastGitPushWindowKey: string | null = null;
  private approvalRegistry = new Map<string, ResolvedApprovalTarget>();
  private lastWindowApprovals: Approval[] = [];
  private readonly conversationRegistry = new ConversationRelationRegistry();

  getConversationRegistry(): ConversationRelationRegistry {
    return this.conversationRegistry;
  }

  refreshConversationContextPatch(): void {
    const context = buildActiveConversationContext(this.currentState, this.conversationRegistry);
    const prev = this.currentState.activeConversationContext;
    if (JSON.stringify(prev) === JSON.stringify(context)) return;
    this.currentState = {
      ...this.currentState,
      activeConversationContext: context,
    };
    this.emit('state:patch', { activeConversationContext: context });
  }

  getLastWindowApprovals(): Approval[] {
    return this.lastWindowApprovals;
  }

  getApprovalRegistry(): ReadonlyMap<string, ResolvedApprovalTarget> {
    return this.approvalRegistry;
  }

  setGlobalApprovals(
    notifications: GlobalApprovalNotification[],
    registry: Map<string, ResolvedApprovalTarget>,
  ): void {
    this.approvalRegistry = new Map(registry);
    const prev = this.currentState.globalApprovalNotifications ?? [];
    if (JSON.stringify(prev) === JSON.stringify(notifications)) return;
    this.currentState = {
      ...this.currentState,
      globalApprovalNotifications: notifications,
    };
    this.emit('state:patch', { globalApprovalNotifications: notifications });
  }

  get generation(): number {
    return this._generation;
  }

  historyScopeKey(): string {
    return getHistoryScopeKey(this.currentState);
  }

  constructor(debounceMs: number) {
    super();
    this.debounceMs = debounceMs;
  }

  getCurrentState(): CursorState {
    return this.currentState;
  }

  mergeStoredHistory(messages: ChatElement[]): { addedCount: number; totalCount: number } {
    if (messages.length === 0) {
      return { addedCount: 0, totalCount: this.currentState.messages.length };
    }

    const beforeIds = new Set(this.currentState.messages.map((message) => message.id));
    const merged = mergeMessages(messages, this.currentState.messages);
    const addedCount = merged.reduce(
      (count, message) => count + (beforeIds.has(message.id) ? 0 : 1),
      0
    );

    if (addedCount === 0 && merged.length === this.currentState.messages.length) {
      return { addedCount: 0, totalCount: this.currentState.messages.length };
    }

    this.messageHistory = merged;
    this.currentState = { ...this.currentState, messages: merged };
    this.emit('state:patch', { messages: merged });
    return { addedCount, totalCount: merged.length };
  }

  /**
   * Called by the DOM extractor on each poll cycle.
   * Diffs against previous state and emits patches.
   */
  onExtraction(newState: CursorState | null): void {
    if (newState === null) {
      this.onExtractionFailure('Extraction returned null');
      return;
    }

    this.consecutiveNulls = 0;
    this._generation++;
    // Preserve bridge-managed fields that the DOM extractor should not own.
    const now = Date.now();
    newState.connected = this.currentState.connected;
    newState.extractorStatus = this.currentState.connected ? 'ok' : 'idle';
    newState.lastExtractionAt = now;
    newState.consecutiveExtractionFailures = 0;
    newState.lastExtractionError = null;
    newState.windows = this.currentState.windows;
    newState.activeWindowId = this.currentState.activeWindowId;
    newState.gitStatus = this.currentState.gitStatus;
    newState.gitScm = this.currentState.gitScm;
    newState.subagents ??= { runningCount: 0, summary: '', items: [] };
    newState.agentChanges ??= {
      fileCount: 0,
      reviewAvailable: false,
      undoAllAvailable: false,
    };
    newState.pendingApprovals = filterActionableApprovals(newState.pendingApprovals);
    const activeWindow = newState.windows.find((w) => w.id === newState.activeWindowId);
    const enrichedApprovals = enrichActiveWindowApprovals(
      newState.pendingApprovals,
      newState.activeWindowId,
      activeWindow?.title ?? '',
      newState.activeComposerId,
      newState.chatTabs,
    );
    this.lastWindowApprovals = enrichedApprovals;

    const historyScope = getHistoryScopeKey(newState);
    const scopeChanged = historyScope !== this.historyScope;
    if (scopeChanged) {
      this.historyScope = historyScope;
      this.messageHistory = newState.messages.slice();
      newState.pendingApprovals = filterContextLocalApprovals(
        enrichedApprovals,
        newState.activeWindowId,
        newState.activeComposerId,
      );
    } else {
      newState.pendingApprovals = filterContextLocalApprovals(
        enrichedApprovals,
        newState.activeWindowId,
        newState.activeComposerId,
      );
    }

    if (newState.pendingApprovals.length === 0 && newState.agentStatus === 'waiting_approval') {
      newState.agentStatus = newState.questionnaire ? 'waiting_question' : 'idle';
    }

    if (!scopeChanged) {
      this.messageHistory = mergeMessages(this.messageHistory, newState.messages);
    }
    newState.messages = this.messageHistory;
    newState.globalApprovalNotifications = this.currentState.globalApprovalNotifications ?? [];

    const stateForApply = this.applyBackgroundTaskStaleness(
      this.applyActivityStaleness(this.enrichConversationContext(newState)),
    );

    const patch = this.diff(this.currentState, stateForApply);
    if (!patch) return;

    this.currentState = stateForApply;
    this.schedulePatch(patch);
  }

  onExtractionFailure(message: string | null): void {
    this.consecutiveNulls++;
    if (this.consecutiveNulls === this.nullWarningThreshold) {
      console.warn(
        `[state-manager] ${this.nullWarningThreshold} consecutive failed extractions. ` +
        'Selectors may need updating or the Cursor window may be background-throttled.'
      );
    }

    const connected = this.currentState.connected;
    const nextState: CursorState = {
      ...this.currentState,
      extractorStatus:
        connected && this.currentState.lastExtractionAt != null ? 'stale' : connected ? 'waiting' : 'idle',
      consecutiveExtractionFailures: this.currentState.consecutiveExtractionFailures + 1,
      lastExtractionError: message,
    };

    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.schedulePatch(patch);
  }

  private enrichConversationContext(newState: CursorState): CursorState {
    newState.composerInputAvailable = newState.composerInputAvailable ?? newState.inputAvailable;
    return {
      ...newState,
      activeConversationContext: buildActiveConversationContext(newState, this.conversationRegistry),
    };
  }

  /**
   * Drop `agentActivityText` after AGENT_ACTIVITY_STALE_MS with no text change
   * (same semantics as Telegram's ephemeral activity deletion) so the web header
   * does not show "Thinking" forever when Telegram has already removed the line.
   */
  private applyActivityStaleness(newState: CursorState): CursorState {
    if (newState.agentActivitySource === 'subagents' && newState.subagents.runningCount > 0) {
      this.activityStableSince = null;
      this.activityStableText = undefined;
      this.activitySuppressedMatch = undefined;
      return newState;
    }

    const text = newState.agentActivityText?.trim()
      ? newState.agentActivityText.trim()
      : null;

    if (!text) {
      this.activityStableSince = null;
      this.activityStableText = undefined;
      this.activitySuppressedMatch = undefined;
      if (newState.agentActivityText === null || newState.agentActivityText === '') {
        return newState;
      }
      return {
        ...newState,
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (
      this.activitySuppressedMatch != null &&
      text === this.activitySuppressedMatch
    ) {
      return {
        ...newState,
        agentStatus:
          newState.agentStatus === 'waiting_approval'
          || newState.agentStatus === 'waiting_question'
          || newState.agentStatus === 'waiting_user_input'
          || newState.agentStatus === 'error'
            ? newState.agentStatus
            : 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (this.activitySuppressedMatch != null && text !== this.activitySuppressedMatch) {
      this.activitySuppressedMatch = undefined;
    }

    const now = Date.now();
    if (text === this.activityStableText && this.activityStableSince != null) {
      if (now - this.activityStableSince >= AGENT_ACTIVITY_STALE_MS) {
        this.activityStableSince = null;
        this.activityStableText = undefined;
        this.activitySuppressedMatch = text;
        return {
          ...newState,
          agentStatus:
            newState.agentStatus === 'waiting_approval'
            || newState.agentStatus === 'waiting_question'
            || newState.agentStatus === 'waiting_user_input'
            || newState.agentStatus === 'error'
              ? newState.agentStatus
              : 'idle',
          agentActivityText: null,
          agentActivityLive: false,
          agentActivitySource: 'none',
        };
      }
      return newState;
    }

    this.activityStableText = text;
    this.activityStableSince = now;
    return newState;
  }

  private applyBackgroundTaskStaleness(newState: CursorState): CursorState {
    const nextTasks = newState.backgroundTasks || [];
    if (nextTasks.length > 0) {
      this.backgroundTasksLastSeen = nextTasks;
      this.backgroundTasksLastSeenAt = Date.now();
      return newState;
    }

    if (this.backgroundTasksLastSeen.length === 0) {
      return newState;
    }

    const agentBusy =
      newState.agentStatus === 'generating' ||
      newState.agentStatus === 'running_tool' ||
      newState.agentStatus === 'thinking' ||
      newState.agentStatus === 'running_subagents';
    const withinHold = Date.now() - this.backgroundTasksLastSeenAt < BACKGROUND_TASKS_STALE_MS;
    if (agentBusy && withinHold) {
      return { ...newState, backgroundTasks: this.backgroundTasksLastSeen };
    }

    this.backgroundTasksLastSeen = [];
    this.backgroundTasksLastSeenAt = 0;
    return newState;
  }

  onConnectionChanged(connected: boolean): void {
    const nextState: CursorState = {
      ...this.currentState,
      connected,
      extractorStatus: connected ? 'waiting' : 'idle',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
    };
    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.emit('state:patch', patch);
    this.emit('connection:changed', connected);
  }

  updateWindows(windows: CursorWindow[], activeWindowId: string): void {
    const windowsChanged = JSON.stringify(this.currentState.windows) !== JSON.stringify(windows);
    const activeChanged = this.currentState.activeWindowId !== activeWindowId;
    if (!windowsChanged && !activeChanged) return;

    this.currentState = { ...this.currentState, windows, activeWindowId };
    const gitPatch = this.syncGitStatusForActiveWindow();
    const patch: Partial<CursorState> = { windows, activeWindowId };
    if (gitPatch?.gitStatus !== undefined) patch.gitStatus = gitPatch.gitStatus;
    if (gitPatch?.gitScm !== undefined) patch.gitScm = gitPatch.gitScm;
    this.emit('state:patch', patch);
  }

  /** Push per-window mode/model into global state (e.g. from a cached snapshot on window switch). */
  updateModeModel(mode: CursorState['mode'], model: CursorState['model']): void {
    const modeChanged = this.currentState.mode?.current !== mode?.current;
    const modelChanged = this.currentState.model?.current !== model?.current
      || this.currentState.model?.currentId !== model?.currentId;
    if (!modeChanged && !modelChanged) return;
    const patch: Partial<CursorState> = {};
    if (modeChanged) patch.mode = mode;
    if (modelChanged) patch.model = model;
    this.currentState = { ...this.currentState, ...patch };
    this.emit('state:patch', patch);
  }

  updateGitStatus(gitStatus: GitStatusInfo | null): void {
    if (JSON.stringify(this.currentState.gitStatus) === JSON.stringify(gitStatus)) return;
    this.currentState = { ...this.currentState, gitStatus };
    this.emit('state:patch', { gitStatus });
  }

  upsertGitWindowSnapshot(payload: GitSnapshotPushPayload): GitStatusInfo | null {
    const snapshot: GitWindowSnapshot = {
      windowKey: payload.windowKey,
      gitStatus: { ...payload.gitStatus, windowKey: payload.windowKey },
      repoBreakdown: payload.repoBreakdown,
      gitScm: payload.gitScm ?? null,
      updatedAt: payload.updatedAt,
      extensionInstanceId: payload.extensionInstanceId,
    };
    this.gitWindowSnapshots.set(payload.windowKey, snapshot);
    this.lastGitPushAt = Date.now();
    this.lastGitPushWindowKey = payload.windowKey;
    const syncResult = this.syncGitStatusForActiveWindow();
    if (syncResult) {
      const patch: Partial<CursorState> = {};
      if (syncResult.gitStatus !== undefined) patch.gitStatus = syncResult.gitStatus;
      if (syncResult.gitScm !== undefined) patch.gitScm = syncResult.gitScm;
      if (Object.keys(patch).length > 0) {
        this.emit('state:patch', patch);
      }
    }
    return syncResult?.gitStatus ?? null;
  }

  getActiveGitScmSnapshot(): GitScmSnapshot | null {
    return this.pickGitSnapshotForActiveWindow()?.gitScm ?? null;
  }

  getGitSnapshotDiagnostics(activeWindowTitle: string | null): GitSnapshotStoreDiagnostics {
    const windowSnapshots: GitSnapshotStoreDiagnostics['windowSnapshots'] = {};
    for (const [key, snapshot] of this.gitWindowSnapshots) {
      windowSnapshots[key] = {
        windowKey: snapshot.windowKey,
        changedCount: snapshot.gitStatus.changedCount,
        repoLabel: snapshot.gitStatus.repoLabel,
        updatedAt: snapshot.updatedAt,
        repoBreakdown: snapshot.repoBreakdown,
      };
    }
    return {
      activeWindowKey: this.activeGitWindowKey,
      activeWindowTitle,
      lastPushAt: this.lastGitPushAt,
      lastPushWindowKey: this.lastGitPushWindowKey,
      windowSnapshots,
    };
  }

  /** Reconcile gitStatus from stored window snapshots (e.g. before state:full on socket connect). */
  hydrateGitStatus(): void {
    this.syncGitStatusForActiveWindow();
  }

  private pickGitSnapshotForActiveWindow(): GitWindowSnapshot | undefined {
    const activeWindow = this.currentState.windows.find(
      window => window.id === this.currentState.activeWindowId,
    );
    let snapshot = resolveGitSnapshotForActiveWindow(
      activeWindow?.title,
      this.gitWindowSnapshots,
    );
    if (!snapshot && this.lastGitPushWindowKey) {
      snapshot = this.gitWindowSnapshots.get(this.lastGitPushWindowKey);
    }
    if (!snapshot && this.activeGitWindowKey) {
      snapshot = this.gitWindowSnapshots.get(this.activeGitWindowKey);
    }
    return snapshot;
  }

  private syncGitStatusForActiveWindow(): {
    gitStatus: GitStatusInfo | null | undefined;
    gitScm: GitScmSnapshot | null | undefined;
  } | undefined {
    const snapshot = this.pickGitSnapshotForActiveWindow();
    if (snapshot) {
      this.activeGitWindowKey = snapshot.windowKey;
      const nextGitStatus = snapshot.gitStatus;
      const nextGitScm = snapshot.gitScm ?? null;
      const statusSame = JSON.stringify(this.currentState.gitStatus) === JSON.stringify(nextGitStatus);
      const scmSame = JSON.stringify(this.currentState.gitScm) === JSON.stringify(nextGitScm);
      if (statusSame && scmSame) {
        return undefined;
      }
      this.currentState = {
        ...this.currentState,
        gitStatus: nextGitStatus,
        gitScm: nextGitScm,
      };
      return {
        gitStatus: statusSame ? undefined : nextGitStatus,
        gitScm: scmSame ? undefined : nextGitScm,
      };
    }

    this.activeGitWindowKey = null;
    if (this.currentState.gitStatus !== null && this.gitWindowSnapshots.size > 0) {
      return undefined;
    }
    const statusChanged = this.currentState.gitStatus !== null;
    const scmChanged = this.currentState.gitScm !== null;
    if (!statusChanged && !scmChanged) {
      return undefined;
    }
    this.currentState = {
      ...this.currentState,
      gitStatus: null,
      gitScm: null,
    };
    return {
      gitStatus: statusChanged ? null : undefined,
      gitScm: scmChanged ? null : undefined,
    };
  }

  private diff(
    prev: CursorState,
    next: CursorState
  ): Partial<CursorState> | null {
    const patch: Partial<CursorState> = {};
    let hasChange = false;

    if (prev.connected !== next.connected) {
      patch.connected = next.connected;
      hasChange = true;
    }

    if (prev.extractorStatus !== next.extractorStatus) {
      patch.extractorStatus = next.extractorStatus;
      hasChange = true;
    }

    if (prev.lastExtractionAt !== next.lastExtractionAt) {
      patch.lastExtractionAt = next.lastExtractionAt;
      hasChange = true;
    }

    if (prev.consecutiveExtractionFailures !== next.consecutiveExtractionFailures) {
      patch.consecutiveExtractionFailures = next.consecutiveExtractionFailures;
      hasChange = true;
    }

    if (prev.lastExtractionError !== next.lastExtractionError) {
      patch.lastExtractionError = next.lastExtractionError;
      hasChange = true;
    }

    if (prev.agentStatus !== next.agentStatus) {
      patch.agentStatus = next.agentStatus;
      hasChange = true;
    }

    if (prev.agentActivityText !== next.agentActivityText) {
      patch.agentActivityText = next.agentActivityText;
      hasChange = true;
    }

    if (prev.agentActivityLive !== next.agentActivityLive) {
      patch.agentActivityLive = next.agentActivityLive;
      hasChange = true;
    }

    if (prev.agentActivitySource !== next.agentActivitySource) {
      patch.agentActivitySource = next.agentActivitySource;
      hasChange = true;
    }

    if (prev.inputAvailable !== next.inputAvailable) {
      patch.inputAvailable = next.inputAvailable;
      hasChange = true;
    }

    if (prev.composerInputAvailable !== next.composerInputAvailable) {
      patch.composerInputAvailable = next.composerInputAvailable;
      hasChange = true;
    }

    if (JSON.stringify(prev.activeConversationContext) !== JSON.stringify(next.activeConversationContext)) {
      patch.activeConversationContext = next.activeConversationContext;
      hasChange = true;
    }

    if (JSON.stringify(prev.messages) !== JSON.stringify(next.messages)) {
      patch.messages = next.messages;
      hasChange = true;
    }

    if (JSON.stringify(prev.pendingApprovals) !== JSON.stringify(next.pendingApprovals)) {
      patch.pendingApprovals = next.pendingApprovals;
      hasChange = true;
    }

    if (JSON.stringify(prev.globalApprovalNotifications) !== JSON.stringify(next.globalApprovalNotifications)) {
      patch.globalApprovalNotifications = next.globalApprovalNotifications;
      hasChange = true;
    }

    if (JSON.stringify(prev.chatTabs) !== JSON.stringify(next.chatTabs)) {
      patch.chatTabs = next.chatTabs;
      hasChange = true;
    }

    if (prev.activeComposerId !== next.activeComposerId) {
      patch.activeComposerId = next.activeComposerId;
      hasChange = true;
    }

    if (JSON.stringify(prev.mode) !== JSON.stringify(next.mode)) {
      patch.mode = next.mode;
      hasChange = true;
    }

    if (JSON.stringify(prev.model) !== JSON.stringify(next.model)) {
      patch.model = next.model;
      hasChange = true;
    }

    if (JSON.stringify(prev.windows) !== JSON.stringify(next.windows)) {
      patch.windows = next.windows;
      hasChange = true;
    }

    if (prev.activeWindowId !== next.activeWindowId) {
      patch.activeWindowId = next.activeWindowId;
      hasChange = true;
    }

    if (JSON.stringify(prev.composerQueue) !== JSON.stringify(next.composerQueue)) {
      patch.composerQueue = next.composerQueue;
      hasChange = true;
    }

    if (JSON.stringify(prev.questionnaire) !== JSON.stringify(next.questionnaire)) {
      patch.questionnaire = next.questionnaire;
      hasChange = true;
    }

    if (JSON.stringify(prev.backgroundTasks) !== JSON.stringify(next.backgroundTasks)) {
      patch.backgroundTasks = next.backgroundTasks;
      hasChange = true;
    }

    if (JSON.stringify(prev.subagents) !== JSON.stringify(next.subagents)) {
      patch.subagents = next.subagents;
      hasChange = true;
    }

    if (JSON.stringify(prev.agentChanges) !== JSON.stringify(next.agentChanges)) {
      patch.agentChanges = next.agentChanges;
      hasChange = true;
    }

    if (JSON.stringify(prev.gitStatus) !== JSON.stringify(next.gitStatus)) {
      patch.gitStatus = next.gitStatus;
      hasChange = true;
    }

    if (JSON.stringify(prev.gitScm) !== JSON.stringify(next.gitScm)) {
      patch.gitScm = next.gitScm;
      hasChange = true;
    }

    if (prev.agentStopSelectorPath !== next.agentStopSelectorPath) {
      patch.agentStopSelectorPath = next.agentStopSelectorPath;
      hasChange = true;
    }

    if (prev.agentStopAvailable !== next.agentStopAvailable) {
      patch.agentStopAvailable = next.agentStopAvailable;
      hasChange = true;
    }

    if (prev.agentStopSource !== next.agentStopSource) {
      patch.agentStopSource = next.agentStopSource;
      hasChange = true;
    }

    if (JSON.stringify(prev.exploratoryUi) !== JSON.stringify(next.exploratoryUi)) {
      patch.exploratoryUi = next.exploratoryUi;
      hasChange = true;
    }

    return hasChange ? patch : null;
  }

  private schedulePatch(patch: Partial<CursorState>): void {
    this.pendingPatch = this.pendingPatch
      ? { ...this.pendingPatch, ...patch }
      : patch;

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingPatch) {
          this.emit('state:patch', this.pendingPatch);
          this.pendingPatch = null;
        }
      }, this.debounceMs);
    }
  }
}
