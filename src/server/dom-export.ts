import { CdpClient } from './cdp-client.js';
import type { CursorWindow, SelectorConfig } from './types.js';

export type DomExportScope = 'chat' | 'document';

export interface DomExportRequest {
  scope: DomExportScope;
  windowId?: string;
  composerId?: string;
}

export interface DomExportResult {
  scope: DomExportScope;
  windowId: string;
  composerId?: string;
  bytes: number;
  exportedAt: string;
  html: string;
}

export class DomExportError extends Error {
  constructor(
    public readonly status: 413 | 422 | 503 | 504,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomExportError';
  }
}

interface DomExportClient {
  connect(wsUrl: string): Promise<void>;
  disconnect(): void;
  callFunctionWithTimeout(
    fn: (...args: never[]) => unknown,
    args: unknown[],
    timeoutMs: number,
  ): Promise<unknown>;
}

interface DomExportSources {
  getWindows(): CursorWindow[];
  getActiveState(): { activeWindowId: string; activeComposerId: string };
}

export interface DomExportServiceOptions {
  maxBytes?: number;
  timeoutMs?: number;
  clientFactory?: () => DomExportClient;
}

export const DEFAULT_DOM_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOM_EXPORT_TIMEOUT_MS = 10_000;
const SAFE_ID_RE = /^[a-zA-Z0-9_.:-]+$/;

export function readDomExportMaxBytes(raw = process.env.DOM_EXPORT_MAX_BYTES): number {
  if (!raw) return DEFAULT_DOM_EXPORT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DOM_EXPORT_MAX_BYTES;
}

function validateId(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200 || !SAFE_ID_RE.test(normalized)) {
    throw new DomExportError(422, `invalid_${label}`, `Invalid ${label}`);
  }
  return normalized;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DomExportError(504, 'timeout', 'DOM export timed out'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function extractDomInPage(
  scope: DomExportScope,
  composerId: string,
  chatSelectors: string[],
  maxBytes: number,
): { ok: true; html: string; bytes: number; composerId?: string } |
   { ok: false; code: 'composer_not_found' | 'chat_not_found' | 'too_large'; bytes?: number } {
  let root: Element | null = null;
  let resolvedComposerId = composerId;

  if (scope === 'document') {
    root = document.documentElement;
  } else if (composerId) {
    root = Array.from(document.querySelectorAll('[data-composer-id]'))
      .find(element => element.getAttribute('data-composer-id') === composerId) ?? null;
    if (!root) return { ok: false, code: 'composer_not_found' };
  } else {
    for (const selector of chatSelectors) {
      try {
        const chat = document.querySelector(selector);
        if (!chat) continue;
        root = chat.closest('[data-composer-id]') ?? chat;
        resolvedComposerId = root.getAttribute('data-composer-id') ?? '';
        break;
      } catch {
        // Ignore stale selector strategies.
      }
    }
    if (!root) return { ok: false, code: 'chat_not_found' };
  }

  const html = (root as Element).outerHTML;
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > maxBytes) return { ok: false, code: 'too_large', bytes };
  return {
    ok: true,
    html,
    bytes,
    ...(resolvedComposerId ? { composerId: resolvedComposerId } : {}),
  };
}

export class DomExportService {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly clientFactory: () => DomExportClient;
  private exporting = false;

  constructor(
    private readonly sources: DomExportSources,
    private readonly selectors: SelectorConfig,
    options: DomExportServiceOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? readDomExportMaxBytes();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DOM_EXPORT_TIMEOUT_MS;
    this.clientFactory = options.clientFactory ?? (() => new CdpClient());
  }

  async export(request: DomExportRequest): Promise<DomExportResult> {
    if (this.exporting) {
      throw new DomExportError(503, 'export_busy', 'Another DOM export is already running');
    }
    this.exporting = true;
    const client = this.clientFactory();

    try {
      const state = this.sources.getActiveState();
      const windowId = validateId(request.windowId, 'window_id') ?? state.activeWindowId;
      const composerId = validateId(request.composerId, 'composer_id') ??
        (request.scope === 'chat' ? state.activeComposerId : undefined);
      if (!windowId) throw new DomExportError(422, 'window_required', 'No active window');
      if (request.scope === 'chat' && !composerId) {
        throw new DomExportError(422, 'composer_required', 'No active composer');
      }

      const window = this.sources.getWindows().find(item => item.id === windowId);
      if (!window?.wsUrl) {
        throw new DomExportError(503, 'window_unavailable', 'Target window is unavailable');
      }

      await withTimeout(client.connect(window.wsUrl), this.timeoutMs);
      const raw = await withTimeout(
        client.callFunctionWithTimeout(
          extractDomInPage as (...args: never[]) => unknown,
          [
            request.scope,
            composerId ?? '',
            this.selectors.chatContainer?.strategies ?? [],
            this.maxBytes,
          ],
          this.timeoutMs,
        ),
        this.timeoutMs,
      ) as {
        ok?: boolean;
        html?: string;
        bytes?: number;
        composerId?: string;
        code?: string;
      };

      if (!raw?.ok) {
        if (raw?.code === 'too_large') {
          throw new DomExportError(413, 'too_large', 'DOM export exceeds configured size limit');
        }
        throw new DomExportError(422, raw?.code ?? 'invalid_target', 'DOM export target was not found');
      }
      if (typeof raw.html !== 'string') {
        throw new DomExportError(503, 'invalid_cdp_response', 'DOM export returned invalid data');
      }
      const bytes = Buffer.byteLength(raw.html, 'utf8');
      if (bytes > this.maxBytes) {
        throw new DomExportError(413, 'too_large', 'DOM export exceeds configured size limit');
      }

      return {
        scope: request.scope,
        windowId,
        ...(raw.composerId || composerId ? { composerId: raw.composerId || composerId } : {}),
        bytes,
        exportedAt: new Date().toISOString(),
        html: raw.html,
      };
    } catch (error) {
      if (error instanceof DomExportError) throw error;
      throw new DomExportError(503, 'cdp_unavailable', 'DOM export is unavailable');
    } finally {
      client.disconnect();
      this.exporting = false;
    }
  }
}
