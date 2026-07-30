import { createContext, useContext } from 'react';
import type { CursorState } from '../../server/types.js';

export const defaultCursorState: CursorState = {
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

export const RemoteStateContext = createContext<CursorState>(defaultCursorState);

export function useRemoteState(): CursorState {
  return useContext(RemoteStateContext);
}

export function mergeCursorPatch(state: CursorState, patch: Partial<CursorState>): CursorState {
  return { ...state, ...patch };
}
