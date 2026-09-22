/**
 * Phase 0 probe for the Claude Code adapter (plan: claude_code_adapter_8ab457cf).
 *
 * Read-only reconnaissance of the `anthropic.claude-code` webviews:
 *   - list Claude CDP targets and classify each surface (chat / session list)
 *   - inventory input, send, stop, permission and session-list controls
 *   - test the fail-closed `backgroundTasks` locator (never runs `/tasks`)
 *   - dump inner-frame DOM + screenshots into temp/ (gitignored)
 *
 * The probe NEVER types, clicks, sends a message or runs a slash command.
 *
 * Run it after every Claude Code version bump: the selectors below are verified
 * facts about one build, not a stable API.
 *
 * Usage:
 *   npx tsx scripts/probe-claude-code.ts [--window <substr>]
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';
import { detectClaudeCodeVersion } from '../src/server/hosts/claude-version.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Query marker every Claude Code webview target carries. Identification is by
 * URL, not by DOM fingerprint — the webview origin hash is random, this is not.
 *
 * `purpose` is deliberately NOT filtered: Claude Code runs both as a side panel
 * (`purpose=webviewView`) and as a full editor tab in the main window.
 */
const CLAUDE_MARKER = 'extensionId=Anthropic.claude-code';

/**
 * A webview target's own document is only VS Code's webview shell. The
 * extension's UI lives in a nested same-origin iframe, `#active-frame`, so
 * every read goes through its `contentDocument` — querying the outer document
 * finds nothing at all.
 */
function inPanel(fn: string): string {
  return `
    (() => {
      const f = document.getElementById('active-frame');
      if (!f || !f.contentDocument) return { __noFrame: true };
      return (${fn})(f.contentDocument, f.contentWindow);
    })()
  `;
}

const OUT_DIR = join(process.cwd(), 'temp', 'probe-claude-code');

/** Shared element describer, injected into each probe body. */
const DESC_FN = `
  const desc = (el) => {
    const attrs = {};
    for (const a of Array.from(el.attributes || [])) {
      if (a.name === 'class' || a.name === 'role' || a.name === 'id' || a.name === 'title'
          || a.name === 'contenteditable' || a.name === 'placeholder'
          || a.name.startsWith('data-') || a.name.startsWith('aria-')) {
        attrs[a.name] = String(a.value).slice(0, 160);
      }
    }
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      attrs,
      rect: { y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0,
    };
  };
`;

/** Which surface this webview renders. */
const VIEW_JS = inPanel(`(d) => {
  if (d.querySelector('[role="textbox"][aria-label="Message input"]')) return 'chat';
  if (d.querySelector('[id^="sessions-list-row-"]')) return 'session-list';
  return 'unknown';
}`);

/** Inventory of candidate controls, without touching any of them. */
const CONTROLS_JS = inPanel(`(d) => {
  ${DESC_FN}
  const all = (sel) => Array.from(d.querySelectorAll(sel)).slice(0, 12).map(desc);
  const controls = Array.from(d.querySelectorAll('button, [role="button"]'))
    .map(desc)
    .filter(b => b.visible);
  const byLabel = (re) => controls.filter(b =>
    re.test(b.text) || re.test(b.attrs['aria-label'] || '') || re.test(b.attrs.title || ''));

  return {
    input: all('[role="textbox"][aria-label="Message input"]'),
    contentEditable: all('[contenteditable]'),
    sessionRows: all('[id^="sessions-list-row-"]'),
    controlCount: controls.length,
    send: byLabel(/send|submit/i),
    stop: byLabel(/\\b(stop|interrupt)\\b/i),
    permission: byLabel(/allow|deny|approve|reject|\\byes\\b|\\bno\\b|always/i),
    diff: byLabel(/accept|keep|undo|revert/i),
    model: byLabel(/model/i),
    mode: byLabel(/shift\\+tab|permission mode|approve actions/i),
    newSession: byLabel(/new session|new conversation/i),
    // Everything labelled, so a bump that renames a control is visible in the diff.
    // Capped: a long transcript yields hundreds of "Copy code to clipboard".
    allLabels: controls.slice(0, 30).map(b => ({
      label: b.attrs['aria-label'] || b.attrs.title || b.text.slice(0, 40),
      y: b.rect.y,
    })),
  };
}`);

/**
 * Fail-closed locator per plan §"Background tasky — Map ano, /tasks ne".
 *
 * Requires a NAMED object owning both `sessionId` and `backgroundTasks`. Also
 * reports a wider sweep (any object with either property) so a negative result
 * distinguishes "shape changed" from "not in the webview at all".
 */
