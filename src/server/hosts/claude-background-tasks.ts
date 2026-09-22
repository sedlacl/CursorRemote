import type { BackgroundTask } from '../types.js';
import type { ClaudeWebviewClient } from './claude-webview-client.js';

/**
 * Reads Claude Code's background tasks out of the webview's session object.
 *
 * Contract (plan §"Background tasky — Map ano, `/tasks` ne"):
 *
 *  1. The locator is named and asserted — an object that owns BOTH a string
 *     `sessionId` and an own `backgroundTasks` property that is a `Map` or a
 *     plain object. No "this fiber node looks like a session" guessing.
 *  2. Entry values are read against the explicit schema below. Only documented
 *     keys are read; unknown keys are ignored, missing required keys reject the
 *     entry.
 *  3. Anything unexpected — property absent, wrong type, entries that fail the
 *     schema, an unverified Claude Code version — yields `[]` plus a one-shot
 *     log. There is no silent fallback to `/tasks` or to transcript scraping.
 *  4. `/tasks` is never executed. It is a `local-jsx` slash command that opens
 *     a window in the user's IDE; the relay must not trigger it.
 *  5. A Claude Code version outside {@link VERIFIED_VERSIONS} means the shape is
 *     unverified, so the reader stays closed until a fresh probe.
 *
 * ## Probe result for 2.1.278 — the reader is closed, and correctly so
 *
 * A live probe of the webview (`scripts/probe-claude-code.ts`) swept 7257 fiber
 * nodes across every Claude webview target and found **no** object owning a
 * `backgroundTasks` property, and **no** object carrying a `sessionId` string
 * at all. The session state — including the task Map — lives in the extension
 * host process (`extension.js`), which is Node, not a renderer, so CDP cannot
 * reach it from the relay.
 *
 * The plan assumed the Map would be readable from the webview. It is not. This
 * reader therefore stays closed on 2.1.278 and reports no background tasks,
 * which is precisely what rule 3 prescribes. It is kept rather than deleted
 * because it encodes the contract a future version would have to satisfy: if a
 * later build does expose the session in the webview, a fresh probe plus a
 * `VERIFIED_VERSIONS` entry is all that is needed to open it.
 */

/**
 * Claude Code versions whose `backgroundTasks` value shape has been confirmed
 * by `scripts/probe-claude-code.ts`. Empty until Phase 0 runs against a live
 * panel with a running background bash — until then this reader returns `[]`.
 */
export const VERIFIED_VERSIONS: readonly string[] = [];

export type BackgroundTasksOutcome =
  | { status: 'ok'; tasks: BackgroundTask[] }
  | { status: 'unverified-version'; version: string }
  | { status: 'no-locator' }
  | { status: 'bad-shape'; detail: string }
  | { status: 'error'; detail: string };

/** Explicit value schema — only these keys are ever read from an entry. */
interface RawBackgroundTaskEntry {
  id?: unknown;
  taskId?: unknown;
  label?: unknown;
  command?: unknown;
  description?: unknown;
  status?: unknown;
}

interface LocatorResult {
  found: boolean;
  reason?: string;
  sessionId?: string;
  entries?: { key: string; value: RawBackgroundTaskEntry }[];
}

/**
 * Locator body for {@link ClaudeWebviewClient.evaluateInPanel}, so it runs
 * against the inner `#active-frame` document rather than VS Code's webview
 * shell. Walks React fiber roots but only accepts a node satisfying the named
 * locator assertion — contract rule 1.
 */
