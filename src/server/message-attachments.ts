import { randomUUID } from 'crypto';
import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CdpClient } from './cdp-client.js';
import type { MessageAttachment } from './types.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const ATTACHMENT_PREVIEW_WAIT_MS = 3000;
const ATTACHMENT_SETTLE_FALLBACK_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function validateAttachment(
  attachment: MessageAttachment,
  index = 0
): string | null {
  const mime = (attachment.mimeType || '').trim().toLowerCase();
  if (!mime || !ALLOWED_ATTACHMENT_MIMES.has(mime)) {
    return `Attachment ${index + 1}: unsupported type (${mime || 'missing'})`;
  }
  if (!attachment.data || typeof attachment.data !== 'string') {
    return `Attachment ${index + 1}: missing data`;
  }
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(attachment.data, 'base64');
  } catch {
    return `Attachment ${index + 1}: invalid base64`;
  }
  if (bytes <= 0) {
    return `Attachment ${index + 1}: empty file`;
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return `Attachment ${index + 1}: too large (max ${MAX_ATTACHMENT_BYTES} bytes)`;
  }
  return null;
}

export function validateAttachments(attachments: MessageAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  if (attachments.length > 5) return 'Too many attachments (max 5)';
  for (let i = 0; i < attachments.length; i++) {
    const err = validateAttachment(attachments[i], i);
    if (err) return err;
  }
  return null;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}

async function getComposerAttachmentPreviewCount(
  client: CdpClient,
  selectors: string[]
): Promise<number> {
  const result = await client.evaluate(`
    (() => {
      const inputSelectors = ${JSON.stringify(selectors)};
      const roots = [];
      for (const sel of inputSelectors) {
        try {
          const input = document.querySelector(sel);
          const root = input?.closest('.composer-bar, [class*="composer"], #workbench\\\\.parts\\\\.auxiliarybar');
          if (root && !roots.includes(root)) roots.push(root);
        } catch {}
      }
      const fallback = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar, .composer-bar, [class*="composer"]');
      if (fallback && !roots.includes(fallback)) roots.push(fallback);
      const previewSelectors = [
        '.context-pill-image',
        'img.image-pill-img',
        '.image-pill-container img',
        'img[src^="blob:"]',
        'img[src^="data:"]',
        '[class*="attachment"]',
        '[class*="Attachment"]',
        '[class*="image-preview"]',
        '[class*="ImagePreview"]',
        '[class*="file-preview"]',
        '[class*="FilePreview"]',
        '[class*="composer-file"]',
        '[class*="ComposerFile"]'
      ];
      const seen = new Set();
      for (const root of roots) {
        for (const sel of previewSelectors) {
          try {
            root.querySelectorAll(sel).forEach((el) => seen.add(el));
          } catch {}
        }
      }
      return seen.size;
    })()
  `) as number;
  return Number.isFinite(result) ? result : 0;
}

async function waitForComposerAttachmentPreview(
  client: CdpClient,
  selectors: string[],
  previousCount: number
): Promise<{ ready: boolean; count: number }> {
  const result = await client.evaluate(`
    new Promise((resolve) => {
      const inputSelectors = ${JSON.stringify(selectors)};
      const previousCount = ${JSON.stringify(previousCount)};
      const startedAt = Date.now();
      const timeoutMs = ${ATTACHMENT_PREVIEW_WAIT_MS};
      function countPreviews() {
        const roots = [];
        for (const sel of inputSelectors) {
          try {
            const input = document.querySelector(sel);
            const root = input?.closest('.composer-bar, [class*="composer"], #workbench\\\\.parts\\\\.auxiliarybar');
            if (root && !roots.includes(root)) roots.push(root);
          } catch {}
        }
        const fallback = document.querySelector('#workbench\\\\.parts\\\\.auxiliarybar, .composer-bar, [class*="composer"]');
        if (fallback && !roots.includes(fallback)) roots.push(fallback);
        const previewSelectors = [
          'img[src^="blob:"]',
          'img[src^="data:"]',
          '[class*="attachment"]',
          '[class*="Attachment"]',
          '[class*="image-preview"]',
          '[class*="ImagePreview"]',
          '[class*="file-preview"]',
          '[class*="FilePreview"]',
          '[class*="composer-file"]',
          '[class*="ComposerFile"]'
        ];
        const seen = new Set();
        for (const root of roots) {
          for (const sel of previewSelectors) {
            try {
              root.querySelectorAll(sel).forEach((el) => seen.add(el));
            } catch {}
          }
        }
        return seen.size;
      }
      function tick() {
        const count = countPreviews();
        if (count > previousCount) return resolve({ ready: true, count });
        if (Date.now() - startedAt >= timeoutMs) return resolve({ ready: false, count });
        setTimeout(tick, 100);
      }
      tick();
    })
  `, ATTACHMENT_PREVIEW_WAIT_MS + 1000) as { ready?: boolean; count?: number } | null;
  return { ready: !!result?.ready, count: Number(result?.count ?? 0) };
}

export async function attachFilesToComposer(
  client: CdpClient,
  selectors: string[],
  attachments: MessageAttachment[]
): Promise<void> {
  await client.send('DOM.enable');

  for (const attachment of attachments) {
    const mime = attachment.mimeType.trim().toLowerCase();
    const buf = Buffer.from(attachment.data, 'base64');
    const ext = mimeToExt(mime);
    const tmpPath = join(tmpdir(), `cursor-remote-${randomUUID()}.${ext}`);
    writeFileSync(tmpPath, buf);

    try {
      const doc = await client.send('DOM.getDocument') as { root: { nodeId: number } };
      let nodeId: number | undefined;
      for (const sel of selectors) {
        const q = await client.send('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: sel,
        }) as { nodeId?: number };
        if (q.nodeId) {
          nodeId = q.nodeId;
          break;
        }
      }
      if (!nodeId) {
        throw new Error('Composer file input not found');
      }

      const previewCountBefore = await getComposerAttachmentPreviewCount(client, selectors);

      await client.send('DOM.setFileInputFiles', { nodeId, files: [tmpPath] });

      const changed = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(selectors)};
          let fi = null;
          for (const sel of strategies) {
            try {
              fi = document.querySelector(sel);
              if (fi) break;
            } catch {}
          }
          if (!fi) return { ok: false, error: 'file input missing after setFileInputFiles' };
          fi.dispatchEvent(new Event('change', { bubbles: true }));
          fi.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        })()
      `) as { ok: boolean; error?: string } | null;

      if (!changed?.ok) {
        throw new Error(changed?.error ?? 'Failed to dispatch file input change');
      }

      const preview = await waitForComposerAttachmentPreview(client, selectors, previewCountBefore);
      if (preview.ready) {
        console.log(`[message-attachments] Composer attachment preview detected (${preview.count})`);
      } else {
        console.warn('[message-attachments] Composer attachment preview not detected before timeout; waiting fallback settle delay');
        await sleep(ATTACHMENT_SETTLE_FALLBACK_MS);
      }
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
