import React from 'react';
import type { CursorState } from '../../../../server/types.js';
import { setMode } from '../../../actions/sheetActions.js';
import { MODE_OPTIONS } from '../../../constants/modeOptions.js';
import { ModeIcon } from '../../icons/ModeIcon.js';
import { useCommandClient } from '../../../state/commandClient.js';
import { useUiState } from '../../../state/uiState.js';

export interface ModeSheetProps {
  state: CursorState;
  visible: boolean;
}

export function ModeSheet({ state, visible }: ModeSheetProps) {
  const command = useCommandClient();
  const ui = useUiState();
  const current = state.mode?.current || 'agent';
  return (
    <div id="sheet-mode" className={`bottom-sheet ${visible ? '' : 'hidden'}`}>
      <div className="sheet-header">Mode</div>
      <div id="sheet-mode-list" className="sheet-list">
        {MODE_OPTIONS.map(mode => (
          <button
            key={mode.id}
            className={`sheet-item ${mode.id === current ? 'selected' : ''}`}
            type="button"
            onClick={() => {
              setMode(command, mode.id);
              ui.closeSheet();
              ui.showToast(`Mode: ${mode.label}`, 'success');
            }}
          >
            <span className="sheet-item-icon"><ModeIcon modeId={mode.id} size={20} /></span>
            <span>{mode.label}</span>
            {mode.id === current && <span className="sheet-item-check">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
