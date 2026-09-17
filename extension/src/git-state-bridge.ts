import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'fs';
import type { UnifiedOutputChannel } from './output-channel.js';
import type { ServerManager } from './server-manager.js';
import { GitSnapshotProvider } from './git-snapshot-provider.js';
import { GitActionExecutor } from './git-action-executor.js';
import type {
  GitSnapshotPushPayload,
  GitStatusInfo,
  OpenSourceControlRequest,
  OpenSourceControlResult,
  CursorRestartRequest,
  CursorRestartResult,
} from '../../src/shared/extension-bridge.js';
import {
  openSourceControlRequestPath,
  openSourceControlResultPath,
  gitActionRequestPath,
  gitActionResultPath,
  cursorRestartRequestPath,
  cursorRestartResultPath,
} from '../../src/shared/extension-bridge.js';
import type { GitActionRequest, GitActionResult, GitScmSnapshot } from '../../src/shared/git-scm.js';
import type { GitSnapshotReason } from '../../src/shared/diagnostics.js';
import { snapshotSignature, type GitWindowSnapshotResult } from '../../src/shared/git-snapshot.js';
import { basenameFromPath, resolveWorkspaceIdentity } from '../../src/shared/workspace-identity.js';
import type { GitLocalStatusSummary } from './git-status-display.js';
import { restartCursorWithRemoteDebugging } from './cursor-cdp-restart.js';

