import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** 1x1 PNG */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const config = loadConfig();
  const targets = await (await fetch(`${config.cdpUrl}/json`)).json() as CDPTarget[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page?.webSocketDebuggerUrl) {
    console.error('No workbench');
    process.exit(2);
  }

  mkdirSync('temp', { recursive: true });
  const pngPath = join(process.cwd(), 'temp', 'probe-tiny.png');
  writeFileSync(pngPath, Buffer.from(TINY_PNG_B64, 'base64'));

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);

  // Focus composer + find file input
  const prep = await client.evaluate(`
    (() => {
      const inputSels = [
        '.aislash-editor-input[contenteditable="true"]',
        '[contenteditable="true"].aislash-editor-input',
        '.composer-bar [contenteditable="true"]',
      ];
      let focused = null;
      for (const sel of inputSels) {
        const el = document.querySelector(sel);
        if (el) { el.focus(); el.click(); focused = sel; break; }
      }
      const fileSels = [
        ".composer-bar input[type='file']",
        "#workbench\\\\.parts\\\\.auxiliarybar input[type='file']",
        "input[type='file'][accept*='image']",
        "input[type='file']",
      ];
      const files = [];
      for (const sel of fileSels) {
        try {
          const els = Array.from(document.querySelectorAll(sel));
          for (const el of els) {
            files.push({
              sel,
              accept: el.getAttribute('accept') || '',
              id: el.id || '',
              className: String(el.className || '').slice(0, 80),
            });
          }
        } catch {}
      }
      return { focused, files };
    })()
  `);
  console.log('prep', JSON.stringify(prep, null, 2));

  // Use CDP DOM.setFileInputFiles via backend node
  const doc = await client.send('DOM.getDocument', { depth: 0 });
  const rootId = (doc as { root?: { nodeId?: number } }).root?.nodeId;
  if (!rootId) throw new Error('No DOM root');

  let fileNodeId: number | null = null;
  for (const sel of [
    ".composer-bar input[type='file']",
    "input[type='file'][accept*='image']",
    "input[type='file']",
  ]) {
    try {
      const q = await client.send('DOM.querySelector', { nodeId: rootId, selector: sel });
      const nodeId = (q as { nodeId?: number }).nodeId;
      if (nodeId) {
        fileNodeId = nodeId;
        console.log('file input via', sel, nodeId);
        break;
      }
    } catch {}
  }
  if (!fileNodeId) {
    console.error('No file input found');
    await client.disconnect();
    process.exit(3);
  }

  await client.send('DOM.setFileInputFiles', { nodeId: fileNodeId, files: [pngPath] });
  await new Promise((r) => setTimeout(r, 600));

  const afterAttach = await client.evaluate(`
    (() => {
      const pick = (root, sel) => Array.from((root || document).querySelectorAll(sel)).slice(0, 20).map((el) => ({
        tag: el.tagName,
        className: String(el.className || '').slice(0, 140),
        attrs: Array.from(el.attributes || []).slice(0, 16).map((a) => a.name + '=' + String(a.value).slice(0, 80)),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        outer: (el.outerHTML || '').slice(0, 400),
      }));
      const bar = document.querySelector('.composer-bar') || document.body;
      return {
        imgsInComposer: pick(bar, 'img'),
        attachClass: pick(bar, '[class*="attach"], [class*="image"], [data-attachment], [data-image]'),
        composerOuterHints: (() => {
          const nodes = Array.from(bar.querySelectorAll('img, [class*="attach"], [class*="thumbnail"], [class*="media"]')).slice(0, 10);
          return nodes.map((n) => (n.outerHTML || '').slice(0, 350));
        })(),
      };
    })()
  `);
  console.log('\\n--- after attach (composer) ---');
  console.log(JSON.stringify(afterAttach, null, 2));

  // Type marker text and send
  await client.typeText('probe-image-indicator ' + Date.now());
  await new Promise((r) => setTimeout(r, 200));
  await client.pressKey('Enter', 'Enter', 13);
  await new Promise((r) => setTimeout(r, 1200));

  const afterSend = await client.evaluate(`
    (() => {
      const humans = Array.from(document.querySelectorAll('.aislash-editor-input-readonly'));
      const samples = humans.slice(-5).map((el) => {
        const wrap = el.closest('[data-message-id]') || el.parentElement;
        return {
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          imgCount: el.querySelectorAll('img').length,
          wrapImgCount: wrap ? wrap.querySelectorAll('img').length : 0,
          wrapOuter: wrap ? (wrap.outerHTML || '').slice(0, 1500) : null,
          inputOuter: (el.outerHTML || '').slice(0, 1200),
          attachHits: Array.from((wrap || el).querySelectorAll('[class*="attach"], [class*="image"], img, picture, canvas, [data-attachment], [aria-label*="image" i]'))
            .slice(0, 12)
            .map((n) => ({
              tag: n.tagName,
              className: String(n.className || '').slice(0, 120),
              attrs: Array.from(n.attributes || []).slice(0, 14).map((a) => a.name + '=' + String(a.value).slice(0, 70)),
              outer: (n.outerHTML || '').slice(0, 300),
            })),
        };
      });
      // Also search any recent img near "probe-image-indicator"
      const all = Array.from(document.querySelectorAll('[data-message-id], .aislash-editor-input-readonly'));
      const matched = all.filter((el) => /probe-image-indicator/.test(el.textContent || '')).slice(0, 5).map((el) => ({
        tag: el.tagName,
        messageId: el.getAttribute('data-message-id'),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
        outer: (el.outerHTML || '').slice(0, 2000),
        imgs: el.querySelectorAll('img').length,
      }));
      return { samples, matched, totalImgs: document.querySelectorAll('img').length };
    })()
  `);
  console.log('\\n--- after send ---');
  console.log(JSON.stringify(afterSend, null, 2));

  await client.disconnect();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
