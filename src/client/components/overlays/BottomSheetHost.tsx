import React from 'react';
import type { CursorState } from '../../../server/types.js';
import type { HealthSnapshot } from '../../state/serverHealth.js';
import { useUiState } from '../../state/uiState.js';
import { hostCan } from '../../view-models/hostCapabilities.js';
import { BackgroundTasksSheet } from './sheets/BackgroundTasksSheet.js';
import { DebugSheet } from './sheets/DebugSheet.js';
import { ModeSheet } from './sheets/ModeSheet.js';
import { ModelSheet } from './sheets/ModelSheet.js';
import { PlanModelSheet } from './sheets/PlanModelSheet.js';
import { QueueActionsSheet } from './sheets/QueueActionsSheet.js';
import { TabActionsSheet } from './sheets/TabActionsSheet.js';
import { GitReviewSheet } from '../git/GitReviewSheet.js';
import { GitDiffOverlay } from '../git/GitDiffOverlay.js';

export interface BottomSheetHostProps {
  state: CursorState;
  serverHealth: HealthSnapshot | null;
  socketConnected: boolean;
  sendPending: boolean;
}

export function BottomSheetHost({
  state,
  serverHealth,
  socketConnected,
  sendPending,
}: BottomSheetHostProps) {
  const ui = useUiState();
  const active = ui.activeSheet;
  return (
    <>
      <div id="sheet-overlay" className={`sheet-overlay ${active ? '' : 'hidden'}`} onClick={ui.closeSheet} />
      {/* A sheet left open across a switch to a backend without the control closes itself. */}
      <ModeSheet state={state} visible={active === 'mode' && hostCan(state, 'setMode')} />
      <ModelSheet state={state} visible={active === 'model' && hostCan(state, 'setModel')} />
      <PlanModelSheet visible={active === 'plan-model' && hostCan(state, 'planModel')} />
      <TabActionsSheet state={state} visible={active === 'tab'} />
      <QueueActionsSheet visible={active === 'queue'} />
      <BackgroundTasksSheet state={state} visible={active === 'background-tasks'} />
      <DebugSheet
        visible={active === 'debug'}
        state={state}
        serverHealth={serverHealth}
        socketConnected={socketConnected}
        sendPending={sendPending}
      />
      <GitReviewSheet state={state} visible={active === 'git'} />
      <GitDiffOverlay file={ui.gitDiffFile} snapshotId={state.gitScm?.snapshotId ?? null} onClose={ui.closeGitDiff} />
    </>
  );
}
