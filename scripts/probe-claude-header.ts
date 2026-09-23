/**
 * Read the Claude chat header: model label and session-history menu.
 * Clicks "Session history" once, dumps row ids, then presses Escape.
 *
 * Usage: npx tsx scripts/probe-claude-header.ts
 */
import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';

interface CDPTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const MARKER = 'extensionId=Anthropic.claude-code';

function inPanel(fn: string): string {
  return `(() => {
    const f = document.getElementById('active-frame');
    if (!f || !f.contentDocument) return { __noFrame: true };
    return (${fn})(f.contentDocument);
  })()`;
}

const HEADER_JS = inPanel(`(d) => {
  const buttons = Array.from(d.querySelectorAll('button, [role="button"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      return { label: label.slice(0, 80), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })
    .filter((b) => b.label && b.w > 0 && b.h > 0 && b.y < 120);
  const modelish = Array.from(d.querySelectorAll('button, [role="button"], [aria-label]'))
    .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => /opus|sonnet|haiku|model|claude/i.test(t))
    .slice(0, 12);
  return { buttons, modelish };
}`);

const OPEN_HISTORY_JS = inPanel(`(d) => {
  const buttons = Array.from(d.querySelectorAll('button, [role="button"]'));
  const hit = buttons.find((el) => /session history/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || ''));
  if (!hit) return { clicked: false };
  hit.click();
  return { clicked: true };
}`);

const DETAIL_JS = inPanel(`(d) => {
  const buttons = Array.from(d.querySelectorAll('button, [role="button"]'));
  const modelBtn = buttons.find((el) => /switch model|opus|sonnet|haiku/i.test(
    (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '')
  ));
  return {
    aria: modelBtn ? modelBtn.getAttribute('aria-label') : null,
    text: modelBtn ? (modelBtn.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    html: modelBtn ? (modelBtn.innerHTML || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
  };
}`);

const MENU_JS = inPanel(`(d) => {
  const rows = Array.from(d.querySelectorAll('[id^="sessions-list-row-"]')).slice(0, 8).map((el) => ({
    id: el.id,
    attrs: Array.from(el.attributes || []).map((a) => a.name + '=' + String(a.value).slice(0, 80)),
    label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  }));
  const bottom = Array.from(d.querySelectorAll('button, [role="button"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      return { label: label.slice(0, 60), y: Math.round(r.y), w: Math.round(r.width) };
    })
    .filter((b) => b.w > 0 && b.y > 200 && b.label && !/copy|clipboard|show more|message actions/i.test(b.label))
    .slice(0, 15);
  return { rows, bottom };
}`);

function qp(url: string, name: string): string {
  const m = new RegExp(`[?&]${name}=([^&]+)`).exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

async function main() {
  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`)).json()) as CDPTarget[];
  const claude = targets.filter((t) => t.url.includes(MARKER) && t.webSocketDebuggerUrl);
  console.log(`[probe-claude-header] ${claude.length} target(s)`);
  for (const target of claude) {
    const client = new CdpClient();
    console.log(`\n--- ${target.id.slice(0, 8)} purpose=${qp(target.url, 'purpose') || '(editor)'} ---`);
    try {
      await client.connect(target.webSocketDebuggerUrl!, 6000);
      const opened = await client.evaluate(OPEN_HISTORY_JS, 8000);
      console.log('open', JSON.stringify(opened));
      await new Promise((r) => setTimeout(r, 400));
      console.log(JSON.stringify(await client.evaluate(DETAIL_JS, 8000), null, 2));
      console.log(JSON.stringify(await client.evaluate(MENU_JS, 8000), null, 2));
      await client.pressKey('Escape', 'Escape', 27);
    } catch (err) {
      console.error(err);
    } finally {
      client.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
