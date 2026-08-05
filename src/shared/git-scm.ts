/** Git SCM review contract (version 2). */

export const GIT_SCM_VERSION = 2 as const;

export type GitFileBucket = 'staged' | 'changes' | 'conflicts' | 'untracked';

export type GitDiffStageView = 'working' | 'index';

export interface GitRepoCounts {
  staged: number;
  changes: number;
  conflicts: number;
  untracked: number;
}

export interface GitRepoSummary {
  repoId: string;
  rootUri: string;
  label: string;
  branch: string | null;
  ahead: number;
  behind: number;
  counts: GitRepoCounts;
}

export interface GitFileSummary {
  fileId: string;
  repoId: string;
  bucket: GitFileBucket;
  path: string;
  originalPath: string | null;
  displayPath: string;
  status: string;
  isRename: boolean;
  isBinary: boolean;
  isLarge: boolean;
  isConflict: boolean;
  updatedAt: number;
}

export interface GitScmSnapshot {
  version: typeof GIT_SCM_VERSION;
  snapshotId: string;
  updatedAt: number;
  windowKey: string;
  repos: GitRepoSummary[];
  files: GitFileSummary[];
}

export interface GitDiffLine {
  kind: 'context' | 'insert' | 'delete';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface GitDiffChunk {
  chunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

export interface GitDiffSummary {
  insertions: number;
  deletions: number;
  hunksTotal: number;
}

export interface GitDiffResponse {
  snapshotId: string;
  repoId: string;
  fileId: string;
  path: string;
  stageView: GitDiffStageView;
  language: string;
  isBinary: boolean;
  isLarge: boolean;
  summary: GitDiffSummary;
  chunks: GitDiffChunk[];
  pagination: {
    returnedHunks: number;
    remainingHunks: number;
    nextHunkCursor: string | null;
  };
}

/** Working-tree file text for the Diff | File viewer (read-only). */
export interface GitFileContentResponse {
  snapshotId: string;
  repoId: string;
  fileId: string;
  path: string;
  language: string;
  isBinary: boolean;
  isLarge: boolean;
  truncated: boolean;
  content: string;
  byteLength: number;
}

export interface GitStageRequest {
  fileIds: string[];
  requestId?: string;
}

export interface GitStageResponse {
  ok: boolean;
  requestId: string;
  affected: string[];
  error?: string;
  /** True when some repos succeeded before a later repo failed. */
  partial?: boolean;
}

export const GIT_SNAPSHOT_STALE_ERROR = 'Stale git snapshot';

export interface GitActionRequest {
  requestId: string;
  requestedAt: number;
  action: 'diff' | 'content' | 'stage' | 'unstage' | 'refresh';
  repoId?: string;
  path?: string;
  paths?: string[];
  stage?: GitDiffStageView;
  hunkCursor?: string;
  bucket?: GitFileBucket;
}

export interface GitActionResult {
  requestId: string;
  ok: boolean;
  completedAt: number;
  error?: string;
  debug?: string[];
  diffText?: string;
  contentText?: string;
  truncated?: boolean;
  byteLength?: number;
  isBinary?: boolean;
  affected?: string[];
}

/** Soft cap for mobile file preview payloads. */
export const GIT_FILE_CONTENT_MAX_BYTES = 512 * 1024;

export const GIT_ACTION_REQUEST_FILENAME = 'git-action-request.json';
export const GIT_ACTION_RESULT_FILENAME = 'git-action-result.json';
