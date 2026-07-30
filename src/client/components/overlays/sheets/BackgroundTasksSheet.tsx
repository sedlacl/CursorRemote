import React from 'react';
import type { CursorState } from '../../../../server/types.js';
import { clickSheetAction } from '../../../actions/sheetActions.js';
import { useCommandClient } from '../../../state/commandClient.js';
import { useUiState } from '../../../state/uiState.js';
import {
  getBackgroundTasksForSheet,
  getVisibleBackgroundTasks,
} from '../../../view-models/backgroundTasks.js';

export interface BackgroundTasksSheetProps {
  state: CursorState;
  visible: boolean;
}

export function BackgroundTasksSheet({ state, visible }: BackgroundTasksSheetProps) {
  const ui = useUiState();
  const command = useCommandClient();
  const tasks = getBackgroundTasksForSheet(getVisibleBackgroundTasks(state));
  return (
    <div id="sheet-background-tasks" className={`bottom-sheet ${visible ? '' : 'hidden'}`}>
      <div className="sheet-header">Active Background Jobs</div>
      <div id="sheet-background-tasks-list" className="sheet-list">
        {tasks.length === 0 && <p className="sheet-tab-hint">No active background jobs.</p>}
        {tasks.map((task, index) => (
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
      </div>
    </div>
  );
}
