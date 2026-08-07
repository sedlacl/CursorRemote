import React from 'react';
import type { Approval, CursorState } from '../../../server/types.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';

function isGarbageActionLabel(label: string): boolean {
  return !label || /^accept$/i.test(label.trim());
}

/** Approve-button labels — never show these as the shell command preview. */
function isApproveActionLabel(label: string): boolean {
  const norm = label.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(accept|approve|run|allow|accept all)$/i.test(norm);
}

function firstLocalApproval(state: CursorState): Approval | null {
  const { pendingApprovals = [], activeComposerId, activeWindowId } = state;
  return pendingApprovals.find((approval) => {
    if (activeComposerId && approval.composerId && approval.composerId !== activeComposerId) {
      return false;
    }
    if (activeWindowId && approval.windowId && approval.windowId !== activeWindowId) {
      return false;
    }
    return approval.actions?.some((action) => (
      action.type === 'approve' || action.type === 'approve_all' || action.type === 'reject'
    ) && !isGarbageActionLabel(action.label));
  }) || null;
}

function displayTitle(approval: Approval): string {
  const title = approval.title?.trim() || '';
  if (title && !isApproveActionLabel(title)) return title;
  const description = approval.description?.trim() || '';
  if (description && !isApproveActionLabel(description)) return description;
  return 'Command pending approval';
}

function displayCommand(approval: Approval): string {
  const command = approval.command?.trim() || '';
  if (command && !isApproveActionLabel(command)) return command;
  const description = approval.description?.trim() || '';
  if (
    description
    && description !== approval.title?.trim()
    && !isApproveActionLabel(description)
  ) {
    return description;
  }
  return '';
}

export function ApprovalBar({ state }: { state: CursorState }) {
  const command = useCommandClient();
  const ui = useUiState();
  const approval = firstLocalApproval(state);
  if (!approval) {
    return <div id="approval-bar" className="approval-bar hidden" aria-hidden="true" />;
  }

  const approve = approval.actions.find((action) => action.type === 'approve' || action.type === 'approve_all');
  const reject = approval.actions.find((action) => action.type === 'reject' && !isGarbageActionLabel(action.label));
  const title = displayTitle(approval);
  const commandText = displayCommand(approval);

  return (
    <div id="approval-bar" className="approval-bar" role="region" aria-label="Pending approval">
      <div className="approval-card">
        <div className="approval-card-header">
          <span className="approval-card-icon" aria-hidden="true">▸</span>
          <span id="approval-desc" className="approval-card-title">{title}</span>
          {approval.mode ? (
            <span className="approval-mode-badge">{approval.mode}</span>
          ) : null}
        </div>
        {commandText ? (
          <pre className="approval-command-block">
            <span className="approval-command-prompt">$ </span>
            {commandText}
          </pre>
        ) : null}
        {approval.reason ? (
          <p className="approval-reason-text">{approval.reason}</p>
        ) : null}
        <div className="approval-actions">
          <button
            id="btn-reject"
            className="btn btn-reject"
            disabled={!reject}
            aria-label={reject ? `${reject.label} approval` : 'Reject unavailable'}
            onClick={() => {
              if (!reject) return;
              command.emit('command:reject', { approvalId: approval.id });
              ui.showToast(`${reject.label} sent`, 'success');
            }}
          >
            {reject?.label || 'Skip'}
          </button>
          <button
            id="btn-approve"
            className="btn btn-approve"
            disabled={!approve}
            aria-label={approve ? `${approve.label} approval` : 'Approve unavailable'}
            onClick={() => {
              if (!approve) return;
              command.emit('command:approve', {
                approvalId: approval.id,
                actionType: approve.type,
              });
              ui.showToast(`${approve.label} sent`, 'success');
            }}
          >
            {approve?.label || 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
