export type CopyToClipboardResult =
  | { ok: true; method: 'clipboard' | 'execCommand' }
  | { ok: false; text: string; shownManualFallback: boolean };

function canUseClipboardApi(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function';
}

/**
 * Legacy copy path for non-secure contexts (HTTP LAN) and older browsers.
 * Must run inside the user-gesture task — do not call after an awaited Clipboard API failure
 * when Clipboard API was never available (feature-detect first).
 */
export function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  // iOS Safari: keep in-DOM, focusable, with a real selection range (display:none breaks copy).
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.margin = '0';
  textarea.style.border = 'none';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.background = 'transparent';
  textarea.style.opacity = '0';
  textarea.style.zIndex = '-1';
  textarea.style.fontSize = '16px'; // avoid iOS focus zoom
  // contentEditable + readOnly trick for iOS selection
  textarea.contentEditable = 'true';
  textarea.readOnly = false;

  document.body.appendChild(textarea);

  let ok = false;
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(textarea);
      selection.removeAllRanges();
      selection.addRange(range);
      textarea.setSelectionRange(0, text.length);
    }

    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    textarea.remove();
  }
  return ok;
}

function dismissManualCopyFallback(): void {
  document.getElementById('clipboard-manual-fallback')?.remove();
}

/** Last resort on phones: surface selectable text when both APIs fail. */
export function showManualCopyFallback(text: string): void {
  if (typeof document === 'undefined') return;
  dismissManualCopyFallback();

  const overlay = document.createElement('div');
  overlay.id = 'clipboard-manual-fallback';
  overlay.className = 'clipboard-manual-fallback';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Copy text manually');

  const panel = document.createElement('div');
  panel.className = 'clipboard-manual-fallback-panel';

  const title = document.createElement('div');
  title.className = 'clipboard-manual-fallback-title';
  title.textContent = 'Select and copy';

  const hint = document.createElement('p');
  hint.className = 'clipboard-manual-fallback-hint';
  hint.textContent = 'Automatic copy is unavailable in this browser context. Long-press the text below and choose Copy.';

  const field = document.createElement('textarea');
  field.className = 'clipboard-manual-fallback-text';
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-label', 'Text to copy');

  const actions = document.createElement('div');
  actions.className = 'clipboard-manual-fallback-actions';

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'clipboard-manual-fallback-btn';
  selectBtn.textContent = 'Select all';
  selectBtn.addEventListener('click', () => {
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'clipboard-manual-fallback-btn clipboard-manual-fallback-btn--primary';
  closeBtn.textContent = 'Done';
  closeBtn.addEventListener('click', () => dismissManualCopyFallback());

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismissManualCopyFallback();
  });

  actions.append(selectBtn, closeBtn);
  panel.append(title, hint, field, actions);
  overlay.append(panel);
  document.body.appendChild(overlay);

  // Focus after paint so iOS can show the selection handles.
  window.setTimeout(() => {
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  }, 0);
}

/**
 * Copy text to the clipboard. Prefer Clipboard API when present; otherwise use
 * execCommand (required on HTTP LAN / non-secure contexts where navigator.clipboard is undefined).
 */
export async function copyToClipboard(text: string): Promise<CopyToClipboardResult> {
  // Feature-detect first so HTTP LAN never awaits a missing API (keeps user gesture for fallback).
  if (canUseClipboardApi()) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Permission / transient failure — try legacy path (may still work on desktop).
    }
  }

  if (copyWithExecCommand(text)) {
    return { ok: true, method: 'execCommand' };
  }

  showManualCopyFallback(text);
  return { ok: false, text, shownManualFallback: true };
}