const LOCATOR_JS_BODY = `(d) => {
    const MAX_NODES = 60000;
    const MAX_DEPTH = 40;
    const seen = new Set();
    let visited = 0;

    const isSession = (obj) =>
      !!obj && typeof obj === 'object'
      && typeof obj.sessionId === 'string' && obj.sessionId.length > 0
      && Object.prototype.hasOwnProperty.call(obj, 'backgroundTasks');

    const roots = [];
    const walkDom = (el, depth) => {
      if (!el || depth > 6) return;
      for (const key of Object.keys(el)) {
        if (key.indexOf('__reactContainer') === 0
            || key.indexOf('_reactRootContainer') === 0
            || key.indexOf('__reactFiber') === 0) {
          roots.push(el[key]);
        }
      }
      for (const child of Array.from(el.children || [])) walkDom(child, depth + 1);
    };
    if (d.body) walkDom(d.body, 0);
    if (roots.length === 0) return { found: false, reason: 'no-react-root' };

    let session = null;
    const visit = (node, depth) => {
      if (session || !node || typeof node !== 'object') return;
      if (visited > MAX_NODES || depth > MAX_DEPTH) return;
      if (seen.has(node)) return;
      seen.add(node);
      visited++;
      try { if (isSession(node)) { session = node; return; } } catch (e) { return; }
      const keys = ['memoizedState', 'memoizedProps', 'stateNode', 'child', 'sibling',
                    'next', 'baseState', 'current', 'value', 'state', 'props', 'context'];
      for (const key of keys) {
        try {
          const child = node[key];
          if (child && typeof child === 'object') visit(child, depth + 1);
        } catch (e) { /* getters may throw */ }
      }
    };
    for (const root of roots) visit(root, 0);

    if (!session) return { found: false, reason: 'no-session-locator' };

    const bt = session.backgroundTasks;
    const isMap = bt instanceof Map;
    const isPlain = !!bt && typeof bt === 'object' && !Array.isArray(bt) && !isMap;
    if (!isMap && !isPlain) {
      return { found: false, reason: 'backgroundTasks-not-map-or-object:' + (bt === null ? 'null' : typeof bt) };
    }

    const rawEntries = isMap ? Array.from(bt.entries()) : Object.entries(bt);
    const entries = rawEntries.slice(0, 50).map(([k, v]) => ({
      key: String(k),
      value: (v && typeof v === 'object') ? {
        id: typeof v.id === 'string' ? v.id : undefined,
        taskId: typeof v.taskId === 'string' ? v.taskId : undefined,
        label: typeof v.label === 'string' ? v.label : undefined,
        command: typeof v.command === 'string' ? v.command : undefined,
        description: typeof v.description === 'string' ? v.description : undefined,
        status: typeof v.status === 'string' ? v.status : undefined,
      } : {},
    }));

    return { found: true, sessionId: session.sessionId, entries };
  }`;

/** One-shot logging so a closed reader does not spam the log every tick. */
const loggedReasons = new Set<string>();

function logOnce(reason: string, message: string): void {
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  console.warn(`[claude-background-tasks] ${message}`);
}

/** Exposed so tests can assert the one-shot behaviour independently. */
export function resetBackgroundTaskLogging(): void {
  loggedReasons.clear();
}

export async function readBackgroundTasks(
  webview: Pick<ClaudeWebviewClient, 'isConnected' | 'evaluateInPanel'> | null,
  claudeVersion: string | null,
): Promise<BackgroundTasksOutcome> {
  if (!webview || !webview.isConnected()) {
    return { status: 'error', detail: 'no webview client' };
  }

  // Contract rule 5: an unverified version means an unverified shape.
  if (!claudeVersion || !VERIFIED_VERSIONS.includes(claudeVersion)) {
    logOnce(
      `unverified:${claudeVersion ?? 'unknown'}`,
      `Claude Code ${claudeVersion ?? 'version unknown'} has no verified backgroundTasks schema `
      + '— reporting no background tasks. Re-run scripts/probe-claude-code.ts and add the version '
      + 'to VERIFIED_VERSIONS.',
    );
    return { status: 'unverified-version', version: claudeVersion ?? 'unknown' };
  }

  let raw: LocatorResult | null;
  try {
    // Must run against the inner `#active-frame` document: the target's own
    // document is only VS Code's webview shell and has no React tree.
    raw = (await webview.evaluateInPanel(LOCATOR_JS_BODY, 8000)) as LocatorResult | null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logOnce(`eval:${detail}`, `backgroundTasks locator failed: ${detail}`);
    return { status: 'error', detail };
  }

  if (!raw?.found) {
    const reason = raw?.reason ?? 'unknown';
    logOnce(`locator:${reason}`, `backgroundTasks locator not satisfied (${reason}) — reporting none.`);
    return reason.startsWith('backgroundTasks-not-')
      ? { status: 'bad-shape', detail: reason }
      : { status: 'no-locator' };
  }

  const tasks: BackgroundTask[] = [];
  for (const entry of raw.entries ?? []) {
    const mapped = mapEntry(entry.key, entry.value);
    if (mapped) tasks.push(mapped);
  }

  return { status: 'ok', tasks };
}

/**
 * Map one entry onto {@link BackgroundTask}. Returns null when the entry lacks
 * both an id and a usable label — a half-read row is worse than no row.
 *
 * `expandSelectorPath` / `stopSelectorPath` stay unset: no verified DOM control
 * exists yet, so the UI renders the list read-only (contract rule 4).
 */
function mapEntry(key: string, value: RawBackgroundTaskEntry): BackgroundTask | null {
  const id = firstString(value.id, value.taskId, key);
  if (!id) return null;

  const label = firstString(value.label, value.command, value.description);
  if (!label) return null;

  const status = firstString(value.status);
  return {
    id,
    label,
    ...(status ? { detail: status } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Convert an outcome into the state field, applying the fail-closed default. */
export function outcomeToTasks(outcome: BackgroundTasksOutcome): BackgroundTask[] {
  return outcome.status === 'ok' ? outcome.tasks : [];
}
