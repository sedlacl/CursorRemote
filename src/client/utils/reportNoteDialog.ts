export type ReportNoteDialogResult =
  | { ok: true; note: string }
  | { ok: false; reason: 'cancelled' };

function dismissReportNoteDialog(): void {
  document.getElementById('report-note-dialog')?.remove();
}

/**
 * Mobile-friendly modal asking for a short bug description.
 * Resolves with trimmed note, or cancelled.
 */
export function promptReportNote(): Promise<ReportNoteDialogResult> {
  if (typeof document === 'undefined') {
    return Promise.resolve({ ok: false, reason: 'cancelled' });
  }

  dismissReportNoteDialog();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ReportNoteDialogResult) => {
      if (settled) return;
      settled = true;
      dismissReportNoteDialog();
      resolve(result);
    };

    const overlay = document.createElement('div');
    overlay.id = 'report-note-dialog';
    overlay.className = 'report-note-dialog';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'report-note-dialog-title');

    const panel = document.createElement('div');
    panel.className = 'report-note-dialog-panel';

    const title = document.createElement('div');
    title.id = 'report-note-dialog-title';
    title.className = 'report-note-dialog-title';
    title.textContent = 'Describe the issue';

    const hint = document.createElement('p');
    hint.className = 'report-note-dialog-hint';
    hint.textContent = 'Short description of what looks wrong (required).';

    const field = document.createElement('textarea');
    field.className = 'report-note-dialog-text';
    field.setAttribute('aria-label', 'Issue description');
    field.placeholder = 'e.g. Approval card shows Allow as the command';
    field.rows = 4;
    field.maxLength = 2000;

    const error = document.createElement('div');
    error.className = 'report-note-dialog-error hidden';
    error.textContent = 'Please enter a short description.';

    const actions = document.createElement('div');
    actions.className = 'report-note-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'report-note-dialog-btn';
    cancelBtn.textContent = 'Cancel';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'report-note-dialog-btn report-note-dialog-btn--primary';
    submitBtn.textContent = 'Submit report';

    const onCancel = () => finish({ ok: false, reason: 'cancelled' });

    const onSubmit = () => {
      const note = field.value.trim();
      if (!note) {
        error.classList.remove('hidden');
        field.focus();
        return;
      }
      finish({ ok: true, note });
    };

    cancelBtn.addEventListener('click', onCancel);
    submitBtn.addEventListener('click', onSubmit);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) onCancel();
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        onSubmit();
      }
    });
    field.addEventListener('input', () => {
      if (field.value.trim()) error.classList.add('hidden');
    });

    actions.append(cancelBtn, submitBtn);
    panel.append(title, hint, field, error, actions);
    overlay.append(panel);
    document.body.appendChild(overlay);

    window.setTimeout(() => {
      field.focus();
    }, 0);
  });
}
