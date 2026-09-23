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
export const VSCODE_COMMAND_BRIDGE_INFO_FILENAME = 'vscode-command-bridge-info.json';

/**
 * Wire version of this handshake.
 *
 * Bumped whenever the request/result shape changes in a way an older peer would
 * misread. The server compares it against what the extension announces, so a
 * version mismatch is reported as such instead of surfacing as a timeout.
 */
export const VSCODE_COMMAND_BRIDGE_PROTOCOL = 1;

/**
 * Written by the extension when its bridge starts watching, read by the server
 * to answer one question precisely: is anything on the other end, and can it do
 * what we are about to ask?
 *
 * Without it, an extension that is missing, outdated, or built without the
 * bridge all look identical from the server — an 8 s silence.
 */
export interface VsCodeCommandBridgeInfo {
  protocol: number;
  extensionId: string;
  extensionVersion: string;
  /** Commands this build will actually execute. */
  commands: string[];
  /** Extension host pid, so a leftover file from a dead host is detectable. */
  pid: number;
  startedAt: number;
}

export function vsCodeCommandRequestPath(dataDir: string): string {
  return join(dataDir, VSCODE_COMMAND_REQUEST_FILENAME);
}

export function vsCodeCommandResultPath(dataDir: string): string {
  return join(dataDir, VSCODE_COMMAND_RESULT_FILENAME);
}

export function vsCodeCommandBridgeInfoPath(dataDir: string): string {
  return join(dataDir, VSCODE_COMMAND_BRIDGE_INFO_FILENAME);
}
