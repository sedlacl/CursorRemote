import * as vscode from 'vscode';
import type { GitActionRequest, GitActionResult, GitFileBucket } from '../../src/shared/git-scm.js';
import type { GitDiffStageView } from '../../src/shared/git-scm.js';
import { GIT_FILE_CONTENT_MAX_BYTES } from '../../src/shared/git-scm.js';
import { buildNewFileUnifiedDiff } from '../../src/shared/git-diff-parser.js';
import { repoIdFromRootUri } from '../../src/shared/git-repo-id.js';
import { resolveRepositories, type GitRepoLike } from '../../src/shared/git-snapshot.js';
import type { GitSnapshotProvider } from './git-snapshot-provider.js';
import type { UnifiedOutputChannel } from './output-channel.js';

interface GitRepository {
  rootUri: vscode.Uri;
  add?(resources: string[] | vscode.Uri[], opts?: { update?: boolean }): Promise<void>;
  restore?(resources: string[] | vscode.Uri[], options?: { staged?: boolean }): Promise<void>;
  revert?(resources: string[] | vscode.Uri[]): Promise<void>;
  diffWithHEAD?(path: string): Promise<string>;
  diffIndexWithHEAD?(path: string): Promise<string>;
  state: {
    indexChanges: Array<{ uri: vscode.Uri }>;
    workingTreeChanges: Array<{ uri: vscode.Uri }>;
    untrackedChanges?: Array<{ uri: vscode.Uri }>;
    mergeChanges: Array<{ uri: vscode.Uri }>;
  };
}

interface GitExtensionApi {
  repositories: GitRepository[];
}

export class GitActionExecutor {
  constructor(
    private readonly snapshotProvider: GitSnapshotProvider,
    private readonly resolveWorkspaceFolderPath: () => string | null,
    private readonly outputChannel: UnifiedOutputChannel,
  ) {}

  async execute(request: GitActionRequest): Promise<GitActionResult> {
    const base: GitActionResult = {
      requestId: request.requestId,
      ok: false,
      completedAt: Date.now(),
    };

    try {
      switch (request.action) {
        case 'refresh':
          await this.snapshotProvider.explicitRefresh('explicit-refresh');
          return { ...base, ok: true };
        case 'diff':
          return await this.executeDiff(request, base);
        case 'content':
          return await this.executeContent(request, base);
        case 'stage':
          return await this.executeStage(request, base, true);
        case 'unstage':
          return await this.executeStage(request, base, false);
        default:
          return { ...base, error: `Unknown action: ${String((request as GitActionRequest).action)}` };
      }
    } catch (err) {
      const debug = this.describeError(err);
      return {
        ...base,
        error: this.errorSummary(err),
        debug,
      };
    }
  }

  private resolveRepo(repoId: string): GitRepository | null {
    const gitApi = this.snapshotProvider.getGitApiSync();
    if (!gitApi) return null;

    const repoLikes: GitRepoLike[] = gitApi.repositories.map(repo => ({
      rootUri: repo.rootUri.toString(),
      state: repo.state,
    }));
    const resolved = resolveRepositories(repoLikes, this.resolveWorkspaceFolderPath());
    const resolvedUris = new Set(resolved.map(repo => repo.rootUri));
    const repositories = gitApi.repositories.filter(
      repo => resolvedUris.has(repo.rootUri.toString()) || resolvedUris.has(repo.rootUri.fsPath),
    );

    for (const repo of repositories) {
      if (repoIdFromRootUri(repo.rootUri.toString()) === repoId) {
        return repo;
      }
    }
    return null;
  }

  private normalizeRepoPath(path: string): string {
    return String(path).replace(/\\/g, '/');
  }

  private relativePathFromRepoUri(repo: GitRepository, uri: vscode.Uri): string {
    const root = repo.rootUri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const file = uri.fsPath.replace(/\\/g, '/');
    if (file.length >= root.length + 2 && file.slice(0, root.length).toLowerCase() === root.toLowerCase() && file[root.length] === '/') {
      return file.slice(root.length + 1);
    }
    return this.normalizeRepoPath(vscode.workspace.asRelativePath(uri, false));
  }

  private resolveResourceUri(repo: GitRepository, relativePath: string): vscode.Uri {
    const target = this.normalizeRepoPath(relativePath);
    const collections = [
      repo.state.indexChanges,
      repo.state.workingTreeChanges,
      repo.state.untrackedChanges ?? [],
      repo.state.mergeChanges,
    ];
    for (const changes of collections) {
      for (const change of changes) {
        const uri = change.uri;
        if (!uri) continue;
        if (this.relativePathFromRepoUri(repo, uri) === target) {
          return uri;
        }
      }
    }
    return this.pathToUri(repo, target);
  }

