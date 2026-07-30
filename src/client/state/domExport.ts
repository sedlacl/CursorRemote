import { getAuthToken } from './socketClient.js';

export type DomExportScope = 'chat' | 'document';

function safeFilename(raw: string | null, scope: DomExportScope): string {
  const fallback = `cursor-dom-${scope}.html`;
  const match = raw?.match(/filename="([^"]+)"/i);
  const candidate = match?.[1] ?? fallback;
  const safe = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.toLowerCase().endsWith('.html') ? safe : fallback;
}

export async function downloadDomExport(
  scope: DomExportScope,
  target: { windowId?: string; composerId?: string },
): Promise<string> {
  const query = new URLSearchParams({ scope });
  if (target.windowId) query.set('windowId', target.windowId);
  if (scope === 'chat' && target.composerId) query.set('composerId', target.composerId);
  const token = getAuthToken();
  const response = await fetch(`/debug/dom-export?${query.toString()}`, {
    credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let code = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) code = body.error;
    } catch {
      // Keep the status-only error.
    }
    throw new Error(`DOM export failed: ${code}`);
  }

  const blob = await response.blob();
  const filename = safeFilename(response.headers.get('Content-Disposition'), scope);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}
