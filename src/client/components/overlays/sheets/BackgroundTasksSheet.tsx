import React, { useEffect, useRef, useState } from 'react';
import type { CursorState } from '../../../../server/types.js';
import { clickSheetAction } from '../../../actions/sheetActions.js';
import { useCommandClient } from '../../../state/commandClient.js';
import { useUiState } from '../../../state/uiState.js';
import {
  getBackgroundTasksSheetModel,
  getVisibleBackgroundTasks,
} from '../../../view-models/backgroundTasks.js';

export interface BackgroundTasksSheetProps {
  state: CursorState;
  visible: boolean;
}

const EXPAND_RETRY_MS = 700;
const EXPAND_GIVE_UP_MS = 2500;

export function BackgroundTasksSheet({ state, visible }: BackgroundTasksSheetProps) {
  const ui = useUiState();
  const command = useCommandClient();
  const { rows, summaryCount, expandSelectorPath, incomplete } =
    getBackgroundTasksSheetModel(getVisibleBackgroundTasks(state));

  const [expandGaveUp, setExpandGaveUp] = useState(false);
  const retriedPathRef = useRef<string | null>(null);
  const awaitingExpand = visible && incomplete && !!expandSelectorPath;

  useEffect(() => {
    if (!visible) {
      setExpandGaveUp(false);
      retriedPathRef.current = null;
      return;
    }
    if (!awaitingExpand || !expandSelectorPath) {
      setExpandGaveUp(false);
      return;
    }

    const retryTimer = setTimeout(() => {
      if (retriedPathRef.current === expandSelectorPath) return;
      retriedPathRef.current = expandSelectorPath;
      clickSheetAction(command, expandSelectorPath);
    }, EXPAND_RETRY_MS);
    const giveUpTimer = setTimeout(() => setExpandGaveUp(true), EXPAND_GIVE_UP_MS);

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(giveUpTimer);
    };
  }, [awaitingExpand, command, expandSelectorPath, visible]);

  const missingCount = Math.max(summaryCount - rows.length, 0);
  const showEmptyHint = rows.length === 0 && summaryCount === 0;

  return (
    <div id="sheet-background-tasks" className={`bottom-sheet ${visible ? '' : 'hidden'}`}>
      <div className="sheet-header">Active Background Jobs</div>
      <div id="sheet-background-tasks-list" className="sheet-list">
        {showEmptyHint && <p className="sheet-tab-hint">No active background jobs.</p>}
        {rows.map((task, index) => (
          <div key={task.id || index} className="background-task-sheet-item">
            <div className="background-task-sheet-main">
              <div className="background-task-sheet-title">{task.label || `Background task ${index + 1}`}</div>
              {task.detail && <div className="background-task-sheet-detail">{task.detail}</div>}
            </div>
            {task.stopSelectorPath ? (
              <button
                type="button"
                className="background-task-stop"
                onClick={() => {
                  clickSheetAction(command, task.stopSelectorPath);
                  ui.closeSheet();
                  ui.showToast('Stop sent', 'success');
                }}
              >
                Stop
              </button>
            ) : (
              <span className="background-task-no-action">No stop</span>
            )}
          </div>
        ))}
        {incomplete && (
          <p className="sheet-tab-hint">
            {expandGaveUp || !expandSelectorPath
              ? `Cursor reports ${summaryCount} job${summaryCount === 1 ? '' : 's'} but keeps ${missingCount} collapsed — expand the job list in Cursor to control ${missingCount === 1 ? 'it' : 'them'}.`
              : `Collapsed in Cursor — expanding ${missingCount} more job${missingCount === 1 ? '' : 's'}…`}
          </p>
        )}
      </div>
    </div>
  );
}
