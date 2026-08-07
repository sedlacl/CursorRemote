import type { CdpClient } from './cdp-client.js';
import type {
  CodeBlockItem,
  CursorState,
  ChatElement,
  ChatTab,
  DiffLineKind,
  ModeInfo,
  ModelInfo,
  SelectorConfig,
} from './types.js';
import { applyDerivedActivityToState } from './activity-derive.js';

const EVALUATE_TIMEOUT_MS = 5000;
const MAX_POLL_BACKOFF_MS = 5000;

/** Canonical tab title cleaning - matches extractionFunction's cleanTabTitle for consistent lookups. */
export function cleanTabTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  t = t.replace(/(@[\w./]+)+\s*$/, '');
  return t.trim().substring(0, 120);
}

export {
  filterActionableApprovals,
  isActionableApproval,
  isApproveActionLabel,
  isApproveAllLabel,
  isBackgroundApprovalLabel,
  isGarbageActionLabel,
  looksLikeButtonLabel,
  sanitizeApprovalCommandText,
} from './approval-filter.js';

/**
 * Runs inside Cursor's renderer process via Runtime.evaluate.
 * Must be completely self-contained (no Node.js imports).
 *
 * Uses Cursor's data attributes (data-flat-index or data-message-index,
 * data-message-role, data-message-kind, data-tool-status) for reliable extraction.
 */
