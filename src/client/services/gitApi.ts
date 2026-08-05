import type {
  GitDiffResponse,
  GitFileBucket,
  GitFileContentResponse,
  GitFileSummary,
  GitRepoSummary,
} from '../../shared/git-scm.js';
import { getAuthToken } from '../state/socketClient.js';

async function gitFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const resp = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText })) as { error?: string };
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export async function fetchGitRepos(): Promise<{ repos: GitRepoSummary[]; snapshotId: string | null }> {
  return gitFetch('/api/git/repos');
}

export async function fetchGitFiles(options: {
  repoId?: string;
  bucket?: GitFileBucket;
  buckets?: GitFileBucket[];
  cursor?: string;
  limit?: number;
}): Promise<{
  snapshotId: string | null;
  items: GitFileSummary[];
  nextCursor: string | null;
  total: number;
}> {
  const params = new URLSearchParams();
  if (options.repoId) params.set('repoId', options.repoId);
  if (options.bucket) params.set('bucket', options.bucket);
  if (options.buckets?.length) params.set('buckets', options.buckets.join(','));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return gitFetch(`/api/git/files${query ? `?${query}` : ''}`);
}

export async function fetchGitDiff(
  fileId: string,
  options?: { stage?: 'working' | 'index'; cursor?: string; snapshotId?: string },
): Promise<GitDiffResponse> {
  const params = new URLSearchParams();
  if (options?.stage) params.set('stage', options.stage);
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.snapshotId) params.set('snapshotId', options.snapshotId);
  const query = params.toString();
  return gitFetch(`/api/git/files/${encodeURIComponent(fileId)}/diff${query ? `?${query}` : ''}`);
}

export async function fetchGitFileContent(
  fileId: string,
  options?: { snapshotId?: string },
): Promise<GitFileContentResponse> {
  const params = new URLSearchParams();
  if (options?.snapshotId) params.set('snapshotId', options.snapshotId);
  const query = params.toString();
  return gitFetch(`/api/git/files/${encodeURIComponent(fileId)}/content${query ? `?${query}` : ''}`);
}

async function gitMutation<T extends { ok: boolean; error?: string }>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const token = getAuthToken();
  const resp = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await resp.json().catch(() => ({
    ok: false,
    error: resp.statusText || `HTTP ${resp.status}`,
  })) as T;
  if (resp.ok) return body;
  if (typeof body === 'object' && body !== null && 'ok' in body) return body;
  throw new Error(body.error || `HTTP ${resp.status}`);
}

export async function stageGitFiles(fileIds: string[], requestId: string): Promise<{ ok: boolean; error?: string }> {
  return gitMutation('/api/git/stage', {
    method: 'POST',
    body: JSON.stringify({ fileIds, requestId }),
  });
}

export async function unstageGitFiles(fileIds: string[], requestId: string): Promise<{ ok: boolean; error?: string }> {
  return gitMutation('/api/git/unstage', {
    method: 'POST',
    body: JSON.stringify({ fileIds, requestId }),
  });
}

export async function refreshGitSnapshot(requestId: string): Promise<{ ok: boolean; error?: string }> {
  return gitMutation('/api/git/refresh', {
    method: 'POST',
    body: JSON.stringify({ requestId }),
  });
}
