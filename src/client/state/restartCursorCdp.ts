import { getAuthToken } from './socketClient.js';

export async function requestRestartCursorWithCdp(): Promise<void> {
  const token = getAuthToken();
  const res = await fetch('/api/cursor/restart-with-cdp', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ confirm: true }),
  });
  const text = await res.text();
  let data: { error?: string } = {};
  try {
    data = text ? JSON.parse(text) as { error?: string } : {};
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    throw new Error(data.error || `Restart failed (${res.status})`);
  }
}