  private isPathTypeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('replace is not a function')
      || msg.includes('.fsPath')
      || msg.includes('sanitizeRelativePath');
  }

  private errorSummary(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
  }

  private describeError(err: unknown): string[] {
    const lines: string[] = [];
    if (err instanceof Error) {
      lines.push(`name=${err.name}`);
      if (err.message) lines.push(`message=${err.message}`);
      const withFields = err as Error & {
        code?: string;
        debug?: string[];
        gitErrorCode?: string;
        stderr?: string;
        stdout?: string;
        stack?: string;
      };
      if (Array.isArray(withFields.debug)) {
        lines.push(...withFields.debug);
      }
      if (withFields.code) lines.push(`code=${withFields.code}`);
      if (withFields.gitErrorCode) lines.push(`gitErrorCode=${withFields.gitErrorCode}`);
      if (typeof withFields.stderr === 'string' && withFields.stderr.trim()) {
        lines.push(`stderr=${withFields.stderr.trim()}`);
      }
      if (typeof withFields.stdout === 'string' && withFields.stdout.trim()) {
        lines.push(`stdout=${withFields.stdout.trim()}`);
      }
      if (withFields.stack) {
        const stackLines = withFields.stack.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 6);
        lines.push(...stackLines.map(line => `stack=${line}`));
      }
      return lines;
    }

    if (typeof err === 'object' && err !== null) {
      for (const [key, value] of Object.entries(err)) {
        lines.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
      if (lines.length > 0) return lines;
    }

    return [`raw=${String(err)}`];
  }

  private makeDebugError(summary: string, debug: string[]): Error & { debug: string[] } {
    const error = new Error(summary) as Error & { debug: string[] };
    error.debug = debug;
    return error;
  }

  private logAttempt(requestId: string, message: string): void {
    this.outputChannel.info(`[git-action:${requestId}] ${message}`);
  }

  private async addResources(repo: GitRepository, relativePaths: string[]): Promise<void> {
    if (!repo.add) {
      throw new Error('Git add API unavailable');
    }
    const paths = relativePaths.map(path => this.normalizeRepoPath(path));
    const uris = paths.map(path => this.resolveResourceUri(repo, path));
    const absolutePaths = uris.map(uri => uri.fsPath);

    try {
      this.logAttempt('stage', `repo.add(absPaths) paths=${JSON.stringify(absolutePaths)}`);
      await repo.add(absolutePaths);
      return;
    } catch (err) {
      const firstDebug = this.describeError(err);
      this.outputChannel.warn(`[git-action:stage] repo.add(absPaths) failed: ${firstDebug.join(' | ')}`);
      if (!this.isPathTypeError(err)) {
        throw this.makeDebugError(this.errorSummary(err), [
          'attempt=repo.add(absPaths)',
          ...firstDebug,
        ]);
      }

      try {
        this.logAttempt('stage', `repo.add(uris) uris=${JSON.stringify(uris.map(uri => uri.toString()))}`);
        await repo.add(uris);
        return;
      } catch (fallbackErr) {
        const fallbackDebug = this.describeError(fallbackErr);
        this.outputChannel.warn(
          `[git-action:stage] repo.add(uris) failed: ${fallbackDebug.join(' | ')}`,
        );
        throw this.makeDebugError(this.errorSummary(fallbackErr), [
          'attempt=repo.add(absPaths)',
          ...firstDebug,
          'attempt=repo.add(uris)',
          ...fallbackDebug,
        ]);
      }
    }
  }

  private async unstageResources(repo: GitRepository, relativePaths: string[]): Promise<void> {
    const paths = relativePaths.map(path => this.normalizeRepoPath(path));
    const uris = paths.map(path => this.resolveResourceUri(repo, path));
    const absolutePaths = uris.map(uri => uri.fsPath);

    if (repo.restore) {
      try {
        this.logAttempt('unstage', `repo.restore(absPaths) paths=${JSON.stringify(absolutePaths)}`);
        await repo.restore(absolutePaths, { staged: true });
        return;
      } catch (err) {
        const firstDebug = this.describeError(err);
        this.outputChannel.warn(`[git-action:unstage] repo.restore(absPaths) failed: ${firstDebug.join(' | ')}`);
        if (!this.isPathTypeError(err)) {
          throw this.makeDebugError(this.errorSummary(err), [
            'attempt=repo.restore(absPaths)',
            ...firstDebug,
          ]);
        }

        try {
          this.logAttempt('unstage', `repo.restore(uris) uris=${JSON.stringify(uris.map(uri => uri.toString()))}`);
          await repo.restore(uris, { staged: true });
          return;
        } catch (fallbackErr) {
          const fallbackDebug = this.describeError(fallbackErr);
          this.outputChannel.warn(
            `[git-action:unstage] repo.restore(uris) failed: ${fallbackDebug.join(' | ')}`,
          );
          throw this.makeDebugError(this.errorSummary(fallbackErr), [
            'attempt=repo.restore(absPaths)',
            ...firstDebug,
            'attempt=repo.restore(uris)',
            ...fallbackDebug,
          ]);
        }
      }
    }

    if (repo.revert) {
      try {
        this.logAttempt('unstage', `repo.revert(absPaths) paths=${JSON.stringify(absolutePaths)}`);
        await repo.revert(absolutePaths);
        return;
      } catch (err) {
        const firstDebug = this.describeError(err);
        this.outputChannel.warn(`[git-action:unstage] repo.revert(absPaths) failed: ${firstDebug.join(' | ')}`);
        if (!this.isPathTypeError(err)) {
          throw this.makeDebugError(this.errorSummary(err), [
            'attempt=repo.revert(absPaths)',
            ...firstDebug,
          ]);
        }
      }

      this.logAttempt('unstage', `repo.revert(uris) uris=${JSON.stringify(uris.map(uri => uri.toString()))}`);
      await repo.revert(uris);
      return;
    }

    throw new Error('Git unstage API unavailable');
  }

  private pathToUri(repo: GitRepository, relativePath: string): vscode.Uri {
    const segments = this.normalizeRepoPath(relativePath).split('/').filter(Boolean);
    return vscode.Uri.joinPath(repo.rootUri, ...segments);
  }

  private looksBinary(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length, 8000);
    for (let i = 0; i < limit; i += 1) {
      if (bytes[i] === 0) return true;
    }
    return false;
  }

  private async readWorkingFileDiff(
    repo: GitRepository,
    relativePath: string,
    base: GitActionResult,
  ): Promise<GitActionResult> {
    const uri = this.pathToUri(repo, relativePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (this.looksBinary(bytes)) {
      return {
        ...base,
        ok: true,
        diffText: 'Binary files differ\n',
        isBinary: true,
      };
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    return {
      ...base,
      ok: true,
      diffText: buildNewFileUnifiedDiff(relativePath, content),
      isBinary: false,
    };
  }

  private async executeContent(
    request: GitActionRequest,
    base: GitActionResult,
  ): Promise<GitActionResult> {
    if (!request.repoId || !request.path) {
      return { ...base, error: 'Missing repoId or path' };
    }
    const repo = this.resolveRepo(request.repoId);
    if (!repo) {
      return { ...base, error: 'Repository not found' };
    }

    const relativePath = this.normalizeRepoPath(String(request.path));
    try {
      const uri = this.pathToUri(repo, relativePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (this.looksBinary(bytes)) {
        return {
          ...base,
          ok: true,
          isBinary: true,
          contentText: '',
          byteLength: bytes.length,
          truncated: false,
        };
      }

      const truncated = bytes.length > GIT_FILE_CONTENT_MAX_BYTES;
      const slice = truncated ? bytes.subarray(0, GIT_FILE_CONTENT_MAX_BYTES) : bytes;
      const contentText = new TextDecoder('utf-8').decode(slice);
      return {
        ...base,
        ok: true,
        isBinary: false,
        contentText,
        byteLength: bytes.length,
        truncated,
      };
    } catch (err) {
      return {
        ...base,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeDiff(
    request: GitActionRequest,
    base: GitActionResult,
  ): Promise<GitActionResult> {
    if (!request.repoId || !request.path) {
      return { ...base, error: 'Missing repoId or path' };
    }
    const repo = this.resolveRepo(request.repoId);
    if (!repo) {
      return { ...base, error: 'Repository not found' };
    }

    const relativePath = this.normalizeRepoPath(String(request.path));
    const stage: GitDiffStageView = request.stage === 'index' ? 'index' : 'working';
    const bucket = request.bucket as GitFileBucket | undefined;

    if (bucket === 'untracked') {
      try {
        return await this.readWorkingFileDiff(repo, relativePath, base);
      } catch (err) {
        return {
          ...base,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    let diffText = '';
    if (stage === 'index' && repo.diffIndexWithHEAD) {
      diffText = await repo.diffIndexWithHEAD(relativePath);
    } else if (repo.diffWithHEAD) {
      diffText = await repo.diffWithHEAD(relativePath);
    } else if (repo.diffIndexWithHEAD && stage === 'index') {
      diffText = await repo.diffIndexWithHEAD(relativePath);
    } else {
      return { ...base, error: 'Git diff API unavailable' };
    }

    if (!diffText.trim()) {
      try {
        return await this.readWorkingFileDiff(repo, relativePath, base);
      } catch (err) {
        return {
          ...base,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const isBinary = diffText.startsWith('Binary files') || diffText.includes('GIT binary patch');
    return {
      ...base,
      ok: true,
      diffText,
      isBinary,
    };
  }

  private async executeStage(
    request: GitActionRequest,
    base: GitActionResult,
    stage: boolean,
  ): Promise<GitActionResult> {
    if (!request.repoId || !request.paths?.length) {
      return { ...base, error: 'Missing repoId or paths' };
    }
    const repo = this.resolveRepo(request.repoId);
    if (!repo) {
      return { ...base, error: 'Repository not found' };
    }

    const paths = request.paths.map(path => this.normalizeRepoPath(String(path)));
    this.logAttempt(
      request.requestId,
      `${stage ? 'stage' : 'unstage'} repo=${request.repoId} root=${repo.rootUri.fsPath} paths=${JSON.stringify(paths)}`,
    );

    if (stage) {
      await this.addResources(repo, paths);
    } else {
      await this.unstageResources(repo, paths);
    }

    return {
      ...base,
      ok: true,
      affected: paths,
    };
  }
}