const GIT_PUSH_RETRY_ATTEMPTS = 3;
const GIT_PUSH_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GitStateBridge implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel: UnifiedOutputChannel;
  private readonly serverManager: ServerManager;
  private readonly snapshotProvider: GitSnapshotProvider;
  private readonly gitActionExecutor: GitActionExecutor;
  private readonly onDidChangeLocalGitStatusEmitter = new vscode.EventEmitter<void>();
  private requestWatcher: FSWatcher | null = null;
  private bridgeDataDir: string;
  private lastRequestId = '';
  private lastGitActionRequestId = '';
  private lastRestartRequestId = '';
  private lastPushedSignature = '';
  private lastSeenServerInstanceId: string | null = null;
  private lastGitRecoveryPushAt = 0;
  private static readonly GIT_RECOVERY_PUSH_INTERVAL_MS = 30_000;
  private lastLocalSnapshot: GitWindowSnapshotResult | null = null;
  private extensionInstanceId: string;
  private disposed = false;

  readonly onDidChangeLocalGitStatus = this.onDidChangeLocalGitStatusEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: UnifiedOutputChannel,
    serverManager: ServerManager,
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.serverManager = serverManager;
    this.bridgeDataDir = context.globalStorageUri.fsPath;
    this.extensionInstanceId = context.globalState.get<string>('gitBridgeInstanceId')
      ?? vscode.env.sessionId
      ?? `ext-${Date.now()}`;
    void context.globalState.update('gitBridgeInstanceId', this.extensionInstanceId);

    this.snapshotProvider = new GitSnapshotProvider(outputChannel, {
      resolveWindowKey: () => this.resolveWindowKey(),
      resolveRepoLabel: () => this.resolveRepoLabel(),
      resolveWorkspaceFolderPath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    });
    this.gitActionExecutor = new GitActionExecutor(
      this.snapshotProvider,
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      outputChannel,
    );
  }

  start(): void {
    this.ensureBridgeDataDir(this.bridgeDataDir);

    this.snapshotProvider.onDidChangeSnapshot(snapshot => {
      void this.pushFromSnapshot(snapshot);
    });

    this.serverManager.on('stateChanged', () => {
      void this.handleOpenSourceControlRequest();
      void this.handleGitActionRequest();
      void this.handleCursorRestartRequest();
    });
    this.serverManager.on('started', () => {
      this.lastPushedSignature = '';
      this.lastSeenServerInstanceId = null;
    });
    this.serverManager.on('health', (health: HealthData) => {
      void this.handleServerHealth(health);
    });

    void this.snapshotProvider.start();
    void this.handleOpenSourceControlRequest();
    void this.handleGitActionRequest();
    void this.handleCursorRestartRequest();
    this.setupBridgeWatcher();
  }

  private ensureBridgeDataDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private updateBridgeDataDir(nextDir: string | undefined): void {
    if (!nextDir || nextDir === this.bridgeDataDir) return;
    this.bridgeDataDir = nextDir;
    this.ensureBridgeDataDir(this.bridgeDataDir);
    this.setupBridgeWatcher();
    this.outputChannel.info(`[git-bridge] Bridge data dir: ${this.bridgeDataDir}`);
  }

  private setupBridgeWatcher(): void {
    if (this.requestWatcher) {
      this.requestWatcher.close();
      this.requestWatcher = null;
    }

    try {
      this.requestWatcher = watch(this.bridgeDataDir, (_eventType, filename) => {
        if (filename === 'open-source-control-request.json') {
          void this.handleOpenSourceControlRequest();
        }
        if (filename === 'git-action-request.json') {
          void this.handleGitActionRequest();
        }
        if (filename === 'cursor-restart-request.json') {
          void this.handleCursorRestartRequest();
        }
      });
    } catch (err) {
      this.outputChannel.warn(
        `[git-bridge] Failed to watch ${this.bridgeDataDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  explicitRefreshGitStatus(): Promise<void> {
    return this.snapshotProvider.explicitRefresh('explicit-refresh');
  }

  getLocalGitStatus(): GitLocalStatusSummary | null {
    const diagnostics = this.snapshotProvider.getDiagnostics();
    if (!this.lastLocalSnapshot && diagnostics.gitLastSnapshotReason == null) {
      return null;
    }

    return {
      available: this.lastLocalSnapshot?.available ?? false,
      changedCount: this.lastLocalSnapshot?.changedCount ?? 0,
      repoLabel: this.lastLocalSnapshot?.available ? this.lastLocalSnapshot.repoLabel : undefined,
      error: diagnostics.lastError,
      reason: this.lastLocalSnapshot?.reason ?? diagnostics.gitLastSnapshotReason,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.requestWatcher) {
      this.requestWatcher.close();
      this.requestWatcher = null;
    }
    this.snapshotProvider.dispose();
    this.onDidChangeLocalGitStatusEmitter.dispose();
  }

  private handleServerHealth(health: HealthData): void {
    this.updateBridgeDataDir(health.extensionBridge?.dataDirPath);
    void this.handleOpenSourceControlRequest();
    void this.handleGitActionRequest();
    void this.handleCursorRestartRequest();

    const instanceId = health.server?.instanceId;
    if (instanceId && this.lastSeenServerInstanceId !== instanceId) {
      this.lastSeenServerInstanceId = instanceId;
      this.lastPushedSignature = '';
      this.snapshotProvider.emitCurrentSnapshot('server-started');
      return;
    }

    if (health.gitStatus != null || !this.lastLocalSnapshot?.available) {
      return;
    }

    const now = Date.now();
    if (now - this.lastGitRecoveryPushAt < GitStateBridge.GIT_RECOVERY_PUSH_INTERVAL_MS) {
      return;
    }
    this.lastGitRecoveryPushAt = now;
    this.lastPushedSignature = '';
    void this.pushFromSnapshot(this.lastLocalSnapshot);
  }

  private resolveWorkspaceName(): string | undefined {
    const configured = vscode.workspace.name?.trim();
    if (configured) return configured;
    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile) return undefined;
    return basenameFromPath(workspaceFile.fsPath).replace(/\.code-workspace$/i, '');
  }

  private resolveWindowKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const includeQualifier = vscode.workspace
      .getConfiguration('cursorRemote')
      .get<boolean>('windowTitleQualifier', true);
    const workspaceName = this.resolveWorkspaceName();
    if (!folder) {
      return workspaceName ?? 'unknown';
    }
    return resolveWorkspaceIdentity({
      workspacePath: folder.uri.fsPath,
      workspaceName,
      authority: folder.uri.authority || undefined,
      includeQualifier,
    });
  }

  private resolveRepoLabel(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.name || undefined;
  }

  private async pushFromSnapshot(snapshot: GitWindowSnapshotResult): Promise<void> {
    if (this.disposed) return;

    this.lastLocalSnapshot = snapshot;
    this.onDidChangeLocalGitStatusEmitter.fire();

    const gitStatus: GitStatusInfo = {
      available: snapshot.available,
      changedCount: snapshot.changedCount,
      repoLabel: snapshot.available ? snapshot.repoLabel : undefined,
      updatedAt: snapshot.updatedAt,
      source: 'vscode.git',
      windowKey: snapshot.windowKey,
    };

    await this.pushGitSnapshot(
      gitStatus,
      snapshot.windowKey,
      snapshot.repoBreakdown,
      snapshot.available ? snapshot.gitScm : null,
      snapshot.reason,
    );
  }

  private async pushGitSnapshot(
    gitStatus: GitStatusInfo,
    windowKey: string,
    repoBreakdown: GitWindowSnapshotResult['repoBreakdown'],
    gitScm: GitScmSnapshot | null,
    reason: GitSnapshotReason,
  ): Promise<void> {
    const pushPayload: GitSnapshotPushPayload = {
      windowKey,
      gitStatus,
      repoBreakdown,
      gitScm,
      updatedAt: gitStatus.updatedAt,
      extensionInstanceId: this.extensionInstanceId,
    };

    const signature = snapshotSignature({
      windowKey,
      available: gitStatus.available,
      changedCount: gitStatus.changedCount,
      repoLabel: gitStatus.repoLabel,
      repoBreakdown: repoBreakdown ?? [],
      repoSnapshots: [],
      gitScm,
      updatedAt: gitStatus.updatedAt,
      reason,
    });

    const force = reason === 'server-started' || reason === 'explicit-refresh';
    if (!force && signature === this.lastPushedSignature) {
      return;
    }

    const pushResult = await this.postGitSnapshot(pushPayload);
    if (pushResult.ok) {
      this.lastPushedSignature = signature;
      return;
    }

    this.outputChannel.warn(
      `[git-bridge] Failed to push git snapshot (${reason}): ${pushResult.error ?? 'unknown error'}`,
    );
  }

  private async postGitSnapshot(
    payload: GitSnapshotPushPayload,
  ): Promise<{ ok: boolean; error?: string }> {
    const pushUrl = this.serverManager.getGitSnapshotPushUrl();

    for (let attempt = 1; attempt <= GIT_PUSH_RETRY_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(2500),
        });
        if (resp.ok) {
          return { ok: true };
        }
        const text = await resp.text().catch(() => '');
        const error = text || `HTTP ${resp.status}`;
        if (attempt === GIT_PUSH_RETRY_ATTEMPTS) {
          return { ok: false, error };
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (attempt === GIT_PUSH_RETRY_ATTEMPTS) {
          return { ok: false, error };
        }
      }

      await sleep(GIT_PUSH_RETRY_DELAY_MS);
    }

    return { ok: false, error: 'Push failed after retries' };
  }

  private async handleOpenSourceControlRequest(): Promise<void> {
    if (this.disposed) return;
    const path = openSourceControlRequestPath(this.bridgeDataDir);
    if (!existsSync(path)) return;

    let request: OpenSourceControlRequest;
    try {
      request = JSON.parse(readFileSync(path, 'utf-8')) as OpenSourceControlRequest;
    } catch {
      return;
    }

    if (!request.requestId || request.requestId === this.lastRequestId) return;
    this.lastRequestId = request.requestId;

    let result: OpenSourceControlResult;
    try {
      await vscode.commands.executeCommand('cursorRemote.openSourceControl');
      result = {
        requestId: request.requestId,
        ok: true,
        completedAt: Date.now(),
      };
    } catch (err) {
      result = {
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        completedAt: Date.now(),
      };
    }

    writeFileSync(
      openSourceControlResultPath(this.bridgeDataDir),
      JSON.stringify(result) + '\n',
      'utf-8',
    );
  }

  private async handleGitActionRequest(): Promise<void> {
    if (this.disposed) return;
    const path = gitActionRequestPath(this.bridgeDataDir);
    if (!existsSync(path)) return;

    let request: GitActionRequest;
    try {
      request = JSON.parse(readFileSync(path, 'utf-8')) as GitActionRequest;
    } catch {
      return;
    }

    if (!request.requestId || request.requestId === this.lastGitActionRequestId) return;
    this.lastGitActionRequestId = request.requestId;
    this.outputChannel.info(
      `[git-bridge] request ${request.requestId}: ${request.action} repo=${request.repoId ?? '-'} paths=${JSON.stringify(request.paths ?? [])}`,
    );

    const result = await this.gitActionExecutor.execute(request);
    this.outputChannel.info(
      `[git-bridge] result ${request.requestId}: ok=${result.ok} error=${result.error ?? '-'} debug=${JSON.stringify(result.debug ?? [])}`,
    );
    if (result.ok && (request.action === 'stage' || request.action === 'unstage')) {
      this.snapshotProvider.emitCurrentSnapshot('state-change');
    }
    writeFileSync(
      gitActionResultPath(this.bridgeDataDir),
      JSON.stringify(result) + '\n',
      'utf-8',
    );
  }

  private async handleCursorRestartRequest(): Promise<void> {
    if (this.disposed) return;
    const path = cursorRestartRequestPath(this.bridgeDataDir);
    if (!existsSync(path)) return;

    let request: CursorRestartRequest;
    try {
      request = JSON.parse(readFileSync(path, 'utf-8')) as CursorRestartRequest;
    } catch {
      return;
    }

    if (!request.requestId || request.requestId === this.lastRestartRequestId) return;
    this.lastRestartRequestId = request.requestId;

    const writeResult = (result: CursorRestartResult): void => {
      writeFileSync(
        cursorRestartResultPath(this.bridgeDataDir),
        JSON.stringify(result) + '\n',
        'utf-8',
      );
    };

    try {
      await restartCursorWithRemoteDebugging({
        port: request.remoteDebuggingPort,
        globalStorageFsPath: this.context.globalStorageUri.fsPath,
        output: this.outputChannel,
        appRoot: vscode.env.appRoot,
      });
      // Result must be on disk before quit — the extension host will not write after exit.
      writeResult({
        requestId: request.requestId,
        ok: true,
        completedAt: Date.now(),
      });
      this.outputChannel.info(
        '[git-bridge] CDP relaunch waiter spawned; quitting all Cursor windows via workbench.action.quit',
      );
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.quit');
      }, 250);
    } catch (err) {
      writeResult({
        requestId: request.requestId,
        ok: false,
        completedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
