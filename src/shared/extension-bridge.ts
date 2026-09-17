import { join } from 'path';
import type { GitBridgeRepoDebugInfo } from './diagnostics.js';
import type { GitScmSnapshot } from './git-scm.js';

export interface GitStatusInfo {
  available: boolean;
  changedCount: number;
  repoLabel?: string;
  updatedAt: number;
  source: 'vscode.git';
  /** Workspace identity this snapshot belongs to (per-window git). */
  windowKey?: string;
}

export interface GitWindowSnapshot {
  windowKey: string;
  gitStatus: GitStatusInfo;
  repoBreakdown?: GitBridgeRepoDebugInfo[];
  gitScm?: GitScmSnapshot | null;
  updatedAt: number;
  extensionInstanceId?: string;
}

export interface GitSnapshotPushPayload {
  windowKey: string;
  gitStatus: GitStatusInfo;
  repoBreakdown?: GitBridgeRepoDebugInfo[];
  gitScm?: GitScmSnapshot | null;
  updatedAt: number;
  extensionInstanceId?: string;
}

export const GIT_SNAPSHOT_PUSH_PATH = '/internal/git-snapshot';

export interface OpenSourceControlRequest {
  requestId: string;
  requestedAt: number;
}

export interface OpenSourceControlResult {
  requestId: string;
  ok: boolean;
  completedAt: number;
  error?: string;
}

const OPEN_SOURCE_CONTROL_REQUEST_FILENAME = 'open-source-control-request.json';
const OPEN_SOURCE_CONTROL_RESULT_FILENAME = 'open-source-control-result.json';

export function openSourceControlRequestPath(dataDir: string): string {
  return join(dataDir, OPEN_SOURCE_CONTROL_REQUEST_FILENAME);
}

export function openSourceControlResultPath(dataDir: string): string {
  return join(dataDir, OPEN_SOURCE_CONTROL_RESULT_FILENAME);
}

export {
  GIT_ACTION_REQUEST_FILENAME,
  GIT_ACTION_RESULT_FILENAME,
} from './git-scm.js';

export function gitActionRequestPath(dataDir: string): string {
  return join(dataDir, 'git-action-request.json');
}

export function gitActionResultPath(dataDir: string): string {
  return join(dataDir, 'git-action-result.json');
}

