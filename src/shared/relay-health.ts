/** Distinguishes a CursorRemote relay from any other service answering `/health` on the same port. */
export function isCursorRemoteHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return rec.ok === true
    && typeof rec.connected === 'boolean'
    && typeof rec.cdpUrl === 'string';
}
