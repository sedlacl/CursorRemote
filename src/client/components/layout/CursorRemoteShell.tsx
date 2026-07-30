import React from 'react';
import type { CursorState } from '../../../server/types.js';
import { useServerHealth } from '../../state/serverHealth.js';
import type { BooleanStateSetter } from '../../types/ui.js';
import { ExploratoryChrome } from '../exploratory/ExploratoryChrome.js';
import { ApprovalBar } from '../decision/ApprovalBar.js';
import { QuestionnaireBar } from '../decision/QuestionnaireBar.js';
import { MessageViewport } from '../messages/transcript.js';
import { BottomSheetHost } from '../overlays/BottomSheetHost.js';
import { PlanModal } from '../overlays/PlanModal.js';
import { ToastHost } from '../overlays/ToastHost.js';
import { ChatTabBar } from '../shell/ChatTabBar.js';
import { ComposerInput } from '../shell/ComposerInput.js';
import { ComposerQueueStrip } from '../shell/ComposerQueueStrip.js';
import { HeaderBar } from '../shell/HeaderBar.js';
import { MultitaskStatusStrip } from '../shell/MultitaskStatusStrip.js';
import { WindowPicker } from '../shell/WindowPicker.js';

export interface CursorRemoteShellProps {
  state: CursorState;
  socketConnected: boolean;
  authReady: boolean;
  sendPending: boolean;
  setSendPending: BooleanStateSetter;
}

export function CursorRemoteShell({
  state,
  socketConnected,
  authReady,
  sendPending,
  setSendPending,
}: CursorRemoteShellProps) {
  const serverHealth = useServerHealth(authReady);
  return (
    <>
      <HeaderBar
        state={state}
        socketConnected={socketConnected}
        serverHealth={serverHealth}
        sendPending={sendPending}
      />
      <ComposerQueueStrip
        queue={state.composerQueue?.items || []}
        queueLabel={state.composerQueue?.queueLabel}
      />
      <WindowPicker windows={state.windows || []} activeWindowId={state.activeWindowId} />
      <ChatTabBar tabs={state.chatTabs || []} />
      <ExploratoryChrome chrome={state.exploratoryUi} />
      <MultitaskStatusStrip subagents={state.subagents} agentChanges={state.agentChanges} />
      <MessageViewport
        state={state}
        socketConnected={socketConnected}
        diagnosticId={serverHealth?.server?.diagnosticId}
      />
      <ApprovalBar state={state} />
      <QuestionnaireBar state={state} />
      <ComposerInput state={state} setSendPending={setSendPending} />
      <BottomSheetHost
        state={state}
        serverHealth={serverHealth}
        socketConnected={socketConnected}
        sendPending={sendPending}
      />
      <PlanModal />
      <ToastHost />
    </>
  );
}