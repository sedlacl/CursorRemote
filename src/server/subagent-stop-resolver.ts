import type { SubagentItemCapabilities, SubagentStopDescriptor } from './types.js';

export type SubagentStopResolveCode = 'stop_not_found' | 'ambiguous' | 'invalid_kind';

export interface SubagentStopResolveInput {
  stop: SubagentStopDescriptor;
  toolbarExpandSelectorPath?: string;
  /** Deprecated fallback; logs warning when used. */
  legacyStopSelectorPath?: string;
}

export interface SubagentStopResolveResult {
  ok: boolean;
  code?: SubagentStopResolveCode;
  element?: Element;
}

export function normalizeDomAttributeValue(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function norm(value: string | null | undefined): string {
  return normalizeDomAttributeValue(value).toLowerCase();
}

function toolCallIdsMatch(expected: string, actual: string | null | undefined): boolean {
  return norm(expected) === norm(actual);
}

function isShellJob(job: Element): boolean {
  return !!job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal');
}

function jobTitle(job: Element): string {
  return normalizeDomAttributeValue(
    job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
    || job.textContent?.replace(/\bStop\b/gi, '')
    || '',
  );
}

function titleMatchesJob(job: Element, matchTitle: string, matchModel?: string): boolean {
  const text = jobTitle(job);
  if (norm(text) !== norm(matchTitle)) return false;
  if (!matchModel) return true;
  return text.toLowerCase().includes(norm(matchModel)) || norm(matchModel).length === 0;
}

function findToolbarJobs(root: Document | Element): Element[] {
  const toolbar = root.querySelector('#composer-toolbar-section');
  if (!toolbar) return [];
  return Array.from(toolbar.querySelectorAll('.composer-toolbar-background-job-item'))
    .filter(job => !isShellJob(job));
}

function resolveCardStop(root: Document | Element, stop: SubagentStopDescriptor): SubagentStopResolveResult {
  const candidates: Element[] = [];

  if (stop.toolCallId) {
    for (const row of Array.from(root.querySelectorAll('[data-tool-call-id]'))) {
      if (!toolCallIdsMatch(stop.toolCallId, row.getAttribute('data-tool-call-id'))) continue;
      if (stop.composerId) {
        const composer = row.closest('[data-composer-id]')
          || root.querySelector(`#container[data-composer-id="${stop.composerId}"]`)
          || root.querySelector(`[data-composer-id="${stop.composerId}"]`);
        if (composer && !composer.contains(row) && !row.contains(composer)) {
          const scopedComposer = row.closest('[data-composer-id]');
          if (scopedComposer && norm(scopedComposer.getAttribute('data-composer-id')) !== norm(stop.composerId)) {
            continue;
          }
        }
      }
      const btn = row.querySelector('.task-subagent-header-pill-button--stop');
      if (btn) candidates.push(btn);
    }
  }

  if (candidates.length === 0 && stop.messageId) {
    for (const row of Array.from(root.querySelectorAll('[data-message-id]'))) {
      if (norm(row.getAttribute('data-message-id')) !== norm(stop.messageId)) continue;
      const btn = row.querySelector('.task-subagent-header-pill-button--stop');
      if (btn) candidates.push(btn);
    }
  }

  if (candidates.length === 0) {
    for (const card of Array.from(root.querySelectorAll('.subagent-task-card[data-chrome="card"]'))) {
      const cardTitle = normalizeDomAttributeValue(
        card.querySelector('.subagent-task-card-title[title]')?.getAttribute('title')
        || card.querySelector('.subagent-task-card-title')?.textContent,
      );
      if (norm(cardTitle) !== norm(stop.matchTitle)) continue;
      if (stop.matchModel) {
        const cardModel = normalizeDomAttributeValue(
          card.querySelector('.task-subagent-model-hover-trigger')?.textContent,
        );
        if (cardModel && norm(cardModel) !== norm(stop.matchModel)) continue;
      }
      const btn = card.querySelector('.task-subagent-header-pill-button--stop');
      if (btn) candidates.push(btn);
    }
  }

  if (candidates.length > 1) return { ok: false, code: 'ambiguous' };
  if (candidates.length === 1) return { ok: true, element: candidates[0] };
  return { ok: false, code: 'stop_not_found' };
}

function resolveToolbarStop(root: Document | Element, stop: SubagentStopDescriptor): SubagentStopResolveResult {
  const matched = findToolbarJobs(root).filter(job => titleMatchesJob(job, stop.matchTitle, stop.matchModel));
  if (matched.length > 1) return { ok: false, code: 'ambiguous' };
  if (matched.length === 0) return { ok: false, code: 'stop_not_found' };
  const stopEl = matched[0]!.querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
  if (!stopEl) return { ok: false, code: 'stop_not_found' };
  return { ok: true, element: stopEl };
}

function resolveSingleJobAfterExpand(
  root: Document | Element,
  toolbarExpandSelectorPath?: string,
): SubagentStopResolveResult {
  let jobs = findToolbarJobs(root);
  if (jobs.length === 0 && toolbarExpandSelectorPath) {
    try {
      const expand = root.querySelector(toolbarExpandSelectorPath);
      if (expand instanceof HTMLElement) {
        expand.click();
        jobs = findToolbarJobs(root);
      }
    } catch {
      // ignore invalid expand selector
    }
  }
  if (jobs.length > 1) return { ok: false, code: 'ambiguous' };
  if (jobs.length !== 1) return { ok: false, code: 'stop_not_found' };
  const stopEl = jobs[0]!.querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
  if (!stopEl) return { ok: false, code: 'stop_not_found' };
  return { ok: true, element: stopEl };
}

function tryLegacyPath(root: Document | Element, legacyStopSelectorPath?: string): SubagentStopResolveResult {
  if (!legacyStopSelectorPath) return { ok: false, code: 'stop_not_found' };
  try {
    const preferred = root.querySelector(legacyStopSelectorPath);
    if (preferred?.matches('.task-subagent-header-pill-button--stop')) {
      console.warn('[subagent-stop-resolver] Used legacy stop selector path fallback');
      return { ok: true, element: preferred };
    }
    if (preferred?.matches('.composer-toolbar-background-job-item-stop[data-click-ready="true"]')) {
      console.warn('[subagent-stop-resolver] Used legacy stop selector path fallback');
      return { ok: true, element: preferred };
    }
  } catch {
    // invalid selector
  }
  return { ok: false, code: 'stop_not_found' };
}

export function resolveSubagentStopElement(
  root: Document | Element,
  input: SubagentStopResolveInput,
): SubagentStopResolveResult {
  const { stop, toolbarExpandSelectorPath, legacyStopSelectorPath } = input;
  let result: SubagentStopResolveResult;
  switch (stop.kind) {
    case 'cardStop':
      result = resolveCardStop(root, stop);
      break;
    case 'toolbarStop':
      result = resolveToolbarStop(root, stop);
      break;
    case 'singleJobAfterExpand':
      result = resolveSingleJobAfterExpand(root, toolbarExpandSelectorPath);
      break;
    default:
      return { ok: false, code: 'invalid_kind' };
  }

  if (!result.ok && legacyStopSelectorPath) {
    return tryLegacyPath(root, legacyStopSelectorPath);
  }
  return result;
}

export function buildSubagentStopResolveEvaluateScript(
  capabilities: SubagentItemCapabilities,
  options: { dryRun?: boolean } = {},
): string {
  const payload = JSON.stringify({
    stop: capabilities.stop,
    toolbarExpandSelectorPath: capabilities.toolbarExpandSelectorPath || '',
    legacyStopSelectorPath: capabilities.legacyStopSelectorPath || '',
    dryRun: !!options.dryRun,
  });

  return `(() => {
    const input = ${payload};

    function normalizeDomAttributeValue(value) {
      return (value || '').replace(/\\s+/g, ' ').trim();
    }
    function norm(value) {
      return normalizeDomAttributeValue(value).toLowerCase();
    }
    function toolCallIdsMatch(expected, actual) {
      return norm(expected) === norm(actual);
    }
    function isShellJob(job) {
      return !!job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal');
    }
    function jobTitle(job) {
      return normalizeDomAttributeValue(
        job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
        || job.textContent?.replace(/\\bStop\\b/gi, '')
        || '',
      );
    }
    function titleMatchesJob(job, matchTitle, matchModel) {
      const text = jobTitle(job);
      if (norm(text) !== norm(matchTitle)) return false;
      if (!matchModel) return true;
      return text.toLowerCase().includes(norm(matchModel)) || norm(matchModel).length === 0;
    }
    function findToolbarJobs(root) {
      const toolbar = root.querySelector('#composer-toolbar-section');
      if (!toolbar) return [];
      return Array.from(toolbar.querySelectorAll('.composer-toolbar-background-job-item'))
        .filter(job => !isShellJob(job));
    }
    function resolveCardStop(root, stop) {
      const candidates = [];
      if (stop.toolCallId) {
        for (const row of Array.from(root.querySelectorAll('[data-tool-call-id]'))) {
          if (!toolCallIdsMatch(stop.toolCallId, row.getAttribute('data-tool-call-id'))) continue;
          const btn = row.querySelector('.task-subagent-header-pill-button--stop');
          if (btn) candidates.push(btn);
        }
      }
      if (candidates.length === 0 && stop.messageId) {
        for (const row of Array.from(root.querySelectorAll('[data-message-id]'))) {
          if (norm(row.getAttribute('data-message-id')) !== norm(stop.messageId)) continue;
          const btn = row.querySelector('.task-subagent-header-pill-button--stop');
          if (btn) candidates.push(btn);
        }
      }
      if (candidates.length === 0) {
        for (const card of Array.from(root.querySelectorAll('.subagent-task-card[data-chrome="card"]'))) {
          const cardTitle = normalizeDomAttributeValue(
            card.querySelector('.subagent-task-card-title[title]')?.getAttribute('title')
            || card.querySelector('.subagent-task-card-title')?.textContent,
          );
          if (norm(cardTitle) !== norm(stop.matchTitle)) continue;
          if (stop.matchModel) {
            const cardModel = normalizeDomAttributeValue(card.querySelector('.task-subagent-model-hover-trigger')?.textContent);
            if (cardModel && norm(cardModel) !== norm(stop.matchModel)) continue;
          }
          const btn = card.querySelector('.task-subagent-header-pill-button--stop');
          if (btn) candidates.push(btn);
        }
      }
      if (candidates.length > 1) return { ok: false, code: 'ambiguous' };
      if (candidates.length === 1) return { ok: true, element: candidates[0] };
      return { ok: false, code: 'stop_not_found' };
    }
    function resolveToolbarStop(root, stop) {
      const matched = findToolbarJobs(root).filter(job => titleMatchesJob(job, stop.matchTitle, stop.matchModel));
      if (matched.length > 1) return { ok: false, code: 'ambiguous' };
      if (matched.length === 0) return { ok: false, code: 'stop_not_found' };
      const stopEl = matched[0].querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
      if (!stopEl) return { ok: false, code: 'stop_not_found' };
      return { ok: true, element: stopEl };
    }
    function resolveSingleJobAfterExpand(root, toolbarExpandSelectorPath) {
      let jobs = findToolbarJobs(root);
      if (jobs.length === 0 && toolbarExpandSelectorPath) {
        try {
          const expand = root.querySelector(toolbarExpandSelectorPath);
          if (expand) {
            expand.scrollIntoView({ block: 'center', behavior: 'instant' });
            expand.click();
            jobs = findToolbarJobs(root);
          }
        } catch {}
      }
      if (jobs.length > 1) return { ok: false, code: 'ambiguous' };
      if (jobs.length !== 1) return { ok: false, code: 'stop_not_found' };
      const stopEl = jobs[0].querySelector('.composer-toolbar-background-job-item-stop[data-click-ready="true"]');
      if (!stopEl) return { ok: false, code: 'stop_not_found' };
      return { ok: true, element: stopEl };
    }
    function tryLegacyPath(root, legacyStopSelectorPath) {
      if (!legacyStopSelectorPath) return { ok: false, code: 'stop_not_found' };
      try {
        const preferred = root.querySelector(legacyStopSelectorPath);
        if (preferred?.matches?.('.task-subagent-header-pill-button--stop, .composer-toolbar-background-job-item-stop[data-click-ready="true"]')) {
          console.warn('[subagent-stop-resolver] Used legacy stop selector path fallback');
          return { ok: true, element: preferred };
        }
      } catch {}
      return { ok: false, code: 'stop_not_found' };
    }

    let result;
    switch (input.stop?.kind) {
      case 'cardStop':
        result = resolveCardStop(document, input.stop);
        break;
      case 'toolbarStop':
        result = resolveToolbarStop(document, input.stop);
        break;
      case 'singleJobAfterExpand':
        result = resolveSingleJobAfterExpand(document, input.toolbarExpandSelectorPath);
        break;
      default:
        return { ok: false, code: 'invalid_kind' };
    }
    if (!result.ok && input.legacyStopSelectorPath) {
      result = tryLegacyPath(document, input.legacyStopSelectorPath);
    }
    if (!result.ok) return { ok: false, code: result.code || 'stop_not_found' };
    if (!input.dryRun) {
      result.element.scrollIntoView({ block: 'center', behavior: 'instant' });
      result.element.click();
    }
    return { ok: true, kind: input.stop.kind, matched: true };
  })()`;
}
