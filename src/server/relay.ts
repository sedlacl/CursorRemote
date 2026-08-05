import express from 'express';
import { createServer } from 'http';
import { createRequire } from 'module';
import { Server as SocketServer, type Socket } from 'socket.io';
import { basename, join, resolve } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult } from './types.js';
import { waitForFreshExtraction, waitForHistoryScopeChange } from './extraction-wait.js';
import { validateAttachments } from './message-attachments.js';
import { loadSkillCatalog } from './skills-catalog.js';
import type { StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CDPBridge } from './cdp-bridge.js';
import type { WindowMonitor } from './window-monitor.js';
import { resolveApprovalActionSelector } from './approval-registry.js';
import { CursorStorageHistory } from './cursor-storage-history.js';
import type { ComposerStorageRelation } from './cursor-storage-history.js';
import { markdownToWebHtml, readPlanFile } from './plan-files.js';
import type { ExtensionFileBridge } from './extension-file-bridge.js';
import { SERVER_INSTANCE, getServerModuleDir } from './server-info.js';
import type { ServerDiagnostics } from '../shared/diagnostics.js';
import { GIT_SNAPSHOT_PUSH_PATH, type GitSnapshotPushPayload } from '../shared/extension-bridge.js';
import { GIT_SNAPSHOT_STALE_ERROR } from '../shared/git-scm.js';
import { GitScmService, parseBucketQuery, parseBucketsQuery } from './git/git-scm-service.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';
import { DomExportError, type DomExportService } from './dom-export.js';
import {
  DiagnosticSnapshotError,
  DiagnosticSnapshotService,
  type WebDomSnapshot,
  type WebDomUnavailable,
} from './diagnostic-snapshot.js';
import { diagnosticIdsMatch } from '../shared/diagnostic-id.js';
import {
  resolveSubagentAction,
  sanitizePatchForClient,
  sanitizeStateForClient,
  validateOpenSubagent,
  validateStopSubagent,
} from './subagent-actions.js';
import { activeTabTitle } from './conversation-context.js';
import { indexStorageRelationsForComposer } from './storage-relation-index.js';
import {
  parentNotOpenError,
  resolveChildComposerAfterOpen,
  resolveReturnToParentTab,
  resolveReturnToParentTarget,
} from './return-to-parent.js';

const POST_COMMAND_REFRESH_DELAYS_MS = [0, 150, 450, 1000, 2000];

interface ViteDevServer {
  middlewares: express.RequestHandler;
  close(): Promise<void>;
}

function resolvePackageRoot(): string {
  const fromEnv = process.env.PACKAGE_ROOT?.trim();
  if (fromEnv && existsSync(join(fromEnv, 'package.json'))) return fromEnv;
  const fromBundle = join(getServerModuleDir(), '..', '..');
  if (existsSync(join(fromBundle, 'package.json'))) return fromBundle;
  return process.cwd();
}

