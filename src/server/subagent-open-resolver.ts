import type { SubagentItemCapabilities } from './types.js';

export type SubagentOpenResolveCode = 'open_not_found' | 'ambiguous';

export interface SubagentOpenResolveResult {
  ok: boolean;
  code?: SubagentOpenResolveCode;
  element?: Element;
}

function norm(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isShellJob(job: Element): boolean {
  return !!job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal');
}

function jobTitle(job: Element): string {
  return (job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
    || job.textContent?.replace(/\bStop\b/gi, '')
    || '').replace(/\s+/g, ' ').trim();
}

function findToolbarJobs(root: Document | Element): Element[] {
  const toolbar = root.querySelector('#composer-toolbar-section');
  if (!toolbar) return [];
  return Array.from(toolbar.querySelectorAll('.composer-toolbar-background-job-item'))
    .filter(job => !isShellJob(job));
}

function readCardTitle(card: Element): string {
  const modelEl = card.querySelector('[data-subagent-task-model="true"]');
  const siblingTitle = (modelEl?.previousElementSibling?.textContent || '').replace(/\s+/g, ' ').trim();
  if (siblingTitle) return siblingTitle;
  const titled =
    card.querySelector('.subagent-task-card-title[title]')
    || card.querySelector('[data-subagent-task-card-header="true"] [title]')
    || card.querySelector('.subagent-task-card-title');
  const fromAttr = (titled?.getAttribute('title') || '').trim();
  if (fromAttr) return fromAttr;
  return (titled?.textContent || '').replace(/\s+/g, ' ').trim();
}

function toolbarOpenTarget(job: Element): Element {
  return job.querySelector('.composer-toolbar-background-job-item-text')
    || (job.matches('.composer-toolbar-background-job-item-clickable')
      ? job
      : job.querySelector('.composer-toolbar-background-job-item-clickable'))
    || job;
}

function resolveToolbarOpen(
  root: Document | Element,
  matchTitle: string,
  toolbarExpandSelectorPath?: string,
): SubagentOpenResolveResult {
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
  const matched = jobs.filter(job => norm(jobTitle(job)) === norm(matchTitle));
  if (matched.length > 1) return { ok: false, code: 'ambiguous' };
  if (matched.length === 1) return { ok: true, element: toolbarOpenTarget(matched[0]!) };
  return { ok: false, code: 'open_not_found' };
}

function resolveCardOpen(root: Document | Element, matchTitle: string): SubagentOpenResolveResult {
  const cards = Array.from(root.querySelectorAll(
    '[data-subagent-task-card="true"], .subagent-task-card[data-chrome="card"]',
  )).filter(card => norm(readCardTitle(card)) === norm(matchTitle));
  if (cards.length > 1) return { ok: false, code: 'ambiguous' };
  if (cards.length === 0) return { ok: false, code: 'open_not_found' };
  const card = cards[0]!;
  const header = card.querySelector('[data-subagent-task-card-header="true"]') || card;
  return { ok: true, element: header };
}

function tryLegacyPath(root: Document | Element, selectorPath?: string): SubagentOpenResolveResult {
  if (!selectorPath) return { ok: false, code: 'open_not_found' };
  try {
    const el = root.querySelector(selectorPath);
    if (el) return { ok: true, element: el };
  } catch {
    // invalid selector
  }
  return { ok: false, code: 'open_not_found' };
}

export function resolveSubagentOpenElement(
  root: Document | Element,
  capabilities: Pick<SubagentItemCapabilities, 'matchTitle' | 'openSelectorPath' | 'toolbarExpandSelectorPath'>,
): SubagentOpenResolveResult {
  const title = capabilities.matchTitle || '';
  if (title) {
    const toolbar = resolveToolbarOpen(root, title, capabilities.toolbarExpandSelectorPath);
    if (toolbar.ok || toolbar.code === 'ambiguous') return toolbar;
    const card = resolveCardOpen(root, title);
    if (card.ok || card.code === 'ambiguous') return card;
  }
  return tryLegacyPath(root, capabilities.openSelectorPath);
}

export function buildSubagentOpenResolveEvaluateScript(
  capabilities: SubagentItemCapabilities,
): string {
  const payload = JSON.stringify({
    matchTitle: capabilities.matchTitle || '',
    openSelectorPath: capabilities.openSelectorPath || '',
    toolbarExpandSelectorPath: capabilities.toolbarExpandSelectorPath || '',
  });

  return `(() => {
    const input = ${payload};
    function norm(value) {
      return (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    }
    function isShellJob(job) {
      return !!job.querySelector('.composer-toolbar-background-job-shell-icon, .codicon-terminal');
    }
    function jobTitle(job) {
      return (job.querySelector('.composer-toolbar-background-job-item-text')?.textContent
        || job.textContent?.replace(/\\bStop\\b/gi, '')
        || '').replace(/\\s+/g, ' ').trim();
    }
    function findToolbarJobs(root) {
      const toolbar = root.querySelector('#composer-toolbar-section');
      if (!toolbar) return [];
      return Array.from(toolbar.querySelectorAll('.composer-toolbar-background-job-item'))
        .filter(job => !isShellJob(job));
    }
    function readCardTitle(card) {
      const modelEl = card.querySelector('[data-subagent-task-model="true"]');
      const siblingTitle = (modelEl && modelEl.previousElementSibling && modelEl.previousElementSibling.textContent || '')
        .replace(/\\s+/g, ' ').trim();
      if (siblingTitle) return siblingTitle;
      const titled =
        card.querySelector('.subagent-task-card-title[title]')
        || card.querySelector('[data-subagent-task-card-header="true"] [title]')
        || card.querySelector('.subagent-task-card-title');
      const fromAttr = (titled && titled.getAttribute('title') || '').trim();
      if (fromAttr) return fromAttr;
      return (titled && titled.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    function toolbarOpenTarget(job) {
      return job.querySelector('.composer-toolbar-background-job-item-text')
        || (job.matches('.composer-toolbar-background-job-item-clickable') ? job : job.querySelector('.composer-toolbar-background-job-item-clickable'))
        || job;
    }
    function clickPlan(el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const tagName = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const clickReady = el.getAttribute('data-click-ready') === 'true';
      const domClickableTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'option', 'label', 'summary']);
      const domClickableRoles = new Set(['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'tab']);
      const useNative = !clickReady && !domClickableTags.has(tagName) && !domClickableRoles.has(role);
      if (!useNative) {
        el.click();
        return { ok: true, usedNative: false };
      }
      const r = el.getBoundingClientRect();
      return {
        ok: true,
        usedNative: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
      };
    }

    const title = input.matchTitle || '';
    let element = null;
    let code = 'open_not_found';
    if (title) {
      let jobs = findToolbarJobs(document);
      if (jobs.length === 0 && input.toolbarExpandSelectorPath) {
        try {
          const expand = document.querySelector(input.toolbarExpandSelectorPath);
          if (expand) {
            expand.click();
            jobs = findToolbarJobs(document);
          }
        } catch {}
      }
      const matchedJobs = jobs.filter(job => norm(jobTitle(job)) === norm(title));
      if (matchedJobs.length > 1) return { ok: false, code: 'ambiguous' };
      if (matchedJobs.length === 1) element = toolbarOpenTarget(matchedJobs[0]);
      if (!element) {
        const cards = Array.from(document.querySelectorAll(
          '[data-subagent-task-card="true"], .subagent-task-card[data-chrome="card"]',
        )).filter(card => norm(readCardTitle(card)) === norm(title));
        if (cards.length > 1) return { ok: false, code: 'ambiguous' };
        if (cards.length === 1) {
          element = cards[0].querySelector('[data-subagent-task-card-header="true"]') || cards[0];
        }
      }
    }
    if (!element && input.openSelectorPath) {
      try { element = document.querySelector(input.openSelectorPath); } catch {}
    }
    if (!element) return { ok: false, code };
    return clickPlan(element);
  })()`;
}
