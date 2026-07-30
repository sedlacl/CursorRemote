import type { GitStatusInfo, GitWindowSnapshot } from './extension-bridge.js';

export interface ServerIdentity {
  version: string;
  instanceId: string;
  /** Short Crockford base32 relay instance ID (visible in UI, not a secret). */
  diagnosticId: string;
  pid: number;
  port: number;
  host: string;
  dataDirName: string;
  startedAt: number;
  clientBuild: 'vite-dev' | 'static';
}

export interface ExtensionBridgeDiagnostics {
  dataDirName: string;
  dataDirPath: string;
}

export type GitSnapshotReason =
  | 'initial'
  | 'state-change'
  | 'repo-open'
  | 'repo-close'
  | 'server-started'
  | 'explicit-refresh';

export interface GitBridgeRepoDebugInfo {
  rootUri: string;
  label: string;
  changedCount: number;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: number;
  changed?: number;
  untracked?: number;
  merge?: number;
}

export interface GitBridgeDebugInfo {
  updatedAt: number;
  extensionVersion: string;
  windowName: string;
  windowKey?: string;
  isOwner: boolean;
  gitApiAvailable: boolean;
  repoCount: number;
  repoResolved: boolean;
  repoLabel?: string;
  changedCount?: number;
  repoBreakdown?: GitBridgeRepoDebugInfo[];
  /** @deprecated use gitLastSnapshotReason */
  runGitStatus?: boolean;
  gitProviderMode?: 'vscode.git.state-cache';
  gitRepositoryCount?: number;
  gitLastSnapshotAt?: number;
  gitLastSnapshotReason?: GitSnapshotReason;
  gitExplicitRefreshCount?: number;
  lastPushAt?: number;
  lastPushOk?: boolean;
  lastPushError?: string;
  lastError?: string;
}

export interface GitSnapshotStoreDiagnostics {
  activeWindowKey: string | null;
  activeWindowTitle: string | null;
  lastPushAt: number | null;
  lastPushWindowKey: string | null;
  windowSnapshots: Record<string, Pick<GitWindowSnapshot, 'windowKey' | 'updatedAt' | 'repoBreakdown'> & {
    changedCount: number;
    repoLabel?: string;
  }>;
}

export interface ServerDiagnostics {
  server: ServerIdentity;
  extensionBridge: ExtensionBridgeDiagnostics;
  gitSnapshots: GitSnapshotStoreDiagnostics;
  gitStatus: GitStatusInfo | null;
  connected: boolean;
  generation: number;
  uptime: number;
  clients: number;
  activeWindowId: string;
  activeWindowTitle: string | null;
  cdpUrl: string;
}