export function extractionFunction(
  containerSelectors: string[],
  approveSelectors: string[],
  approveTextMatch: string[],
  rejectSelectors: string[],
  rejectTextMatch: string[],
  inputSelectors: string[],
  statusSelectors: string[],
  chatTabSelectors: string[],
  modeSelectors: string[],
  modelSelectors: string[],
  windowTitle?: string
): CursorState | null {
  function projectNameFromTitle(title: string): string {
    const idx = title.indexOf(' [');
    return (idx >= 0 ? title.substring(0, idx) : title).trim();
  }
  function findFirst(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  function findFirstWithin(root: Element, selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        if (root.matches(sel)) return root;
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  /**
   * Line diff stats from Edit tool UI. Tries legacy classes, then +N / -M chip spans
   * (Cursor sometimes omits or renames .ui-edit-tool-call__additions / __deletions).
   */
  function tryParseDiffStatsFromWrapper(scope: Element): { additions?: number; deletions?: number } {
    let additions: number | undefined;
    let deletions: number | undefined;
    const addEl = scope.querySelector('.ui-edit-tool-call__additions');
    const delEl = scope.querySelector('.ui-edit-tool-call__deletions');
    const addText = addEl?.textContent?.trim();
    const delText = delEl?.textContent?.trim();
    const addM = addText?.match(/\d+/);
    const delM = delText?.match(/\d+/);
    if (addM) additions = parseInt(addM[0], 10);
    if (delM) deletions = parseInt(delM[0], 10);
    if (additions !== undefined || deletions !== undefined) return { additions, deletions };

    for (const el of Array.from(scope.querySelectorAll('span, div, a'))) {
      const t = (el.textContent || '').trim();
      if (additions === undefined && /^\+\d+$/.test(t)) additions = parseInt(t.slice(1), 10);
      if (deletions === undefined && /^-\d+$/.test(t)) deletions = parseInt(t.slice(1), 10);
      if (additions !== undefined && deletions !== undefined) break;
    }
    return { additions, deletions };
  }

  function buildSelectorPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += `#${cur.id.replace(/([.:])/g, '\\$1')}`;
        parts.unshift(seg);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  /** Legacy flat-index wrappers, or virtualized composer rows (Cursor 2026+). */
  function discoverMessageWrappers(root: Element): Element[] {
    const virtualRows = root.querySelectorAll('.virtualized-composer-messages-row');
    if (virtualRows.length > 0) {
      const wrappers: Element[] = [];
      for (const row of Array.from(virtualRows)) {
        if (row.matches('[data-message-role]') || row.querySelector('[data-message-role]')) {
          wrappers.push(row);
          continue;
        }
        const transcriptRow = row.querySelector('[data-react-transcript-row-kind]');
        const rowKind = transcriptRow?.getAttribute('data-react-transcript-row-kind');
        const isRolelessActivity =
          rowKind === 'activityGroup' &&
          !!transcriptRow?.querySelector(
            '.agent-transcript-row-activity .agent-transcript-activity-group-collapsible [data-component="collapsible-header"]',
          );
        const isRolelessNotification =
          rowKind === 'notification' &&
          !!transcriptRow?.querySelector(
            '.agent-transcript-row-notification .agent-transcript-notification-collapsible [data-component="collapsible-header"]',
          );
        if (isRolelessActivity || isRolelessNotification) wrappers.push(row);
      }
      if (wrappers.length > 0) return wrappers;
    }

    const legacy = root.querySelectorAll('[data-flat-index]');
    if (legacy.length > 0) return Array.from(legacy);

    const rendered = root.querySelectorAll('.composer-rendered-message[data-message-role]');
    if (rendered.length > 0) return Array.from(rendered);

    return [];
  }

  function resolveFlatIndex(wrapper: Element, msgEl: Element, wrapperIndex: number): number {
    const flatAttr = wrapper.getAttribute('data-flat-index');
    if (flatAttr != null && flatAttr !== '') {
      const parsed = parseInt(flatAttr, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    const msgIndex = msgEl.getAttribute('data-message-index');
    if (msgIndex != null && msgIndex !== '') {
      const parsed = parseInt(msgIndex, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    const rowIndex = wrapper.getAttribute('data-index');
    if (rowIndex != null && rowIndex !== '') {
      const parsed = parseInt(rowIndex, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    // The value is retained for the wire format, but is never a cross-snapshot
    // order key. An ordinal keeps fallback IDs unique when a new Cursor build
    // temporarily omits every known numeric attribute.
    return wrapperIndex;
  }

  function resolveTranscriptOrder(
    wrapper: Element,
  ): { turnIndex: number; turnOrder: number } | undefined {
    const pairAttr = wrapper.getAttribute('data-pair-index');
    const rowAttr = wrapper.getAttribute('data-index');
    if (pairAttr == null || pairAttr === '' || rowAttr == null || rowAttr === '') return undefined;
    const turnIndex = parseInt(pairAttr, 10);
    const turnOrder = parseInt(rowAttr, 10);
    if (!Number.isFinite(turnIndex) || !Number.isFinite(turnOrder)) return undefined;
    return { turnIndex, turnOrder };
  }

  function isTranscriptMessage(el: Element): boolean {
    return !!el.closest(
      '.composer-messages-container, [data-flat-index], .composer-human-ai-pair-container, .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
    );
  }

  try {
    const container = findFirst(containerSelectors);
    if (!container) return null;

    const messageWrappers = discoverMessageWrappers(container);
    let containerComposerId =
      container.getAttribute('data-composer-id') ||
      container.closest('[data-composer-id]')?.getAttribute('data-composer-id') ||
      '';
    if (!containerComposerId && messageWrappers.length > 0) {
      const firstMsg = messageWrappers[0];
      containerComposerId = firstMsg.closest('[data-composer-id]')?.getAttribute('data-composer-id') || '';
    }

    const elements: ChatElement[] = [];
    const _rawElements: Array<{
      flatIndex: number; role?: string; kind?: string; messageId?: string;
      toolCallId?: string; toolStatus?: string; indicators: string[];
      textPreview: string; parsedAs: string;
    }> = [];

    function detectIndicators(el: Element): string[] {
      const flags: string[] = [];
      if (el.querySelector('.loading-indicator-v3')) flags.push('loading-v3');
      if (el.querySelector('.make-shine')) flags.push('make-shine');
      if (el.querySelector('.ui-collapsible.ui-step-group-collapsible')) flags.push('step-group');
      if (el.querySelector('.composer-tool-former-message')) flags.push('compact-tool');
      if (el.querySelector('.composer-terminal-tool-call-block-container') ||
          el.querySelector('.composer-tool-call-container.composer-terminal-compact-mode')) flags.push('run-command');
      if (el.querySelector('.plan-execution-message-content')) flags.push('plan-execution');
      if (el.querySelector('.composer-create-plan-container')) flags.push('plan-create');
      if (el.querySelector('.composer-edit-file-review-wrapper')) flags.push('edit-review');
      if (el.querySelector('.todo-list-container')) flags.push('todo-list');
      if (el.querySelector('.ui-tool-call-line-action')) flags.push('tool-line');
      if (el.querySelector('.ui-edit-tool-call__filename')) flags.push('edit-file');
      if (el.querySelector('.composer-message-group')) flags.push('message-group');
      if (el.querySelector('.markdown-root')) flags.push('markdown');
      if (el.querySelector('.aislash-editor-input-readonly')) flags.push('human-input');
      return flags;
    }

    function durationFromThoughtText(raw: string): string {
      const t = raw.trim();
      const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
      if (forM) return forM[1].replace(/\s+/g, '');
      const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
      if (bareM) return bareM[1].replace(/\s+/g, '');
      return '';
    }

    function isDurationOnlyThoughtSpan(raw: string): boolean {
      const t = raw.trim();
      if (/^for\s+/i.test(t)) return false;
      return !!durationFromThoughtText(t) && t.length <= 20;
    }

    /** Header shows a finished timing (for 2s, or trailing 9s). */
    function collapsibleHeaderTextLooksComplete(ht: string): boolean {
      const t = ht.replace(/\s+/g, ' ').trim();
      if (!t) return false;
      if (/\bfor\s+[\d.]+\s*s(ec(onds?)?)?\b/i.test(t)) return true;
      if (/\b[\d.]+\s*s(ec(onds?)?)?\s*$/i.test(t)) return true;
      return false;
    }

    function parseThoughtSpansFromHeader(headerEl: Element | null): {
      action: string;
      detail: string;
      duration: string;
    } {
      if (!headerEl) return { action: '', detail: '', duration: '' };
      const headerSpans = headerEl.querySelectorAll(':scope > span');
      let action = '';
      let detail = '';
      let duration = '';
      for (const s of Array.from(headerSpans)) {
        if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
        const t = (s.textContent || '').trim();
        if (!t) continue;
        const d = durationFromThoughtText(t);
        if (d && !duration) duration = d;
        if (isDurationOnlyThoughtSpan(t)) continue;
        if (!action) {
          action = t;
          continue;
        }
        if (t.startsWith('for ')) {
          duration = duration || t.replace(/^for\s+/i, '').trim();
          detail = t;
        } else {
          detail = detail || t;
        }
      }
      if (!duration) {
        const fullHeader = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
        duration = durationFromThoughtText(fullHeader);
      }
      return { action, detail, duration };
    }

    function parseActivityGroupHeader(headerEl: Element | null): {
      action: string;
      detail: string;
      duration: string;
    } {
      if (!headerEl) return { action: '', detail: '', duration: '' };
      const action = (
        headerEl.querySelector(':scope > .ui-collapsible-action')?.textContent || ''
      ).replace(/\s+/g, ' ').trim();
      const detailsEl = headerEl.querySelector(':scope > .ui-collapsible-details');
      let detail = '';
      if (detailsEl) {
        const expanded = detailsEl.querySelector('[data-summary-variant="expanded"]');
        if (expanded) {
          detail = (expanded.textContent || '').replace(/\s+/g, ' ').trim();
        } else {
          const clone = detailsEl.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('style, script').forEach(el => el.remove());
          const candidates = Array.from(clone.children)
            .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          const unique = Array.from(new Set(candidates));
          detail = unique.length === 1
            ? unique[0]
            : (clone.textContent || '').replace(/\s+/g, ' ').trim();
          if (detail.length % 2 === 0) {
            const half = detail.length / 2;
            if (detail.slice(0, half) === detail.slice(half)) detail = detail.slice(0, half);
          }
        }
      }
      const duration = durationFromThoughtText(detail);
      return { action, detail, duration };
    }

    type RawElRef = {
      flatIndex: number;
      role?: string;
      kind?: string;
      messageId?: string;
      toolCallId?: string;
      toolStatus?: string;
      indicators: string[];
      textPreview: string;
      parsedAs: string;
    };

    function cleanCodeLine(raw: string): string {
      return (raw || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
    }

    function trimOuterBlankCodeLines(lines: string[]): string[] {
      const out = [...lines];
      while (out.length > 0 && out[0].trim().length === 0) out.shift();
      while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
      return out;
    }

    function joinCodeLines(lines: string[]): string {
      return trimOuterBlankCodeLines(lines.map(cleanCodeLine)).join('\n');
    }

    function extractStructuredCodeText(root: Element): string {
      const parts: string[] = [];

      function ensureNewline(): void {
        if (parts.length === 0) return;
        const last = parts[parts.length - 1] || '';
        if (!last.endsWith('\n')) parts.push('\n');
      }

      function hasBlockishChildren(el: Element): boolean {
        return Array.from(el.children).some((child) => {
          const tag = (child.tagName || '').toLowerCase();
          return (
            tag === 'div' ||
            tag === 'p' ||
            tag === 'li' ||
            child.matches('.ui-default-code__line-content, .view-line, [data-line], .line')
          );
        });
      }

      function walk(node: Node): void {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = cleanCodeLine(node.textContent || '');
          if (text) parts.push(text);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'br') {
          ensureNewline();
          return;
        }

        const lineLike =
          el.matches('.ui-default-code__line-content, .view-line, [data-line], .line') ||
          ((tag === 'div' || tag === 'p' || tag === 'li') && !hasBlockishChildren(el));

        const beforeCount = parts.length;
        el.childNodes.forEach(walk);
        if (lineLike && parts.length > beforeCount) ensureNewline();
      }

      walk(root);
      return joinCodeLines(parts.join('').split('\n'));
    }

    function extractComposerPlainText(cb: Element): string {
      const codeContent = cb.querySelector('.ui-default-code__content');
      const contentRoot =
        codeContent ||
        cb.querySelector('.composer-code-block-content, .ui-code-block-content') ||
        cb;
      let code = '';
      if (codeContent) {
        const lineEls = codeContent.querySelectorAll('.ui-default-code__line-content');
        code =
          lineEls.length > 0
            ? joinCodeLines(
                Array.from(lineEls).map((l) => l.textContent || '')
              )
            : extractStructuredCodeText(codeContent);
      }
      if (!code) {
        const vl = cb.querySelectorAll('.view-line');
        if (vl.length > 0) {
          code = joinCodeLines(
            Array.from(vl)
              .map((line) => line.textContent || '')
              .filter((ln) => ln.trim().length > 0)
          );
        }
      }
      if (!code) {
        const diffEl = cb.querySelector('.composer-diff-block');
        if (diffEl) {
          const vl2 = diffEl.querySelectorAll('.view-line');
          code = joinCodeLines(Array.from(vl2).map((line) => line.textContent || ''));
        }
      }
      if (!code && contentRoot) code = extractStructuredCodeText(contentRoot);
      return code;
    }

    function parseTopPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/top:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function parseHeightPx(style: string | null | undefined): number | undefined {
      const m = (style || '').match(/height:\s*([\d.]+)px/);
      return m ? parseFloat(m[1]) : undefined;
    }

    function lineKindFromOverlays(editorRoot: Element, lineTop: number): 'add' | 'rem' | null {
      const overlayRows = editorRoot.querySelectorAll('.view-overlays > div');
      for (let i = 0; i < overlayRows.length; i++) {
        const row = overlayRows[i];
        const t = parseTopPx(row.getAttribute('style'));
        if (t === undefined || Math.abs(t - lineTop) > 2) continue;
        if (row.querySelector('.cdr.line-insert, .cdr.char-insert')) return 'add';
        if (row.querySelector('.cdr.line-delete, .cdr.char-delete')) return 'rem';
      }
      return null;
    }

    function lineRemFromViewZones(editorRoot: Element, lineTop: number, lineHeight: number): boolean {
      const zones = editorRoot.querySelectorAll('.view-zones > div');
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (!z.classList.contains('diagonal-fill')) continue;
        const t = parseTopPx(z.getAttribute('style'));
        const h = parseHeightPx(z.getAttribute('style')) || 16;
        if (t === undefined) continue;
        if (lineTop + lineHeight > t && lineTop < t + h) return true;
      }
      return false;
    }

    function extractViewLinesWithKinds(
      editorRoot: Element,
      side: 'original' | 'modified'
    ): { kind: DiffLineKind; text: string }[] {
      const lines = editorRoot.querySelectorAll('.view-lines > .view-line');
      const out: { kind: DiffLineKind; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const text = (line.textContent || '').replace(/\u00a0/g, ' ').replace(/\r/g, '').trimEnd();
        const lineTop = parseTopPx(line.getAttribute('style'));
        const ht = parseHeightPx(line.getAttribute('style')) || 16;
        let kind: DiffLineKind = 'ctx';
        const topPx = lineTop ?? 0;
        if (side === 'original') {
          const o = lineKindFromOverlays(editorRoot, topPx);
          if (o === 'rem') kind = 'rem';
          else if (lineRemFromViewZones(editorRoot, topPx, ht)) kind = 'rem';
        } else if (lineKindFromOverlays(editorRoot, topPx) === 'add') {
          kind = 'add';
        }
        out.push({ kind, text });
      }
      return out;
    }

    function parseUnifiedDiffLines(code: string): { kind: DiffLineKind; text: string }[] | undefined {
      const lines = (code || '').replace(/\r/g, '').split('\n');
      if (lines.length === 0) return undefined;

      let addCount = 0;
      let remCount = 0;
      let signalCount = 0;
      const diffLines: { kind: DiffLineKind; text: string }[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        let kind: DiffLineKind = 'ctx';

        if (
          line.startsWith('*** Begin Patch') ||
          line.startsWith('*** Update File:') ||
          line.startsWith('*** Add File:') ||
          line.startsWith('*** Delete File:') ||
          line.startsWith('*** End Patch') ||
          line.startsWith('*** End of File') ||
          line.startsWith('diff --') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ')
        ) {
          kind = 'meta';
          signalCount++;
        } else if (line.startsWith('@@')) {
          kind = 'hunk';
          signalCount++;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          kind = 'add';
          addCount++;
          signalCount++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          kind = 'rem';
          remCount++;
          signalCount++;
        }

        diffLines.push({ kind, text: line });
      }

      const looksDiff =
        (addCount > 0 || remCount > 0) &&
        (signalCount >= 2 || lines.some((line) => line.startsWith('@@') || line.startsWith('*** ')));

      return looksDiff ? diffLines : undefined;
    }

    function extractCodeBlockItem(cb: Element): CodeBlockItem {
      const headerEl = cb.querySelector('.ui-code-block-header');
      const filenameEl = cb.querySelector('.composer-code-block-filename, .ui-code-block-filename');
      const filename = filenameEl ? (filenameEl.textContent || '').trim() || undefined : undefined;
      const language = headerEl ? headerEl.getAttribute('data-language') || undefined : undefined;

      const diffEditor = cb.querySelector('.monaco-diff-editor');
      if (diffEditor) {
        const orig = diffEditor.querySelector('.editor.original');
        const mod = diffEditor.querySelector('.editor.modified');
        const diffLines: { kind: DiffLineKind; text: string }[] = [];
        if (orig) diffLines.push(...extractViewLinesWithKinds(orig, 'original'));
        if (mod) diffLines.push(...extractViewLinesWithKinds(mod, 'modified'));
        const code = diffLines.map(function (d) {
          return d.text;
        }).join('\n');
        return { blockKind: 'diff', filename, language, code, diffLines };
      }

      const code = extractComposerPlainText(cb);
      const parsedDiffLines = parseUnifiedDiffLines(code);
      if (parsedDiffLines) {
        return { blockKind: 'diff', filename, language, code, diffLines: parsedDiffLines };
      }
      return { blockKind: 'code', filename, language, code };
    }

    function extractDiffBlockFromScope(scope: Element): CodeBlockItem | undefined {
      const block = scope.querySelector('.composer-code-block-container, .composer-message-codeblock');
      if (!block) return undefined;
      return extractCodeBlockItem(block);
    }

    function isBackgroundApprovalLabel(label: string): boolean {
      const norm = label.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!norm) return false;
      if (norm.includes('background')) return true;
      return /run\s+in\s+back(?:ground)?/.test(norm);
    }

    function looksLikeButtonLabel(label: string): boolean {
      const norm = label.replace(/\s+/g, ' ').trim();
      if (!norm || norm.length > 48) return false;
      if (/[{}\[\];]/.test(norm)) return false;
      if (/\/\/|\/\*|\*\//.test(norm)) return false;
      if (/\b(function|const|let|var|catch|syncopen|chatTabs)\b/i.test(norm)) return false;
      if (/^\+\s*\+/.test(norm)) return false;
      return true;
    }

    function isGarbageActionLabel(label: string): boolean {
      if (!looksLikeButtonLabel(label)) return true;
      const norm = label.replace(/\s+/g, ' ').trim();
      if (/#\s*fail\b/i.test(norm)) return true;
      if (/\bduration_ms\b/i.test(norm)) return true;
      if (/#\s*(cancelled|skipped|todo)\s+\d+/i.test(norm)) return true;
      return false;
    }

    // Keep in sync with approval-filter.ts APPROVE_ACTION_LABELS / isApproveActionLabel.
    function isApproveActionLabel(label: string): boolean {
      const norm = label.replace(/\s+/g, ' ').trim().toLowerCase();
      return /^(accept|approve|run|allow|accept all)$/i.test(norm);
    }

    // Keep in sync with approval-filter.ts isApproveAllLabel — do not use
    // includes('all') (that mis-classifies "Allow" as approve_all).
    function isApproveAllLabel(label: string): boolean {
      const norm = label.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!norm) return false;
      return /\b(accept|approve|allow)\s+all\b/.test(norm) || /^all$/i.test(norm);
    }

    function sanitizeApprovalCommandText(text: string): string {
      const trimmed = (text || '').replace(/\s+/g, ' ').trim();
      if (!trimmed || isApproveActionLabel(trimmed)) return '';
      return trimmed;
    }

    function getButtonLabel(btn: Element): string {
      const clean = (raw: string): string =>
        raw.replace(/\s*(Shift\+)?⏎\s*/g, '').replace(/\s+/g, ' ').trim();

      const aria = btn.getAttribute('aria-label')?.trim();
      if (aria && looksLikeButtonLabel(aria)) return clean(aria);

      let shallow = '';
      for (const child of Array.from(btn.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) shallow += child.textContent || '';
        else if (child instanceof Element) {
          const tag = child.tagName;
          if (tag === 'SPAN' || tag === 'DIV') shallow += child.textContent || '';
        }
      }
      shallow = clean(shallow);
      if (shallow && looksLikeButtonLabel(shallow)) return shallow;

      const title = btn.getAttribute('title')?.trim();
      if (title && looksLikeButtonLabel(title)) return clean(title);

      const full = clean(btn.textContent || '');
      if (full && looksLikeButtonLabel(full)) return full;
      return '';
    }

    function isActionableApproval(entry: {
      description: string;
      actions: { label: string; type: string }[];
    }): boolean {
      const approves = entry.actions.filter(
        (a) => a.type === 'approve' || a.type === 'approve_all'
      );
      if (approves.length === 0) return false;
      if (isBackgroundApprovalLabel(entry.description)) return false;
      if (approves.every((a) => isBackgroundApprovalLabel(a.label))) return false;
      if (!approves.some((a) => looksLikeButtonLabel(a.label))) return false;
      return true;
    }

    function extractToolActions(
      container: Element
    ): { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] {
      const actions: { label: string; type: 'run' | 'skip' | 'allow'; selectorPath: string }[] = [];
      const seenPaths = new Set<string>();

      const skipBtn = container.querySelector('.composer-skip-button');
      if (skipBtn) {
        const path = buildSelectorPath(skipBtn);
        seenPaths.add(path);
        actions.push({ label: 'Skip', type: 'skip' as const, selectorPath: path });
      }

      const runBtns = container.querySelectorAll('.composer-run-button, .anysphere-secondary-button');
      for (const btn of Array.from(runBtns)) {
        const path = buildSelectorPath(btn);
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        const btnText = (btn.textContent || '').replace(/[⏎⌘⇧]/g, '').trim();
        if (isBackgroundApprovalLabel(btnText)) continue;
        const isAllow =
          btn.classList.contains('anysphere-secondary-button') || btnText.toLowerCase().includes('allow');
        if (isAllow) {
          actions.push({ label: btnText, type: 'allow' as const, selectorPath: path });
        } else {
          actions.push({ label: btnText || 'Run', type: 'run' as const, selectorPath: path });
        }
      }

      return actions;
    }

    function extractAiTool(
      toolRoot: Element,
      flatIndex: number,
      messageId: string,
      patchRaw: RawElRef | null
    ): { element: ChatElement; parsedAs: string } | null {
      const toolEl = toolRoot.querySelector('[data-tool-call-id]') || toolRoot;
      const toolCallId = toolEl.getAttribute('data-tool-call-id') || `tool-${flatIndex}`;
      const toolStatus = (toolEl.getAttribute('data-tool-status') ||
        toolRoot.getAttribute('data-tool-status') ||
        'completed') as 'loading' | 'completed';
      if (patchRaw) {
        patchRaw.toolCallId = toolCallId;
        patchRaw.toolStatus = toolStatus;
      }

      const planContainer = toolRoot.querySelector('.composer-create-plan-container');
      if (planContainer) {
        const label = (planContainer.querySelector('.composer-create-plan-label')?.textContent || '').trim();
        const title = (planContainer.querySelector('.composer-create-plan-title')?.textContent || '').trim();
        const descRoot = planContainer.querySelector('.composer-create-plan-text .markdown-root');
        const description = descRoot ? (descRoot.textContent || '').trim() : undefined;
        const descriptionHtml = descRoot ? (descRoot.innerHTML || '').trim() : undefined;

        const todoItems = planContainer.querySelectorAll('.composer-create-plan-todo-item');
        const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted = 0;
        let todosTotal = 0;
        let todosMoreCount: number | undefined;
        for (const item of Array.from(todoItems)) {
          if (item.querySelector('.composer-plan-todo-ellipsis')) {
            const moreEl = item.querySelector('.composer-plan-todo-more-text');
            const moreText = (moreEl?.textContent || '').trim();
            const moreMatch = moreText.match(/(\d+)\s+more/i);
            if (moreMatch) todosMoreCount = parseInt(moreMatch[1], 10);
            continue;
          }
          const contentEl = item.querySelector('.composer-create-plan-todo-content');
          if (!contentEl) continue;
          const text = (contentEl.textContent || '').trim();
          if (!text) continue;
          const indicator = item.querySelector('.composer-plan-todo-indicator');
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (indicator) {
            const cls = indicator.className || '';
            if (cls.includes('completed')) {
              status = 'completed';
              todosCompleted++;
            } else if (cls.includes('in_progress') || cls.includes('in-progress')) status = 'in_progress';
          }
          todosTotal++;
          todos.push({ text, status });
        }

        const todosHeader = (planContainer.querySelector('.composer-create-plan-todos-header')?.textContent || '').trim();
        const headerMatch = todosHeader.match(/(\d+)/);
        if (headerMatch && todosTotal === 0) {
          todosTotal = parseInt(headerMatch[0], 10);
        }

        const actions: { label: string; type: 'view_plan' | 'build'; selectorPath: string }[] = [];
        const viewPlanBtn = planContainer.querySelector('.composer-create-plan-view-plan-button');
        if (viewPlanBtn) {
          actions.push({
            label: 'View Plan',
            type: 'view_plan' as const,
            selectorPath: buildSelectorPath(viewPlanBtn),
          });
        }
        let buildBtn: Element | null = null;
        const buildCandidates = planContainer.querySelectorAll('.composer-create-plan-build-button');
        for (const b of Array.from(buildCandidates)) {
          const tx = (b.textContent || '').replace(/\s+/g, ' ').trim();
          if (/build/i.test(tx) && tx.length > 2) {
            buildBtn = b;
            break;
          }
        }
        if (!buildBtn && buildCandidates.length > 0) buildBtn = buildCandidates[0];
        if (buildBtn) {
          actions.push({ label: 'Build', type: 'build' as const, selectorPath: buildSelectorPath(buildBtn) });
        }

        const modelEl = planContainer.querySelector('.composer-unified-dropdown-model');
        let model: string | undefined;
        let modelDropdownSelectorPath: string | undefined;
        if (modelEl) {
          modelDropdownSelectorPath = buildSelectorPath(modelEl);
          const spans = modelEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            const t = (s.textContent || '').trim();
            if (t && !t.includes('chevron') && t.length > 1) {
              model = t;
              break;
            }
          }
        }

        return {
          element: {
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            description,
            descriptionHtml: descriptionHtml || undefined,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
            todosMoreCount,
            model,
            modelDropdownSelectorPath,
            actions: actions.length > 0 ? actions : undefined,
          },
          parsedAs: 'plan',
        };
      }

      const runContainer =
        toolRoot.querySelector('.composer-terminal-tool-call-block-container') ||
        toolRoot.querySelector('.composer-tool-call-container.composer-terminal-compact-mode');
      if (runContainer) {
        const descEl = runContainer.querySelector('.composer-terminal-top-header-description');
        const candidatesEl = runContainer.querySelector('.composer-terminal-top-header-candidates');
        const commandEl =
          runContainer.querySelector('.composer-terminal-command-expanded-text') ||
          runContainer.querySelector('.composer-terminal-command-editor') ||
          runContainer.querySelector('.composer-terminal-command-wrapper') ||
          runContainer.querySelector('.composer-tool-call-header-content');
        const description = (descEl?.textContent || '').trim();
        const candidates = (candidatesEl?.textContent || '').trim();

        let command = '';
        if (commandEl) {
          const rawCmd = (commandEl.textContent || '').replace(/^\$\s*/, '');
          const cmdLines = rawCmd.split('\n');
          const nonEmpty = cmdLines.filter(function (l: string) {
            return l.trim().length > 0;
          });
          let minIndent = 0;
          if (nonEmpty.length > 0) {
            minIndent = Infinity;
            for (let li = 0; li < nonEmpty.length; li++) {
              const m = nonEmpty[li].match(/^(\s*)/);
              const len = m ? m[1].length : 0;
              if (len < minIndent) minIndent = len;
            }
          }
          command = cmdLines
            .map(function (l: string) {
              return l.length >= minIndent ? l.substring(minIndent) : l;
            })
            .join('\n')
            .trim();
        }

        const runActions = extractToolActions(runContainer);

        return {
          element: {
            type: 'run_command' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            description,
            candidates,
            command,
            actions: runActions,
          },
          parsedAs: 'run_command',
        };
      }

      const editReviewEl = toolRoot.querySelector('.composer-edit-file-review-wrapper');
      if (editReviewEl) {
        const filenameEl = editReviewEl.querySelector('.composer-code-block-filename');
        const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;

        const statusSpans = editReviewEl.querySelectorAll('.composer-code-block-status span');
        let additions: number | undefined;
        let deletions: number | undefined;
        for (const s of Array.from(statusSpans)) {
          const t = (s.textContent || '').trim();
          const addM = t.match(/^\+(\d+)$/);
          const delM = t.match(/^-(\d+)$/);
          if (addM) additions = parseInt(addM[1], 10);
          if (delM) deletions = parseInt(delM[1], 10);
        }
        const editDiffFb = tryParseDiffStatsFromWrapper(editReviewEl);
        if (additions === undefined) additions = editDiffFb.additions;
        if (deletions === undefined) deletions = editDiffFb.deletions;

        const blockedPill = editReviewEl.querySelector('.block-attribution-pill');
        const blocked = blockedPill
          ? (blockedPill.getAttribute('aria-label') || blockedPill.textContent || '').trim()
          : undefined;

        const statusRow = editReviewEl.querySelector('.composer-tool-call-status-row');
        const editActions = statusRow
          ? extractToolActions(statusRow)
          : extractToolActions(editReviewEl);

        const diffBlock = extractDiffBlockFromScope(editReviewEl);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: 'Edit',
            details: '',
            filename,
            additions,
            deletions,
            blocked: blocked || undefined,
            actions: editActions.length > 0 ? editActions : undefined,
            ...(diffBlock ? { diffBlock } : {}),
          },
          parsedAs: 'tool:edit-review',
        };
      }

      const todoListContainer = toolRoot.querySelector('.todo-list-container');
      if (todoListContainer) {
        const headerElTodo = todoListContainer.querySelector('.todo-list-header-left-title');
        const title = (headerElTodo?.textContent || 'To-dos').replace(/\d+\s*$/, '').trim();
        const todoItems2 = todoListContainer.querySelectorAll('.ui-todo-item');
        const todos2: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
        let todosCompleted2 = 0;
        for (const item of Array.from(todoItems2)) {
          const contentEl2 = item.querySelector('.ui-todo-item__content');
          const text = (contentEl2?.textContent || '').trim();
          if (!text) continue;
          const cls = item.className || '';
          let status: 'pending' | 'completed' | 'in_progress' = 'pending';
          if (cls.includes('completed')) {
            status = 'completed';
            todosCompleted2++;
          } else if (cls.includes('dimmed') || (contentEl2 && contentEl2.className.includes('in-progress'))) {
            status = 'in_progress';
          }
          todos2.push({ text, status });
        }
        return {
          element: {
            type: 'todo_list' as const,
            id: messageId,
            flatIndex,
            title,
            todosCompleted: todosCompleted2,
            todosTotal: todos2.length,
            todos: todos2,
          },
          parsedAs: 'todo_list',
        };
      }

      const compactEl = toolRoot.querySelector('.composer-tool-former-message');
      if (compactEl) {
        let actionPart = '';
        let descPart = '';

        const headerContent = compactEl.querySelector('.composer-tool-call-header-content');
        if (headerContent) {
          const headerSpans = headerContent.querySelectorAll('span');
          for (const s of Array.from(headerSpans)) {
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (!actionPart) {
              actionPart = txt;
            } else if (!descPart) {
              descPart = txt;
            }
          }
        } else {
          const spans = compactEl.querySelectorAll('span');
          for (const s of Array.from(spans)) {
            if (s.closest('.composer-tool-call-control-row') || s.closest('.composer-tool-call-status-row')) continue;
            const txt = (s.textContent || '').trim();
            if (!txt) continue;
            if (s.classList.toString().includes('codicon') || s.classList.toString().includes('cursor-icon')) continue;
            if (s.classList.contains('truncate-one-line') || s.classList.toString().includes('truncate')) {
              descPart = txt;
            } else if (!actionPart) {
              actionPart = txt;
            }
          }
        }

        const compactActions = extractToolActions(compactEl);
        const summaryText = headerContent
          ? ''
          : (compactEl.textContent || '').trim();
        const compactDiff = tryParseDiffStatsFromWrapper(toolRoot);
        const diffBlockCompact = extractDiffBlockFromScope(toolRoot);
        return {
          element: {
            type: 'tool' as const,
            id: messageId,
            flatIndex,
            toolCallId,
            status: toolStatus,
            action: actionPart || '',
            details: descPart || '',
            summaryText: !actionPart && !descPart && summaryText ? summaryText : undefined,
            additions: compactDiff.additions,
            deletions: compactDiff.deletions,
            actions: compactActions.length > 0 ? compactActions : undefined,
            ...(diffBlockCompact ? { diffBlock: diffBlockCompact } : {}),
          },
          parsedAs: 'tool:compact',
        };
      }

      const actionEl = toolRoot.querySelector('.ui-tool-call-line-action');
      const detailsEl = toolRoot.querySelector('.ui-tool-call-line-details');
      let action = (actionEl?.textContent || '').trim();
      let details = (detailsEl?.textContent || '').trim();

      const filenameEl2 = toolRoot.querySelector('.ui-edit-tool-call__filename');
      const additionsEl = toolRoot.querySelector('.ui-edit-tool-call__additions');
      const deletionsEl = toolRoot.querySelector('.ui-edit-tool-call__deletions');
      const filename2 = filenameEl2 ? (filenameEl2.textContent || '').trim() : undefined;
      const addMatch = additionsEl ? (additionsEl.textContent || '').match(/\d+/) : null;
      const delMatch = deletionsEl ? (deletionsEl.textContent || '').match(/\d+/) : null;
      let additions2 = addMatch ? parseInt(addMatch[0], 10) : undefined;
      let deletions2 = delMatch ? parseInt(delMatch[0], 10) : undefined;
      const lineDiffFb = tryParseDiffStatsFromWrapper(toolRoot);
      if (additions2 === undefined) additions2 = lineDiffFb.additions;
      if (deletions2 === undefined) deletions2 = lineDiffFb.deletions;

      const shellCmd = toolRoot.querySelector('.ui-shell-tool-call__command');
      if (shellCmd && !details) details = (shellCmd.textContent || '').trim();

      if (!action) {
        const cardHeader = toolRoot.querySelector('.ui-tool-call-card__header');
        if (cardHeader) action = (cardHeader.textContent || '').trim().split('\n')[0].trim();
      }

      if (!action) {
        const fullText = (toolRoot.textContent || '').trim();
        if (fullText.length > 0 && fullText.length < 200) {
          action = fullText.substring(0, 60);
        }
      }

      const diffBlockLine = extractDiffBlockFromScope(toolRoot);
      const fallbackActions = extractToolActions(toolRoot);
      return {
        element: {
          type: 'tool' as const,
          id: messageId,
          flatIndex,
          toolCallId,
          status: toolStatus,
          action: action || 'Tool',
          details,
          filename: filename2 || (action === 'Edit' || action === 'Write' ? details : undefined),
          additions: additions2,
          deletions: deletions2,
          actions: fallbackActions.length > 0 ? fallbackActions : undefined,
          ...(diffBlockLine ? { diffBlock: diffBlockLine } : {}),
        },
        parsedAs: !action && !details && !filename2 ? 'tool:fallback' : 'tool',
      };
    }

    for (const [wrapperIndex, wrapper] of messageWrappers.entries()) {
      const msgEl = wrapper.matches('[data-message-role]')
        ? wrapper
        : (wrapper.querySelector('[data-message-role]') || wrapper);
      const flatIndex = resolveFlatIndex(wrapper, msgEl, wrapperIndex);
      const role = msgEl.getAttribute('data-message-role');
      const kind = msgEl.getAttribute('data-message-kind');
      const transcriptRow = wrapper.querySelector('[data-react-transcript-row-kind]');
      const transcriptRowKey = transcriptRow?.getAttribute('data-react-transcript-row-key');
      const messageId = msgEl.getAttribute('data-message-id') ||
        (transcriptRowKey ? `transcript:${transcriptRowKey}` : `fi-${flatIndex}`);
      const transcriptOrder = resolveTranscriptOrder(wrapper);
      const firstElementIndex = elements.length;

      try {
        const rawEl = {
          flatIndex,
          ...transcriptOrder,
          role: role || undefined,
          kind: kind || undefined,
          messageId,
          toolCallId: undefined as string | undefined,
          toolStatus: undefined as string | undefined,
          indicators: detectIndicators(wrapper),
          textPreview: (wrapper.textContent || '').trim().substring(0, 120),
          parsedAs: 'unknown',
        };
        _rawElements.push(rawEl);

      // --- Loading indicator (skip as content — handled as agentActivity) ---
      if (wrapper.querySelector('.loading-indicator-v3')) {
        rawEl.parsedAs = 'skipped:loading';
        continue;
      }

      // --- Roleless transcript activity/progress rows ---
      // Current Cursor virtualizes activityGroup and notification rows without
      // data-message-role. Their transcript kind plus row-specific collapsible
      // structure is stable; do not infer these from auxiliary-bar text.
      if (!role && transcriptRow) {
        const rowKind = transcriptRow.getAttribute('data-react-transcript-row-kind');
        const collapsible = rowKind === 'activityGroup'
          ? transcriptRow.querySelector(
            '.agent-transcript-row-activity .agent-transcript-activity-group-collapsible.ui-step-group-collapsible',
          )
          : rowKind === 'notification'
            ? transcriptRow.querySelector(
              '.agent-transcript-row-notification .agent-transcript-notification-collapsible.ui-step-group-collapsible',
            )
            : null;
        const header = collapsible?.querySelector(
          ':scope > [data-component="collapsible-header"], :scope > .ui-collapsible-header',
        ) ?? null;
        const parsed = parseActivityGroupHeader(header);
        if (parsed.action || parsed.detail || parsed.duration) {
          elements.push({
            type: 'thought' as const,
            id: messageId,
            flatIndex,
            duration: parsed.duration,
            action: parsed.action || undefined,
            detail: parsed.detail || undefined,
            thoughtKind: 'step_summary' as const,
          });
          rawEl.parsedAs = `roleless:${rowKind}`;
          continue;
        }
      }

      // --- Composer message group: Explored + nested ui-thinking-collapsible + tools (one flat-index) ---
      const composerGroup = wrapper.querySelector('.composer-message-group');
      const stepGroupCollapsible = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (composerGroup && stepGroupCollapsible) {
        rawEl.parsedAs = 'message-group';
        const outerHeader = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-header');
        const outerParsed = parseThoughtSpansFromHeader(outerHeader);
        if (outerParsed.action || outerParsed.detail || outerParsed.duration) {
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}-summary`,
            flatIndex,
            duration: outerParsed.duration,
            action: outerParsed.action || undefined,
            detail: outerParsed.detail || undefined,
            thoughtKind: 'step_summary' as const,
          });
        }
        const contentEl = stepGroupCollapsible.querySelector(':scope > .ui-collapsible-content');
        const column = contentEl?.firstElementChild;
        if (column) {
          let seq = 0;
          for (const child of Array.from(column.children)) {
            if (child.classList.contains('ui-thinking-collapsible')) {
              const h = child.querySelector(':scope > .ui-collapsible-header');
              const p = parseThoughtSpansFromHeader(h);
              if (p.action || p.detail || p.duration) {
                elements.push({
                  type: 'thought' as const,
                  id: `thought-${flatIndex}-s${seq}`,
                  flatIndex,
                  duration: p.duration,
                  action: p.action || undefined,
                  detail: p.detail || undefined,
                  thoughtKind: 'thinking_step' as const,
                });
              }
              seq++;
              continue;
            }
            const toolHost =
              child.getAttribute('data-message-role') === 'ai' && child.getAttribute('data-message-kind') === 'tool'
                ? child
                : child.querySelector(':scope > [data-message-role="ai"][data-message-kind="tool"]');
            if (toolHost) {
              const mid =
                toolHost.getAttribute('data-message-id') || `fi-${flatIndex}-g${seq}`;
              const parsedTool = extractAiTool(toolHost as Element, flatIndex, mid, null);
              if (parsedTool) {
                elements.push(parsedTool.element);
                seq++;
              }
            }
          }
        }
        continue;
      }

      // --- Step-group header (Thought, Explored, Searched, Read, etc.) — lone wrapper, no message-role ---
      const thoughtEl = wrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      if (thoughtEl && !role) {
        const hdr = thoughtEl.querySelector('.ui-collapsible-header');
        const parsed = parseThoughtSpansFromHeader(hdr);
        elements.push({
          type: 'thought' as const,
          id: `thought-${flatIndex}`,
          flatIndex,
          duration: parsed.duration,
          action: parsed.action || undefined,
          detail: parsed.detail || undefined,
        });
        rawEl.parsedAs = 'thought';
        continue;
      }

      // --- Human message ---
      if (role === 'human' && kind === 'human') {
        // Check for plan block
        const planContent = wrapper.querySelector('.plan-execution-message-content');
        if (planContent) {
          const label = (planContent.querySelector('.plan-execution-label')?.textContent || '').trim();
          const title = (planContent.querySelector('.plan-execution-title')?.textContent || '').trim();
          const todoSummary = wrapper.querySelector('.todo-summary-content');
          let todosCompleted = 0;
          let todosTotal = 0;
          if (todoSummary) {
            const summaryText = todoSummary.textContent || '';
            const ofMatch = summaryText.match(/(\d+)\s+of\s+(\d+)/);
            const slashMatch = summaryText.match(/(\d+)\s*\/\s*(\d+)/);
            const countMatch = ofMatch || slashMatch;
            if (countMatch) {
              todosCompleted = parseInt(countMatch[1], 10);
              todosTotal = parseInt(countMatch[2], 10);
            }
          }

          const todos: { text: string; status: 'pending' | 'completed' | 'in_progress' }[] = [];
          const summaryItems = wrapper.querySelectorAll('.todo-summary-item');
          for (const item of Array.from(summaryItems)) {
            const contentEl = item.querySelector('.todo-summary-item-content');
            const text = (contentEl?.textContent || '').trim();
            if (!text) continue;
            const contentCls = contentEl?.className || '';
            let status: 'pending' | 'completed' | 'in_progress' = 'pending';
            if (contentCls.includes('todo-completed')) { status = 'completed'; }
            else if (contentCls.includes('todo-in-progress') || item.querySelector('.todo-summary-in-progress-circle')) { status = 'in_progress'; }
            todos.push({ text, status });
          }

          // Collapsed: items not rendered yet. Click to expand; they'll appear next poll cycle.
          if (todos.length === 0 && todosTotal > 0) {
            const clickable = wrapper.querySelector('.todo-summary-content-clickable') as HTMLElement | null;
            if (clickable) clickable.click();
          }

          if (todos.length > 0 && todosTotal === 0) {
            todosTotal = todos.length;
            todosCompleted = todos.filter(function(t) { return t.status === 'completed'; }).length;
          }

          elements.push({
            type: 'plan' as const,
            id: messageId,
            flatIndex,
            label,
            title,
            todosCompleted,
            todosTotal,
            todos: todos.length > 0 ? todos : undefined,
          });
          rawEl.parsedAs = 'plan';
          continue;
        }

        // Regular human message
        const inputEl = wrapper.querySelector('.aislash-editor-input-readonly');
        let text = (inputEl?.textContent || wrapper.textContent || '').trim();
        let quoted: { text: string } | undefined;
        const quoteEl = inputEl?.querySelector('blockquote');
        if (inputEl && quoteEl) {
          const qt = (quoteEl.textContent || '').trim();
          if (qt) quoted = { text: qt };
        }
        const mentionEls = wrapper.querySelectorAll('.mention');
        const mentions = Array.from(mentionEls).map(m => ({
          name: m.getAttribute('data-mention-name') || (m.textContent || '').trim(),
          mentionType: m.getAttribute('data-typeahead-type') || 'unknown',
        }));
        if (inputEl && (quoteEl || mentionEls.length > 0)) {
          const clone = inputEl.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('blockquote, .mention').forEach((el) => el.remove());
          text = (clone.textContent || '').trim();
        }
        // Image pills live beside the readonly Lexical input (not inside it).
        // Live probe: `.context-pill.context-pill-image` > `.image-pill-container` > `img.image-pill-img`.
        const imagePills = wrapper.querySelectorAll('.context-pill-image');
        const imageCount = imagePills.length > 0
          ? imagePills.length
          : wrapper.querySelectorAll('img.image-pill-img').length;

        elements.push({
          type: 'human' as const,
          id: messageId,
          flatIndex,
          text,
          mentions,
          ...(quoted ? { quoted } : {}),
          ...(imageCount > 0 ? { imageCount } : {}),
        });
        rawEl.parsedAs = 'human';
        continue;
      }

      // --- AI thinking (virtualized composer exposes as its own message row) ---
      if (role === 'ai' && kind === 'thinking') {
        const rowKind = msgEl.getAttribute('data-react-transcript-row-kind');
        const activityGroup = rowKind === 'activityGroup'
          ? wrapper.querySelector('.agent-transcript-activity-group-collapsible.ui-step-group-collapsible')
          : null;
        if (activityGroup) {
          const header = activityGroup.querySelector(
            ':scope > [data-component="collapsible-header"], :scope > .ui-collapsible-header',
          );
          const parsed = parseActivityGroupHeader(header);
          if (parsed.action || parsed.detail || parsed.duration) {
            elements.push({
              type: 'thought' as const,
              id: messageId,
              flatIndex,
              duration: parsed.duration,
              action: parsed.action || undefined,
              detail: parsed.detail || undefined,
              thoughtKind: 'step_summary' as const,
            });
          }
          rawEl.parsedAs = 'thinking:activity-group';
          continue;
        }
        const thoughtCollapsible = wrapper.querySelector('.ui-thinking-collapsible');
        if (thoughtCollapsible) {
          const hdr = thoughtCollapsible.querySelector('.ui-collapsible-header');
          const parsed = parseThoughtSpansFromHeader(hdr);
          elements.push({
            type: 'thought' as const,
            id: messageId,
            flatIndex,
            duration: parsed.duration,
            action: parsed.action || undefined,
            detail: parsed.detail || undefined,
            thoughtKind: 'thinking_step' as const,
          });
          rawEl.parsedAs = 'thinking';
          continue;
        }
      }

      // --- AI assistant message ---
      if (role === 'ai' && kind === 'assistant') {
        const markdownRoot = wrapper.querySelector('.markdown-root');
        const text = (markdownRoot?.textContent || wrapper.textContent || '').trim();
        const html = markdownRoot?.innerHTML || '';

        const codeBlockEls = wrapper.querySelectorAll('.composer-message-codeblock, .composer-code-block-container');
        const codeBlocks = Array.from(codeBlockEls).map(cb => extractCodeBlockItem(cb));

        elements.push({
          type: 'assistant' as const,
          id: messageId,
          flatIndex,
          text,
          html,
          codeBlocks,
        });
        rawEl.parsedAs = 'assistant';
        continue;
      }

      // --- Tool call ---
      if (role === 'ai' && kind === 'tool') {
        const parsedTool = extractAiTool(msgEl as Element, flatIndex, messageId, rawEl);
        if (parsedTool) {
          elements.push(parsedTool.element);
          rawEl.parsedAs = parsedTool.parsedAs;
        }
        continue;
      }

      // --- Fallback: step-group inside a message-group wrapper ---
      if (!role && wrapper.querySelector('.composer-message-group')) {
        const collapseEl = wrapper.querySelector('.ui-collapsible-header');
        if (collapseEl) {
          const spans = collapseEl.querySelectorAll(':scope > span');
          let action = '';
          let detail = '';
          let duration = '';
          const durationFromTextFb = (raw: string): string => {
            const t = raw.trim();
            const forM = t.match(/\bfor\s+([\d.]+\s*s(?:ec(?:onds?)?)?)\b/i);
            if (forM) return forM[1].replace(/\s+/g, '');
            const bareM = t.match(/^([\d.]+\s*s(?:ec(?:onds?)?)?)$/i);
            if (bareM) return bareM[1].replace(/\s+/g, '');
            return '';
          };
          const isDurationOnlySpanFb = (raw: string): boolean => {
            const t = raw.trim();
            if (/^for\s+/i.test(t)) return false;
            return !!durationFromTextFb(t) && t.length <= 20;
          };
          for (const s of Array.from(spans)) {
            if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
            const t = (s.textContent || '').trim();
            if (!t) continue;
            const d = durationFromTextFb(t);
            if (d && !duration) duration = d;
            if (isDurationOnlySpanFb(t)) continue;
            if (!action) { action = t; continue; }
            if (t.startsWith('for ')) { duration = duration || t.replace(/^for\s+/i, '').trim(); detail = t; }
            else { detail = detail || t; }
          }
          if (!duration) {
            const fullHeader = (collapseEl.textContent || '').replace(/\s+/g, ' ').trim();
            duration = durationFromTextFb(fullHeader);
          }
          elements.push({
            type: 'thought' as const,
            id: `thought-${flatIndex}`,
            flatIndex,
            duration,
            action: action || undefined,
            detail: detail || undefined,
          });
          rawEl.parsedAs = 'thought:fallback';
        }
      }
      } finally {
        if (transcriptOrder) {
          for (let i = firstElementIndex; i < elements.length; i++) {
            Object.assign(elements[i], transcriptOrder);
          }
        }
      }
    }

    // --- Orphan activity indicators (not inside any transcript message) ---
    const _orphanIndicators: Array<{ cls: string; text: string; parentCls: string }> = [];
    const allIndicators = container.querySelectorAll('.loading-indicator-v3, .make-shine');
    for (const ind of Array.from(allIndicators)) {
      if (isTranscriptMessage(ind)) continue;
      _orphanIndicators.push({
        cls: ind.className.substring(0, 200),
        text: (ind.textContent || '').trim().substring(0, 120),
        parentCls: (ind.parentElement?.className || '').substring(0, 200),
      });
    }

    // --- Approval extraction. Two paths:
    //
    // Primary (per-card): each pending shell tool-call card carries its own
    // Run / Skip / Allowlist buttons plus the actual command text. We surface
    // one approval entry per card with the command as the description — much
    // more useful than just the button label.
    //
    // Fallback (legacy/non-shell): older Cursor builds and non-shell approval
    // surfaces. Collapses everything found into a single entry.
    //
    // Both paths must:
    //   - scope to `container` (otherwise multi-agent workbenches leak
    //     buttons across composers and approvals never clear), and
    //   - skip elements with aria-haspopup (Cursor's "Auto-Run in Sandbox"
    //     mode-dropdown trigger has text "Auto-Run …" and would match a
    //     generic "Run" textMatch — but it opens a settings menu, not an
    //     approval action).
    const pendingApprovals: CursorState['pendingApprovals'] = [];
    const isMenuTrigger = (btn: Element): boolean => {
      const popup = btn.getAttribute('aria-haspopup');
      return popup === 'menu' || popup === 'true' || popup === 'listbox';
    };
    const cleanBtnLabel = (raw: string): string =>
      raw.replace(/\s*(Shift\+)?⏎\s*/g, '').replace(/\s+/g, ' ').trim();
    const matchesActionPattern = (text: string, pattern: string): boolean => {
      const normalizedPattern = pattern.replace(/\s+/g, ' ').trim();
      if (!normalizedPattern) return false;
      const escaped = normalizedPattern
        .split(' ')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
    };

    const readScopedText = (root: Element, selectors: string[], maxLen = 400): string => {
      for (const sel of selectors) {
        try {
          const el = root.querySelector(sel);
          const text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) return text.substring(0, maxLen);
        } catch { /* skip */ }
      }
      return '';
    };

    const readPolicyFromCard = (card: Element): string => {
      const direct = readScopedText(card, ['.ui-shell-tool-call__policy'], 120);
      if (direct) return direct;
      for (const el of Array.from(card.querySelectorAll('.ui-tool-call-card__header span, .ui-tool-call-card__header div, .ui-shell-tool-call__header span'))) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/auto-review/i.test(text)) return text.substring(0, 120);
      }
      return '';
    };

    const readReasonFromCard = (card: Element): string => {
      return readScopedText(card, [
        '.ui-shell-tool-call__reason',
        '[data-smart-mode-block-reason]',
        '[class*="block-reason"]',
      ], 400);
    };

    const readTitleFromCard = (card: Element, cmdText: string, descText: string): string => {
      const headerDesc = readScopedText(card, ['.ui-tool-call-card__header .ui-shell-tool-call__description'], 200);
      if (headerDesc && headerDesc !== cmdText) return headerDesc;
      if (descText && descText !== cmdText) return descText;
      const header = card.querySelector('.ui-tool-call-card__header');
      if (header) {
        const headerText = (header.textContent || '').replace(/\s+/g, ' ').trim();
        const withoutCmd = cmdText ? headerText.replace(cmdText, '').trim() : headerText;
        const withoutPolicy = withoutCmd.replace(/auto-review/gi, '').trim();
        if (
          withoutPolicy
          && withoutPolicy.length > 3
          && !isApproveActionLabel(withoutPolicy)
        ) {
          return withoutPolicy.substring(0, 200);
        }
      }
      return '';
    };

    const buildApprovalFromCard = (
      card: Element,
      row: Element | null,
      actions: CursorState['pendingApprovals'][0]['actions'],
    ): CursorState['pendingApprovals'][0] | null => {
      const cmdEl = card.querySelector('.ui-shell-tool-call__command');
      const cmdText = sanitizeApprovalCommandText(
        (cmdEl?.textContent || '')
          .trim()
          .replace(/^\$\s*/, '')
          .replace(/\s+/g, ' ')
          .substring(0, 240),
      );
      const descEl = card.querySelector('.ui-shell-tool-call__description');
      const rawDesc = (descEl?.textContent || '').trim().substring(0, 200);
      const descText = isApproveActionLabel(rawDesc) ? '' : rawDesc;
      const rawTitle = readTitleFromCard(card, cmdText, descText);
      const title = isApproveActionLabel(rawTitle) ? '' : rawTitle;
      const reason = readReasonFromCard(card);
      const mode = readPolicyFromCard(card);
      const composerId =
        card.closest('[data-composer-id]')?.getAttribute('data-composer-id')
        || containerComposerId
        || '';
      const description = title || cmdText || descText || 'Command pending approval';
      if (isBackgroundApprovalLabel(description)) return null;
      if (!actions.some((a) => a.type === 'approve')) return null;

      const bubble = card.closest('[data-tool-call-id]');
      const toolCallId = bubble?.getAttribute('data-tool-call-id') || buildSelectorPath(card);
      return {
        id: `tool:${toolCallId}`,
        description,
        title: title || undefined,
        command: cmdText || undefined,
        reason: reason || undefined,
        mode: mode || undefined,
        composerId: composerId || undefined,
        actions,
      };
    };

    const collectRowActions = (row: Element): CursorState['pendingApprovals'][0]['actions'] => {
      const actions: CursorState['pendingApprovals'][0]['actions'] = [];
      const runBtn = row.querySelector('button.ui-shell-tool-call__run-btn');
      if (runBtn && !isMenuTrigger(runBtn)) {
        const runLabel = cleanBtnLabel(getButtonLabel(runBtn));
        if (runLabel && !isBackgroundApprovalLabel(runLabel) && looksLikeButtonLabel(runLabel)) {
          actions.push({
            label: runLabel,
            type: 'approve',
            selectorPath: buildSelectorPath(runBtn),
          });
        }
      }
      const allowlistBtn = row.querySelector('button.ui-shell-tool-call__allowlist-button');
      if (allowlistBtn && !isMenuTrigger(allowlistBtn)) {
        const lblEl = allowlistBtn.querySelector('.ui-shell-tool-call__allowlist-button-label');
        actions.push({
          label: cleanBtnLabel(lblEl?.textContent || allowlistBtn.textContent || '') || 'Allowlist',
          type: 'approve',
          selectorPath: buildSelectorPath(allowlistBtn),
        });
      }
      const skipBtn = row.querySelector('button.ui-shell-tool-call__skip-btn');
      if (skipBtn && !isMenuTrigger(skipBtn)) {
        const skipLabel = cleanBtnLabel(getButtonLabel(skipBtn)) || 'Skip';
        if (!isGarbageActionLabel(skipLabel)) {
          actions.push({
            label: skipLabel,
            type: 'reject',
            selectorPath: buildSelectorPath(skipBtn),
          });
        }
      }
      return actions;
    };

    const seenCards = new Set<Element>();
    const approvalRows = container.querySelectorAll('.ui-shell-tool-call__approval-row');
    for (const row of Array.from(approvalRows)) {
      const card = row.closest('.ui-tool-call-card') || row.closest('.ui-shell-tool-call');
      if (!card || seenCards.has(card)) continue;

      const cardText = (card.textContent || '').replace(/\s+/g, ' ').trim();
      if (isBackgroundApprovalLabel(cardText)) continue;

      const actions = collectRowActions(row);
      const entry = buildApprovalFromCard(card, row, actions);
      if (!entry) continue;
      seenCards.add(card);
      pendingApprovals.push(entry);
    }

    if (pendingApprovals.length === 0) {
      const approveButtons: { label: string; selector: string; el: Element }[] = [];
      const rejectButtons: { label: string; selector: string; el: Element }[] = [];
      const seenApproveBtns = new Set<Element>();
      const seenRejectBtns = new Set<Element>();

      for (const sel of approveSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenApproveBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = getButtonLabel(btn);
            if (
              label &&
              !isBackgroundApprovalLabel(label) &&
              looksLikeButtonLabel(label)
            ) {
              seenApproveBtns.add(btn);
              approveButtons.push({ label, selector: buildSelectorPath(btn), el: btn });
            }
          }
        } catch { /* skip */ }
      }
      if (approveButtons.length === 0 && approveTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenApproveBtns.has(btn) || isMenuTrigger(btn)) continue;
          const text = `${getButtonLabel(btn)} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
          if (isBackgroundApprovalLabel(text)) continue;
          for (const pat of approveTextMatch) {
            if (matchesActionPattern(text, pat)) {
              const label = getButtonLabel(btn) || pat;
              if (
                isBackgroundApprovalLabel(label) ||
                isBackgroundApprovalLabel(text) ||
                !looksLikeButtonLabel(label)
              ) {
                break;
              }
              seenApproveBtns.add(btn);
              approveButtons.push({ label, selector: buildSelectorPath(btn), el: btn });
              break;
            }
          }
        }
      }

      for (const sel of rejectSelectors) {
        try {
          const btns = container.querySelectorAll(sel);
          for (const btn of Array.from(btns)) {
            if (seenRejectBtns.has(btn) || isMenuTrigger(btn)) continue;
            const label = getButtonLabel(btn);
            if (label && !isGarbageActionLabel(label)) {
              seenRejectBtns.add(btn);
              rejectButtons.push({ label, selector: buildSelectorPath(btn), el: btn });
            }
          }
        } catch { /* skip */ }
      }
      if (rejectButtons.length === 0 && rejectTextMatch.length > 0) {
        for (const btn of Array.from(container.querySelectorAll('button'))) {
          if (seenRejectBtns.has(btn) || isMenuTrigger(btn)) continue;
          const text = `${getButtonLabel(btn)} ${btn.getAttribute('aria-label') || ''}`.toLowerCase();
          for (const pat of rejectTextMatch) {
            if (matchesActionPattern(text, pat)) {
              const label = getButtonLabel(btn) || pat;
              if (isGarbageActionLabel(label)) break;
              seenRejectBtns.add(btn);
              rejectButtons.push({ label, selector: buildSelectorPath(btn), el: btn });
              break;
            }
          }
        }
      }

      if (approveButtons.length > 0) {
        const cardByBtn = new Map<Element, { approve: typeof approveButtons; reject: typeof rejectButtons }>();
        for (const btn of approveButtons) {
          const card = btn.el.closest('.ui-tool-call-card') || btn.el.closest('.ui-shell-tool-call');
          if (!card || seenCards.has(card)) continue;
          const bucket = cardByBtn.get(card) ?? { approve: [], reject: [] };
          bucket.approve.push(btn);
          cardByBtn.set(card, bucket);
        }
        for (const btn of rejectButtons) {
          const card = btn.el.closest('.ui-tool-call-card') || btn.el.closest('.ui-shell-tool-call');
          if (!card || seenCards.has(card)) continue;
          const bucket = cardByBtn.get(card) ?? { approve: [], reject: [] };
          bucket.reject.push(btn);
          cardByBtn.set(card, bucket);
        }

        for (const [card, bucket] of cardByBtn) {
          if (bucket.approve.length === 0) continue;
          const actions: CursorState['pendingApprovals'][0]['actions'] = [];
          for (const btn of bucket.approve) {
            actions.push({
              label: btn.label,
              type: isApproveAllLabel(btn.label) ? 'approve_all' : 'approve',
              selectorPath: btn.selector,
            });
          }
          for (const btn of bucket.reject) {
            actions.push({ label: btn.label, type: 'reject', selectorPath: btn.selector });
          }
          const row = card.querySelector('.ui-shell-tool-call__approval-row');
          const entry = buildApprovalFromCard(card, row, actions);
          if (!entry) continue;
          // Bare approve-label cards with no command/title are false positives
          // (e.g. unrelated "Run" controls). Keep Allow/Accept when they still
          // have real actions but never treat the label itself as the command.
          if (
            !entry.command
            && !entry.title
            && isApproveActionLabel(entry.description)
          ) {
            entry.description = 'Command pending approval';
          }
          if (
            !entry.command
            && !entry.title
            && entry.description === 'Command pending approval'
            && /^run$/i.test(
              bucket.approve[0]?.label?.trim() || '',
            )
          ) {
            // Empty "Run" without payload is almost always a non-approval control.
            continue;
          }
          seenCards.add(card);
          pendingApprovals.push(entry);
        }

        const usedApprove = new Set<Element>();
        for (const bucket of cardByBtn.values()) {
          for (const btn of bucket.approve) usedApprove.add(btn.el);
        }
        for (const btn of approveButtons) {
          if (usedApprove.has(btn.el)) continue;
          // Bare "Run" without a tool card is usually a false positive; other
          // approve labels (Allow / Accept) may still be real approvals whose
          // command text lives outside the legacy selectors.
          if (/^run$/i.test(btn.label.trim())) continue;
          const actions: CursorState['pendingApprovals'][0]['actions'] = [{
            label: btn.label,
            type: isApproveAllLabel(btn.label) ? 'approve_all' : 'approve',
            selectorPath: btn.selector,
          }];
          for (const rej of rejectButtons) {
            if (rej.el.closest('.ui-tool-call-card') || rej.el.closest('.ui-shell-tool-call')) continue;
            actions.push({ label: rej.label, type: 'reject', selectorPath: rej.selector });
          }
          const labelIsApproveOnly = isApproveActionLabel(btn.label);
          pendingApprovals.push({
            id: `legacy:${btn.selector}`,
            description: labelIsApproveOnly ? 'Command pending approval' : btn.label,
            composerId: containerComposerId || undefined,
            actions,
          });
        }
      }
    }

    const actionableApprovals = pendingApprovals.filter((entry) => isActionableApproval(entry));

    // --- Cursor Multitask subagents (separate from background terminals/tools) ---
    const subagentItems: CursorState['subagents']['items'] = [];
    const subagentKeys = new Set<string>();
    const multitaskToolbar =
      container.querySelector('#composer-toolbar-section')
      || document.querySelector('#composer-toolbar-section');
    const subagentSummaryRe = /^(\d+)\s+subagents?\s+running$/i;
    let subagentSummary = '';
    let subagentSummaryCount = 0;
    let subagentToolbarExpandPath: string | undefined;
    const hasSubagentChevron = (row: Element): boolean =>
      !!row.querySelector(
        '.codicon-chevron-right, .codicon-chevron-down, i[data-icon-name="chevron-right"], i[data-icon-name="chevron-down"]',
      );
    if (multitaskToolbar) {
      for (const el of Array.from(multitaskToolbar.querySelectorAll('div, span'))) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const match = text.match(subagentSummaryRe);
        if (!match) continue;
        if (Array.from(el.children).some(child => subagentSummaryRe.test((child.textContent || '').replace(/\s+/g, ' ').trim()))) {
          continue;
        }
        subagentSummary = text;
        subagentSummaryCount = Math.max(subagentSummaryCount, parseInt(match[1], 10));
        const expandRow =
          el.closest('.composer-toolbar-section-header')
          || el.closest('.composer-toolbar-background-job-item-clickable')
          || el.closest('[style*="cursor: pointer"]')
          || el.parentElement;
        if (expandRow && hasSubagentChevron(expandRow)) {
          subagentToolbarExpandPath = buildSelectorPath(expandRow);
        }
      }
    }

    const findToolbarStopDescriptor = (title: string, model?: string) => {
      if (!multitaskToolbar) return undefined;
      const normTitle = title.replace(/\s+/g, ' ').trim().toLowerCase();
      let sawMatch = false;
      for (const job of Array.from(multitaskToolbar.querySelectorAll('.composer-toolbar-background-job-item'))) {
        if (job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal')) continue;
        const jobTitle = (
          job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
          || job.textContent?.replace(/\bStop\b/gi, '')
          || ''
        ).replace(/\s+/g, ' ').trim();
        if (!jobTitle || jobTitle.toLowerCase() !== normTitle) continue;
        const stopEl = job.querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
        if (!stopEl) continue;
        sawMatch = true;
      }
      if (!sawMatch) return undefined;
      return {
        kind: 'toolbarStop' as const,
        matchTitle: title.replace(/\s+/g, ' ').trim(),
        ...(model ? { matchModel: model.replace(/\s+/g, ' ').trim() } : {}),
      };
    };

    const normalizeDomId = (value: string | null | undefined): string | undefined => {
      const normalized = (value || '').replace(/\s+/g, ' ').trim();
      return normalized || undefined;
    };

    const readSubagentCardStopIdentity = (card: Element): {
      toolCallId?: string;
      messageId?: string;
      composerId?: string;
    } => {
      const row = card.closest('[data-tool-call-id], [data-message-id]');
      const composerEl =
        card.closest('[data-composer-id]')
        || container.closest('[data-composer-id]')
        || document.querySelector('#container[data-composer-id]');
      return {
        toolCallId: normalizeDomId(row?.getAttribute('data-tool-call-id')),
        messageId: normalizeDomId(row?.getAttribute('data-message-id')),
        composerId: normalizeDomId(composerEl?.getAttribute('data-composer-id')),
      };
    };

    const addSubagent = (
      title: string,
      model: string | undefined,
      status: CursorState['subagents']['items'][number]['status'],
      statusText?: string,
      capabilities?: {
        openSelectorPath?: string;
        toolbarExpandSelectorPath?: string;
        stop?: NonNullable<CursorState['subagents']['items'][number]['_capabilities']>['stop'];
      },
    ): void => {
      const cleanTitle = title.replace(/\s+/g, ' ').trim().substring(0, 160);
      if (!cleanTitle) return;
      const cleanModel = model?.replace(/\s+/g, ' ').trim().substring(0, 80) || undefined;
      const key = `${cleanTitle.toLowerCase()}|${(cleanModel || '').toLowerCase()}`;
      const openSelectorPath = capabilities?.openSelectorPath;
      const incomingStop = capabilities?.stop ?? findToolbarStopDescriptor(cleanTitle, cleanModel);
      const toolbarExpandSelectorPath = capabilities?.toolbarExpandSelectorPath ?? subagentToolbarExpandPath;
      const openAvailable = !!openSelectorPath;
      const stopAvailable = !!incomingStop;
      const existing = subagentItems.find(item => item.id === `subagent:${key}`);
      if (existing) {
        if (status === 'running') existing.status = 'running';
        if (!existing.statusText && statusText) existing.statusText = statusText;
        existing.openAvailable = existing.openAvailable || openAvailable;
        existing.stopAvailable = existing.stopAvailable || stopAvailable;
        const prevCaps = existing._capabilities;
        existing._capabilities = {
          matchTitle: cleanTitle,
          ...(cleanModel ? { matchModel: cleanModel } : {}),
          openSelectorPath: prevCaps?.openSelectorPath || openSelectorPath,
          toolbarExpandSelectorPath: prevCaps?.toolbarExpandSelectorPath || toolbarExpandSelectorPath,
          stop: prevCaps?.stop || incomingStop,
        };
        return;
      }
      subagentKeys.add(cleanTitle.toLowerCase());
      subagentItems.push({
        id: `subagent:${key}`,
        title: cleanTitle,
        ...(cleanModel ? { model: cleanModel } : {}),
        status,
        ...(statusText ? { statusText: statusText.substring(0, 120) } : {}),
        openAvailable,
        stopAvailable,
        _capabilities: {
          matchTitle: cleanTitle,
          ...(cleanModel ? { matchModel: cleanModel } : {}),
          ...(openSelectorPath ? { openSelectorPath } : {}),
          ...(toolbarExpandSelectorPath ? { toolbarExpandSelectorPath } : {}),
          ...(incomingStop ? { stop: incomingStop } : {}),
        },
      });
    };

    const dedupeRepeatedText = (value: string): string => {
      const text = value.replace(/\s+/g, ' ').trim();
      if (text.length >= 4 && text.length % 2 === 0) {
        const half = text.slice(0, text.length / 2);
        if (half === text.slice(half.length)) return half;
      }
      return text;
    };

    const readSubagentCardTitle = (card: Element): string => {
      // Current Cursor: title is the leaf span immediately before [data-subagent-task-model].
      const modelEl = card.querySelector('[data-subagent-task-model="true"]');
      const modelSibling = modelEl?.previousElementSibling;
      const siblingTitle = (modelSibling?.textContent || '').replace(/\s+/g, ' ').trim();
      if (siblingTitle) return siblingTitle;

      const titled =
        card.querySelector('.subagent-task-card-title[title]')
        || card.querySelector('[data-subagent-task-card-header="true"] [title]')
        || card.querySelector('.subagent-task-card-title');
      const fromAttr = titled?.getAttribute('title') || '';
      if (fromAttr.trim()) return fromAttr;
      return (titled?.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const readSubagentCardModel = (card: Element): string | undefined => {
      const modelEl =
        card.querySelector('[data-subagent-task-model="true"]')
        || card.querySelector('.task-subagent-model-hover-trigger');
      const model = (modelEl?.textContent || '').replace(/\s+/g, ' ').trim();
      return model || undefined;
    };

    const readSubagentCardStopEl = (card: Element): Element | null =>
      card.querySelector('[data-subagent-task-action="stop"]')
      || card.querySelector('.task-subagent-header-pill-button--stop');

    const collectSubagentCards = (root: Element | Document): Element[] => {
      const seen = new Set<Element>();
      const cards: Element[] = [];
      for (const card of Array.from(root.querySelectorAll(
        '[data-subagent-task-card="true"], .subagent-task-card[data-chrome="card"]',
      ))) {
        if (seen.has(card)) continue;
        seen.add(card);
        cards.push(card);
      }
      return cards;
    };

    const ingestSubagentCards = (root: Element | Document): void => {
      for (const card of collectSubagentCards(root)) {
        const title = readSubagentCardTitle(card);
        const model = readSubagentCardModel(card);
        const running = !!card.querySelector('.ui-subagent-status-indicator--running-loader');
        const statusText = dedupeRepeatedText(
          card.querySelector('[data-shimmer="true"]')?.textContent
          || card.querySelector('.ui-text-roll__item')?.textContent
          || '',
        );
        const cardStopEl = readSubagentCardStopEl(card);
        const cleanTitle = title.replace(/\s+/g, ' ').trim();
        const cleanModel = model?.replace(/\s+/g, ' ').trim();
        let status: CursorState['subagents']['items'][number]['status'] = 'unknown';
        if (running) status = 'running';
        else if (/\b(error|failed)\b/i.test(statusText)) status = 'error';
        else if (/\b(waiting|blocked)\b/i.test(statusText)) status = 'waiting';
        else if (/\b(done|complete(?:d)?|finished)\b/i.test(statusText)) status = 'completed';
        const openTarget =
          card.querySelector('[data-subagent-task-card-header="true"]')
          || card;
        addSubagent(title, model, status, statusText || undefined, {
          openSelectorPath: cleanTitle ? buildSelectorPath(openTarget) : undefined,
          stop: cardStopEl ? {
            kind: 'cardStop',
            matchTitle: cleanTitle,
            ...(cleanModel ? { matchModel: cleanModel } : {}),
            ...readSubagentCardStopIdentity(card),
          } : undefined,
        });
      }
    };

    const ingestToolbarSubagentJobs = (): void => {
      if (!multitaskToolbar || subagentSummaryCount <= 0) return;
      for (const job of Array.from(multitaskToolbar.querySelectorAll('.composer-toolbar-background-job-item'))) {
        if (job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal')) continue;
        const title = (
          job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
          || job.textContent?.replace(/\bStop\b/gi, '')
          || ''
        ).replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const stopEl = job.querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
        addSubagent(title, undefined, 'running', 'Running', {
          stop: stopEl ? { kind: 'toolbarStop', matchTitle: title } : undefined,
          toolbarExpandSelectorPath: subagentToolbarExpandPath,
        });
      }
    };

    ingestSubagentCards(container);
    ingestSubagentCards(document);
    ingestToolbarSubagentJobs();

    // Collapsed multitask toolbar: expand once when summary promises more workers than we extracted.
    if (
      multitaskToolbar
      && subagentToolbarExpandPath
      && subagentSummaryCount > subagentItems.length
    ) {
      try {
        const expandEl = document.querySelector(subagentToolbarExpandPath);
        if (expandEl instanceof HTMLElement) {
          expandEl.scrollIntoView({ block: 'center', behavior: 'instant' });
          expandEl.click();
          ingestToolbarSubagentJobs();
          ingestSubagentCards(document);
        }
      } catch {
        // ignore invalid expand selector / click failures
      }
    }

    if (subagentSummaryCount === 1 && subagentToolbarExpandPath) {
      const runningItems = subagentItems.filter(item => item.status === 'running');
      if (runningItems.length === 0) {
        addSubagent('Running subagent', undefined, 'running', subagentSummary || undefined, {
          toolbarExpandSelectorPath: subagentToolbarExpandPath,
          stop: { kind: 'singleJobAfterExpand', matchTitle: 'Running subagent' },
        });
      } else if (runningItems.length === 1 && !runningItems[0]!.stopAvailable) {
        const item = runningItems[0]!;
        item.stopAvailable = true;
        item._capabilities = {
          matchTitle: item._capabilities?.matchTitle || item.title,
          ...(item._capabilities?.matchModel ? { matchModel: item._capabilities.matchModel } : {}),
          ...(item._capabilities?.openSelectorPath ? { openSelectorPath: item._capabilities.openSelectorPath } : {}),
          toolbarExpandSelectorPath: item._capabilities?.toolbarExpandSelectorPath || subagentToolbarExpandPath,
          stop: item._capabilities?.stop || { kind: 'singleJobAfterExpand', matchTitle: item.title },
        };
      }
    }

    const runningSubagentItems = subagentItems.filter(item => item.status === 'running').length;
    const runningCount = Math.max(subagentSummaryCount, runningSubagentItems);
    if (!subagentSummary && runningCount > 0) {
      subagentSummary = `${runningCount} subagent${runningCount === 1 ? '' : 's'} running`;
    }
    const subagents: CursorState['subagents'] = {
      runningCount,
      summary: subagentSummary,
      items: subagentItems,
    };

    // --- Agent-authored file changes (not extension Git status) ---
    let fileCount = 0;
    let reviewEl: Element | null = null;
    let undoAllEl: Element | null = null;
    if (multitaskToolbar) {
      for (const el of Array.from(multitaskToolbar.querySelectorAll('div, span'))) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const fileMatch = text.match(/^(\d+)\s+Files?$/i);
        if (fileMatch && !Array.from(el.children).some(child => /^\d+\s+Files?$/i.test((child.textContent || '').trim()))) {
          fileCount = Math.max(fileCount, parseInt(fileMatch[1], 10));
        }
      }
      for (const action of Array.from(multitaskToolbar.querySelectorAll('div[data-click-ready="true"]'))) {
        const label = (action.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^Review$/i.test(label)) reviewEl = action;
        else if (/^Undo All$/i.test(label)) undoAllEl = action;
      }
    }
    const agentChanges: CursorState['agentChanges'] = {
      fileCount,
      reviewAvailable: reviewEl !== null,
      undoAllAvailable: undoAllEl !== null,
      ...(reviewEl ? { reviewSelectorPath: buildSelectorPath(reviewEl) } : {}),
      ...(undoAllEl ? { undoAllSelectorPath: buildSelectorPath(undoAllEl) } : {}),
    };

    // --- Background task / terminal extraction ---
    const backgroundTasks: CursorState['backgroundTasks'] = [];
    const seenBackgroundCards = new Set<Element>();
    const stopLabelRe = /\b(stop|cancel|interrupt|terminate|kill)\b/i;
    const findStopButton = (card: Element): Element | null => {
      const composerStop = card.querySelector('[data-stop-button="true"]');
      if (composerStop) return composerStop;

      const debugStopIcon = card.querySelector('.codicon-debug-stop');
      const debugStopControl = debugStopIcon?.closest('[data-click-ready="true"], .anysphere-icon-button, button');
      if (debugStopControl) return debugStopControl;

      const buttons = Array.from(card.querySelectorAll('button')) as HTMLButtonElement[];
      for (const btn of buttons) {
        const label = `${getButtonLabel(btn)} ${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`.trim();
        if (stopLabelRe.test(label)) return btn;
      }
      return null;
    };
    const findComposerStopControl = (): Element | null => {
      const explicit = document.querySelector('[data-stop-button="true"]');
      if (explicit) return explicit;

      const debugStopIcon = document.querySelector('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop');
      return debugStopIcon?.closest('[data-click-ready="true"], .anysphere-icon-button, button') ?? null;
    };
    const cleanTaskText = (raw: string): string =>
      raw.replace(/\s+/g, ' ').replace(/^\$\s*/, '').trim();
    const isInTranscript = isTranscriptMessage;
    const backgroundSummaryRe = /^(\d+)\s+background\s+(?:terminal|task)s?$/i;
    const hasSummaryChevron = (row: Element): boolean =>
      !!row.querySelector(
        '.codicon-chevron-right, .codicon-chevron-down, i[data-icon-name="chevron-right"], i[data-icon-name="chevron-down"]',
      );
    const isFinishedToolCallLine = (el: Element): boolean => {
      const line = el.closest('.ui-tool-call-line, .ui-collapsible-header');
      if (!line) return false;
      const action = line.querySelector('.ui-tool-call-line-action, .ui-collapsible-action');
      return /^finished$/i.test(cleanTaskText(action?.textContent || ''));
    };
    const collectBackgroundSummary = (root: Element, source: 'toolbar' | 'transcript'): void => {
      for (const el of Array.from(root.querySelectorAll('div, span'))) {
        const label = cleanTaskText(el.textContent || '');
        const match = label.match(backgroundSummaryRe);
        if (!match) continue;
        if (Array.from(el.children).some(child => backgroundSummaryRe.test(cleanTaskText(child.textContent || '')))) {
          continue;
        }
        if (source === 'transcript' && isFinishedToolCallLine(el)) continue;

        const row =
          el.closest('.composer-toolbar-background-job-item-clickable') ||
          el.closest('.group[style*="cursor: pointer"], .group[style*="cursor:pointer"]') ||
          el.closest('[style*="cursor: pointer"]') ||
          el.parentElement;
        if (!row || seenBackgroundCards.has(row)) continue;
        if (!hasSummaryChevron(row)) continue;

        const summaryCount = parseInt(match[1], 10);
        if (!Number.isFinite(summaryCount) || summaryCount <= 0) continue;

        seenBackgroundCards.add(row);
        backgroundTasks.push({
          id: `background:summary:${source}:${buildSelectorPath(row)}`,
          label,
          expandSelectorPath: buildSelectorPath(row),
        });
      }
    };

    const toolbarBackgroundJobs = document.querySelectorAll('.composer-toolbar-background-job-item');
    for (const job of Array.from(toolbarBackgroundJobs)) {
      const jobTitle = cleanTaskText(
        job.querySelector('.composer-toolbar-background-job-item-text')?.textContent || '',
      ).toLowerCase();
      const looksLikeSubagent =
        subagentSummaryCount > 0
        && !job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal')
        && (subagentKeys.size === 0 || subagentKeys.has(jobTitle));
      if (looksLikeSubagent) continue;
      const stopEl = job.querySelector('.composer-toolbar-background-job-item-stop, [class*="background-job"][class*="stop"]');
      if (!stopEl) continue;
      const label = cleanTaskText(
        job.querySelector('.composer-toolbar-background-job-item-text')?.textContent ||
        job.textContent?.replace(/\bStop\b/gi, '') ||
        ''
      ).substring(0, 120) || 'Background terminal';
      const id = job.getAttribute('data-tool-call-id') || buildSelectorPath(job);

      seenBackgroundCards.add(job);
      backgroundTasks.push({
        id: `background:${id}`,
        label,
        stopSelectorPath: buildSelectorPath(stopEl),
      });
    }

    // Live background count lives in #composer-toolbar-section above the input box.
    for (const toolbarRoot of [
      document.querySelector('#composer-toolbar-section'),
      document.querySelector('.composer-bar.editor #composer-toolbar-section'),
      document.querySelector('.composer-bar #composer-toolbar-section'),
    ]) {
      if (toolbarRoot && !seenBackgroundCards.has(toolbarRoot)) {
        collectBackgroundSummary(toolbarRoot, 'toolbar');
      }
    }

    const foregroundWaitingRe = /Waiting for (\d+) commands? to finish/i;
    for (const nudge of Array.from(document.querySelectorAll('.composer-foreground-shell-background-nudge-line'))) {
      if (seenBackgroundCards.has(nudge)) continue;
      const actionText = cleanTaskText(
        nudge.querySelector('.ui-tool-call-line-action')?.textContent || nudge.textContent || '',
      );
      const match = actionText.match(foregroundWaitingRe);
      if (!match) continue;
      const waitCount = parseInt(match[1], 10);
      if (!Number.isFinite(waitCount) || waitCount <= 0) continue;

      const relatedShell = nudge.closest('[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message')
        ?.querySelector('.ui-shell-tool-call--with-stop')
        ?? nudge.parentElement?.querySelector('.ui-shell-tool-call--with-stop');
      const stopEl = relatedShell?.querySelector('.ui-shell-tool-call__glass-stop');

      seenBackgroundCards.add(nudge);
      backgroundTasks.push({
        id: `foreground:waiting:${buildSelectorPath(nudge)}`,
        label: `Waiting for ${waitCount} command${waitCount === 1 ? '' : 's'} to finish`,
        ...(stopEl ? { stopSelectorPath: buildSelectorPath(stopEl) } : {}),
      });
    }

    // Transcript may surface active (non-finished) background summaries separately from the toolbar.
    const transcriptRoot = container.querySelector(
      '.composer-messages-container, .virtualized-composer-messages-scroll-container, .virtualized-composer-messages-layout',
    ) ?? container;
    collectBackgroundSummary(transcriptRoot, 'transcript');

    let maxSummaryCount = 0;
    for (const task of backgroundTasks) {
      const match = task.label.trim().match(backgroundSummaryRe);
      if (match) maxSummaryCount = Math.max(maxSummaryCount, parseInt(match[1], 10));
    }

    const detailedCount = backgroundTasks.filter(task => !backgroundSummaryRe.test(task.label.trim())).length;
    if (maxSummaryCount > detailedCount) {
      const hasSummaryLabel = backgroundTasks.some(task => {
        const summaryMatch = task.label.trim().match(backgroundSummaryRe);
        return summaryMatch && parseInt(summaryMatch[1], 10) === maxSummaryCount;
      });
      if (!hasSummaryLabel) {
        backgroundTasks.push({
          id: `background:summary:count:${maxSummaryCount}`,
          label: `${maxSummaryCount} background ${maxSummaryCount === 1 ? 'terminal' : 'terminals'}`,
        });
      }
    }

    const backgroundStopButtons = Array.from(
      document.querySelectorAll('.ui-shell-tool-call__glass-stop, button[aria-label="Stop command"]'),
    ) as HTMLButtonElement[];
    for (const stopBtn of backgroundStopButtons) {
      const card =
        stopBtn.closest('.ui-shell-tool-call') ||
        stopBtn.closest('.ui-tool-call-card') ||
        stopBtn.closest('[class*="background"]') ||
        stopBtn.parentElement;
      if (!card || seenBackgroundCards.has(card)) continue;

      const inTranscript = isTranscriptMessage(stopBtn);
      const isStoppableShellCall =
        stopBtn.classList.contains('ui-shell-tool-call__glass-stop') ||
        !!stopBtn.closest('.ui-shell-tool-call--with-stop') ||
        !!card.querySelector('.ui-shell-tool-call__command');
      if (inTranscript && !isStoppableShellCall) continue;

      const commandEl =
        card.querySelector('.ui-shell-tool-call__command') ||
        card.querySelector('.composer-terminal-command-expanded-text') ||
        card.querySelector('.composer-terminal-command-editor') ||
        card.querySelector('.composer-terminal-command-wrapper') ||
        card.querySelector('.composer-tool-call-header-content');
      const descEl =
        card.querySelector('.ui-shell-tool-call__description') ||
        card.querySelector('.composer-terminal-top-header-description');
      const cardText = cleanTaskText(card.textContent || '');
      const label = cleanTaskText(commandEl?.textContent || descEl?.textContent || cardText.replace(/\bStop\b/gi, ''))
        .substring(0, 120) || 'Background task';
      const detail = cleanTaskText(descEl?.textContent || '')
        .substring(0, 160) || undefined;
      const id = card.getAttribute('data-tool-call-id') || buildSelectorPath(card);

      seenBackgroundCards.add(card);
      backgroundTasks.push({
        id: `background:${id}`,
        label,
        ...(detail && detail !== label ? { detail } : {}),
        stopSelectorPath: buildSelectorPath(stopBtn),
      });
    }
    const agentStopButton = findComposerStopControl() || findStopButton(container);
    const agentStopSelectorPath = agentStopButton
      ? buildSelectorPath(agentStopButton)
      : (backgroundTasks.find((task) => task.stopSelectorPath)?.stopSelectorPath ?? '');
    const agentStopSource = agentStopButton
      ? 'composer'
      : (backgroundTasks.some((task) => task.stopSelectorPath) ? 'background_task' : 'none');
    const agentStopAvailable = agentStopSource !== 'none';

    // --- Agent status ---
    const statusEl = findFirstWithin(container, statusSelectors);
    let agentStatus: CursorState['agentStatus'] = 'idle';
    if (statusEl) {
      const statusText = (statusEl.textContent || '').toLowerCase();
      const combined = `${statusText} ${statusEl.classList.toString().toLowerCase()}`;
      if (combined.includes('error') || combined.includes('fail')) agentStatus = 'error';
      else if (/\b(approv|confirm|permission|allow)\w*/.test(statusText)) agentStatus = 'waiting_approval';
      else if (/\b(question|choose|select an option)\b/.test(statusText)) agentStatus = 'waiting_question';
      else if (/\b(waiting|input required|action required)\b/.test(statusText)) agentStatus = 'waiting_user_input';
      else if (combined.includes('think')) agentStatus = 'thinking';
      else if (combined.includes('generat')) agentStatus = 'generating';
      else if (combined.includes('running') || combined.includes('execut')) agentStatus = 'running_tool';
    }
    if (actionableApprovals.length > 0) agentStatus = 'waiting_approval';
    if (agentStatus === 'idle' && agentStopSelectorPath) {
      agentStatus = 'generating';
    }
    const composerStatusEl =
      container.closest('[data-composer-status]')
      || container.querySelector('[data-composer-status]');
    const composerStatus = composerStatusEl?.getAttribute('data-composer-status')?.toLowerCase() || '';
    if (agentStatus === 'idle' && /running|generating|loading|thinking/.test(composerStatus)) {
      agentStatus = 'generating';
    }

    // Element-based status detection removed: tool loading badges and
    // run_command elements persist in the DOM long after completion.
    // Shimmer + .loading-indicator-v3 (checked below) are the ground truth.

    const inputEl = findFirst(inputSelectors);
    const composerBarRoot =
      container.closest('.composer-bar')
      || container.querySelector('.composer-bar')
      || (container.matches?.('.composer-bar') ? container : null);
    const auxiliaryBar = document.querySelector('#workbench\\.parts\\.auxiliarybar');
    const composerInputSelectors = inputSelectors.filter((sel) =>
      sel.includes('composer-bar') || sel.includes('auxiliarybar'),
    );
    let composerInputEl: Element | null = null;
    if (composerBarRoot) {
      composerInputEl = findFirstWithin(
        composerBarRoot,
        composerInputSelectors.length > 0 ? composerInputSelectors : inputSelectors,
      );
    } else if (auxiliaryBar) {
      composerInputEl = findFirstWithin(
        auxiliaryBar,
        composerInputSelectors.length > 0 ? composerInputSelectors : inputSelectors,
      );
    }
    const composerInputAvailable = composerInputEl !== null;

    // --- Chat tabs from agent sidebar/history cells ---
    const chatTabs: ChatTab[] = [];

    function cleanTabTitle(raw: string): string {
      let t = raw.trim().replace(/\s+/g, ' ');
      t = t.replace(/(@[\w./]+)+\s*$/, '');
      return t.trim().substring(0, 120);
    }

    const hiddenSidebarTabTitles = new Set(['automations', 'customize']);

    function isHiddenSidebarTab(title: string): boolean {
      const base = cleanTabTitle(title).toLowerCase();
      if (hiddenSidebarTabTitles.has(base)) return true;
      const slash = base.lastIndexOf(' / ');
      if (slash >= 0) return hiddenSidebarTabTitles.has(base.slice(slash + 3));
      return false;
    }

    function deriveWorkStatusFromSidebarCell(cell: Element): ChatTab['workStatus'] {
      const iconDefault = cell.querySelector('.agent-sidebar-cell-icon-default');
      if (iconDefault?.querySelector('.spinning-loader')) return 'running';
      if (cell.getAttribute('data-has-subtitle') === 'true') return 'completed';
      return 'idle';
    }

    function deriveWorkStatusFromGlassBtn(btn: Element): ChatTab['workStatus'] {
      if (btn.querySelector('.spinning-loader')) return 'running';
      return 'idle';
    }

    function deriveWorkStatusFromComposer(composerId: string): ChatTab['workStatus'] {
      if (!composerId || /^open:|^tab-|^glass:/.test(composerId)) return 'idle';
      const els = document.querySelectorAll(`[data-composer-id="${composerId}"]`);
      for (const el of Array.from(els)) {
        const s = (el.getAttribute('data-composer-status') || '').toLowerCase();
        if (s && s !== 'idle' && s !== 'completed' && s !== 'done') return 'running';
      }
      return 'idle';
    }

    function isComposerUuid(value: string): boolean {
      return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    function reconcileOpenTabComposerIds(tabs: ChatTab[]): void {
      const sidebarByTitle = new Map<string, string>();
      for (const t of tabs) {
        if (t.source !== 'sidebar' || !isComposerUuid(t.composerId)) continue;
        const key = cleanTabTitle(t.title).toLowerCase();
        if (key && !sidebarByTitle.has(key)) sidebarByTitle.set(key, t.composerId);
      }
      for (const t of tabs) {
        if (t.source !== 'open' || isComposerUuid(t.composerId)) continue;
        const cid = sidebarByTitle.get(cleanTabTitle(t.title).toLowerCase());
        if (cid) t.composerId = cid;
      }
      if (containerComposerId) {
        for (const t of tabs) {
          if (t.source !== 'open' || !t.isActive || isComposerUuid(t.composerId)) continue;
          t.composerId = containerComposerId;
        }
      }
    }

    function syncOpenTabWorkStatus(tabs: ChatTab[]): void {
      const byTitle = new Map<string, ChatTab['workStatus']>();
      for (const t of tabs) {
        if (t.source === 'sidebar') byTitle.set(t.title.toLowerCase(), t.workStatus);
      }
      for (const t of tabs) {
        if (t.source !== 'open') continue;
        if (deriveWorkStatusFromComposer(t.composerId) === 'running') {
          t.workStatus = 'running';
          continue;
        }
        t.workStatus = byTitle.get(t.title.toLowerCase()) ?? t.workStatus;
      }
    }

    function markSidebarActiveByComposer(tabs: ChatTab[]): void {
      if (!containerComposerId) return;
      let matched = false;
      for (const t of tabs) {
        if (t.source !== 'sidebar') continue;
        if (t.composerId === containerComposerId) {
          matched = true;
          t.isActive = true;
          t.status = 'active';
        }
      }
      if (!matched) return;
      for (const t of tabs) {
        if (t.source !== 'sidebar') continue;
        if (t.composerId !== containerComposerId) {
          t.isActive = false;
          t.status = 'idle';
        }
      }
    }

    try {
      const seenOpenIds = new Set<string>();
      const openTabEls = document.querySelectorAll(
        '.tabs-container .tab[aria-label*="Chat Editors"], .editor-group-container.has-composer-editor .tab[role="tab"]'
      );
      for (const tab of Array.from(openTabEls)) {
        const resourceId = tab.getAttribute('data-resource-name') || '';
        if (resourceId && seenOpenIds.has(resourceId)) continue;
        if (resourceId) seenOpenIds.add(resourceId);

        const ariaLabel = tab.getAttribute('aria-label') || '';
        const rawTitle = (ariaLabel.split(',')[0] || (tab.textContent || '')).trim();
        const title = cleanTabTitle(rawTitle);
        if (!title) continue;

        const isActive = tab.getAttribute('aria-selected') === 'true';
        chatTabs.push({
          composerId: resourceId || `open:${title}`,
          title,
          isActive,
          status: isActive ? 'active' : 'idle',
          selectorPath: buildSelectorPath(tab),
          source: 'open',
          workStatus: deriveWorkStatusFromComposer(resourceId),
        });
      }

      const seenTitles = new Set<string>();
      let scopeRoot: Element | null = null;
      if (containerComposerId) {
        const allCells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(allCells)) {
          const cid = cell.getAttribute('data-composer-id') || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === containerComposerId) {
            scopeRoot = cell.closest('.agent-sidebar-project-cell') || document.body;
            break;
          }
        }
      }
      if (!scopeRoot && windowTitle) {
        const projectName = projectNameFromTitle(windowTitle).toLowerCase();
        if (projectName) {
          const projectCells = document.querySelectorAll('.agent-sidebar-project-cell');
          for (const cell of Array.from(projectCells)) {
            const labelEl = cell.querySelector('.agent-sidebar-section-title-text') || cell.querySelector('.agent-sidebar-workspace-name') || cell;
            const label = (labelEl.textContent || '').trim().toLowerCase();
            const firstWord = (label.split(/[\s\[\]\-]/)[0] || '').toLowerCase();
            if (label.includes(projectName) || projectName.includes(firstWord) || firstWord === projectName) {
              scopeRoot = cell;
              break;
            }
          }
        }
      }
      // Cursor Agents unified window: glass sidebar rows (replaces .agent-sidebar-cell in newer builds)
      const glassTabRoots = document.querySelectorAll(
        '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
      );
      if (glassTabRoots.length > 0) {
        for (const tab of Array.from(glassTabRoots)) {
          const labelEl = tab.querySelector('.ui-sidebar-menu-button-label');
          const rawAgentTitle = (labelEl?.textContent || '').trim();
          if (!rawAgentTitle) continue;

          const group = tab.closest('.ui-sidebar-group');
          const groupTitleEl = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroupTitle = (groupTitleEl?.textContent || '').trim();

          let displayTitle = cleanTabTitle(rawAgentTitle);
          if (rawGroupTitle) {
            const g = cleanTabTitle(rawGroupTitle);
            if (g) {
              displayTitle = `${g} / ${cleanTabTitle(rawAgentTitle)}`.substring(0, 120);
            }
          }

          if (isHiddenSidebarTab(displayTitle)) continue;
          if (seenTitles.has(displayTitle)) continue;
          seenTitles.add(displayTitle);

          const composerId =
            tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `glass:${displayTitle}`;

          const isActive = tab.getAttribute('data-active') === 'true';

          chatTabs.push({
            composerId,
            title: displayTitle,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
            source: 'sidebar',
            workStatus: deriveWorkStatusFromGlassBtn(tab),
          });
        }

        markSidebarActiveByComposer(chatTabs);
      }

      for (const sel of chatTabSelectors) {
        if (chatTabs.some((t) => t.source === 'sidebar')) break;
        let tabItems: NodeListOf<Element>;
        try {
          const root: Element | Document = scopeRoot || document;
          tabItems = root.querySelectorAll(sel);
        } catch {
          continue;
        }
        if (tabItems.length === 0) continue;
        for (const tab of Array.from(tabItems)) {
          if (scopeRoot && !scopeRoot.contains(tab)) continue;
          const titleEl = tab.querySelector('.agent-sidebar-cell-text');
          const rawTitle = titleEl
            ? (titleEl.textContent || '').trim()
            : (tab.getAttribute('aria-label') || tab.textContent || '').trim();
          const title = cleanTabTitle(rawTitle);
          if (!title || isHiddenSidebarTab(title) || seenTitles.has(title)) continue;
          seenTitles.add(title);

          const composerId = tab.getAttribute('data-composer-id')
            || tab.closest('[data-composer-id]')?.getAttribute('data-composer-id')
            || `tab-${chatTabs.length}`;
          const selectedAttr = tab.getAttribute('data-selected');
          const highlightedAttr = tab.getAttribute('data-highlighted');
          const isActive = selectedAttr === 'true'
            || highlightedAttr === 'true'
            || tab.classList.contains('selected')
            || tab.classList.contains('active');

          chatTabs.push({
            composerId,
            title,
            isActive,
            status: isActive ? 'active' : 'idle',
            selectorPath: buildSelectorPath(tab),
            source: 'sidebar',
            workStatus: deriveWorkStatusFromSidebarCell(tab),
          });
        }
        if (chatTabs.some((t) => t.source === 'sidebar')) {
          markSidebarActiveByComposer(chatTabs);
          break;
        }
      }

      reconcileOpenTabComposerIds(chatTabs);
      syncOpenTabWorkStatus(chatTabs);
    } catch { /* skip */ }

    // --- Mode extraction ---
    const modeEl = findFirst(modeSelectors);
    let currentMode = 'agent';
    if (modeEl) {
      currentMode = modeEl.getAttribute('data-mode') || 'agent';
    }
    if (currentMode === 'agent') {
      const modeCarrier =
        container.closest('[data-mode]')
        || Array.from(container.querySelectorAll('[data-mode]')).find((el) =>
          /^(agent|plan|debug|multitask|chat|ask)$/.test(el.getAttribute('data-mode') || ''),
        );
      if (modeCarrier) currentMode = modeCarrier.getAttribute('data-mode') || currentMode;
    }
    if (currentMode === 'ask') currentMode = 'chat';
    const mode: ModeInfo = {
      current: currentMode,
      available: [
        { id: 'agent', label: 'Agent', icon: 'infinity' },
        { id: 'plan', label: 'Plan', icon: 'todos' },
        { id: 'debug', label: 'Debug', icon: 'bug' },
        { id: 'multitask', label: 'Multitask', icon: 'layers' },
        { id: 'chat', label: 'Ask', icon: 'chat' },
      ],
    };

    // --- Model extraction ---
    // Skip plan-scoped model dropdowns (id starts with "plan-exec-model") — those
    // show the model for a specific plan, not the composer-level model.
    let modelEl: Element | null = null;
    for (const sel of modelSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const c of Array.from(candidates)) {
          const cId = c.getAttribute('id') || '';
          if (!cId.startsWith('plan-exec-model')) {
            modelEl = c;
            break;
          }
        }
        if (modelEl) break;
      } catch { /* skip */ }
    }
    let modelName = '';
    let modelId = '';
    if (modelEl) {
      // Cursor's model trigger may show an Effort badge ("High") as the first
      // span — skip effort/options tokens and prefer a longer model label.
      const effortBadgeRe = /^(low|medium|high|fast)$/i;
      const spans = modelEl.querySelectorAll('span');
      const candidates: string[] = [];
      for (const s of Array.from(spans)) {
        const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.includes('chevron') || t.length <= 1) continue;
        if (effortBadgeRe.test(t)) continue;
        candidates.push(t);
      }
      // Prefer the longest non-effort span (model names are usually longer).
      if (candidates.length > 0) {
        modelName = candidates.reduce((best, cur) =>
          cur.length > best.length ? cur : best
        );
      }
      if (!modelName) {
        const aria = (modelEl.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const ariaModel = aria.replace(/^(model|current model)\s*[:\-]?\s*/i, '').trim();
        if (ariaModel && !effortBadgeRe.test(ariaModel)) modelName = ariaModel;
      }
      if (!modelName) {
        const title = (modelEl.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (title && !effortBadgeRe.test(title)) modelName = title;
      }
      modelId = modelEl.getAttribute('id') || '';
    }
    const model: ModelInfo = {
      current: modelName || 'Auto',
      currentId: modelId,
    };

    // --- Raw activity signals (objective DOM snapshot for recording) ---
    const _shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }> = [];
    const hasLoadingIndicator = container.querySelector('.loading-indicator-v3') !== null;
    const hasLoadingTool = container.querySelector('[data-tool-status="loading"]') !== null;
    const shineEls = container.querySelectorAll('.make-shine');
    for (const sh of Array.from(shineEls).reverse()) {
      const inToolCall = !!sh.closest('[data-tool-call-id]') || !!sh.closest('.composer-terminal-tool');
      const header = sh.closest('.ui-collapsible-header');
      let text = '';
      if (header) {
        const spans = header.querySelectorAll(':scope > span');
        const parts: string[] = [];
        for (const s of Array.from(spans)) {
          if (s.classList.contains('cursor-icon') || s.classList.contains('ui-icon')) continue;
          const t = (s.textContent || '').trim();
          if (t) parts.push(t);
        }
        text = parts.join(' ');
      } else if (sh.classList.contains('composer-terminal-top-header-description') ||
                 sh.closest('.composer-terminal-top-header-text')) {
        text = (sh.textContent || '').trim();
      } else {
        const descEl = (sh.closest(
          '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
        ) || sh.parentElement)
          ?.querySelector('.composer-terminal-top-header-description, .ui-tool-call-line-action, .ui-edit-tool-call__filename');
        text = descEl ? (descEl.textContent || '').trim() : (sh.textContent || '').trim();
      }
      if (text.length > 2) {
        const entry = { text: text.substring(0, 80), inToolCall, inHeader: !!header };
        _shimmer.push(entry);
      }
    }

    const _rawSignals = {
      shimmer: _shimmer,
      loadingIndicator: hasLoadingIndicator,
      statusEl: statusEl ? { text: (statusEl.textContent || '').trim(), classes: statusEl.className } : undefined,
      elements: _rawElements,
      orphanIndicators: _orphanIndicators,
    };

    const queueItems: CursorState['composerQueue']['items'] = [];
    let queueLabel: string | undefined;
    const toolbarSection = document.querySelector('#composer-toolbar-section');
    if (toolbarSection) {
      for (const lc of Array.from(toolbarSection.querySelectorAll('.opacity-80'))) {
        const lt = (lc.textContent || '').trim();
        if (lt && /queued/i.test(lt)) {
          queueLabel = lt;
          break;
        }
      }
      if (!queueLabel) {
        const fb = toolbarSection.querySelector('.group .opacity-80');
        const t0 = (fb?.textContent || '').trim();
        if (t0) queueLabel = t0;
      }
      const queueActionLabels: Record<string, string> = {
        send: 'Send now',
        remove: 'Remove',
        edit: 'Edit',
      };
      function queueActionSelector(item: Element, action: string): string {
        const qid = item.getAttribute('data-queue-item-id');
        if (qid) {
          return `.composer-toolbar-queue-item[data-queue-item-id="${qid}"] [data-queue-action="${action}"] .anysphere-icon-button`;
        }
        const target =
          item.querySelector(`[data-queue-action="${action}"] .anysphere-icon-button`) ||
          item.querySelector(`[data-queue-action="${action}"]`);
        return target ? buildSelectorPath(target) : '';
      }

      for (const item of Array.from(toolbarSection.querySelectorAll('.composer-toolbar-queue-item'))) {
        const qid = item.getAttribute('data-queue-item-id') || '';
        let qtext = (item.getAttribute('data-queue-item-query') || '').trim();
        if (!qtext) {
          const ro = item.querySelector('.aislash-editor-input-readonly');
          qtext = (ro?.textContent || '').trim();
        }
        const actions: { type: 'send' | 'remove' | 'edit'; label: string; selectorPath: string }[] = [];
        for (const actionEl of Array.from(item.querySelectorAll('[data-queue-action]'))) {
          const kind = actionEl.getAttribute('data-queue-action') || '';
          if (kind !== 'send' && kind !== 'remove' && kind !== 'edit') continue;
          const selectorPath = queueActionSelector(item, kind);
          if (!selectorPath) continue;
          actions.push({
            type: kind,
            label: queueActionLabels[kind] || kind,
            selectorPath,
          });
        }
        if (qid || qtext) {
          queueItems.push({
            id: qid || `qi-${queueItems.length}`,
            text: qtext,
            actions: actions.length > 0 ? actions : undefined,
          });
        }
      }
    }

    // --- Questionnaire widget ---
    type QOption = { letter: string; label: string; isFreeform: boolean; isSelected?: boolean; selectorPath: string };
    type QQuestion = { number: string; text: string; options: QOption[]; isActive: boolean };
    let questionnaire: {
      questions: QQuestion[];
      activeIndex: number;
      totalLabel: string;
      skipSelectorPath: string;
      continueSelectorPath: string;
      continueDisabled: boolean;
    } | null = null;
    const qToolbar = document.querySelector('.composer-questionnaire-toolbar');
    if (qToolbar) {
      const stepperLabel = (qToolbar.querySelector('.composer-questionnaire-toolbar-stepper-label')?.textContent || '').trim();
      const questionEls = Array.from(qToolbar.querySelectorAll('.composer-questionnaire-toolbar-question'));
      const questions: QQuestion[] = [];
      let activeIdx = 0;
      for (let qi = 0; qi < questionEls.length; qi++) {
        const qEl = questionEls[qi];
        const isActive = qEl.classList.contains('composer-questionnaire-toolbar-question-active');
        if (isActive) activeIdx = qi;
        const num = (qEl.querySelector('.composer-questionnaire-toolbar-question-number')?.textContent || '').trim();
        const mdRoot = qEl.querySelector('.markdown-root');
        const text = (mdRoot?.textContent || '').trim();
        const optionEls = Array.from(qEl.querySelectorAll('.composer-questionnaire-toolbar-option'));
        const options: QOption[] = [];
        for (const optEl of optionEls) {
          const letterBtn = optEl.querySelector('.composer-questionnaire-toolbar-option-letter');
          const letter = (letterBtn?.textContent || '').trim();
          const isFreeform = optEl.classList.contains('composer-questionnaire-toolbar-option-freeform');
          const label = isFreeform ? 'Other' : (optEl.querySelector('.composer-questionnaire-toolbar-option-label')?.textContent || '').trim();
          const isSelected =
            !!letterBtn?.classList.contains('composer-questionnaire-toolbar-option-letter-selected')
            || !!optEl.querySelector('.composer-questionnaire-toolbar-option-label-selected')
            || optEl.classList.contains('composer-questionnaire-toolbar-option-selected')
            || optEl.getAttribute('aria-pressed') === 'true'
            || optEl.getAttribute('aria-selected') === 'true';
          const clickTarget = letterBtn || optEl;
          options.push({ letter, label, isFreeform, isSelected, selectorPath: buildSelectorPath(clickTarget as Element) });
        }
        questions.push({ number: num, text, options, isActive });
      }

      let skipPath = '';
      let continuePath = '';
      let continueDisabled = false;
      const actionsContainer = qToolbar.querySelector('.composer-questionnaire-toolbar-actions');
      if (actionsContainer) {
        const skipBtn = actionsContainer.querySelector('.composer-skip-button');
        if (skipBtn) {
          skipPath = '.composer-questionnaire-toolbar .composer-skip-button';
        }
        const contBtn = actionsContainer.querySelector('.composer-run-button');
        if (contBtn) {
          continuePath = '.composer-questionnaire-toolbar .composer-questionnaire-toolbar-actions .composer-run-button:not([data-disabled="true"])';
          continueDisabled = contBtn.getAttribute('data-disabled') === 'true';
        }
      }

      questionnaire = {
        questions,
        activeIndex: activeIdx,
        totalLabel: stepperLabel,
        skipSelectorPath: skipPath,
        continueSelectorPath: continuePath,
        continueDisabled,
      };
    }

    // Priority: actionable user interaction, Multitask workers, parent composer,
    // then completed/idle. A completed parent is not authoritative while any
    // extracted or toolbar-reported subagent remains active.
    if (questionnaire) {
      agentStatus = 'waiting_question';
    } else if (actionableApprovals.length > 0) {
      agentStatus = 'waiting_approval';
    } else if (
      agentStatus !== 'waiting_approval'
      && agentStatus !== 'waiting_question'
      && agentStatus !== 'waiting_user_input'
      && subagents.runningCount > 0
    ) {
      agentStatus = 'running_subagents';
    }

    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus,
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: elements,
      pendingApprovals: actionableApprovals,
      globalApprovalNotifications: [],
      inputAvailable: inputEl !== null,
      composerInputAvailable,
      activeConversationContext: null,
      chatTabs,
      activeComposerId: containerComposerId || (chatTabs.find((t) => t.isActive)?.composerId ?? ''),
      mode,
      model,
      windows: [],
      activeWindowId: '',
      composerQueue: { items: queueItems, ...(queueLabel ? { queueLabel } : {}) },
      questionnaire,
      backgroundTasks,
      subagents,
      agentChanges,
      gitStatus: null,
      gitScm: null,
      agentStopSelectorPath,
      agentStopAvailable,
      agentStopSource,
      exploratoryUi: null,
      _rawSignals,
    };
  } catch {
    return null;
  }
}

export class DOMExtractor {
  private selectors: SelectorConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private client: CdpClient | null = null;
  private onExtract: (state: CursorState | null, errorMessage?: string | null) => void;
  private getWindowTitle: () => string;
  private loggedFirstExtraction = false;
  private basePollIntervalMs = 300;
  private currentPollIntervalMs = 300;
  private pollInFlight = false;
  private failureStreak = 0;
  private running = false;

  constructor(
    selectors: SelectorConfig,
    onExtract: (state: CursorState | null, errorMessage?: string | null) => void,
    getWindowTitle: () => string = () => ''
  ) {
    this.selectors = selectors;
    this.onExtract = onExtract;
    this.getWindowTitle = getWindowTitle;
  }

  start(client: CdpClient, intervalMs: number): void {
    this.client = client;
    this.stop();
    this.running = true;
    this.basePollIntervalMs = intervalMs;
    this.currentPollIntervalMs = intervalMs;
    this.failureStreak = 0;
    console.log(`[dom-extractor] Starting polling every ${intervalMs}ms`);
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.failureStreak = 0;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  requestPoll(delayMs = 0): void {
    this.scheduleNextPoll(delayMs);
  }

  private scheduleNextPoll(delayMs = this.currentPollIntervalMs): void {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
  }

  private handleFailure(message: string): void {
    const timedOut = message.includes('timeout');
    this.failureStreak++;
    if (timedOut) {
      const nextInterval = Math.min(
        Math.max(this.basePollIntervalMs, this.basePollIntervalMs * (2 ** (this.failureStreak - 1))),
        MAX_POLL_BACKOFF_MS
      );
      if (nextInterval !== this.currentPollIntervalMs) {
        this.currentPollIntervalMs = nextInterval;
        console.warn(`[dom-extractor] Backing off poll interval to ${this.currentPollIntervalMs}ms after ${message}`);
      }
    }
    this.onExtract(null, message);
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      this.scheduleNextPoll();
      return;
    }
    this.pollInFlight = true;

    if (!this.client || !this.client.isConnected()) {
      this.handleFailure('CDP client not connected');
      this.pollInFlight = false;
      this.scheduleNextPoll();
      return;
    }

    try {
      const state = await this.client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer.strategies,
          this.selectors.approveButton.strategies,
          this.selectors.approveButton.textMatch ?? [],
          this.selectors.rejectButton.strategies,
          this.selectors.rejectButton.textMatch ?? [],
          this.selectors.chatInput.strategies,
          this.selectors.agentStatus.strategies,
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          this.getWindowTitle(),
        ],
        EVALUATE_TIMEOUT_MS
      ) as CursorState | null;

      const derivedState = state ? applyDerivedActivityToState(state) : null;
      this.failureStreak = 0;
      this.currentPollIntervalMs = this.basePollIntervalMs;

      if (derivedState && !this.loggedFirstExtraction) {
        this.loggedFirstExtraction = true;
        console.log(`[dom-extractor] First successful extraction:`);
        console.log(`  status: ${derivedState.agentStatus}${derivedState.agentActivityText ? ` (${derivedState.agentActivityText})` : ''}`);
        console.log(`  messages: ${derivedState.messages.length}`);
        console.log(`  approvals: ${derivedState.pendingApprovals.length}`);
        console.log(`  inputAvailable: ${derivedState.inputAvailable}`);
        console.log(`  chatTabs: ${derivedState.chatTabs.length}`);
        console.log(`  mode: ${derivedState.mode.current}, model: ${derivedState.model.current}`);
        if (derivedState.messages.length > 0) {
          const last = derivedState.messages[derivedState.messages.length - 1];
          const preview = last.type === 'human' ? last.text
            : last.type === 'assistant' ? last.text
            : last.type === 'tool' ? `${last.action} ${last.details}`
            : last.type === 'thought' ? `thought ${last.duration}`
            : last.type === 'plan' ? `${last.label}: ${last.title}`
            : last.type === 'run_command' ? `run: ${last.command.substring(0, 60)}`
            : last.type === 'todo_list' ? `todos: ${last.todosCompleted}/${last.todosTotal}`
            : 'loading';
          console.log(`  last element (${last.type}): "${preview.substring(0, 80)}..."`);
        }
      }

      this.onExtract(derivedState, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('WebSocket closed') && !message.includes('Intentional disconnect')) {
        console.warn(`[dom-extractor] Extraction failed: ${message}`);
      }
      this.handleFailure(message);
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }
}
