import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandResult, ComposerQueueItem, CursorState, PlanBlock } from '../../server/types.js';
import type { GitFileSummary } from '../../shared/git-scm.js';
import { CursorRemoteShell } from '../components/layout/CursorRemoteShell.js';
import { CommandClientContext, useCreateCommandClient } from '../state/commandClient.js';
import { defaultCursorState, mergeCursorPatch, RemoteStateContext } from '../state/remoteStateStore.js';
import { checkAuth, clearAuthToken, createSocket, type SocketLike } from '../state/socketClient.js';
import { UiStateContext, type SheetType, type ToastMessage } from '../state/uiState.js';
import { newCommandId } from '../utils/commandIds.js';

interface AppProps {
  socket?: SocketLike;
  skipAuth?: boolean;
}

export function App({ socket: providedSocket, skipAuth = false }: AppProps) {
  const socket = useMemo(() => providedSocket ?? createSocket(), [providedSocket]);
  const commandClient = useCreateCommandClient(socket);
  const [authReady, setAuthReady] = useState(skipAuth);
  const [socketConnected, setSocketConnected] = useState(socket.connected !== false);
  const [remoteState, setRemoteState] = useState<CursorState>(defaultCursorState);
  const [activeSheet, setActiveSheet] = useState<SheetType>(null);
  const [queueSheetItem, setQueueSheetItem] = useState<ComposerQueueItem | null>(null);
  const [tabSheetComposerId, setTabSheetComposerId] = useState<string | null>(null);
  const [planModelContext, setPlanModelContext] = useState<PlanBlock | null>(null);
  const [activePlanModal, setActivePlanModal] = useState<PlanBlock | null>(null);
  const [planModalBody, setPlanModalBody] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [sendPending, setSendPending] = useState(false);
  const [gitDiffFile, setGitDiffFile] = useState<GitFileSummary | null>(null);

  const showToast = useCallback((message: string, type?: 'success' | 'error') => {
    setToasts(items => {
      const last = items[items.length - 1];
      if (last && last.message === message && last.type === type) {
        return items;
      }
      const id = newCommandId();
      window.setTimeout(() => {
        setToasts(current => current.filter(item => item.id !== id));
      }, 3500);
      return [...items, { id, message, type }];
    });
  }, []);

  useEffect(() => {
    if (skipAuth) return;
    let cancelled = false;
    void checkAuth().then(ok => {
      if (!cancelled) setAuthReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [skipAuth]);

  useEffect(() => {
    if (!authReady) return;

    let connectFailCount = 0;
    const onConnect = () => {
      connectFailCount = 0;
      setSocketConnected(true);
    };
    const onDisconnect = () => setSocketConnected(false);
    const onConnectError = (err: Error) => {
      connectFailCount++;
      if (err.message === 'Unauthorized' || connectFailCount >= 5) {
        clearAuthToken();
        window.location.href = '/login';
      }
    };
    const onStateFull = (newState: CursorState) => {
      setRemoteState({ ...defaultCursorState, ...newState });
    };
    const onStatePatch = (patch: Partial<CursorState>) => {
      setRemoteState(current => mergeCursorPatch(current, patch));
    };
    const onConnectionStatus = (data: { connected: boolean }) => {
      setRemoteState(current => ({ ...current, connected: data.connected }));
    };
    const onCommandResult = (result: CommandResult) => {
      if (!commandClient.resolveCommandResult(result) && !result.ok) {
        showToast(result.error || 'Command failed', 'error');
      }
    };
    const onDiagnosticCollect = (payload: { requestId?: string; parts?: string[] }) => {
      const requestId = payload?.requestId?.trim();
      if (!requestId || !payload.parts?.includes('web-dom')) return;
      const html = document.documentElement.outerHTML;
      const bytes = new TextEncoder().encode(html).byteLength;
      const maxBytes = 2 * 1024 * 1024;
      if (bytes > maxBytes) {
        socket.emit('diagnostic:collect-response', {
          requestId,
          error: 'too_large',
          bytes,
        });
        return;
      }
      socket.emit('diagnostic:collect-response', {
        requestId,
        webDom: {
          html,
          bytes,
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          collectedAt: new Date().toISOString(),
        },
      });
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('state:full', onStateFull);
    socket.on('state:patch', onStatePatch);
    socket.on('connection:status', onConnectionStatus);
    socket.on('command:result', onCommandResult);
    socket.on('diagnostic:collect', onDiagnosticCollect);
    socket.connect?.();

    return () => {
      socket.off?.('connect', onConnect);
      socket.off?.('disconnect', onDisconnect);
      socket.off?.('connect_error', onConnectError as (...args: unknown[]) => void);
      socket.off?.('state:full', onStateFull as (...args: unknown[]) => void);
      socket.off?.('state:patch', onStatePatch as (...args: unknown[]) => void);
      socket.off?.('connection:status', onConnectionStatus as (...args: unknown[]) => void);
      socket.off?.('command:result', onCommandResult as (...args: unknown[]) => void);
      socket.off?.('diagnostic:collect', onDiagnosticCollect as (...args: unknown[]) => void);
    };
  }, [authReady, commandClient, showToast, socket]);

  useEffect(() => {
    if (!sendPending) return;
    const hasLiveWork = remoteState.agentActivityLive
      || remoteState.agentStatus !== 'idle'
      || (remoteState.backgroundTasks?.length || 0) > 0;
    if (hasLiveWork) {
      setSendPending(false);
      return;
    }
    const timer = window.setTimeout(() => setSendPending(false), 5000);
    return () => window.clearTimeout(timer);
  }, [
    remoteState.agentActivityLive,
    remoteState.agentStatus,
    remoteState.backgroundTasks,
    sendPending,
  ]);

  const ui = useMemo(() => ({
    activeSheet,
    queueSheetItem,
    tabSheetComposerId,
    planModelContext,
    activePlanModal,
    planModalBody,
    toasts,
    backgroundTaskContext: null,
    gitDiffFile,
    openSheet: (type: SheetType) => setActiveSheet(type),
    closeSheet: () => setActiveSheet(null),
    openQueueSheet: (item: ComposerQueueItem) => {
      setQueueSheetItem(item);
      setActiveSheet('queue');
    },
    openTabSheet: (composerId: string) => {
      setTabSheetComposerId(composerId);
      setActiveSheet('tab');
    },
    openPlanModelSheet: (plan: PlanBlock) => {
      setPlanModelContext(plan);
      setActiveSheet('plan-model');
    },
    openPlanModal: (plan: PlanBlock) => {
      setActivePlanModal(plan);
      setPlanModalBody('');
    },
    closePlanModal: () => {
      setActivePlanModal(null);
      setPlanModalBody('');
    },
    setPlanModalBody,
    showToast,
    removeToast: (id: string) => setToasts(items => items.filter(item => item.id !== id)),
    openGitSheet: () => setActiveSheet('git'),
    openGitDiff: (file) => setGitDiffFile(file),
    closeGitDiff: () => setGitDiffFile(null),
  }), [activePlanModal, activeSheet, gitDiffFile, planModalBody, planModelContext, queueSheetItem, showToast, tabSheetComposerId, toasts]);

  if (!authReady) return null;

  return (
    <RemoteStateContext.Provider value={remoteState}>
      <CommandClientContext.Provider value={commandClient}>
        <UiStateContext.Provider value={ui}>
          <CursorRemoteShell
            state={remoteState}
            socketConnected={socketConnected}
            authReady={authReady}
            sendPending={sendPending}
            setSendPending={setSendPending}
          />
        </UiStateContext.Provider>
      </CommandClientContext.Provider>
    </RemoteStateContext.Provider>
  );
}
