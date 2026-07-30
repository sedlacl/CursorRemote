import React, { useEffect, useRef, useState } from 'react';
import type { CursorState } from '../../../server/types.js';
import { sendStopAgent } from '../../actions/stopActions.js';
import { useCommandClient } from '../../state/commandClient.js';
import type { HealthSnapshot } from '../../state/serverHealth.js';
import { useUiState } from '../../state/uiState.js';
import { getConnectionUiState } from '../../view-models/connectionState.js';
import { buildStopButtonState } from '../../view-models/stopState.js';
import { StopAgentButton } from './StopAgentButton.js';

export interface HeaderBarProps {
  state: CursorState;
  socketConnected: boolean;
  serverHealth: HealthSnapshot | null;
  sendPending: boolean;
}

export function HeaderBar({
  state,
  socketConnected,
  serverHealth,
  sendPending,
}: HeaderBarProps) {
  const ui = useUiState();
  const command = useCommandClient();
  const [stopPending, setStopPending] = useState(false);
  const [navigatePending, setNavigatePending] = useState(false);
  const lastKnownStopSelectorRef = useRef('');
  const connection = getConnectionUiState(state, socketConnected);
  const globalApprovals = state.globalApprovalNotifications ?? [];
  const primaryApproval = globalApprovals[0];
  const labels: Record<string, string> = {
    idle: 'Idle',
    thinking: 'Thinking...',
    generating: 'Generating...',
    running_tool: 'Running tool...',
    running_subagents: 'Subagents running...',
    waiting_approval: 'Needs approval',
    waiting_question: 'Needs an answer',
    waiting_user_input: 'Waiting for input',
    error: 'Error',
  };
  const activity = (state.agentActivityText || '').trim();
  const showActivity = state.agentActivityLive && activity && state.agentStatus !== 'idle';
  const suppressApprovalInRight = globalApprovals.length > 0
    || state.agentStatus === 'waiting_approval';
  const rawStatusText = showActivity
    ? (activity.length > 56 ? `${activity.slice(0, 55)}...` : activity)
    : (suppressApprovalInRight && state.agentStatus === 'waiting_approval'
      ? (labels.idle)
      : (labels[state.agentStatus] || state.agentStatus));
  const stopState = buildStopButtonState({
    state,
    sendPending,
    stopPending,
    lastKnownStopSelectorPath: lastKnownStopSelectorRef.current,
  });
  if (stopState.realStopAvailable && stopState.effectiveStopSelectorPath) {
    lastKnownStopSelectorRef.current = stopState.effectiveStopSelectorPath;
  }
  const stopEnabled = stopState.stopEnabled;
  const statusText = stopPending
    ? 'Stopping...'
    : navigatePending
      ? 'Opening approval...'
      : sendPending && !showActivity && state.agentStatus === 'idle'
        ? 'Sending...'
        : rawStatusText;
  const waitingForUser = (state.agentStatus === 'waiting_question' || state.agentStatus === 'waiting_user_input')
    || (state.agentStatus === 'waiting_approval' && globalApprovals.length === 0);
  const statusStyle = waitingForUser || globalApprovals.length > 0
    ? { color: 'var(--accent-yellow)' }
    : state.agentStatus === 'error'
      ? { color: 'var(--accent-red)' }
      : undefined;

  useEffect(() => {
    if (!stopPending) return;
    if (!stopState.realStopAvailable && !sendPending) {
      setStopPending(false);
      return;
    }
    const timer = window.setTimeout(() => setStopPending(false), 4000);
    return () => window.clearTimeout(timer);
  }, [sendPending, stopPending, stopState.realStopAvailable]);

  useEffect(() => {
    if (!navigatePending) return;
    const timer = window.setTimeout(() => setNavigatePending(false), 5000);
    return () => window.clearTimeout(timer);
  }, [navigatePending]);

  const handleStop = async () => {
    if (!stopEnabled) return;
    setStopPending(true);
    const result = await sendStopAgent(command);
    if (!result.ok) {
      setStopPending(false);
      ui.showToast(result.error || 'Stop failed', 'error');
    }
  };

  const handleNavigateApproval = async () => {
    if (!primaryApproval || navigatePending) return;
    setNavigatePending(true);
    const result = await command.sendCommandAwaitResult('command:navigate_to_approval', {
      approvalId: primaryApproval.id,
    });
    setNavigatePending(false);
    if (!result.ok) {
      ui.showToast(result.error || 'Could not open approval', 'error');
    }
  };

  const approvalSummary = primaryApproval
    ? `Needs approval · ${primaryApproval.chatTitle || primaryApproval.summary}`
    : '';
  const approvalCountLabel = globalApprovals.length > 1 ? ` (${globalApprovals.length})` : '';

  return (
    <header id="header">
      <div className="header-left">
        <span id="connection-dot" className={`dot ${connection.status}`} />
        <span id="connection-text">{connection.label}</span>
        {serverHealth?.server && (
          <button
            id="server-version-badge"
            type="button"
            className="server-version-badge"
            title="Open server debug panel"
            onClick={() => ui.openSheet('debug')}
          >
            v{serverHealth.server.version}:{serverHealth.server.port}
          </button>
        )}
      </div>
      {primaryApproval ? (
        <div className="header-center">
          <button
            id="global-approval-notification"
            type="button"
            className="global-approval-notification"
            aria-live="polite"
            aria-label={`${approvalSummary}${approvalCountLabel}. Open approval context.`}
            title={approvalSummary}
            disabled={navigatePending}
            onClick={() => void handleNavigateApproval()}
          >
            <span className="global-approval-notification-label">
              {approvalSummary}
              {approvalCountLabel}
            </span>
          </button>
        </div>
      ) : null}
      <div className="header-right">
        <span id="agent-status-icon">
          {waitingForUser ? '!' : state.agentStatus === 'error' ? 'x' : ''}
        </span>
        <span
          id="agent-status-text"
          className={!stopPending && !navigatePending && (showActivity || sendPending) ? 'agent-status-shimmer' : ''}
          style={statusStyle}
        >
          {statusText}
        </span>
        <StopAgentButton disabled={!stopEnabled} onStop={() => void handleStop()} />
      </div>
    </header>
  );
}
