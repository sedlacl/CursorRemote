import type { CursorState } from '../../server/types.js';

const LIVE_AGENT_STATUSES = new Set<CursorState['agentStatus']>([
  'generating',
  'running_subagents',
  'running_tool',
  'thinking',
]);

function isLoadingEmptyTranscript(state: CursorState): boolean {
  return state.messages.length === 0
    && !!state.agentStatus
    && LIVE_AGENT_STATUSES.has(state.agentStatus);
}

export interface ConnectionUiState {
  status: 'connected' | 'reconnecting' | 'stale';
  label: string;
  emptyPrimary: string;
  emptyHint: string;
}

export function getConnectionUiState(state: CursorState, socketConnected: boolean): ConnectionUiState {
  const lastError = (state.lastExtractionError || '').trim();
  if (!socketConnected) {
    return {
      status: 'reconnecting',
      label: 'Connecting...',
      emptyPrimary: 'Relay disconnected.',
      emptyHint: 'Waiting for the CursorRemote server connection.',
    };
  }
  if (!state.connected) {
    return {
      status: 'reconnecting',
      label: 'Cursor disconnected',
      emptyPrimary: 'Cursor IDE is not connected.',
      emptyHint: 'Start Cursor with CDP enabled and keep the target window open.',
    };
  }
  if (state.extractorStatus === 'stale') {
    return {
      status: 'stale',
      label: 'Stale',
      emptyPrimary: 'No fresh Cursor state yet.',
      emptyHint: lastError ? `Last extractor error: ${lastError}` : 'Waiting for a fresh extraction.',
    };
  }
  if (isLoadingEmptyTranscript(state)) {
    return {
      status: 'connected',
      label: 'Connected',
      emptyPrimary: 'Loading transcript…',
      emptyHint: 'The agent is active but this chat transcript has not loaded yet. It should appear shortly.',
    };
  }
  return {
    status: 'connected',
    label: 'Connected',
    emptyPrimary: 'No messages in this chat yet.',
    emptyHint: 'Send a message below or switch chat tab / window in Cursor.',
  };
}