const BACKGROUND_TASKS_JS = inPanel(`(d) => {
  const MAX_NODES = 200000;
  const MAX_DEPTH = 60;
  const seen = new Set();
  let visited = 0;
  const strictHits = [];
  const looseBgProps = [];
  let sessionIdObjects = 0;

  const roots = [];
  const walkDom = (el, depth) => {
    if (!el || depth > 6) return;
    for (const key of Object.keys(el)) {
      if (key.indexOf('__react') === 0 || key.indexOf('_react') === 0) roots.push(el[key]);
    }
    for (const child of Array.from(el.children || [])) walkDom(child, depth + 1);
  };
  if (d.body) walkDom(d.body, 0);

  const describeTasks = (bt) => {
    const isMap = bt instanceof Map;
    const entries = isMap ? Array.from(bt.entries())
      : (bt && typeof bt === 'object' ? Object.entries(bt) : []);
    return {
      kind: isMap ? 'Map' : (bt === null ? 'null' : Array.isArray(bt) ? 'Array' : typeof bt),
      size: entries.length,
      sampleKeys: entries.slice(0, 2).map(([k]) => String(k).slice(0, 60)),
      sampleValueKeys: entries.slice(0, 2).map(([, v]) =>
        v && typeof v === 'object' ? Object.keys(v).slice(0, 30) : typeof v),
      sample: entries.slice(0, 2).map(([k, v]) => {
        let plain;
        try {
          plain = JSON.parse(JSON.stringify(v, (_k, val) => typeof val === 'function' ? '[fn]' : val));
        } catch (e) { plain = String(v).slice(0, 200); }
        return { key: String(k).slice(0, 60), value: plain };
      }),
    };
  };

  const KEYS = ['memoizedState', 'memoizedProps', 'stateNode', 'child', 'sibling', 'return',
                'next', 'baseState', 'current', 'value', 'state', 'props', 'pendingProps',
                'dependencies', 'firstContext', 'context', '_currentValue', 'store'];

  const visit = (node, depth, path) => {
    if (!node || typeof node !== 'object' || visited > MAX_NODES || depth > MAX_DEPTH) return;
    if (seen.has(node)) return;
    seen.add(node);
    visited++;
    try {
      const hasBg = Object.prototype.hasOwnProperty.call(node, 'backgroundTasks');
      const hasSid = typeof node.sessionId === 'string' && node.sessionId.length > 0;
      if (hasSid) sessionIdObjects++;
      if (hasBg && looseBgProps.length < 6) {
        looseBgProps.push({ path: path.slice(0, 160), siblingKeys: Object.keys(node).slice(0, 40) });
      }
      if (hasSid && hasBg && strictHits.length < 4) {
        strictHits.push({
          path: path.slice(0, 160),
          sessionId: String(node.sessionId).slice(0, 80),
          ownKeys: Object.keys(node).slice(0, 50),
          backgroundTasks: describeTasks(node.backgroundTasks),
          backgroundTaskIds: Array.isArray(node.backgroundTaskIds)
            ? node.backgroundTaskIds.slice(0, 5)
            : (node.backgroundTaskIds === undefined ? '<absent>' : typeof node.backgroundTaskIds),
        });
        return;
      }
    } catch (e) { return; }
    for (const key of KEYS) {
      try {
        const child = node[key];
        if (child && typeof child === 'object') visit(child, depth + 1, path + '.' + key);
      } catch (e) { /* getters may throw */ }
    }
  };
  for (const root of roots) visit(root, 0, 'root');

  return {
    reactRoots: roots.length,
    visited,
    sessionIdObjects,
    strictHitCount: strictHits.length,
    strictHits,
    looseBgPropCount: looseBgProps.length,
    looseBgProps,
    verdict: strictHits.length > 0
      ? 'Locator satisfied — record the value schema, then add the version to VERIFIED_VERSIONS.'
      : (sessionIdObjects === 0
        ? 'No sessionId object in the webview at all: session state lives in the extension host, which CDP cannot reach. Reader stays closed.'
        : 'sessionId objects exist but none owns backgroundTasks: shape changed. Reader stays closed.'),
  };
}`);

const DOM_DUMP_JS = inPanel(`(d) =>
  d.documentElement ? d.documentElement.outerHTML.slice(0, 900000) : ''`);

function isNoFrame(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { __noFrame?: boolean }).__noFrame === true;
}

