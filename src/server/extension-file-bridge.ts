import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import type { StateManager } from './state-manager.js';
import type {
  OpenSourceControlRequest,
  OpenSourceControlResult,
  CursorRestartRequest,
  CursorRestartResult,
} from '../shared/extension-bridge.js';
import type { GitActionRequest, GitActionResult } from '../shared/git-scm.js';
import type { ExtensionBridgeDiagnostics } from '../shared/diagnostics.js';
import {
  openSourceControlRequestPath,
  openSourceControlResultPath,
  gitActionRequestPath,
  gitActionResultPath,
  cursorRestartRequestPath,
  cursorRestartResultPath,
} from '../shared/extension-bridge.js';

const OPEN_SOURCE_CONTROL_TIMEOUT_MS = 5000;
const OPEN_SOURCE_CONTROL_POLL_MS = 125;
const GIT_ACTION_TIMEOUT_MS = 15000;
const GIT_ACTION_POLL_MS = 125;
const CURSOR_RESTART_TIMEOUT_MS = 12000;
const CURSOR_RESTART_POLL_MS = 125;

export class ExtensionFileBridge {
  private readonly dataDir: string;
  private gitActionChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, _stateManager: StateManager) {
    this.dataDir = dataDir;
  }

  start(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  stop(): void {
    // no-op
  }

  getDiagnostics(): ExtensionBridgeDiagnostics {
    return {
      dataDirName: basename(this.dataDir),
      dataDirPath: this.dataDir,
    };
  }

  async requestOpenSourceControl(requestId: string): Promise<void> {
    const request: OpenSourceControlRequest = {
      requestId,
      requestedAt: Date.now(),
    };

    writeFileSync(
      openSourceControlRequestPath(this.dataDir),
      JSON.stringify(request) + '\n',
      'utf-8',
    );

    const deadline = Date.now() + OPEN_SOURCE_CONTROL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = this.readOpenSourceControlResult();
      if (result?.requestId === requestId) {
        if (result.ok) return;
        throw new Error(result.error || 'Open Source Control failed');
      }
      await sleep(OPEN_SOURCE_CONTROL_POLL_MS);
    }

    throw new Error('Timed out waiting for extension to open Source Control');
  }

  async requestCursorRestart(requestId: string, remoteDebuggingPort: number): Promise<void> {
    const request: CursorRestartRequest = {
      requestId,
      requestedAt: Date.now(),
      remoteDebuggingPort,
    };

    writeFileSync(
      cursorRestartRequestPath(this.dataDir),
      JSON.stringify(request) + '\n',
      'utf-8',
    );

    const deadline = Date.now() + CURSOR_RESTART_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = this.readCursorRestartResult();
      if (result?.requestId === requestId) {
        if (result.ok) return;
        throw new Error(result.error || 'Cursor restart with CDP failed');
      }
      await sleep(CURSOR_RESTART_POLL_MS);
    }

    throw new Error(
      'Timed out waiting for the CursorRemote extension to restart Cursor. Start the relay from the installed extension, not only npm run dev.',
    );
  }

  async requestGitAction(request: GitActionRequest): Promise<GitActionResult> {
    const task = this.gitActionChain.then(() => this.executeGitAction(request));
    this.gitActionChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async executeGitAction(request: GitActionRequest): Promise<GitActionResult> {
    writeFileSync(
      gitActionRequestPath(this.dataDir),
      JSON.stringify(request) + '\n',
      'utf-8',
    );

    const deadline = Date.now() + GIT_ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = this.readGitActionResult();
      if (result?.requestId === request.requestId) {
        return result;
      }
      await sleep(GIT_ACTION_POLL_MS);
    }

    return {
      requestId: request.requestId,
      ok: false,
      completedAt: Date.now(),
      error: 'Timed out waiting for extension git action',
    };
  }

  private readGitActionResult(): GitActionResult | null {
    const path = gitActionResultPath(this.dataDir);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as GitActionResult;
    } catch {
      return null;
    }
  }

  private readOpenSourceControlResult(): OpenSourceControlResult | null {
    const path = openSourceControlResultPath(this.dataDir);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as OpenSourceControlResult;
    } catch {
      return null;
    }
  }

  private readCursorRestartResult(): CursorRestartResult | null {
    const path = cursorRestartResultPath(this.dataDir);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as CursorRestartResult;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
