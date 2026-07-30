import { CdpClient } from './cdp-client.js';
import { DomExportError, DomExportService, type DomExportScope } from './dom-export.js';
import { sanitizeStateForClient } from './subagent-actions.js';
import type { CursorState, CursorWindow } from './types.js';
import type { ServerDiagnostics } from '../shared/diagnostics.js';

export type DiagnosticSnapshotPart =
  | 'meta'
  | 'state'
  | 'cursor-dom'
  | 'screenshot'
  | 'web-dom'
  | 'all';

export interface WebDomSnapshot {
  html: string;
  bytes: number;
  url: string;
  viewport: { width: number; height: number };
  collectedAt: string;
}

export interface WebDomUnavailable {
  reason: 'no_client' | 'timeout' | 'too_large' | 'error';
  message: string;
  bytes?: number;
}

export interface DiagnosticScreenshot {
  format: 'png';
  dataBase64: string;
  bytes: number;
  capturedAt: string;
}

export interface DiagnosticStateSnapshot {
  exportedAt: string;
  activeWindowId: string;
  activeComposerId: string;
  activeConversationContext: CursorState['activeConversationContext'];
  agentStatus: CursorState['agentStatus'];
  agentActivityText: CursorState['agentActivityText'];
  agentActivityLive: CursorState['agentActivityLive'];
  connected: boolean;
  messageCount: number;
  chatTabs: Array<{ isActive: boolean; title: string; composerId: string }>;
  windows: Array<{ id: string; title: string }>;
  pendingApprovalCount: number;
  mode: CursorState['mode'];
  model: CursorState['model'];
  gitStatus: CursorState['gitStatus'];
  diagnostics: Pick<
    ServerDiagnostics,
    'server' | 'connected' | 'generation' | 'uptime' | 'clients' | 'activeWindowTitle' | 'cdpUrl'
  >;
}

export interface DiagnosticSnapshotMeta {
  diagnosticId: string;
  exportedAt: string;
  parts: DiagnosticSnapshotPart[];
  warnings: string[];
  endpoints: Record<string, string>;
}

export class DiagnosticSnapshotError extends Error {
  constructor(
    public readonly status: 404 | 413 | 422 | 503 | 504,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosticSnapshotError';
  }
}

interface SnapshotClient {
  connect(wsUrl: string): Promise<void>;
  disconnect(): void;
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

interface DiagnosticSnapshotSources {
  getWindows(): CursorWindow[];
  getActiveState(): { activeWindowId: string; activeComposerId: string };
  getSanitizedState(): CursorState;
  getDiagnostics(): ServerDiagnostics;
  collectWebDom(timeoutMs: number): Promise<WebDomSnapshot | WebDomUnavailable>;
}

export interface DiagnosticSnapshotServiceOptions {
  screenshotMaxBytes?: number;
  webDomMaxBytes?: number;
  timeoutMs?: number;
  clientFactory?: () => SnapshotClient;
}

export const DEFAULT_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WEB_DOM_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DiagnosticSnapshotError(504, code, 'Diagnostic snapshot timed out'));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseScope(raw: unknown): DomExportScope {
  if (raw === 'document') return 'document';
  return 'chat';
}

function parsePart(raw: unknown): DiagnosticSnapshotPart {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (value) {
    case 'state':
    case 'cursor-dom':
    case 'screenshot':
    case 'web-dom':
    case 'all':
      return value;
    default:
      return 'meta';
  }
}

export class DiagnosticSnapshotService {
  private readonly screenshotMaxBytes: number;
  private readonly webDomMaxBytes: number;
  private readonly timeoutMs: number;
  private readonly clientFactory: () => SnapshotClient;
  private running = false;

  constructor(
    private readonly domExportService: DomExportService,
    private readonly sources: DiagnosticSnapshotSources,
    options: DiagnosticSnapshotServiceOptions = {},
  ) {
    this.screenshotMaxBytes = options.screenshotMaxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;
    this.webDomMaxBytes = options.webDomMaxBytes ?? DEFAULT_WEB_DOM_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    this.clientFactory = options.clientFactory ?? (() => new CdpClient());
  }

  parsePart(raw: unknown): DiagnosticSnapshotPart {
    return parsePart(raw);
  }

  buildMeta(diagnosticId: string, basePath: string): DiagnosticSnapshotMeta {
    const query = `id=${encodeURIComponent(diagnosticId)}`;
    return {
      diagnosticId,
      exportedAt: new Date().toISOString(),
      parts: ['meta', 'state', 'cursor-dom', 'screenshot', 'web-dom', 'all'],
      warnings: [
        'Raw diagnostic data may contain chats, code, terminal output, local paths, and secrets.',
        'Web client visual capture is not available via this API; use a browser tool on the web UI URL if you need a screenshot.',
      ],
      endpoints: {
        meta: `${basePath}?${query}&part=meta`,
        state: `${basePath}?${query}&part=state`,
        cursorDomChat: `${basePath}?${query}&part=cursor-dom&scope=chat`,
        cursorDomDocument: `${basePath}?${query}&part=cursor-dom&scope=document`,
        screenshot: `${basePath}?${query}&part=screenshot`,
        webDom: `${basePath}?${query}&part=web-dom`,
        all: `${basePath}?${query}&part=all`,
      },
    };
  }

