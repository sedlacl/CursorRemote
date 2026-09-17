export type CdpDisconnectReason =
  | 'unavailable'
  | 'wrong_port'
  | 'no_target'
  | 'connect_error';

export interface CdpFailure {
  reason: CdpDisconnectReason;
  message: string;
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const rec = err as { code?: unknown; cause?: { code?: unknown } };
  const direct = typeof rec.code === 'string' ? rec.code : '';
  const cause = typeof rec.cause?.code === 'string' ? rec.cause.code : '';
  return (direct || cause).toUpperCase();
}

export function classifyCdpFailure(err: unknown): CdpFailure {
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  const name = err instanceof Error ? err.name : '';
  const combined = `${name} ${code} ${message}`.toLowerCase();

  if (
    code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH'
  ) {
    return { reason: 'unavailable', message };
  }
  if (name === 'AbortError' || /aborted|timed out|timeout/i.test(combined)) {
    return { reason: 'connect_error', message };
  }
  if (/no suitable cdp target/i.test(message)) {
    return { reason: 'no_target', message };
  }
  if (/cdp target discovery failed: http/i.test(message) || /unexpected token|not valid json|invalid json/i.test(combined)) {
    return { reason: 'wrong_port', message };
  }
  if (/fetch failed/i.test(message) || code === 'ECONNRESET') {
    return { reason: 'unavailable', message };
  }
  return { reason: 'connect_error', message };
}

export function parseRemoteDebuggingPort(cdpUrl: string): number | null {
  try {
    const url = new URL(cdpUrl);
    const raw = url.port || (url.protocol === 'https:' ? '443' : '80');
    const port = Number.parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

/** Best-effort JSONC update of Cursor/VS Code `argv.json`. */
export function upsertArgvRemoteDebuggingPort(raw: string, port: number): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return `{\n  "remote-debugging-port": ${port}\n}\n`;
  }

  const withoutLineComments = trimmed.replace(/^\s*\/\/.*$/gm, '');
  try {
    const parsed = JSON.parse(withoutLineComments) as Record<string, unknown>;
    parsed['remote-debugging-port'] = port;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    if (/"remote-debugging-port"\s*:/.test(trimmed)) {
      return `${trimmed.replace(/"remote-debugging-port"\s*:\s*[^,\n}]+/, `"remote-debugging-port": ${port}`)}\n`;
    }
    return trimmed.replace(/\{/, `{\n  "remote-debugging-port": ${port},`);
  }
}

export function describeCdpFailure(reason: CdpDisconnectReason | null | undefined, cdpUrl: string, lastError: string | null | undefined): string {
  const url = cdpUrl.trim() || 'http://127.0.0.1:9222';
  const detail = (lastError || '').trim();
  switch (reason) {
    case 'unavailable':
      return `Nothing is listening at <code>${escapeHtml(url)}</code>. Cursor is probably not running with remote debugging.`;
    case 'wrong_port':
      return `The endpoint at <code>${escapeHtml(url)}</code> answered, but it is not a CDP target list. Check <code>cursorRemote.cdpUrl</code>.`;
    case 'no_target':
      return `CDP is up at <code>${escapeHtml(url)}</code>, but no Cursor workbench page was found.`;
    case 'connect_error':
      return detail
        ? `Could not connect to <code>${escapeHtml(url)}</code>: <code>${escapeHtml(detail)}</code>`
        : `Could not connect to <code>${escapeHtml(url)}</code>.`;
    default:
      return `Waiting for Cursor CDP at <code>${escapeHtml(url)}</code>.`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
