import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CursorState } from '../../../server/types.js';
import { getHistoryScopeKey } from '../../../shared/history-scope.js';
import { parseInternalTranscriptLink } from '../../../shared/internal-links.js';
import { useMessageScroll } from '../../hooks/useMessageScroll.js';
import { useNotifications } from '../../hooks/useNotifications.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import { sanitizeHtml } from '../../utils/sanitizeHtml.js';
import { getConnectionUiState } from '../../view-models/connectionState.js';
import { DiagnosticIdBadge } from '../shell/DiagnosticIdBadge.js';
import { MessageList } from './messageTypes.js';

export interface MessageViewportProps {
  state: CursorState;
  socketConnected: boolean;
  diagnosticId?: string | null;
}

const TRANSCRIPT_NAV_TIMEOUT_MS = 12000;

export function MessageViewport({ state, socketConnected, diagnosticId }: MessageViewportProps) {
  const messagesRef = useRef<HTMLElement | null>(null);
  const command = useCommandClient();
  const ui = useUiState();
  const connection = getConnectionUiState(state, socketConnected);
  const [transcriptNavPending, setTranscriptNavPending] = useState(false);
  const transcriptNavScopeRef = useRef('');
  const historyScopeKey = useMemo(() => getHistoryScopeKey(state), [state]);
  const loadHistory = useCallback((times: number) => (
    command.sendCommandAwaitResult('command:load_history', { times })
  ), [command]);
  const { historyLoading, captureHistoryScrollPreserve, restoreHistoryScrollPreserve } = useMessageScroll(
    messagesRef,
    state.messages || [],
    state.activeComposerId,
    state.connected,
    loadHistory,
    ui.showToast,
  );
  useNotifications(state.messages || []);

  useEffect(() => {
    (window as unknown as { __cursorRemoteTestApi?: unknown }).__cursorRemoteTestApi = {
      captureHistoryScrollPreserve,
      restoreHistoryScrollPreserve,
    };
  }, [captureHistoryScrollPreserve, restoreHistoryScrollPreserve]);

  useEffect(() => {
    if (!transcriptNavPending) return;
    if (historyScopeKey !== transcriptNavScopeRef.current) {
      setTranscriptNavPending(false);
    }
  }, [historyScopeKey, transcriptNavPending]);

  useEffect(() => {
    if (!transcriptNavPending) return;
    const timer = window.setTimeout(() => setTranscriptNavPending(false), TRANSCRIPT_NAV_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [transcriptNavPending]);

  useEffect(() => {
    const root = messagesRef.current;
    if (!root) return;

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || !root.contains(anchor)) return;

      const href = anchor.getAttribute('href') || '';
      const parsed = parseInternalTranscriptLink(href);
      if (!parsed) return;

      event.preventDefault();
      event.stopPropagation();

      const linkLabel = (anchor.textContent || '').trim();
      transcriptNavScopeRef.current = historyScopeKey;
      setTranscriptNavPending(true);
      void command.sendCommandAwaitResult('command:open_transcript_link', {
        composerId: parsed.composerId,
        linkHref: parsed.href,
        linkLabel,
      }).then(result => {
        if (!result.ok) {
          setTranscriptNavPending(false);
          ui.showToast(result.error || 'Failed to open chat', 'error');
        }
      });
    };

    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }, [command, historyScopeKey, ui.showToast]);

  const showTranscriptLoader = transcriptNavPending;
  const displayMessages = transcriptNavPending ? [] : (state.messages || []);

  return (
    <div className="messages-region">
      <main id="messages" ref={messagesRef} role="log" aria-live="polite">
        <div
          id="transcript-nav-loader"
          className={`history-loader ${showTranscriptLoader ? '' : 'hidden'}`}
          aria-live="polite"
        >
          Opening chat...
        </div>
        <div id="history-loader" className={`history-loader ${historyLoading ? '' : 'hidden'}`} aria-live="polite">
          Loading older messages...
        </div>
        {showTranscriptLoader ? null : displayMessages.length === 0 ? (
          <EmptyState primary={connection.emptyPrimary} hint={connection.emptyHint} />
        ) : (
          <MessageList key={historyScopeKey} messages={displayMessages} />
        )}
      </main>
      {/* Sits outside the scroll container so it stays pinned while the transcript scrolls. */}
      <div className="messages-diagnostic-anchor">
        <DiagnosticIdBadge diagnosticId={diagnosticId} />
      </div>
    </div>
  );
}

function EmptyState({ primary, hint }: { primary: string; hint: string }) {
  return (
    <div id="empty-state" className="empty-state">
      <p id="empty-state-primary">{primary}</p>
      <p id="empty-state-hint" className="hint" dangerouslySetInnerHTML={{ __html: sanitizeHtml(hint) }} />
    </div>
  );
}
