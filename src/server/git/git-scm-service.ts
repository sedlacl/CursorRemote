import type { StateManager } from '../state-manager.js';
import type { ExtensionFileBridge } from '../extension-file-bridge.js';
import type {
  GitDiffResponse,
  GitDiffStageView,
  GitFileBucket,
  GitFileContentResponse,
  GitFileSummary,
  GitScmSnapshot,
  GitStageResponse,
} from '../../shared/git-scm.js';
import { GIT_SNAPSHOT_STALE_ERROR } from '../../shared/git-scm.js';
import {
  decodeFileListCursor,
  findFileInSnapshot,
  paginateFiles,
} from '../../shared/git-file-list.js';
import { parseFileId } from '../../shared/git-repo-id.js';
import {
  languageFromPath,
  paginateDiffChunks,
  parseUnifiedDiff,
  summarizeDiff,
} from '../../shared/git-diff-parser.js';

const DEFAULT_FILE_PAGE_SIZE = 50;
const DEFAULT_HUNK_PAGE_SIZE = 1;
const VALID_BUCKETS = new Set<GitFileBucket>(['staged', 'changes', 'conflicts', 'untracked']);

interface DiffCacheEntry {
  snapshotId: string;
  chunks: ReturnType<typeof parseUnifiedDiff>;
  summary: ReturnType<typeof summarizeDiff>;
  isBinary: boolean;
  cachedAt: number;
}

export function resolveDiffStage(
  file: GitFileSummary,
  requested?: GitDiffStageView,
): GitDiffStageView {
  if (file.bucket === 'staged') return 'index';
  if (requested === 'index') return 'index';
  return 'working';
}

export function parseBucketQuery(value: string | undefined): GitFileBucket | undefined {
  if (!value) return undefined;
  if (!VALID_BUCKETS.has(value as GitFileBucket)) {
    throw new Error(`Invalid bucket: ${value}`);
  }
  return value as GitFileBucket;
}

export function parseBucketsQuery(value: string | undefined): GitFileBucket[] | undefined {
  if (!value) return undefined;
  const buckets = value.split(',').map(part => part.trim()).filter(Boolean);
  if (!buckets.length) return undefined;
  for (const bucket of buckets) {
    if (!VALID_BUCKETS.has(bucket as GitFileBucket)) {
      throw new Error(`Invalid bucket: ${bucket}`);
    }
  }
  return buckets as GitFileBucket[];
}

export class GitScmService {
  private readonly diffCache = new Map<string, DiffCacheEntry>();
  private readonly maxDiffCacheEntries = 32;

  constructor(
    private readonly stateManager: StateManager,
    private readonly extensionBridge: ExtensionFileBridge,
  ) {}

  getSnapshot(): GitScmSnapshot | null {
    return this.stateManager.getActiveGitScmSnapshot();
  }

  getRepos() {
    const snapshot = this.getSnapshot();
    if (!snapshot) return { repos: [], snapshotId: null as string | null };
    return { repos: snapshot.repos, snapshotId: snapshot.snapshotId };
  }

  listFiles(options: {
    repoId?: string;
    bucket?: GitFileBucket;
    buckets?: GitFileBucket[];
    cursor?: string;
    limit?: number;
  }) {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      return { snapshotId: null as string | null, items: [], nextCursor: null, total: 0 };
    }

    let repoId = options.repoId;
    let bucket = options.bucket;
    let buckets = options.buckets;
    let offset = 0;

    if (options.cursor) {
      const decoded = decodeFileListCursor(options.cursor);
      if (!decoded) {
        throw new Error('Invalid cursor');
      }
      offset = decoded.offset;
      repoId = repoId ?? decoded.repoId;
      bucket = bucket ?? decoded.bucket;
      buckets = buckets ?? decoded.buckets;
    }

