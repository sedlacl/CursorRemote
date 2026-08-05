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
 * Probe human-message image attachment markers in live Cursor DOM.
 *
 * Usage: npx tsx scripts/probe-image-attachments.ts [--window <substring>]
 * Env:   CDP_URL (default http://127.0.0.1:9222)
 */

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`);
  const targets = await resp.json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));
  if (pages.length === 0) {
    console.error('[probe-image-attachments] No workbench page targets at', config.cdpUrl);
    process.exit(2);
  }
  let target = pages[0]!;
  if (windowFilter) {
    const m = pages.find((p) => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (m) target = m;
  }
  console.log(`[probe-image-attachments] Probing "${target.title}" via ${config.cdpUrl}`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  const report = await client.evaluate(`
    (() => {
      const out = {
        humanRows: 0,
        withImg: 0,
        withPicture: 0,
        withCanvas: 0,
        markerHits: {},
        samples: [],
      };
      const markers = [
        'img',
        'picture',
        'canvas',
        '[data-attachment]',
        '[data-attachments]',
        '[data-image-attachment]',
        '[data-image]',
        '[data-file-attachment]',
        '.image-attachment',
        '.composer-attachment',
        '.attachment-image',
        '.ui-image',
        '.aislash-editor-input-readonly img',
        '[class*="attachment"]',
        '[class*="image"]',
        '[aria-label*="image" i]',
        '[aria-label*="Image"]',
        '[aria-label*="attachment" i]',
        '[aria-label*="Attachment"]',
      ];
      for (const sel of markers) {
        try { out.markerHits[sel] = document.querySelectorAll(sel).length; }
        catch { out.markerHits[sel] = -1; }
      }

      const rows = Array.from(document.querySelectorAll(
        '[data-message-role="human"], [data-role="human"], .composer-human-message, [data-message-kind="human"]'
      ));
      // Fallback: readonly human inputs
      const inputs = Array.from(document.querySelectorAll('.aislash-editor-input-readonly'));
      const wrappers = rows.length ? rows : inputs.map((el) => el.closest('[data-message-id], [data-flat-index], .composer-message') || el.parentElement).filter(Boolean);
      out.humanRows = wrappers.length;

      for (const wrap of wrappers.slice(0, 40)) {
        const imgs = wrap.querySelectorAll('img');
        const pictures = wrap.querySelectorAll('picture');
        const canvases = wrap.querySelectorAll('canvas');
        const classHits = Array.from(wrap.querySelectorAll('[class*="attach"], [class*="image"], [data-attachment], [data-image]'))
          .slice(0, 8)
          .map((el) => ({
            tag: el.tagName,
            className: (el.className || '').toString().slice(0, 120),
            attrs: Array.from(el.attributes || []).slice(0, 12).map((a) => a.name + '=' + String(a.value).slice(0, 60)),
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          }));
        if (imgs.length || pictures.length || canvases.length || classHits.length) {
          if (imgs.length) out.withImg++;
          if (pictures.length) out.withPicture++;
          if (canvases.length) out.withCanvas++;
          out.samples.push({
            messageId: wrap.getAttribute?.('data-message-id') || null,
            imgCount: imgs.length,
            pictureCount: pictures.length,
            canvasCount: canvases.length,
            imgSrcSample: Array.from(imgs).slice(0, 3).map((img) => ({
              src: (img.getAttribute('src') || '').slice(0, 80),
              alt: img.getAttribute('alt') || '',
              className: (img.className || '').toString().slice(0, 80),
            })),
            classHits,
            outerSlice: (wrap.outerHTML || '').slice(0, 500),
          });
        }
      }

      // Also scan transcript for any img near human-looking text
      const allImgs = Array.from(document.querySelectorAll('.aislash-editor-input-readonly img, [data-message-role="human"] img, .composer-human-message img'));
      out.directHumanImgs = allImgs.length;
      out.directHumanImgSample = allImgs.slice(0, 5).map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 100),
        alt: img.getAttribute('alt') || '',
        parentClass: (img.parentElement?.className || '').toString().slice(0, 100),
        closestAttrs: (() => {
          const host = img.closest('[data-message-id], [class*="attach"], [class*="image"]');
          if (!host) return null;
          return {
            tag: host.tagName,
            className: (host.className || '').toString().slice(0, 100),
            attrs: Array.from(host.attributes || []).slice(0, 15).map((a) => a.name + '=' + String(a.value).slice(0, 60)),
          };
        })(),
      }));

      return out;
    })()
  `);

  console.log(JSON.stringify(report, null, 2));
  await client.disconnect();
  console.log('\n[probe-image-attachments] done.');
}

main().catch((err) => {
  console.error('[probe-image-attachments] failed:', err);
  process.exit(1);
});
