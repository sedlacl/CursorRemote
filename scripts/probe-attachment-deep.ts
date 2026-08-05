import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function main() {
  const config = loadConfig();
  const targets = await (await fetch(`${config.cdpUrl}/json`)).json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));
  console.log('windows:', pages.map((p) => p.title));
  if (!pages[0]?.webSocketDebuggerUrl) {
    console.error('No workbench target');
    process.exit(2);
  }

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(pages[0].webSocketDebuggerUrl);

  const report = await client.evaluate(`
    (() => {
      const pick = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 12).map((el) => ({
        tag: el.tagName,
        className: String(el.className || '').slice(0, 140),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        attrs: Array.from(el.attributes || []).slice(0, 16).map((a) => a.name + '=' + String(a.value).slice(0, 70)),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        inHuman: !!el.closest('.aislash-editor-input-readonly, [data-message-role="human"], [data-role="human"]'),
        parent: el.parentElement ? {
          tag: el.parentElement.tagName,
          className: String(el.parentElement.className || '').slice(0, 120),
        } : null,
        ancestorChain: (() => {
          const parts = [];
          let n = el;
          for (let i = 0; i < 6 && n; i++) {
            parts.push(n.tagName + '.' + String(n.className || '').split(/\\s+/).slice(0, 3).join('.'));
            n = n.parentElement;
          }
          return parts;
        })(),
      }));
      return {
        attachClass: pick('[class*="attachment"]'),
        imageClass: pick('[class*="image"]'),
        ariaImage: pick('[aria-label*="image" i], [aria-label*="Image"]'),
        ariaAttach: pick('[aria-label*="attachment" i], [aria-label*="Attachment"]'),
        imgs: pick('img'),
        humanReadonlyCount: document.querySelectorAll('.aislash-editor-input-readonly').length,
        humanReadonlyHtml: Array.from(document.querySelectorAll('.aislash-editor-input-readonly'))
          .slice(0, 3)
          .map((el) => (el.outerHTML || '').slice(0, 900)),
      };
    })()
  `);
  console.log(JSON.stringify(report, null, 2));
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
