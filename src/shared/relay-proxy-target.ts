/** Relay port used by Vite dev proxy (`npm run dev:gui`). */
export function resolveRelayProxyPort(env: Record<string, string | undefined> = process.env): number {
  const explicit = env.CURSOR_REMOTE_RELAY_PORT?.trim();
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const serverPort = env.SERVER_PORT?.trim();
  if (serverPort) {
    const parsed = Number.parseInt(serverPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3001;
}

export function resolveRelayProxyTarget(env: Record<string, string | undefined> = process.env): string {
  const host = env.SERVER_HOST?.trim() || '127.0.0.1';
  return `http://${host}:${resolveRelayProxyPort(env)}`;
}