function queryParam(url: string, name: string): string {
  const match = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Workbench-side: which tabs and webview iframes exist, for target pairing. */
async function probeWorkbenchTabs(client: CdpClient): Promise<unknown> {
  return client.evaluate(`
    (() => {
      const tabs = Array.from(document.querySelectorAll('.tabs-container .tab')).map(el => {
        const label = el.querySelector('.label-name, .monaco-icon-name-container');
        return {
          text: ((label ? label.textContent : el.textContent) || '').trim().slice(0, 80),
          active: el.classList.contains('active'),
          dataResource: (el.getAttribute('data-resource-name') || '').slice(0, 120),
        };
      });
      // A workbench iframe's name is the webview target's \`id=\` query param —
      // that is how a visible tab pairs to a CDP target.
      const webviewIframes = Array.from(document.querySelectorAll('iframe.webview, iframe[src*="vscode-webview"]'))
        .slice(0, 12)
        .map(f => ({
          name: (f.getAttribute('name') || '').slice(0, 120),
          title: (f.getAttribute('title') || '').slice(0, 80),
        }));
      return { tabCount: tabs.length, tabs: tabs.slice(0, 25), webviewIframes };
    })()
  `, 10000);
}

async function screenshot(client: CdpClient): Promise<string | null> {
  try {
    const res = await client.send('Page.captureScreenshot', { format: 'png' }, 15000);
    return (res as { data?: string }).data ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  mkdirSync(OUT_DIR, { recursive: true });
  const config = loadConfig();
  const claudeVersion = detectClaudeCodeVersion();

  console.log(`[probe-claude] CDP: ${config.cdpUrl}`);
  console.log(`[probe-claude] Claude Code version: ${claudeVersion ?? 'not installed'}`);

  const targets = (await (await fetch(`${config.cdpUrl}/json`)).json()) as CDPTarget[];
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
  const claudeTargets = targets.filter(
    t => typeof t.url === 'string' && t.url.includes(CLAUDE_MARKER) && !!t.webSocketDebuggerUrl,
  );

  console.log(`[probe-claude] ${pages.length} workbench page(s), ${claudeTargets.length} Claude webview target(s)`);
  if (claudeTargets.length === 0) {
    console.log('[probe-claude] No Claude Code webview is open. Open the panel (or a Claude editor tab) and re-run.');
  }

  const report: Record<string, unknown> = {
    probedAt: new Date().toISOString(),
    cdpUrl: config.cdpUrl,
    claudeVersion,
    claudeTargetCount: claudeTargets.length,
  };

  // --- workbench side -------------------------------------------------------
  let page = pages[0];
  if (windowFilter) {
    const match = pages.find(p => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (match) page = match;
  }
  if (page?.webSocketDebuggerUrl) {
    const wb = new CdpClient();
    try {
      await wb.connect(page.webSocketDebuggerUrl);
      report.workbench = { title: page.title, tabs: await probeWorkbenchTabs(wb) };
    } catch (err) {
      report.workbench = { error: String(err) };
    } finally {
      wb.disconnect();
    }
  }

  // --- Claude webviews ------------------------------------------------------
  const webviewReports: unknown[] = [];
  for (const target of claudeTargets) {
    const short = target.id.slice(0, 8);
    const client = new CdpClient();
    let entry: Record<string, unknown> = {
      targetId: target.id,
      webviewName: queryParam(target.url, 'id'),
      purpose: queryParam(target.url, 'purpose') || '(editor tab)',
    };

    try {
      await client.connect(target.webSocketDebuggerUrl!, 6000);

      const view = await client.evaluate(VIEW_JS, 8000);
      if (isNoFrame(view)) {
        entry.view = 'no-active-frame';
        webviewReports.push(entry);
        continue;
      }
      entry.view = view;
      console.log(`[probe-claude] ${short} view=${String(view)} purpose=${entry.purpose}`);

      entry.controls = await client.evaluate(CONTROLS_JS, 15000);
      entry.backgroundTasks = await client.evaluate(BACKGROUND_TASKS_JS, 45000);

      const html = await client.evaluate(DOM_DUMP_JS, 20000);
      if (typeof html === 'string' && html) {
        const file = join(OUT_DIR, `panel-${short}-${String(view)}.html`);
        writeFileSync(file, html, 'utf-8');
        entry.domDump = file;
      }
      const shot = await screenshot(client);
      if (shot) {
        const file = join(OUT_DIR, `panel-${short}.png`);
        writeFileSync(file, Buffer.from(shot, 'base64'));
        entry.screenshot = file;
      }
    } catch (err) {
      entry = { ...entry, error: String(err) };
    } finally {
      client.disconnect();
    }
    webviewReports.push(entry);
  }
  report.claudeWebviews = webviewReports;

  const reportPath = join(OUT_DIR, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n[probe-claude] Report written to ${reportPath}`);

  for (const entry of webviewReports) {
    const bt = (entry as { backgroundTasks?: { verdict?: string } }).backgroundTasks;
    if (bt?.verdict) console.log(`[probe-claude] backgroundTasks: ${bt.verdict}`);
  }
}

main().catch(err => {
  console.error('[probe-claude] failed:', err);
  process.exit(1);
});
