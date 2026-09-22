import { join } from 'path';

/**
 * File handshake for running whitelisted `vscode.commands.executeCommand` calls
 * from the CursorRemote server through the extension host.
 *
 * Same shape as the git action bridge (request file + result file in the
 * extension's globalStorage dir), because the server process has no VS Code API.
 *
 * Fail-closed: only commands in {@link VSCODE_BRIDGE_COMMANDS} may be requested.
 * The extension re-validates the id before executing — a server that asks for
 * anything else gets an error result, never an execution.
 */
export const VSCODE_BRIDGE_COMMANDS = [
  'claude-vscode.editor.open',
  'claude-vscode.newConversation',
  'claude-vscode.focus',
  'claude-vscode.focusLastMessage',
  'claude-vscode.blur',
  'claude-vscode.acceptProposedDiff',
  'claude-vscode.rejectProposedDiff',
  'claude-vscode.reopenClosedSession',
  'claude-vscode.renameSessionTab',
  'claude-vscode.markSessionUnread',
] as const;

export type VsCodeBridgeCommand = (typeof VSCODE_BRIDGE_COMMANDS)[number];

export function isVsCodeBridgeCommand(value: unknown): value is VsCodeBridgeCommand {
  return typeof value === 'string'
    && (VSCODE_BRIDGE_COMMANDS as readonly string[]).includes(value);
}

/** JSON-serialisable command arguments. `undefined` holes are encoded as null. */
export type VsCodeCommandArg = string | number | boolean | null | Record<string, unknown>;

export interface VsCodeCommandRequest {
  requestId: string;
  command: VsCodeBridgeCommand;
  args: VsCodeCommandArg[];
  requestedAt: number;
}

export interface VsCodeCommandResult {
  requestId: string;
  ok: boolean;
  completedAt: number;
  /** Serialisable return value, when the command produced one. */
  value?: unknown;
  error?: string;
}

export const VSCODE_COMMAND_REQUEST_FILENAME = 'vscode-command-request.json';
export const VSCODE_COMMAND_RESULT_FILENAME = 'vscode-command-result.json';

export function vsCodeCommandRequestPath(dataDir: string): string {
  return join(dataDir, VSCODE_COMMAND_REQUEST_FILENAME);
}

export function vsCodeCommandResultPath(dataDir: string): string {
  return join(dataDir, VSCODE_COMMAND_RESULT_FILENAME);
}