    const page = paginateFiles(
      snapshot.files,
      repoId,
      bucket,
      offset,
      options.limit ?? DEFAULT_FILE_PAGE_SIZE,
      buckets,
    );
    return {
      snapshotId: snapshot.snapshotId,
      items: page.items,
      nextCursor: page.nextCursor,
      total: page.total,
    };
  }

  async getDiff(options: {
    fileId: string;
    snapshotId?: string;
    stage?: GitDiffStageView;
    hunkCursor?: string;
    limit?: number;
  }): Promise<GitDiffResponse> {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      throw new Error('No git snapshot available');
    }
    if (options.snapshotId && options.snapshotId !== snapshot.snapshotId) {
      throw new Error(GIT_SNAPSHOT_STALE_ERROR);
    }

    const file = findFileInSnapshot(snapshot, options.fileId);
    if (!file) {
      throw new Error('Unknown fileId');
    }

    const effectiveStage = resolveDiffStage(file, options.stage);

    if (file.isBinary) {
      return {
        snapshotId: snapshot.snapshotId,
        repoId: file.repoId,
        fileId: file.fileId,
        path: file.path,
        stageView: effectiveStage,
        language: languageFromPath(file.path),
        isBinary: true,
        isLarge: file.isLarge,
        summary: { insertions: 0, deletions: 0, hunksTotal: 0 },
        chunks: [],
        pagination: { returnedHunks: 0, remainingHunks: 0, nextHunkCursor: null },
      };
    }

    const cacheKey = `${snapshot.snapshotId}|${file.fileId}|${effectiveStage}`;
    let cached = this.diffCache.get(cacheKey);
    if (!cached || cached.snapshotId !== snapshot.snapshotId) {
      const actionResult = await this.extensionBridge.requestGitAction({
        requestId: `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        requestedAt: Date.now(),
        action: 'diff',
        repoId: file.repoId,
        path: file.path,
        stage: effectiveStage,
        bucket: file.bucket,
      });
      if (!actionResult.ok) {
        throw new Error(actionResult.error || 'Diff request failed');
      }
      const diffText = actionResult.diffText ?? '';
      const isBinary = actionResult.isBinary === true || diffText.startsWith('Binary files');
      const chunks = isBinary ? [] : parseUnifiedDiff(diffText);
      cached = {
        snapshotId: snapshot.snapshotId,
        chunks,
        summary: summarizeDiff(chunks),
        isBinary,
        cachedAt: Date.now(),
      };
      this.diffCache.set(cacheKey, cached);
      this.trimDiffCache();
    }

    const page = paginateDiffChunks(
      cached.chunks,
      options.hunkCursor,
      options.limit ?? DEFAULT_HUNK_PAGE_SIZE,
    );

    return {
      snapshotId: snapshot.snapshotId,
      repoId: file.repoId,
      fileId: file.fileId,
      path: file.path,
      stageView: effectiveStage,
      language: languageFromPath(file.path),
      isBinary: cached.isBinary,
      isLarge: file.isLarge,
      summary: cached.summary,
      chunks: page.chunks,
      pagination: {
        returnedHunks: page.chunks.length,
        remainingHunks: page.remainingHunks,
        nextHunkCursor: page.nextHunkCursor,
      },
    };
  }

  async getContent(options: {
    fileId: string;
    snapshotId?: string;
  }): Promise<GitFileContentResponse> {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      throw new Error('No git snapshot available');
    }
    if (options.snapshotId && options.snapshotId !== snapshot.snapshotId) {
      throw new Error(GIT_SNAPSHOT_STALE_ERROR);
    }

    const file = findFileInSnapshot(snapshot, options.fileId);
    if (!file) {
      throw new Error('Unknown fileId');
    }

    if (file.isBinary) {
      return {
        snapshotId: snapshot.snapshotId,
        repoId: file.repoId,
        fileId: file.fileId,
        path: file.path,
        language: languageFromPath(file.path),
        isBinary: true,
        isLarge: file.isLarge,
        truncated: false,
        content: '',
        byteLength: 0,
      };
    }

    const actionResult = await this.extensionBridge.requestGitAction({
      requestId: `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedAt: Date.now(),
      action: 'content',
      repoId: file.repoId,
      path: file.path,
      bucket: file.bucket,
    });
    if (!actionResult.ok) {
      throw new Error(actionResult.error || 'Content request failed');
    }

    const isBinary = actionResult.isBinary === true;
    return {
      snapshotId: snapshot.snapshotId,
      repoId: file.repoId,
      fileId: file.fileId,
      path: file.path,
      language: languageFromPath(file.path),
      isBinary,
      isLarge: file.isLarge || actionResult.truncated === true,
      truncated: actionResult.truncated === true,
      content: isBinary ? '' : (actionResult.contentText ?? ''),
      byteLength: actionResult.byteLength ?? 0,
    };
  }

  async stageFiles(fileIds: string[], requestId: string): Promise<GitStageResponse> {
    return this.mutateFiles(fileIds, requestId, 'stage');
  }

  async unstageFiles(fileIds: string[], requestId: string): Promise<GitStageResponse> {
    return this.mutateFiles(fileIds, requestId, 'unstage');
  }

  async refresh(requestId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.extensionBridge.requestGitAction({
      requestId,
      requestedAt: Date.now(),
      action: 'refresh',
    });
    if (!result.ok) {
      return { ok: false, error: result.error || 'Refresh failed' };
    }
    this.diffCache.clear();
    return { ok: true };
  }

  invalidateDiffCache(snapshotId?: string): void {
    if (!snapshotId) {
      this.diffCache.clear();
      return;
    }
    for (const [key, entry] of this.diffCache) {
      if (entry.snapshotId === snapshotId) {
        this.diffCache.delete(key);
      }
    }
  }

  private async mutateFiles(
    fileIds: string[],
    requestId: string,
    action: 'stage' | 'unstage',
  ): Promise<GitStageResponse> {
    const snapshot = this.getSnapshot();
    if (!snapshot) {
      return { ok: false, requestId, affected: [], error: 'No git snapshot available' };
    }

    const grouped = new Map<string, string[]>();
    for (const fileId of fileIds) {
      const parsed = parseFileId(fileId);
      if (!parsed) {
        return { ok: false, requestId, affected: [], error: `Invalid fileId: ${fileId}` };
      }
      const file = findFileInSnapshot(snapshot, fileId);
      if (!file) {
        return { ok: false, requestId, affected: [], error: `Unknown fileId: ${fileId}` };
      }
      if (file.isConflict) {
        return { ok: false, requestId, affected: [], error: `Cannot ${action} conflict file: ${fileId}` };
      }
      const paths = grouped.get(parsed.repoId) ?? [];
      paths.push(file.path);
      grouped.set(parsed.repoId, paths);
    }

    const affected: string[] = [];
    const repoIds = [...grouped.keys()];
    for (let index = 0; index < repoIds.length; index += 1) {
      const repoId = repoIds[index]!;
      const paths = grouped.get(repoId) ?? [];
      const result = await this.extensionBridge.requestGitAction({
        requestId: `${requestId}-${repoId}`,
        requestedAt: Date.now(),
        action,
        repoId,
        paths,
      });
      if (!result.ok) {
        const partial = affected.length > 0;
        return {
          ok: false,
          requestId,
          affected,
          partial,
          error: partial
            ? `${action} partially applied before failure in ${repoId}: ${result.error || `${action} failed`}`
            : result.error || `${action} failed`,
        };
      }
      affected.push(...(result.affected ?? paths));
    }

    this.diffCache.clear();
    return { ok: true, requestId, affected };
  }

  private trimDiffCache(): void {
    if (this.diffCache.size <= this.maxDiffCacheEntries) return;
    const oldest = [...this.diffCache.entries()]
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
      .slice(0, this.diffCache.size - this.maxDiffCacheEntries);
    for (const [key] of oldest) {
      this.diffCache.delete(key);
    }
  }
}
