import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'fs';
import type { UnifiedOutputChannel } from './output-channel.js';
import type {
  VsCodeCommandRequest,
  VsCodeCommandResult,
} from '../../src/shared/vscode-command-bridge.js';
import {
  VSCODE_COMMAND_REQUEST_FILENAME,
  isVsCodeBridgeCommand,
  vsCodeCommandRequestPath,
  vsCodeCommandResultPath,
} from '../../src/shared/vscode-command-bridge.js';

/**
 * Runs whitelisted VS Code commands on behalf of the CursorRemote server.
 *
 * The server writes `vscode-command-request.json` into the extension's
 * globalStorage dir; this bridge executes the command and writes the result
 * back. Mirrors the git action handshake in {@link GitStateBridge}.
 *
 * Only ids in the shared allowlist run — a request for anything else is
 * answered with an error, never executed. That keeps the file handshake from
 * becoming an arbitrary command channel into the IDE.
 */
export class VsCodeCommandBridge implements vscode.Disposable {
  private readonly outputChannel: UnifiedOutputChannel;
  private readonly dataDir: string;
  private watcher: FSWatcher | null = null;
  private lastRequestId = '';
  private disposed = false;

  constructor(context: vscode.ExtensionContext, outputChannel: UnifiedOutputChannel) {
    this.outputChannel = outputChannel;
    this.dataDir = context.globalStorageUri.fsPath;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dataDir, (_eventType, filename) => {
        if (filename === VSCODE_COMMAND_REQUEST_FILENAME) {
          void this.handleRequest();
        }
      });
    } catch (err) {
      this.outputChannel.warn(
        `[vscode-command-bridge] Failed to watch ${this.dataDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleRequest(): Promise<void> {
    if (this.disposed) return;
    const path = vsCodeCommandRequestPath(this.dataDir);
    if (!existsSync(path)) return;

    let request: VsCodeCommandRequest;
    try {
      request = JSON.parse(readFileSync(path, 'utf-8')) as VsCodeCommandRequest;
    } catch {
      return;
    }

    if (!request.requestId || request.requestId === this.lastRequestId) return;
    this.lastRequestId = request.requestId;

    const result = await this.execute(request);
    this.outputChannel.info(
      `[vscode-command-bridge] ${request.requestId}: ${request.command} ok=${result.ok}${result.error ? ` error=${result.error}` : ''}`,
    );

    try {
      writeFileSync(
        vsCodeCommandResultPath(this.dataDir),
        JSON.stringify(result) + '\n',
        'utf-8',
      );
    } catch (err) {
      this.outputChannel.warn(
        `[vscode-command-bridge] Failed to write result: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async execute(request: VsCodeCommandRequest): Promise<VsCodeCommandResult> {
    const base = { requestId: request.requestId, completedAt: Date.now() };

    if (!isVsCodeBridgeCommand(request.command)) {
      return { ...base, ok: false, error: `Command not allowed: ${String(request.command)}` };
    }

    const args = Array.isArray(request.args) ? request.args : [];
    // `null` is the wire encoding for an omitted positional argument
    // (`claude-vscode.editor.open` takes optional slots in the middle).
    const callArgs = args.map(a => (a === null ? undefined : a));

    try {
      const value = await vscode.commands.executeCommand(request.command, ...callArgs);
      return { ...base, ok: true, completedAt: Date.now(), value: serialisable(value) };
    } catch (err) {
      return {
        ...base,
        ok: false,
        completedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

/** Command return values can be VS Code objects; keep only what survives JSON. */
function serialisable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value).slice(0, 500);
  }
}
