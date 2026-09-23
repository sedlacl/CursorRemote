import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// Opens the Cursor model picker via the new + legacy trigger selectors,
// then dumps the resulting menu (and its child rows) so we can confirm the
// selectors used inside command-executor.ts still work on the current Cursor.
//
// Usage: npm run cdp:discover-dom -- model-picker
// or:    npx tsx scripts/probe-model-picker.ts [--window <substring>]

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`);
  const targets = await resp.json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));
  if (pages.length === 0) {
    console.error('[probe-model-picker] No workbench page targets found at', config.cdpUrl);
    process.exit(2);
  }
  let target = pages[0];
  if (windowFilter) {
    const m = pages.find((p) => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (m) target = m;
  }
  console.log(`[probe-model-picker] Probing "${target.title}"`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  // Step 1: report which trigger selectors match before opening.
  const triggerReport = await client.evaluate(`
    (() => {
      const out = {};
      for (const sel of ['.vscode-model-picker__trigger', '.ui-model-picker__trigger', '.composer-unified-dropdown-model']) {
        const els = document.querySelectorAll(sel);
        out[sel] = {
          count: els.length,
          first: els[0] ? (els[0].outerHTML || '').slice(0, 400) : null,
          ariaControls: els[0] ? els[0].getAttribute('aria-controls') : null,
          ariaExpanded: els[0] ? els[0].getAttribute('aria-expanded') : null,
        };
      }
      return out;
    })()
  `) as Record<string, { count: number; first: string | null; ariaControls: string | null; ariaExpanded: string | null }>;
  console.log('\n--- Trigger selectors (before click) ---');
  console.log(JSON.stringify(triggerReport, null, 2));

  // Step 2: click the first matching trigger.
  const clicked = await client.evaluate(`
    (() => {
      for (const sel of ['.vscode-model-picker__trigger', '.ui-model-picker__trigger', '.composer-unified-dropdown-model']) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return sel; }
      }
      return null;
    })()
  `) as string | null;
  console.log(`\nClicked: ${clicked ?? 'NOTHING (no trigger matched)'}`);
  if (!clicked) {
    process.exit(3);
  }

  await new Promise((r) => setTimeout(r, 400));

  // Step 3: report what the menu looks like now.
  const menuReport = await client.evaluate(`
    (() => {
      const out = {};
      out.byTestId = !!document.querySelector('[data-testid="model-picker-menu"]');
      const trigger = document.querySelector(
        '.vscode-model-picker__trigger[aria-expanded="true"],.ui-model-picker__trigger[aria-expanded="true"],.composer-unified-dropdown-model[aria-expanded="true"]'
      );
      out.ariaControls = trigger ? trigger.getAttribute('aria-controls') : null;
      out.menuByControls = (() => {
        if (!out.ariaControls) return null;
        const el = document.getElementById(out.ariaControls);
        return el ? { tag: el.tagName, role: el.getAttribute('role'), childCount: el.children.length, outer: (el.outerHTML || '').slice(0, 600) } : null;
      })();
      const openMenu = document.querySelector('[role="menu"][data-state="open"]')
        || document.querySelector('[role="menu"]:not([hidden])');
      out.firstOpenMenu = openMenu ? {
        tag: openMenu.tagName,
        role: openMenu.getAttribute('role'),
        dataState: openMenu.getAttribute('data-state'),
        childCount: openMenu.children.length,
      } : null;
      const itemsSel = '[id], [role="menuitem"], button, [data-testid]';
      const items = openMenu ? Array.from(openMenu.querySelectorAll(itemsSel)) : [];
      out.itemSample = items.slice(0, 12).map((it) => ({
        tag: it.tagName,
        id: it.id || '',
        role: it.getAttribute('role'),
        testid: it.getAttribute('data-testid'),
        text: (it.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      }));
      return out;
    })()
  `);
  console.log('\n--- Menu after click ---');
  console.log(JSON.stringify(menuReport, null, 2));

  const structure = await client.evaluate(`
    (() => {
      const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], .ui-menu'));
      return menus.slice(0, 6).map((m) => {
        const rect = m.getBoundingClientRect();
        const sections = Array.from(m.querySelectorAll('.ui-menu__section, [role="group"]')).slice(0, 8).map((sec) => ({
          cls: String(sec.className || '').slice(0, 80),
          title: ((sec.querySelector('.ui-menu__section-title, [class*="section-title"]') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        }));
        const rows = Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [aria-haspopup]')).slice(0, 24).map((it) => ({
          role: it.getAttribute('role'),
          popup: it.getAttribute('aria-haspopup'),
          expanded: it.getAttribute('aria-expanded'),
          controls: it.getAttribute('aria-controls'),
          cls: String(it.className || '').split(/\\s+/).slice(0, 4).join(' '),
          text: (it.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        }));
        return {
          role: m.getAttribute('role'),
          state: m.getAttribute('data-state'),
          id: m.id || '',
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          sections,
          rows,
        };
      });
    })()
  `);
  console.log('\n--- Menu structure ---');
  console.log(JSON.stringify(structure, null, 2));

  const submenu = await client.evaluate(`
    (() => {
      const menu = document.querySelector('[role="menu"]');
      if (!menu) return { error: 'no menu' };
      const triggers = Array.from(menu.querySelectorAll('.ui-menu__submenu-trigger, [aria-haspopup="menu"]'));
      const model = triggers.find((t) => /^model/i.test((t.textContent || '').replace(/\\s+/g, '')));
      if (!model) return { error: 'no model trigger', count: triggers.length };
      (model.querySelector('.composer-unified-context-menu-item') || model).click();
      return { clicked: (model.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    })()
  `);
  console.log('\n--- Opened model submenu ---');
  console.log(JSON.stringify(submenu, null, 2));
  await new Promise((r) => setTimeout(r, 400));
  const catalog = await client.evaluate(`
    (() => {
      const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return menus.map((m) => ({
        id: m.id || '',
        h: Math.round(m.getBoundingClientRect().height),
        rows: Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).slice(0, 30).map((it) => ({
          role: it.getAttribute('role'),
          popup: it.getAttribute('aria-haspopup'),
          checked: it.getAttribute('aria-checked'),
          cls: String(it.className || '').split(/\\s+/).filter((c) => c.startsWith('ui-menu') || c.includes('selected') || c.includes('checked')).join(' '),
          text: (it.innerText || it.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
        })),
      }));
    })()
  `);
  console.log('\n--- Visible menus after Model click ---');
  console.log(JSON.stringify(catalog, null, 2));

  // Step 4: close the menu.
  await client.pressKey('Escape', 'Escape', 27);
  await new Promise((r) => setTimeout(r, 100));
  await client.pressKey('Escape', 'Escape', 27);

  await client.disconnect();
  console.log('\n[probe-model-picker] done. Paste this report into issue #22 to confirm the fix.');
}

main().catch((err) => {
  console.error('[probe-model-picker]', err);
  process.exit(1);
});