  buildStateSnapshot(): DiagnosticStateSnapshot {
    const state = this.sources.getSanitizedState();
    const diagnostics = this.sources.getDiagnostics();
    return {
      exportedAt: new Date().toISOString(),
      activeWindowId: state.activeWindowId,
      activeComposerId: state.activeComposerId,
      activeConversationContext: state.activeConversationContext,
      agentStatus: state.agentStatus,
      agentActivityText: state.agentActivityText,
      agentActivityLive: state.agentActivityLive,
      connected: state.connected,
      messageCount: state.messages.length,
      chatTabs: state.chatTabs.map(tab => ({
        isActive: tab.isActive,
        title: tab.title,
        composerId: tab.composerId,
      })),
      windows: state.windows.map(window => ({
        id: window.id,
        title: window.title,
      })),
      pendingApprovalCount: state.pendingApprovals.length,
      mode: state.mode,
      model: state.model,
      gitStatus: state.gitStatus,
      diagnostics: {
        server: diagnostics.server,
        connected: diagnostics.connected,
        generation: diagnostics.generation,
        uptime: diagnostics.uptime,
        clients: diagnostics.clients,
        activeWindowTitle: diagnostics.activeWindowTitle,
        cdpUrl: diagnostics.cdpUrl,
      },
    };
  }

  async captureScreenshot(): Promise<DiagnosticScreenshot> {
    const { activeWindowId } = this.sources.getActiveState();
    if (!activeWindowId) {
      throw new DiagnosticSnapshotError(422, 'window_required', 'No active window');
    }
    const window = this.sources.getWindows().find(item => item.id === activeWindowId);
    if (!window?.wsUrl) {
      throw new DiagnosticSnapshotError(503, 'window_unavailable', 'Target window is unavailable');
    }

    const client = this.clientFactory();
    try {
      await withTimeout(client.connect(window.wsUrl), this.timeoutMs, 'screenshot_connect_timeout');
      const raw = await withTimeout(
        client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        this.timeoutMs,
        'screenshot_timeout',
      );
      const dataBase64 = typeof raw.data === 'string' ? raw.data : '';
      if (!dataBase64) {
        throw new DiagnosticSnapshotError(503, 'invalid_cdp_response', 'Screenshot returned no data');
      }
      const bytes = Buffer.byteLength(dataBase64, 'base64');
      if (bytes > this.screenshotMaxBytes) {
        throw new DiagnosticSnapshotError(413, 'screenshot_too_large', 'Screenshot exceeds configured size limit');
      }
      return {
        format: 'png',
        dataBase64,
        bytes,
        capturedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DiagnosticSnapshotError) throw error;
      throw new DiagnosticSnapshotError(503, 'screenshot_unavailable', 'Screenshot capture is unavailable');
    } finally {
      client.disconnect();
    }
  }

  async captureCursorDom(scope: DomExportScope) {
    return this.domExportService.export({ scope });
  }

  async captureWebDom(): Promise<WebDomSnapshot | WebDomUnavailable> {
    const result = await this.sources.collectWebDom(Math.min(this.timeoutMs, 5000));
    if ('html' in result) {
      if (result.bytes > this.webDomMaxBytes) {
        return {
          reason: 'too_large',
          message: 'Web client DOM exceeds configured size limit',
          bytes: result.bytes,
        };
      }
      return result;
    }
    return result;
  }

  async capture(part: DiagnosticSnapshotPart, options: { scope?: unknown } = {}): Promise<unknown> {
    if (this.running) {
      throw new DiagnosticSnapshotError(503, 'snapshot_busy', 'Another diagnostic snapshot is already running');
    }
    this.running = true;
    try {
      const scope = parseScope(options.scope);
      switch (part) {
        case 'state':
          return this.buildStateSnapshot();
        case 'cursor-dom':
          return await this.captureCursorDom(scope);
        case 'screenshot':
          return await this.captureScreenshot();
        case 'web-dom':
          return await this.captureWebDom();
        case 'all': {
          const [state, cursorDom, screenshot, webDom] = await Promise.all([
            Promise.resolve(this.buildStateSnapshot()),
            this.captureCursorDom('chat').catch(error => ({
              error: error instanceof DomExportError ? error.code : 'cursor_dom_unavailable',
            })),
            this.captureScreenshot().catch(error => ({
              error: error instanceof DiagnosticSnapshotError ? error.code : 'screenshot_unavailable',
            })),
            this.captureWebDom(),
          ]);
          return {
            exportedAt: new Date().toISOString(),
            state,
            cursorDom,
            screenshot,
            webDom,
            warnings: [
              'Web client visual capture is not available via this API; use a browser tool on the web UI URL if you need a screenshot.',
            ],
          };
        }
        default:
          throw new DiagnosticSnapshotError(422, 'invalid_part', 'Unknown snapshot part');
      }
    } finally {
      this.running = false;
    }
  }
}

export function sanitizeStateForDiagnosticSnapshot(state: CursorState): CursorState {
  return sanitizeStateForClient(state);
}
