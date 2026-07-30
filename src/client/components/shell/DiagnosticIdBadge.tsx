import React, { useCallback, useState } from 'react';
import { useUiState } from '../../state/uiState.js';

export interface DiagnosticIdBadgeProps {
  diagnosticId?: string | null;
}

export function DiagnosticIdBadge({ diagnosticId }: DiagnosticIdBadgeProps) {
  const ui = useUiState();
  const [copied, setCopied] = useState(false);
  const id = diagnosticId?.trim();

  const copyId = useCallback(async () => {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      ui.showToast(`Diagnostic ID copied: ${id}`, 'success');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      ui.showToast('Copy failed', 'error');
    }
  }, [id, ui]);

  if (!id) return null;

  return (
    <button
      type="button"
      id="diagnostic-id-badge"
      className={`diagnostic-id-badge${copied ? ' copied' : ''}`}
      aria-label={`Diagnostic ID ${id}. Tap to copy.`}
      title="Diagnostic relay ID — tap to copy for support or agent debugging"
      onClick={() => void copyId()}
    >
      <span className="diagnostic-id-label">ID</span>
      <span className="diagnostic-id-value">{id}</span>
    </button>
  );
}
