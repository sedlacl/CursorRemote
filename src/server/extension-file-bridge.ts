import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import type { StateManager } from './state-manager.js';
import type {
  OpenSourceControlRequest,
  OpenSourceControlResult,
} from '../shared/extension-bridge.js';
import type { GitActionRequest, GitActionResult } from '../shared/git-scm.js';
import type {
  VsCodeCommandBridgeInfo,
  VsCodeCommandRequest,
  VsCodeCommandResult,
} from '../shared/vscode-command-bridge.js';
import {
  VSCODE_COMMAND_BRIDGE_PROTOCOL,
  isVsCodeBridgeCommand,
  vsCodeCommandBridgeInfoPath,
  vsCodeCommandRequestPath,
  vsCodeCommandResultPath,
} from '../shared/vscode-command-bridge.js';
import type { ExtensionBridgeDiagnostics } from '../shared/diagnostics.js';
import {
  openSourceControlRequestPath,
  openSourceControlResultPath,
  gitActionRequestPath,
  gitActionResultPath,
} from '../shared/extension-bridge.js';

const OPEN_SOURCE_CONTROL_TIMEOUT_MS = 5000;
const OPEN_SOURCE_CONTROL_POLL_MS = 125;
const GIT_ACTION_TIMEOUT_MS = 15000;
const GIT_ACTION_POLL_MS = 125;
const VSCODE_COMMAND_TIMEOUT_MS = 8000;
const VSCODE_COMMAND_POLL_MS = 100;

export class ExtensionFileBridge {
  private readonly dataDir: string;
  private gitActionChain: Promise<void> = Promise.resolve();
  private vsCodeCommandChain: Promise<void> = Promise.resolve();

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

  /**
   * Run a whitelisted VS Code command in the extension host.
   * Serialised like git actions — one in flight at a time, so a slow
   * `claude-vscode.editor.open` cannot interleave with the next request file.
   */
  async requestVsCodeCommand(request: VsCodeCommandRequest): Promise<VsCodeCommandResult> {
    if (!isVsCodeBridgeCommand(request.command)) {
      return {
        requestId: request.requestId,
        ok: false,
        completedAt: Date.now(),
        error: `Command not allowed by bridge: ${String(request.command)}`,
      };
    }

    // Check the far end before writing a request nobody will read — otherwise
    // a missing, stale or older extension all look the same: an 8 s silence.
    const preflight = this.checkVsCodeBridge(request.command);
    if (preflight) {
      return {
        requestId: request.requestId,
        ok: false,
        completedAt: Date.now(),
        error: preflight,
      };
    }

    const task = this.vsCodeCommandChain.then(() => this.executeVsCodeCommand(request));
    this.vsCodeCommandChain = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * What the extension announced about itself, or null when nothing did.
   * Also surfaced by the verify harness, so the state is inspectable before a
   * command is ever attempted.
   */
  readVsCodeBridgeInfo(): VsCodeCommandBridgeInfo | null {
    const path = vsCodeCommandBridgeInfoPath(this.dataDir);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as VsCodeCommandBridgeInfo;
    } catch {
      return null;
    }
  }

  /** Null when the bridge can run `command`; otherwise why it cannot. */
  checkVsCodeBridge(command: string): string | null {
    const info = this.readVsCodeBridgeInfo();
    if (!info) {
      return `No CursorRemote extension is watching ${this.dataDir}. `
        + 'Start the extension (F5 "CursorRemote: Extension Dev Host") or point DATA_DIR '
        + 'at the globalStorage directory of the extension that is running.';
    }

    if (!isProcessAlive(info.pid)) {
      return `The extension that claimed ${this.dataDir} (${info.extensionId}@${info.extensionVersion}, `
        + `pid ${info.pid}) is no longer running — its announcement is stale.`;
    }

    if (info.protocol !== VSCODE_COMMAND_BRIDGE_PROTOCOL) {
      return `Command bridge protocol mismatch: server speaks ${VSCODE_COMMAND_BRIDGE_PROTOCOL}, `
        + `${info.extensionId}@${info.extensionVersion} speaks ${info.protocol}. Rebuild and reload the extension.`;
    }

    if (Array.isArray(info.commands) && !info.commands.includes(command)) {
      return `${info.extensionId}@${info.extensionVersion} does not support ${command}. `
        + 'Rebuild (npm run build:ext) and reload the extension host.';
    }

    return null;
  }

  private async executeVsCodeCommand(request: VsCodeCommandRequest): Promise<VsCodeCommandResult> {
    writeFileSync(
      vsCodeCommandRequestPath(this.dataDir),
      JSON.stringify(request) + '\n',
      'utf-8',
    );

    const deadline = Date.now() + VSCODE_COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = this.readVsCodeCommandResult();
      if (result?.requestId === request.requestId) {
        return result;
      }
      await sleep(VSCODE_COMMAND_POLL_MS);
    }

    // Preflight already established that a matching bridge is alive, so a
    // timeout here means the command itself hung, not a setup problem.
    const info = this.readVsCodeBridgeInfo();
    const who = info ? `${info.extensionId}@${info.extensionVersion}` : 'the extension';
    return {
      requestId: request.requestId,
      ok: false,
      completedAt: Date.now(),
      error: `Timed out waiting for ${who} to run ${request.command} (watching ${this.dataDir})`,
    };
  }

  private readVsCodeCommandResult(): VsCodeCommandResult | null {
    const path = vsCodeCommandResultPath(this.dataDir);
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as VsCodeCommandResult;
    } catch {
      return null;
    }
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
}

/** Signal 0 tests for existence without touching the process. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
