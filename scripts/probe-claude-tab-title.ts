/**
 * Compare Cursor editor-tab labels with the Claude webview header title.
 *
 * Usage: npx tsx scripts/probe-claude-tab-title.ts
 */
import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const MARKER = 'extensionId=Anthropic.claude-code';

async function main() {
  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`)).json()) as CDPTarget[];

  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench') && t.webSocketDebuggerUrl);
  if (page?.webSocketDebuggerUrl) {
    const client = new CdpClient();
    await client.connect(page.webSocketDebuggerUrl, 6000);
    const tabs = await client.evaluate(`(() => {
      return Array.from(document.querySelectorAll('[role="tab"]')).slice(0, 40).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
          w: Math.round(r.width),
          y: Math.round(r.y),
        };
      }).filter((t) => t.w > 0 && t.label);
    })()`, 8000);
    console.log('workbench tabs', JSON.stringify(tabs, null, 2));
    client.disconnect();
  }

  const claude = targets.filter((t) => t.url.includes(MARKER) && t.webSocketDebuggerUrl);
  for (const target of claude) {
    const purpose = new URL(target.url).searchParams.get('purpose') || 'editor';
    const client = new CdpClient();
    try {
      await client.connect(target.webSocketDebuggerUrl!, 6000);
      const header = await client.evaluate(`(() => {
        const f = document.getElementById('active-frame');
        const d = f && f.contentDocument;
        if (!d) return { noFrame: true };
        const anchor = d.querySelector('[aria-label="New session"]');
        const y = anchor ? anchor.getBoundingClientRect().y : -1;
        const row = Array.from(d.querySelectorAll('button, [role="button"], h1, h2, [role="heading"]')).map((el) => {
          const r = el.getBoundingClientRect();
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim();
          return { tag: el.tagName, label: label.slice(0, 80), y: Math.round(r.y), w: Math.round(r.width) };
        }).filter((c) => c.label && c.w > 0 && (y < 0 || Math.abs(c.y - y) <= 8));
        return { purpose: ${JSON.stringify(purpose)}, y, row };
      })()`, 8000);
      console.log('claude', JSON.stringify(header, null, 2));
    } finally {
      client.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
