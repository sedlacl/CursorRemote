import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Probe Cursor slash/skill menu + skill filesystem hints.
 * Opens composer, types "/", dumps slash-menu markup if present.
 *
 * Usage: npx tsx scripts/probe-skills-slash.ts [--window <substring>] [--no-type]
 */

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';
  const noType = args.includes('--no-type');

  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`);
  const targets = await resp.json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));
  if (pages.length === 0) {
    console.error('[probe-skills-slash] No workbench page targets at', config.cdpUrl);
    process.exit(2);
  }
  let target = pages[0]!;
  if (windowFilter) {
    const m = pages.find((p) => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (m) target = m;
  }
  console.log(`[probe-skills-slash] Probing "${target.title}" via ${config.cdpUrl}`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  const before = await client.evaluate(`
    (() => {
      const sels = [
        '.ui-slash-menu',
        '[class*="ui-slash-menu"]',
        '[data-testid*="slash"]',
        '[role="listbox"]',
        '[role="menu"]',
        '.mention',
        '[data-typeahead-type="cursor_skill"]',
      ];
      const hits = {};
      for (const sel of sels) {
        try { hits[sel] = document.querySelectorAll(sel).length; } catch { hits[sel] = -1; }
      }
      return hits;
    })()
  `);
  console.log('\n--- Before typing / ---');
  console.log(JSON.stringify(before, null, 2));

  if (!noType) {
    // Focus composer input
    const focused = await client.evaluate(`
      (() => {
        const sels = [
          '.aislash-editor-input[contenteditable="true"]',
          '[contenteditable="true"].aislash-editor-input',
          '.composer-bar [contenteditable="true"]',
          '[data-lexical-editor="true"]',
        ];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el) {
            el.focus();
            el.click();
            return sel;
          }
        }
        return null;
      })()
    `) as string | null;
    console.log(`\nFocused composer: ${focused ?? 'NONE'}`);
    if (focused) {
      await client.typeText('/');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const after = await client.evaluate(`
    (() => {
      const out = { menuRoots: [], items: [], pinButtons: 0, classSamples: [] };
      out.pinButtons = document.querySelectorAll('.ui-slash-menu__pin-button, [class*="ui-slash-menu__pin"]').length;
      const roots = Array.from(document.querySelectorAll(
        '.ui-slash-menu, [class*="ui-slash-menu"], [data-testid*="slash"], [role="listbox"]'
      )).slice(0, 8);
      out.menuRoots = roots.map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        className: (el.className || '').toString().slice(0, 160),
        childCount: el.children.length,
        attrs: Array.from(el.attributes || []).slice(0, 12).map((a) => a.name + '=' + String(a.value).slice(0, 80)),
        outer: (el.outerHTML || '').slice(0, 700),
      }));
      const itemCandidates = roots.length
        ? roots.flatMap((root) => Array.from(root.querySelectorAll('[role="option"], [role="menuitem"], button, li, [data-index], [data-value]')))
        : Array.from(document.querySelectorAll('[class*="slash"] [role="option"], [class*="slash"] [role="menuitem"]'));
      out.items = itemCandidates.slice(0, 30).map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        className: (el.className || '').toString().slice(0, 120),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        attrs: Array.from(el.attributes || []).slice(0, 14).map((a) => a.name + '=' + String(a.value).slice(0, 80)),
      }));
      // Unique class tokens containing slash/skill
      const classes = new Set();
      for (const el of Array.from(document.querySelectorAll('[class*="slash"], [class*="skill"]')).slice(0, 80)) {
        for (const c of String(el.className || '').split(/\\s+/)) {
          if (/slash|skill/i.test(c)) classes.add(c);
        }
      }
      out.classSamples = Array.from(classes).slice(0, 40);
      return out;
    })()
  `);
  console.log('\n--- After typing / ---');
  console.log(JSON.stringify(after, null, 2));

  if (!noType) {
    await client.pressKey('Escape', 'Escape', 27);
  }

  // Also dump subagent markers while we're here
  const subagents = await client.evaluate(`
    (() => {
      const sels = {
        legacyCard: document.querySelectorAll('.subagent-task-card[data-chrome="card"]').length,
        newCard: document.querySelectorAll('[data-subagent-task-card="true"]').length,
        newHeader: document.querySelectorAll('[data-subagent-task-card-header="true"]').length,
        newModel: document.querySelectorAll('[data-subagent-task-model="true"]').length,
        newStop: document.querySelectorAll('[data-subagent-task-action="stop"]').length,
      };
      const card = document.querySelector('[data-subagent-task-card="true"]');
      return {
        counts: sels,
        cardSample: card ? {
          outer: (card.outerHTML || '').slice(0, 1200),
          headerText: (card.querySelector('[data-subagent-task-card-header="true"]')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
          modelText: (card.querySelector('[data-subagent-task-model="true"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        } : null,
      };
    })()
  `);
  console.log('\n--- Subagent markers ---');
  console.log(JSON.stringify(subagents, null, 2));

  await client.disconnect();
  console.log('\n[probe-skills-slash] done.');
}

main().catch((err) => {
  console.error('[probe-skills-slash] failed:', err);
  process.exit(1);
});
