import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CursorState } from '../../../server/types.js';
import type { GitFileBucket, GitFileSummary, GitRepoSummary } from '../../../shared/git-scm.js';
import { fetchGitFiles, refreshGitSnapshot, stageGitFiles, unstageGitFiles } from '../../services/gitApi.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import { getVisibleGitStatus } from '../../view-models/backgroundTasks.js';
import { newCommandId } from '../../utils/commandIds.js';
import { GitFileRow } from './GitFileRow.js';

type GitSegment = 'staged' | 'changes' | 'conflicts';

function segmentBucket(segment: GitSegment): GitFileBucket {
  if (segment === 'staged') return 'staged';
  if (segment === 'conflicts') return 'conflicts';
  return 'changes';
}

function segmentBuckets(segment: GitSegment): GitFileBucket[] | undefined {
  if (segment === 'changes') return ['changes', 'untracked'];
  return undefined;
}

function filesForSegment(files: GitFileSummary[], segment: GitSegment, repoId: string | null): GitFileSummary[] {
  let filtered = repoId ? files.filter(file => file.repoId === repoId) : files;
  if (segment === 'staged') {
    filtered = filtered.filter(file => file.bucket === 'staged');
  } else if (segment === 'conflicts') {
    filtered = filtered.filter(file => file.bucket === 'conflicts');
  } else {
    filtered = filtered.filter(file => file.bucket === 'changes' || file.bucket === 'untracked');
  }
  return filtered;
}

export interface GitReviewSheetProps {
  state: CursorState;
  visible: boolean;
}

export function GitReviewSheet({ state, visible }: GitReviewSheetProps) {
  const ui = useUiState();
  const command = useCommandClient();
  const gitStatus = getVisibleGitStatus(state);
  const snapshot = state.gitScm;
  const repos = snapshot?.repos ?? [];
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [segment, setSegment] = useState<GitSegment>('changes');
  const [displayFiles, setDisplayFiles] = useState<GitFileSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const activeRepoId = selectedRepoId ?? repos[0]?.repoId ?? null;
  const activeRepo = useMemo(
    () => repos.find(item => item.repoId === activeRepoId) ?? null,
    [activeRepoId, repos],
  );

  const counts = useMemo(
    () => activeRepo?.counts ?? { staged: 0, changes: 0, conflicts: 0, untracked: 0 },
    [activeRepo],
  );

  const loadFiles = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    try {
      const response = await fetchGitFiles({
        repoId: activeRepoId ?? undefined,
        bucket: segmentBuckets(segment) ? undefined : segmentBucket(segment),
        buckets: segmentBuckets(segment),
        limit: 100,
      });
      setDisplayFiles(response.items);
    } catch (err) {
      ui.showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [activeRepoId, segment, ui, visible]);

  useEffect(() => {
    if (!visible) return;
    if (snapshot?.files?.length) {
      setDisplayFiles(filesForSegment(snapshot.files, segment, activeRepoId));
      return;
    }
    void loadFiles();
  }, [
    activeRepoId,
    loadFiles,
    segment,
    snapshot?.files,
    snapshot?.snapshotId,
    snapshot?.updatedAt,
    visible,
  ]);

  const handleRefresh = async () => {
    const result = await refreshGitSnapshot(newCommandId());
    if (!result.ok) {
      ui.showToast(result.error || 'Refresh failed', 'error');
      return;
    }
    ui.showToast('Git refresh requested', 'success');
    await loadFiles();
  };

  const handleStage = async (file: GitFileSummary) => {
    try {
      const result = await stageGitFiles([file.fileId], newCommandId());
      if (!result.ok) {
        ui.showToast(result.error || 'Stage failed', 'error');
        return;
      }
      ui.showToast('Staged', 'success');
      await refreshGitSnapshot(newCommandId()).catch(() => undefined);
      await loadFiles();
    } catch (err) {
      ui.showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleUnstage = async (file: GitFileSummary) => {
    try {
      const result = await unstageGitFiles([file.fileId], newCommandId());
      if (!result.ok) {
        ui.showToast(result.error || 'Unstage failed', 'error');
        return;
      }
      ui.showToast('Unstaged', 'success');
      await refreshGitSnapshot(newCommandId()).catch(() => undefined);
      await loadFiles();
    } catch (err) {
      ui.showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const openInCursor = async () => {
    const result = await command.sendCommandAwaitResult('command:open_source_control');
    if (!result.ok) {
      ui.showToast(result.error || 'Failed to open Source Control', 'error');
    }
  };

  return (
    <div id="sheet-git-review" className={`bottom-sheet git-review-sheet ${visible ? '' : 'hidden'}`}>
      <div className="sheet-header git-review-header">
        <span>Git Review</span>
        <div className="git-review-header-actions">
          <button type="button" className="git-review-icon-btn" aria-label="Refresh git" onClick={() => void handleRefresh()}>
            ↻
          </button>
          <button type="button" className="git-review-icon-btn" aria-label="Open in Cursor" onClick={() => void openInCursor()}>
            IDE
          </button>
        </div>
      </div>

      {gitStatus && (
        <div className="git-review-summary">
          <span>
            {gitStatus.repoLabel || activeRepo?.label || 'Repository'}
            {activeRepo?.branch ? ` · ${activeRepo.branch}` : ''}
          </span>
          <span className="git-review-count">F:{gitStatus.changedCount}</span>
        </div>
      )}

      {repos.length > 1 && (
        <div className="git-repo-picker">
          {repos.map((repo: GitRepoSummary) => (
            <button
              key={repo.repoId}
              type="button"
              className={`git-repo-chip ${repo.repoId === activeRepoId ? 'active' : ''}`}
              onClick={() => setSelectedRepoId(repo.repoId)}
            >
              {repo.label}
              {repo.branch ? ` · ${repo.branch}` : ''}
            </button>
          ))}
        </div>
      )}

      <div className="git-segment-bar" role="tablist" aria-label="Git change buckets">
        <button
          type="button"
          role="tab"
          className={`git-segment ${segment === 'staged' ? 'active' : ''}`}
          onClick={() => setSegment('staged')}
        >
          Staged {counts.staged}
        </button>
        <button
          type="button"
          role="tab"
          className={`git-segment ${segment === 'changes' ? 'active' : ''}`}
          onClick={() => setSegment('changes')}
        >
          Changes {counts.changes + counts.untracked}
        </button>
        <button
          type="button"
          role="tab"
          className={`git-segment ${segment === 'conflicts' ? 'active' : ''}`}
          onClick={() => setSegment('conflicts')}
        >
          Conflicts {counts.conflicts}
        </button>
      </div>

      {segment === 'conflicts' && counts.conflicts > 0 && (
        <div className="git-conflict-alert">Merge conflicts detected — resolve in Cursor before staging.</div>
      )}

      <div className="sheet-list git-file-list">
        {loading && displayFiles.length === 0 && (
          <p className="sheet-tab-hint">Loading changed files…</p>
        )}
        {!loading && displayFiles.length === 0 && (
          <p className="sheet-tab-hint">No files in this section.</p>
        )}
        {displayFiles.map(file => (
          <GitFileRow
            key={file.fileId}
            file={file}
            onOpen={target => ui.openGitDiff(target)}
            onStage={handleStage}
            onUnstage={handleUnstage}
          />
        ))}
      </div>
    </div>
  );
}
