import { toPng } from 'html-to-image';

const HIDE_SELECTORS = [
  '.bottom-sheet',
  '.sheet-overlay',
  '.report-note-dialog',
  '.clipboard-manual-fallback',
  '.plan-modal-overlay',
  '.git-diff-overlay',
  '.code-block-fs-overlay',
];

function shouldIncludeNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return true;
  for (const selector of HIDE_SELECTORS) {
    if (node.matches?.(selector) || node.closest?.(selector)) return false;
  }
  return true;
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Capture the visible web-client viewport as PNG base64 (no data-URL prefix).
 * Debug sheet / overlays are filtered out of the clone.
 */
export async function captureWebClientScreenshot(): Promise<string> {
  await waitForPaint();

  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  const bg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';

  const dataUrl = await toPng(document.documentElement, {
    cacheBust: true,
    width,
    height,
    backgroundColor: bg,
    filter: shouldIncludeNode,
    style: {
      // Crop to the current viewport.
      transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
      width: `${width}px`,
      height: `${height}px`,
      overflow: 'hidden',
    },
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  });

  const marker = 'base64,';
  const idx = dataUrl.indexOf(marker);
  if (idx < 0) throw new Error('screenshot_encode_failed');
  const base64 = dataUrl.slice(idx + marker.length);
  if (!base64) throw new Error('empty_screenshot');
  return base64;
}

export function waitForNextPaint(): Promise<void> {
  return waitForPaint();
}
