import React, { useCallback, useState } from 'react';
import type { AgentChangesState, SubagentItem, SubagentState } from '../../../server/types.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';

export interface MultitaskStatusStripProps {
  subagents?: SubagentState;
  agentChanges?: AgentChangesState;
}

/** Safe header Stop target: exactly one running item with stop capability. */
export function resolveHeaderStopTarget(subagents?: SubagentState): SubagentItem | null {
  const workers = subagents?.items || [];
  const runningStoppable = workers.filter(
    worker => worker.status === 'running' && worker.stopAvailable,
  );
  if (runningStoppable.length !== 1) return null;
  return runningStoppable[0] ?? null;
}

export function MultitaskStatusStrip({ subagents, agentChanges }: MultitaskStatusStripProps) {
  const command = useCommandClient();
  const ui = useUiState();
  const [pendingOpenId, setPendingOpenId] = useState('');
  const [pendingStopId, setPendingStopId] = useState('');
  const workers = subagents?.items || [];
  const hasSubagents = (subagents?.runningCount || 0) > 0 || workers.length > 0;
  const headerStopTarget = resolveHeaderStopTarget(subagents);
  const headerStopping = headerStopTarget ? pendingStopId === headerStopTarget.id : false;
  const hasChanges = (agentChanges?.fileCount || 0) > 0
    || !!agentChanges?.reviewAvailable
    || !!agentChanges?.undoAllAvailable;

  const clickAction = (selectorPath: string | undefined) => {
    if (selectorPath) command.emit('command:click_action', { selectorPath });
  };

  const openSubagent = useCallback(async (subagentId: string, title: string) => {
    setPendingOpenId(subagentId);
    try {
      const result = await command.sendCommandAwaitResult('command:open_subagent', { subagentId });
      if (!result.ok) {
        ui.showToast(result.error || `Could not open ${title}`, 'error');
      }
    } finally {
      setPendingOpenId('');
    }
  }, [command, ui]);

  const stopSubagent = useCallback(async (subagentId: string, title: string) => {
    const confirmed = window.confirm(`Stop subagent "${title}"?`);
    if (!confirmed) return;
    setPendingStopId(subagentId);
    try {
      const result = await command.sendCommandAwaitResult('command:stop_subagent', { subagentId });
      if (!result.ok) {
        ui.showToast(result.error || `Could not stop ${title}`, 'error');
      } else {
        ui.showToast(`Stop sent for ${title}`, 'success');
      }
    } finally {
      setPendingStopId('');
    }
  }, [command, ui]);

  if (!hasSubagents && !hasChanges) return null;

  return (
    <section className="multitask-strip" aria-label="Multitask activity" aria-live="polite">
      {hasSubagents && (
        <div className="multitask-section">
          <div className="multitask-section-header">
            <div className="multitask-section-header-main">
              <span className={`multitask-running-dot ${(subagents?.runningCount || 0) > 0 ? 'is-running' : ''}`} />
              <span className="multitask-section-summary">
                {subagents?.summary || `${workers.length} subagent${workers.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {headerStopTarget && (
              <button
                type="button"
                className="multitask-header-stop-btn"
                aria-label={`Stop ${headerStopTarget.title}`}
                disabled={headerStopping || pendingOpenId === headerStopTarget.id}
                onClick={(event) => {
                  event.stopPropagation();
                  void stopSubagent(headerStopTarget.id, headerStopTarget.title);
                }}
              >
                {headerStopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
          <div className="subagent-list">
            {workers.slice(0, 4).map(worker => {
              const opening = pendingOpenId === worker.id;
              const stopping = pendingStopId === worker.id;
              return (
                <div className={`subagent-row subagent-${worker.status}`} key={worker.id}>
                  {worker.openAvailable ? (
                    <button
                      type="button"
                      className="subagent-open-btn"
                      aria-label={`Open ${worker.title}`}
                      disabled={opening || stopping}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openSubagent(worker.id, worker.title);
                      }}
                    >
                      {opening ? 'Opening…' : worker.title}
                    </button>
                  ) : (
                    <span className="subagent-title">{worker.title}</span>
                  )}
                  {worker.model && <span className="subagent-model">{worker.model}</span>}
                  <span className="subagent-status">{worker.statusText || worker.status}</span>
                  {worker.stopAvailable && (
                    <button
                      type="button"
                      className="subagent-stop-btn"
                      aria-label={`Stop ${worker.title}`}
                      disabled={opening || stopping}
                      onClick={(event) => {
                        event.stopPropagation();
                        void stopSubagent(worker.id, worker.title);
                      }}
                    >
                      {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  )}
                </div>
              );
            })}
            {workers.length > 4 && <div className="subagent-more">+{workers.length - 4} more</div>}
          </div>
        </div>
      )}
      {hasChanges && (
        <div className="agent-changes-section">
          <span className="agent-changes-count">
            {agentChanges?.fileCount || 0} changed file{agentChanges?.fileCount === 1 ? '' : 's'}
          </span>
          <div className="agent-changes-actions">
            {agentChanges?.undoAllAvailable && (
              <button
                type="button"
                className="agent-change-btn agent-change-undo"
                disabled={!agentChanges.undoAllSelectorPath}
                onClick={() => clickAction(agentChanges.undoAllSelectorPath)}
              >
                Undo all
              </button>
            )}
            {agentChanges?.reviewAvailable && (
              <button
                type="button"
                className="agent-change-btn agent-change-review"
                disabled={!agentChanges.reviewSelectorPath}
                onClick={() => clickAction(agentChanges.reviewSelectorPath)}
              >
                Review
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
