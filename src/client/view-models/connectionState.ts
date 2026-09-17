import type { CursorState } from '../../server/types.js';
import { describeCdpFailure } from '../../shared/cdp-status.js';

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
  showRestartCursorCdp: boolean;
}

export function getConnectionUiState(state: CursorState, socketConnected: boolean): ConnectionUiState {
  const lastError = (state.lastExtractionError || '').trim();
  if (!socketConnected) {
    return {
      status: 'reconnecting',
      label: 'Connecting...',
      emptyPrimary: 'Relay disconnected.',
      emptyHint: 'Waiting for the CursorRemote server connection.',
      showRestartCursorCdp: false,
    };
  }
  if (!state.connected) {
    const hint = describeCdpFailure(state.cdpDisconnectReason, state.cdpUrl || '', state.cdpLastError);
    const labels: Record<string, string> = {
      unavailable: 'CDP unavailable',
      wrong_port: 'Wrong CDP port',
      no_target: 'No Cursor window',
      connect_error: 'CDP connect error',
    };
    const label = state.cdpDisconnectReason
      ? labels[state.cdpDisconnectReason] ?? 'Cursor disconnected'
      : 'Cursor disconnected';
    return {
      status: 'reconnecting',
      label,
      emptyPrimary: 'Cursor IDE is not connected.',
      emptyHint: hint,
      showRestartCursorCdp: true,
    };
  }
  if (state.extractorStatus === 'stale') {
    return {
      status: 'stale',
      label: 'Stale',
      emptyPrimary: 'No fresh Cursor state yet.',
      emptyHint: lastError ? `Last extractor error: ${lastError}` : 'Waiting for a fresh extraction.',
      showRestartCursorCdp: false,
    };
  }
  if (isLoadingEmptyTranscript(state)) {
    return {
      status: 'connected',
      label: 'Connected',
      emptyPrimary: 'Loading transcript…',
      emptyHint: 'The agent is active but this chat transcript has not loaded yet. It should appear shortly.',
      showRestartCursorCdp: false,
    };
  }
  return {
    status: 'connected',
    label: 'Connected',
    emptyPrimary: 'No messages in this chat yet.',
    emptyHint: 'Send a message below or switch chat tab / window in Cursor.',
    showRestartCursorCdp: false,
  };
}
