import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CursorState } from '../../../../server/types.js';
import { useCommandClient } from '../../../state/commandClient.js';
import { downloadDomExport, type DomExportScope } from '../../../state/domExport.js';
import { fetchDebugInfo, type HealthSnapshot } from '../../../state/serverHealth.js';
import { captureUiReport } from '../../../state/uiReport.js';
import { useUiState } from '../../../state/uiState.js';
import { copyToClipboard } from '../../../utils/clipboard.js';
import { promptReportNote } from '../../../utils/reportNoteDialog.js';
import { captureWebClientScreenshot, waitForNextPaint } from '../../../utils/webScreenshot.js';
import { buildStopButtonState } from '../../../view-models/stopState.js';

function formatAgentStopDebugLabel(state: CursorState): string {
  if (!state.agentStopAvailable && !state.agentStopSelectorPath) return '—';
  switch (state.agentStopSource) {
    case 'composer':
      return 'composer · data-stop-button / debug-stop';
    case 'background_task':
      return 'background_task · shell/toolbar stop';
    case 'none':
      return 'none';
    default:
      return String(state.agentStopSource);
  }
}

export interface DebugSheetProps {
  visible: boolean;
  state: CursorState;
  serverHealth: HealthSnapshot | null;
  socketConnected: boolean;
  sendPending: boolean;
}