function resolveClientDir(serverDir: string): { clientDir: string; clientBuild: 'vite-dev' | 'static' } {
  const clientSrc = process.env.CLIENT_SRC_DIR?.trim();
  if (clientSrc && existsSync(clientSrc)) {
    return { clientDir: resolve(clientSrc), clientBuild: 'vite-dev' };
  }
  const bundledClientDir = join(serverDir, '..', 'client');
  const isSourceClient = bundledClientDir.replace(/\\/g, '/').endsWith('/src/client');
  return {
    clientDir: bundledClientDir,
    clientBuild: isSourceClient ? 'vite-dev' : 'static',
  };
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1a1a2e">
  <title>CursorRemote - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #181818;
      color: rgba(228,228,228,0.92);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh;
    }
    .login-card {
      width: 100%; max-width: 340px; padding: 32px 24px;
      background: #232323; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; text-align: center; }
    .subtitle { font-size: 13px; color: rgba(228,228,228,0.5); margin-bottom: 24px; text-align: center; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: rgba(228,228,228,0.7); }
    input[type="password"] {
      width: 100%; padding: 10px 12px; font-size: 15px;
      background: #181818; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      color: rgba(228,228,228,0.92); outline: none;
    }
    input[type="password"]:focus { border-color: #3794ff; }
    button {
      width: 100%; padding: 10px; margin-top: 16px; font-size: 15px; font-weight: 500;
      background: #3794ff; color: #fff; border: none; border-radius: 8px; cursor: pointer;
    }
    button:hover { background: #2b7ee0; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #e34671; font-size: 13px; margin-top: 12px; text-align: center; display: none; }
  </style>
</head>
<body>
  <form class="login-card" id="form">
    <h1>CursorRemote</h1>
    <p class="subtitle">Enter password to continue</p>
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
    <button type="submit" id="btn">Sign in</button>
    <p class="error" id="err"></p>
  </form>
  <script>
    const form = document.getElementById('form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-remote-token', data.token);
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Invalid password';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;
  private windowMonitor: WindowMonitor;
  private extensionBridge: ExtensionFileBridge;
  private gitScmService: GitScmService;
  private storageHistory: CursorStorageHistory;
  private viteDevServer?: Promise<ViteDevServer>;
  private requestFreshExtraction: () => void;
  private readonly clientBuild: 'vite-dev' | 'static';
  private readonly clientDir: string;
  private readonly domExportService: DomExportService;
  private readonly diagnosticSnapshotService: DiagnosticSnapshotService;

  private sessionStore: WebappSessionStore;
  private loginAttempts = new Map<string, RateLimitEntry>();
  private storageIndexInFlight = false;
  private pendingWebDomCollects = new Map<string, (result: WebDomSnapshot | WebDomUnavailable) => void>();

  /** Max-Age for session cookie (30 days), aligned with typical “stay signed in” expectation. */
  private static readonly SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge,
    extensionBridge: ExtensionFileBridge,
    domExportService: DomExportService,
    windowMonitor: WindowMonitor,
    requestFreshExtraction: () => void = () => {},
    diagnosticSnapshotService?: DiagnosticSnapshotService,
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.windowMonitor = windowMonitor;
    this.extensionBridge = extensionBridge;
    this.gitScmService = new GitScmService(stateManager, extensionBridge);
    this.requestFreshExtraction = requestFreshExtraction;
    this.domExportService = domExportService;
    this.diagnosticSnapshotService = diagnosticSnapshotService ?? new DiagnosticSnapshotService(
      domExportService,
      {
        getWindows: () => this.cdpBridge.windows,
        getActiveState: () => {
          const state = this.stateManager.getCurrentState();
          return {
            activeWindowId: state.activeWindowId,
            activeComposerId: state.activeComposerId,
          };
        },
        getSanitizedState: () => sanitizeStateForClient(this.stateManager.getCurrentState()),
        getDiagnostics: () => this.buildDiagnostics(),
        collectWebDom: (timeoutMs) => this.collectWebDomFromClients(timeoutMs),
      },
    );
    this.storageHistory = new CursorStorageHistory(config.cursorStateDbPath);
    this.sessionStore = createWebappSessionStore(config.dataDir);
    const resolvedClient = resolveClientDir(getServerModuleDir());
    this.clientDir = resolvedClient.clientDir;
    this.clientBuild = resolvedClient.clientBuild;
    if (this.clientBuild === 'vite-dev') {
      console.log(`[relay] Serving web client from source via Vite: ${this.clientDir}`);
    }

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.authEnabled) {
      console.log('[relay] Web app password protection enabled');
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        console.log(
          `[relay] Server listening on http://${this.config.serverHost}:${this.config.serverPort}`
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.io.close();
    if (this.viteDevServer) {
      await (await this.viteDevServer).close();
    }
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private isLocalRequest(req: express.Request): boolean {
    const ip = req.socket.remoteAddress ?? '';
    return ip === '127.0.0.1'
      || ip === '::1'
      || ip === '::ffff:127.0.0.1'
      || ip.endsWith('127.0.0.1');
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }

    if (entry.count >= 10) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true, retryAfter: 0 };
  }

  /** Session cookie/Bearer, or DIAGNOSTIC_TOKEN Bearer when WEBAPP_PASSWORD is set. */
  private resolveDebugAuth(req: express.Request): boolean {
    if (!this.authEnabled) return true;
    if (this.resolveHttpSession(req) !== undefined) return true;
    const configured = this.config.diagnosticToken.trim();
    if (!configured) return false;
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const provided = authHeader.slice(7).trim();
    if (provided.length !== configured.length) return false;
    try {
      return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
    } catch {
      return false;
    }
  }

  private collectWebDomFromClients(timeoutMs: number): Promise<WebDomSnapshot | WebDomUnavailable> {
    const sockets = [...this.io.sockets.sockets.values()];
    if (sockets.length === 0) {
      return Promise.resolve({
        reason: 'no_client',
        message: 'No connected web client to collect DOM from',
      });
    }

    const requestId = randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWebDomCollects.delete(requestId);
        resolve({
          reason: 'timeout',
          message: 'Timed out waiting for web client DOM',
        });
      }, timeoutMs);

      this.pendingWebDomCollects.set(requestId, (result) => {
        clearTimeout(timer);
        this.pendingWebDomCollects.delete(requestId);
        resolve(result);
      });

      for (const socket of sockets) {
        socket.emit('diagnostic:collect', { requestId, parts: ['web-dom'] });
      }
    });
  }

  /** First matching credential that exists in the persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.has(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private buildDiagnostics(): ServerDiagnostics {
    const state = this.stateManager.getCurrentState();
    const activeWindow = state.windows.find(window => window.id === state.activeWindowId);
    return {
      server: {
        version: SERVER_INSTANCE.version,
        instanceId: SERVER_INSTANCE.instanceId,
        diagnosticId: SERVER_INSTANCE.diagnosticId,
        pid: SERVER_INSTANCE.pid,
        port: this.config.serverPort,
        host: this.config.serverHost,
        dataDirName: basename(this.config.dataDir),
        startedAt: SERVER_INSTANCE.startedAt,
        clientBuild: this.clientBuild,
      },
      extensionBridge: this.extensionBridge.getDiagnostics(),
      gitSnapshots: this.stateManager.getGitSnapshotDiagnostics(activeWindow?.title ?? null),
      gitStatus: state.gitStatus,
      connected: state.connected,
      generation: this.stateManager.generation,
      uptime: process.uptime(),
      clients: this.io.engine.clientsCount,
      activeWindowId: state.activeWindowId,
      activeWindowTitle: activeWindow?.title ?? null,
      cdpUrl: this.config.cdpUrl,
    };
  }

  private setupRoutes(): void {
    const clientDir = this.clientDir;
    const isSourceClient = this.clientBuild === 'vite-dev';

    this.app.use(express.json());

    this.app.post(GIT_SNAPSHOT_PUSH_PATH, (req, res) => {
      if (!this.isLocalRequest(req)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      const payload = req.body as GitSnapshotPushPayload;
      if (
        !payload
        || typeof payload.windowKey !== 'string'
        || !payload.windowKey.trim()
        || !payload.gitStatus
        || typeof payload.gitStatus.changedCount !== 'number'
      ) {
        res.status(400).json({ error: 'invalid payload' });
        return;
      }

      const gitStatus = this.stateManager.upsertGitWindowSnapshot({
        ...payload,
        windowKey: payload.windowKey.trim(),
        updatedAt: payload.updatedAt || Date.now(),
        gitStatus: {
          ...payload.gitStatus,
          available: payload.gitStatus.available !== false,
          source: 'vscode.git',
          updatedAt: payload.updatedAt || Date.now(),
          windowKey: payload.windowKey.trim(),
        },
        gitScm: payload.gitScm ?? null,
      });
      if (payload.gitScm) {
        this.gitScmService.invalidateDiffCache();
      }
      res.json({ ok: true, gitStatus });
    });

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
      if (!allowed) {
        console.warn(`[relay] Rate limited login from ${ip}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        console.warn(`[relay] Failed login attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful login from ${ip}`);
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.get('/health', (req, res) => {
      const diagnostics = this.buildDiagnostics();
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      res.json({
        ok: true,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
        connected: diagnostics.connected,
        extractorStatus: this.stateManager.getCurrentState().extractorStatus,
        lastExtractionAt: this.stateManager.getCurrentState().lastExtractionAt,
        consecutiveExtractionFailures: this.stateManager.getCurrentState().consecutiveExtractionFailures,
        lastExtractionError: this.stateManager.getCurrentState().lastExtractionError,
        agentStatus: this.stateManager.getCurrentState().agentStatus,
        clients: diagnostics.clients,
        uptime: diagnostics.uptime,
        windows: this.stateManager.getCurrentState().windows,
        activeWindowId: diagnostics.activeWindowId,
        mode: this.stateManager.getCurrentState().mode?.current ?? null,
        model: this.stateManager.getCurrentState().model?.current ?? null,
        chatTabCount: this.stateManager.getCurrentState().chatTabs?.length ?? 0,
        pendingApprovalCount: this.stateManager.getCurrentState().pendingApprovals?.length ?? 0,
        gitStatus: diagnostics.gitStatus,
        generation: diagnostics.generation,
        server: diagnostics.server,
        extensionBridge: diagnostics.extensionBridge,
      });
    });

    this.app.get('/debug/info', (req, res) => {
      if (!this.resolveDebugAuth(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json(this.buildDiagnostics());
    });

    this.app.get('/debug/state', (req, res) => {
      if (!this.resolveDebugAuth(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        agentActivitySource: state.agentActivitySource,
        agentStopSelectorPath: state.agentStopSelectorPath,
        agentStopAvailable: state.agentStopAvailable,
        agentStopSource: state.agentStopSource,
        pendingApprovals: state.pendingApprovals,
        gitStatus: state.gitStatus,
        gitScm: state.gitScm,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
      });
    });

    this.app.get('/debug/dom-export', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!this.resolveDebugAuth(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const scope = req.query.scope;
      if (scope !== 'chat' && scope !== 'document') {
        res.status(422).json({ error: 'invalid_scope' });
        return;
      }

      try {
        const result = await this.domExportService.export({
          scope,
          windowId: typeof req.query.windowId === 'string' ? req.query.windowId : undefined,
          composerId: typeof req.query.composerId === 'string' ? req.query.composerId : undefined,
        });
        const metadata = JSON.stringify({
          scope: result.scope,
          windowId: result.windowId,
          composerId: result.composerId,
          bytes: result.bytes,
          exportedAt: result.exportedAt,
          sanitized: false,
        });
        const body = `<!-- CursorRemote raw DOM export metadata: ${metadata} -->\n${result.html}`;
        const date = result.exportedAt.slice(0, 10);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.setHeader('Content-Disposition', `attachment; filename="cursor-dom-${scope}-${date}.html"`);
        res.type('html').send(body);
      } catch (error) {
        if (error instanceof DomExportError) {
          res.status(error.status).json({ error: error.code });
          return;
        }
        res.status(503).json({ error: 'dom_export_unavailable' });
      }
    });

    this.app.get('/debug/snapshot', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!this.resolveDebugAuth(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const providedId = typeof req.query.id === 'string' ? req.query.id : '';
      if (!providedId.trim()) {
        res.status(422).json({ error: 'id_required' });
        return;
      }
      if (!diagnosticIdsMatch(SERVER_INSTANCE.diagnosticId, providedId)) {
        res.status(404).json({ error: 'diagnostic_id_mismatch' });
        return;
      }

      const part = this.diagnosticSnapshotService.parsePart(req.query.part);
      if (part === 'meta') {
        res.json(this.diagnosticSnapshotService.buildMeta(
          SERVER_INSTANCE.diagnosticId,
          '/debug/snapshot',
        ));
        return;
      }

      try {
        const payload = await this.diagnosticSnapshotService.capture(part, {
          scope: req.query.scope,
        });

        if (part === 'cursor-dom') {
          const result = payload as Awaited<ReturnType<DomExportService['export']>>;
          const metadata = JSON.stringify({
            scope: result.scope,
            windowId: result.windowId,
            composerId: result.composerId,
            bytes: result.bytes,
            exportedAt: result.exportedAt,
            sanitized: false,
            diagnosticId: SERVER_INSTANCE.diagnosticId,
          });
          const body = `<!-- CursorRemote diagnostic snapshot metadata: ${metadata} -->\n${result.html}`;
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          res.type('html').send(body);
          return;
        }

        if (part === 'web-dom' && payload && typeof payload === 'object' && 'html' in payload) {
          const webDom = payload as WebDomSnapshot;
          const metadata = JSON.stringify({
            bytes: webDom.bytes,
            url: webDom.url,
            viewport: webDom.viewport,
            collectedAt: webDom.collectedAt,
            diagnosticId: SERVER_INSTANCE.diagnosticId,
          });
          const body = `<!-- CursorRemote web client DOM snapshot metadata: ${metadata} -->\n${webDom.html}`;
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          res.type('html').send(body);
          return;
        }

        res.json(payload);
      } catch (error) {
        if (error instanceof DiagnosticSnapshotError) {
          res.status(error.status).json({ error: error.code });
          return;
        }
        if (error instanceof DomExportError) {
          res.status(error.status).json({ error: error.code });
          return;
        }
        res.status(503).json({ error: 'snapshot_unavailable' });
      }
    });

    this.app.get('/api/git/repos', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json(this.gitScmService.getRepos());
    });

    this.app.get('/api/git/files', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const repoId = typeof req.query.repoId === 'string' ? req.query.repoId : undefined;
        const bucket = parseBucketQuery(typeof req.query.bucket === 'string' ? req.query.bucket : undefined);
        const buckets = parseBucketsQuery(typeof req.query.buckets === 'string' ? req.query.buckets : undefined);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
        res.json(this.gitScmService.listFiles({ repoId, bucket, buckets, cursor, limit }));
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    this.app.get('/api/git/files/:fileId/diff', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const fileId = decodeURIComponent(req.params.fileId);
        const stage = req.query.stage === 'index' ? 'index' : 'working';
        const hunkCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
        const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId : undefined;
        const diff = await this.gitScmService.getDiff({ fileId, snapshotId, stage, hunkCursor });
        res.json(diff);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let status = 500;
        if (message.includes('Unknown fileId') || message.includes('Invalid')) status = 400;
        if (message === GIT_SNAPSHOT_STALE_ERROR) status = 409;
        res.status(status).json({ error: message });
      }
    });

    this.app.get('/api/git/files/:fileId/content', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const fileId = decodeURIComponent(req.params.fileId);
        const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId : undefined;
        const content = await this.gitScmService.getContent({ fileId, snapshotId });
        res.json(content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let status = 500;
        if (message.includes('Unknown fileId') || message.includes('Invalid')) status = 400;
        if (message === GIT_SNAPSHOT_STALE_ERROR) status = 409;
        res.status(status).json({ error: message });
      }
    });

    this.app.post('/api/git/stage', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds as string[] : [];
      const requestId = typeof req.body?.requestId === 'string'
        ? req.body.requestId
        : `stage-${Date.now()}`;
      if (!fileIds.length) {
        res.status(400).json({ error: 'fileIds required' });
        return;
      }
      const result = await this.gitScmService.stageFiles(fileIds, requestId);
      res.status(result.ok ? 200 : 400).json(result);
    });

    this.app.post('/api/git/unstage', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds as string[] : [];
      const requestId = typeof req.body?.requestId === 'string'
        ? req.body.requestId
        : `unstage-${Date.now()}`;
      if (!fileIds.length) {
        res.status(400).json({ error: 'fileIds required' });
        return;
      }
      const result = await this.gitScmService.unstageFiles(fileIds, requestId);
      res.status(result.ok ? 200 : 400).json(result);
    });

    this.app.post('/api/git/refresh', async (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const requestId = typeof req.body?.requestId === 'string'
        ? req.body.requestId
        : `refresh-${Date.now()}`;
      const result = await this.gitScmService.refresh(requestId);
      res.status(result.ok ? 200 : 500).json(result);
    });

    if (isSourceClient) {
      this.app.use(async (req, res, next) => {
        try {
          const vite = await this.getViteDevServer(clientDir);
          vite.middlewares(req, res, next);
        } catch (err) {
          next(err);
        }
      });
    } else {
      const cacheBust = Date.now().toString(36);
      this.app.get('/', (_req, res) => {
        const htmlPath = join(clientDir, 'index.html');
        try {
          let html = readFileSync(htmlPath, 'utf-8');
          html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
          res.setHeader('Cache-Control', 'no-store');
          res.type('html').send(html);
        } catch (err) {
          console.error(`[relay] Failed to serve index.html: ${err}`);
          res.status(500).send('Client files not found');
        }
      });

      this.app.use(express.static(clientDir, {
        etag: true,
        lastModified: true,
        setHeaders: (res) => {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        },
      }));
    }

    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);
  }

  private getViteDevServer(clientDir: string): Promise<ViteDevServer> {
    this.viteDevServer ??= (async () => {
      const packageRoot = resolvePackageRoot();
      const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
      const { createServer: createViteServer } = requireFromPackage('vite') as {
        createServer: (options: Record<string, unknown>) => Promise<ViteDevServer>;
      };
      const configFile = existsSync(join(packageRoot, 'vite.config.ts'))
        ? join(packageRoot, 'vite.config.ts')
        : undefined;
      return createViteServer({
        root: clientDir,
        configFile,
        server: {
          middlewareMode: true,
          hmr: false,
        },
        appType: 'spa',
      });
    })();
    return this.viteDevServer;
  }

  private setupSocketHandlers(): void {
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        console.warn(`[relay] Socket.io auth rejected (${socket.id}) — ${hint}`);
        next(new Error('Unauthorized'));
      });
    }

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      this.stateManager.hydrateGitStatus();
      socket.emit('state:full', sanitizeStateForClient(this.stateManager.getCurrentState()));

      socket.on('command:send_message', async (payload: CommandPayload) => {
        const text = (payload.text || '').trim();
        const attachments = payload.attachments ?? [];
        if (!payload.commandId || (!text && attachments.length === 0)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, text, or attachments',
          } satisfies CommandResult);
          return;
        }
        const attachmentError = validateAttachments(attachments);
        if (attachmentError) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: attachmentError,
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          text || undefined,
          attachments
        );
        if (result.ok) {
          this.requestFreshExtractionBurst();
        }
        socket.emit('command:result', result);
      });

      socket.on('command:load_history', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const countBefore = this.stateManager.getCurrentState().messages.length;
        const currentState = this.stateManager.getCurrentState();
        const composerId = payload.composerId || currentState.activeComposerId;
        const times = Math.min(Math.max(payload.times ?? 2, 1), 8);
        console.log(`[relay] Command: load_history (${times}x) from ${socket.id}`);

        if (composerId) {
          try {
            const stored = await this.storageHistory.loadComposerHistory(composerId);
            if (stored && stored.loadedBubbles > 0) {
              const merged = this.stateManager.mergeStoredHistory(stored.messages);
              console.log(
                `[relay] load_history storage: composer=${composerId.slice(0, 8)} ` +
                `headers=${stored.totalHeaders} loaded=${stored.loadedBubbles} added=${merged.addedCount}`
              );
              socket.emit('command:result', {
                commandId: payload.commandId,
                ok: true,
                data: {
                  addedCount: merged.addedCount,
                  totalCount: merged.totalCount,
                  source: 'cursor_storage',
                  loadedBubbles: stored.loadedBubbles,
                  totalHeaders: stored.totalHeaders,
                },
              } satisfies CommandResult);
              return;
            }
          } catch (err) {
            console.warn(
              `[relay] load_history storage fallback: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        const genBefore = this.stateManager.generation;

        const scrollResult = await this.commandExecutor.scrollChatUp(payload.commandId, times);
        if (!scrollResult.ok) {
          socket.emit('command:result', scrollResult);
          return;
        }

        await waitForFreshExtraction(this.stateManager, genBefore, 6000);
        const countAfterScroll = this.stateManager.getCurrentState().messages.length;

        // Return Cursor to the live tail with a single scrollTop jump (no wheel burst).
        const bottomGen = this.stateManager.generation;
        const bottomId = `${payload.commandId}-bottom`;
        await this.commandExecutor.scrollChatToBottom(bottomId);
        await waitForFreshExtraction(this.stateManager, bottomGen, 3000);

        const totalCount = this.stateManager.getCurrentState().messages.length;
        const addedCount = Math.max(0, countAfterScroll - countBefore);
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: { addedCount, totalCount },
        } satisfies CommandResult);
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const selectorPath = payload.selectorPath
          ?? (payload.approvalId
            ? resolveApprovalActionSelector(
              this.stateManager.getApprovalRegistry(),
              payload.approvalId,
              payload.actionType === 'approve_all' ? 'approve_all' : 'approve',
            )
            : undefined);
        if (!selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Approval action no longer available',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve from ${socket.id}`);
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          selectorPath,
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const selectorPath = payload.selectorPath
          ?? (payload.approvalId
            ? resolveApprovalActionSelector(
              this.stateManager.getApprovalRegistry(),
              payload.approvalId,
              'reject',
            )
            : undefined);
        if (!selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Approval action no longer available',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: reject from ${socket.id}`);
        const result = await this.commandExecutor.reject(
          payload.commandId,
          selectorPath,
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath && !payload.composerId)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle ?? payload.composerId ?? payload.selectorPath}" from ${socket.id}`);
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath,
          payload.composerId,
          payload.tabSource
        );
        socket.emit('command:result', result);
      });

      socket.on('command:open_transcript_link', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.composerId && !payload.linkHref)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and transcript link target',
          } satisfies CommandResult);
          return;
        }
        const target = payload.composerId ?? payload.linkHref ?? 'unknown';
        console.log(`[relay] Command: open_transcript_link to "${target}" from ${socket.id}`);
        const scopeBefore = this.stateManager.historyScopeKey();
        const genBefore = this.stateManager.generation;
        const result = await this.commandExecutor.openTranscriptLink(
          payload.commandId,
          payload.composerId,
          payload.linkHref,
          payload.linkLabel ?? payload.tabTitle,
        );
        if (result.ok) {
          this.requestFreshExtractionBurst();
          await waitForFreshExtraction(this.stateManager, genBefore, 8000);
          const scopeChanged = await waitForHistoryScopeChange(this.stateManager, scopeBefore, 5000);
          if (!scopeChanged) {
            this.requestFreshExtractionBurst();
            await waitForFreshExtraction(this.stateManager, this.stateManager.generation, 3000);
          }
        }
        socket.emit('command:result', result);
      });

      socket.on('command:close_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.composerId)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: close_tab "${payload.tabTitle ?? payload.composerId}" from ${socket.id}`);
        const result = await this.commandExecutor.closeTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.composerId,
          payload.tabSource
        );
        socket.emit('command:result', result);
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_skill_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_skill_options from ${socket.id}`);
        try {
          const options = loadSkillCatalog(resolvePackageRoot());
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: true,
            data: { options },
          } satisfies CommandResult);
        } catch (err) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to load skills',
          } satisfies CommandResult);
        }
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_full for ${payload.planLabel} from ${socket.id}`);
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_action from ${socket.id}`);
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath
        );
        if (result.ok) {
          this.requestFreshExtractionBurst();
        }
        socket.emit('command:result', result);
      });

      socket.on('command:stop_agent', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const state = this.stateManager.getCurrentState();
        const selectorPath = state.agentStopSelectorPath
          || state.backgroundTasks.find(task => task.stopSelectorPath)?.stopSelectorPath
          || '';
        if (!selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Stop button not available',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: stop_agent from ${socket.id}`);
        const result = await this.commandExecutor.clickAction(payload.commandId, selectorPath);
        if (result.ok) {
          this.requestFreshExtractionBurst();
        }
        socket.emit('command:result', result);
      });

      socket.on('command:open_subagent', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const resolved = resolveSubagentAction(this.stateManager.getCurrentState(), payload.subagentId);
        const validationError = validateOpenSubagent(resolved);
        if (validationError) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: validationError,
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: open_subagent ${payload.subagentId} from ${socket.id}`);
        const beforeState = this.stateManager.getCurrentState();
        const genBefore = this.stateManager.generation;
        const parentComposerId = beforeState.activeComposerId;
        const parentWindowId = beforeState.activeWindowId;
        const parentTitle = activeTabTitle(beforeState.chatTabs);
        const parentDepth = beforeState.activeConversationContext?.depth ?? 0;
        const parentRoot = beforeState.activeConversationContext?.rootOrchestratorComposerId
          || (parentDepth === 0 ? parentComposerId : undefined);

        const result = await this.commandExecutor.openSubagent(
          payload.commandId,
          resolved!.capabilities.openSelectorPath!,
        );
        if (result.ok) {
          await waitForFreshExtraction(this.stateManager, genBefore, 4000);
          const afterState = this.stateManager.getCurrentState();
          const childComposerId = resolveChildComposerAfterOpen(
            beforeState,
            afterState,
            resolved!.item.title,
          );
          if (
            childComposerId
            && parentComposerId
            && childComposerId !== parentComposerId
            && parentWindowId
          ) {
            this.stateManager.getConversationRegistry().recordEdge({
              childComposerId,
              childWindowId: afterState.activeWindowId || parentWindowId,
              parentComposerId,
              parentWindowId,
              parentTitle: parentTitle || undefined,
              rootOrchestratorComposerId: parentRoot || parentComposerId,
              depth: parentDepth + 1,
              source: 'open_subagent',
              updatedAt: Date.now(),
              openSubagentItemId: payload.subagentId,
            });
          }
          void this.refreshStorageRelations(afterState.activeComposerId, afterState.activeWindowId);
          this.stateManager.refreshConversationContextPatch();
          this.requestFreshExtractionBurst();
        }
        socket.emit('command:result', result);
      });

      socket.on('command:return_to_parent', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }

        const state = this.stateManager.getCurrentState();
        const childComposerId = payload.composerId?.trim() || state.activeComposerId;
        const windowId = state.activeWindowId;
        if (!childComposerId || !windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'No active conversation',
          } satisfies CommandResult);
          return;
        }

        await this.refreshStorageRelations(childComposerId, windowId);
        const registry = this.stateManager.getConversationRegistry();
        const storageCache = new Map<string, ComposerStorageRelation | null>();
        const loadStorageRelation = (composerId: string): ComposerStorageRelation | null => {
          if (storageCache.has(composerId)) return storageCache.get(composerId) ?? null;
          return null;
        };
        try {
          storageCache.set(childComposerId, await this.storageHistory.loadComposerRelation(childComposerId));
        } catch {
          storageCache.set(childComposerId, null);
        }

        const target = resolveReturnToParentTarget(
          childComposerId,
          windowId,
          registry,
          loadStorageRelation,
        );
        if (!target) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Parent conversation unavailable',
          } satisfies CommandResult);
          return;
        }

        console.log(`[relay] Command: return_to_parent ${childComposerId.slice(0, 8)} -> ${target.parentComposerId.slice(0, 8)} from ${socket.id}`);
        try {
          const genBefore = this.stateManager.generation;
          if (target.parentWindowId && target.parentWindowId !== state.activeWindowId) {
            await this.cdpBridge.switchWindow(target.parentWindowId);
            this.windowMonitor.setHomeWindow(target.parentWindowId);
            this.stateManager.updateWindows(this.cdpBridge.windows, target.parentWindowId);
            await waitForFreshExtraction(this.stateManager, genBefore, 4000);
          }

          const scopeBefore = this.stateManager.historyScopeKey();
          const tab = resolveReturnToParentTab(target, this.stateManager.getCurrentState().chatTabs);
          if (tab.matchedBy === 'none') {
            socket.emit('command:result', {
              commandId: payload.commandId,
              ok: false,
              error: parentNotOpenError(target.parentTitle),
            } satisfies CommandResult);
            return;
          }
          const tabResult = await this.commandExecutor.switchTab(
            payload.commandId,
            tab.tabTitle,
            undefined,
            target.parentComposerId,
            tab.tabSource,
          );
          if (!tabResult.ok) {
            socket.emit('command:result', tabResult);
            return;
          }

          await waitForHistoryScopeChange(this.stateManager, scopeBefore, 4000);
          this.requestFreshExtractionBurst();
          await waitForFreshExtraction(this.stateManager, this.stateManager.generation, 4000);

          const afterState = this.stateManager.getCurrentState();
          if (afterState.activeComposerId !== target.parentComposerId) {
            socket.emit('command:result', {
              commandId: payload.commandId,
              ok: false,
              error: 'Navigation did not reach parent conversation',
            } satisfies CommandResult);
            return;
          }

          this.stateManager.refreshConversationContextPatch();
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('command:stop_subagent', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        const resolved = resolveSubagentAction(this.stateManager.getCurrentState(), payload.subagentId);
        const validationError = validateStopSubagent(resolved);
        if (validationError) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: validationError,
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: stop_subagent ${payload.subagentId} from ${socket.id}`);
        const result = await this.commandExecutor.stopSubagent(payload.commandId, resolved!.capabilities);
        if (result.ok) {
          this.requestFreshExtractionBurst();
        }
        socket.emit('command:result', result);
      });

      socket.on('command:open_source_control', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: open_source_control from ${socket.id}`);
        try {
          await this.extensionBridge.requestOpenSourceControl(payload.commandId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true } satisfies CommandResult);
        } catch (err) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies CommandResult);
        }
      });

      socket.on('command:kill_server', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: kill_server from ${socket.id}`);
        socket.emit('command:result', { commandId: payload.commandId, ok: true } satisfies CommandResult);
        setTimeout(() => {
          void this.stop().finally(() => process.exit(0));
        }, 50);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        try {
          const genBefore = this.stateManager.generation;
          await this.cdpBridge.switchWindow(payload.windowId);
          this.windowMonitor.setHomeWindow(payload.windowId);
          this.stateManager.updateWindows(this.cdpBridge.windows, payload.windowId);
          await waitForFreshExtraction(this.stateManager, genBefore, 4000);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('command:navigate_to_approval', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.approvalId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or approvalId',
          } satisfies CommandResult);
          return;
        }
        const target = this.stateManager.getApprovalRegistry().get(payload.approvalId);
        if (!target) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Approval no longer available',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: navigate_to_approval ${payload.approvalId} from ${socket.id}`);
        try {
          const state = this.stateManager.getCurrentState();
          if (target.windowId && target.windowId !== state.activeWindowId) {
            const genBefore = this.stateManager.generation;
            await this.cdpBridge.switchWindow(target.windowId);
            this.windowMonitor.setHomeWindow(target.windowId);
            this.stateManager.updateWindows(this.cdpBridge.windows, target.windowId);
            await waitForFreshExtraction(this.stateManager, genBefore, 4000);
          }
          const scopeBefore = this.stateManager.historyScopeKey();
          const tabResult = await this.commandExecutor.switchTab(
            payload.commandId,
            target.tabTitle,
            undefined,
            target.composerId,
            target.tabSource,
          );
          if (!tabResult.ok) {
            socket.emit('command:result', tabResult);
            return;
          }
          await waitForHistoryScopeChange(this.stateManager, scopeBefore, 4000);
          this.requestFreshExtraction();
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('diagnostic:collect-response', (payload: {
        requestId?: string;
        webDom?: WebDomSnapshot;
        error?: string;
        bytes?: number;
      }) => {
        const requestId = payload?.requestId?.trim();
        if (!requestId) return;
        const resolve = this.pendingWebDomCollects.get(requestId);
        if (!resolve) return;
        if (payload.webDom?.html) {
          resolve(payload.webDom);
          return;
        }
        resolve({
          reason: 'error',
          message: payload.error || 'Web client DOM collection failed',
          ...(typeof payload.bytes === 'number' ? { bytes: payload.bytes } : {}),
        });
      });

      socket.on('disconnect', (reason) => {
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      if (patch.activeComposerId || patch.activeWindowId) {
        const state = this.stateManager.getCurrentState();
        void this.refreshStorageRelations(state.activeComposerId, state.activeWindowId);
      }
      this.io.emit('state:patch', sanitizePatchForClient(patch));
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });
  }

  private async refreshStorageRelations(composerId: string, windowId: string): Promise<void> {
    const normalizedComposerId = composerId?.trim();
    const normalizedWindowId = windowId?.trim();
    if (!normalizedComposerId || !normalizedWindowId) return;

    if (this.storageIndexInFlight) return;

    this.storageIndexInFlight = true;
    try {
      await indexStorageRelationsForComposer(
        this.storageHistory,
        this.stateManager.getConversationRegistry(),
        normalizedComposerId,
        normalizedWindowId,
      );
      this.stateManager.refreshConversationContextPatch();
    } catch (err) {
      console.warn(
        `[relay] Failed to index storage relations for ${normalizedComposerId.slice(0, 8)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.storageIndexInFlight = false;
    }
  }

  private requestFreshExtractionBurst(): void {
    for (const delayMs of POST_COMMAND_REFRESH_DELAYS_MS) {
      setTimeout(() => this.requestFreshExtraction(), delayMs);
    }
  }
}