export function DebugSheet({
  visible,
  state,
  serverHealth,
  socketConnected,
  sendPending,
}: DebugSheetProps) {
  const ui = useUiState();
  const command = useCommandClient();
  const [details, setDetails] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<DomExportScope | null>(null);
  const [exportError, setExportError] = useState('');
  const [reporting, setReporting] = useState(false);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchDebugInfo() as Record<string, unknown>;
      setDetails(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void loadDetails();
  }, [visible, loadDetails]);

  const rows = useMemo(() => {
    const bridge = details?.extensionBridge as Record<string, unknown> | undefined;
    const gitSnapshots = details?.gitSnapshots as Record<string, unknown> | undefined;
    const snapshotEntries = gitSnapshots?.windowSnapshots as Record<string, {
      changedCount: number;
      updatedAt: number;
      repoBreakdown?: Array<{ label: string; changedCount: number }>;
    }> | undefined;
    const snapshotSummary = snapshotEntries
      ? Object.entries(snapshotEntries)
        .map(([key, snap]) => `${key}:F:${snap.changedCount}`)
        .join(', ')
      : '—';
    const server = (details?.server ?? serverHealth?.server) as Record<string, unknown> | undefined;
    const clientStopState = buildStopButtonState({
      state,
      sendPending,
      stopPending: false,
      lastKnownStopSelectorPath: '',
    });
    return [
      ['Client URL', window.location.origin],
      ['Socket', socketConnected ? 'connected' : 'disconnected'],
      ['Server version', server?.version ?? '—'],
      ['Server port', server?.port ?? '—'],
      ['Instance ID', server?.instanceId ?? '—'],
      ['Diagnostic ID', server?.diagnosticId ?? '—'],
      ['PID', server?.pid ?? '—'],
      ['Data dir', server?.dataDirName ?? bridge?.dataDirName ?? '—'],
      ['Client build', server?.clientBuild ?? '—'],
      ['CDP URL', details?.cdpUrl ?? '—'],
      ['Active window title', details?.activeWindowTitle ?? '—'],
      ['Active git window key', gitSnapshots?.activeWindowKey ?? '—'],
      ['Git snapshots', snapshotSummary],
      ['Last git push', gitSnapshots?.lastPushAt ? new Date(Number(gitSnapshots.lastPushAt)).toLocaleString() : '—'],
      ['Last push window key', gitSnapshots?.lastPushWindowKey ?? '—'],
      ['State gitStatus', state.gitStatus ? `F:${state.gitStatus.changedCount}` : 'null'],
      ['Health gitStatus', serverHealth?.gitStatus ? `F:${serverHealth.gitStatus.changedCount}` : 'null'],
      ['Stop target', formatAgentStopDebugLabel(state)],
      ['Stop available', (details?.agentStopAvailable as boolean | undefined) == null ? String(state.agentStopAvailable) : String(details?.agentStopAvailable)],
      ['Stop source', (details?.agentStopSource as string | undefined) ?? state.agentStopSource ?? '—'],
      ['Activity source', (details?.agentActivitySource as string | undefined) ?? state.agentActivitySource ?? '—'],
      ['Client sendPending', String(sendPending)],
      ['Client stop enabled', String(clientStopState.stopEnabled)],
      ['Client real stop', String(clientStopState.realStopAvailable)],
      ['Generation', details?.generation ?? serverHealth?.generation ?? '—'],
      ['Uptime', details?.uptime ?? serverHealth?.uptime ?? '—'],
    ] as const;
  }, [details, sendPending, serverHealth, socketConnected, state]);

  const copyJson = useCallback(async () => {
    const payload = details ?? {
      client: { url: window.location.origin, socketConnected },
      health: serverHealth,
      stateGitStatus: state.gitStatus,
    };
    const result = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (result.ok) {
      ui.showToast('Debug JSON copied', 'success');
      return;
    }
    ui.showToast(
      result.shownManualFallback
        ? 'Copy failed — select text manually'
        : 'Copy failed',
      'error',
    );
  }, [details, serverHealth, socketConnected, state.gitStatus, ui]);

  const killServer = useCallback(async () => {
    const result = await command.sendCommandAwaitResult('command:kill_server');
    if (!result.ok) {
      ui.showToast(result.error || 'Kill server failed', 'error');
      return;
    }
    ui.showToast('Server kill sent', 'success');
  }, [command, ui]);

  const exportDom = useCallback(async (scope: DomExportScope) => {
    if (scope === 'document') {
      const confirmed = window.confirm(
        'Export full window DOM as raw, unsanitized HTML?\n\n' +
        'It may contain chats, code, terminal output, local paths, and secrets.',
      );
      if (!confirmed) return;
    }
    setExporting(scope);
    setExportError('');
    try {
      const filename = await downloadDomExport(scope, {
        windowId: state.activeWindowId,
        composerId: state.activeComposerId,
      });
      ui.showToast(`Downloaded ${filename}`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExportError(message);
      ui.showToast('DOM export failed', 'error');
    } finally {
      setExporting(null);
    }
  }, [state.activeComposerId, state.activeWindowId, ui]);

  const reportUi = useCallback(async () => {
    const server = (details?.server ?? serverHealth?.server) as Record<string, unknown> | undefined;
    const diagnosticId = typeof server?.diagnosticId === 'string' ? server.diagnosticId : undefined;
    setReporting(true);
    setExportError('');
    // Hide Debug sheet so it is not in the web-client screenshot.
    ui.closeSheet();
    try {
      await waitForNextPaint();
      let webScreenshotPngBase64: string | null = null;
      let screenshotWarning = '';
      try {
        webScreenshotPngBase64 = await captureWebClientScreenshot();
      } catch (err) {
        screenshotWarning = err instanceof Error ? err.message : String(err);
      }

      const noteResult = await promptReportNote();
      if (!noteResult.ok) {
        return;
      }

      const result = await captureUiReport({
        diagnosticId,
        note: noteResult.note,
        webScreenshotPngBase64,
      });
      const warnSuffix = result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : '';
      ui.showToast(`Report saved: ${result.issuePath}${warnSuffix}`, 'success');
      if (screenshotWarning) {
        ui.showToast(`Web screenshot unavailable: ${screenshotWarning}`, 'error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExportError(message);
      ui.showToast(message, 'error');
    } finally {
      setReporting(false);
    }
  }, [details, serverHealth, ui]);

  return (
    <div id="sheet-debug" className={`bottom-sheet debug-sheet ${visible ? '' : 'hidden'}`}>
      <div className="sheet-header debug-sheet-header">
        <span>Debug</span>
        <div className="debug-sheet-actions">
          <button type="button" className="debug-action-btn" disabled={loading} onClick={() => void loadDetails()}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button id="debug-kill-server" type="button" className="debug-action-btn" onClick={() => void killServer()}>
            Kill server
          </button>
          <button type="button" className="debug-action-btn" onClick={() => void copyJson()}>
            Copy JSON
          </button>
        </div>
      </div>
      {error && <div className="debug-error">{error}</div>}
      <div className="debug-export-panel">
        <div className="debug-export-warning">
          Raw diagnostic HTML and snapshot API responses are not sanitized and may contain sensitive chats, code, terminals, paths, or secrets.
          Use <code>/debug/snapshot?id=&lt;Diagnostic ID&gt;</code> with session or <code>DIAGNOSTIC_TOKEN</code> Bearer auth.
          <strong> Report</strong> hides this sheet, captures a web-client screenshot, asks for a short description, then sends DOM + note to the server (Cursor DOM/screenshot/state) and writes an issue under <code>docs/issues/</code>.
        </div>
        <div className="debug-export-actions">
          <button
            id="debug-ui-report"
            type="button"
            className="debug-action-btn debug-report-btn"
            disabled={reporting || exporting !== null}
            onClick={() => void reportUi()}
          >
            {reporting ? 'Reporting…' : 'Report'}
          </button>
          <button
            id="debug-export-chat"
            type="button"
            className="debug-action-btn"
            disabled={reporting || exporting !== null || !socketConnected || !state.activeComposerId}
            onClick={() => void exportDom('chat')}
          >
            {exporting === 'chat' ? 'Exporting chat…' : 'Export chat DOM'}
          </button>
          <button
            id="debug-export-document"
            type="button"
            className="debug-action-btn debug-export-danger"
            disabled={reporting || exporting !== null || !socketConnected || !state.activeWindowId}
            onClick={() => void exportDom('document')}
          >
            {exporting === 'document' ? 'Exporting window…' : 'Export full window DOM'}
          </button>
        </div>
      </div>
      {exportError && <div className="debug-error">{exportError}</div>}
      <div className="debug-sheet-body">
        {rows.map(([label, value]) => (
          <div key={label} className="debug-row">
            <span className="debug-row-label">{label}</span>
            <span className="debug-row-value">{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
