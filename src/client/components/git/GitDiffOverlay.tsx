import React, { useCallback, useEffect, useState } from 'react';
import type { GitDiffResponse, GitFileContentResponse, GitFileSummary } from '../../../shared/git-scm.js';
import {
  fetchGitDiff,
  fetchGitFileContent,
  refreshGitSnapshot,
  stageGitFiles,
  unstageGitFiles,
} from '../../services/gitApi.js';
import { newCommandId } from '../../utils/commandIds.js';
import { useUiState } from '../../state/uiState.js';

export interface GitDiffOverlayProps {
  file: GitFileSummary | null;
  snapshotId: string | null;
  onClose: () => void;
}

type ViewMode = 'diff' | 'file';

export function GitDiffOverlay({ file, snapshotId, onClose }: GitDiffOverlayProps) {
  const ui = useUiState();
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [content, setContent] = useState<GitFileContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = useCallback(async (target: GitFileSummary, cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchGitDiff(target.fileId, {
        stage: target.bucket === 'staged' ? 'index' : 'working',
        cursor,
        snapshotId: snapshotId ?? undefined,
      });
      setDiff(prev => {
        if (!cursor || !prev) return response;
        return {
          ...response,
          chunks: [...prev.chunks, ...response.chunks],
          pagination: response.pagination,
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [snapshotId]);

  const loadContent = useCallback(async (target: GitFileSummary) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchGitFileContent(target.fileId, {
        snapshotId: snapshotId ?? undefined,
      });
      setContent(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [snapshotId]);

  useEffect(() => {
    if (!file) {
      setDiff(null);
      setContent(null);
      setError(null);
      setViewMode('diff');
      return;
    }
    setContent(null);
    setViewMode('diff');
    void loadDiff(file);
  }, [file, loadDiff]);

  useEffect(() => {
    if (!file || viewMode !== 'file') return;
    if (content && content.fileId === file.fileId) return;
    void loadContent(file);
  }, [content, file, loadContent, viewMode]);

  if (!file) return null;

  const canMutate = file.bucket !== 'conflicts';

  const handleStageToggle = async () => {
    if (!canMutate) return;
    try {
      const requestId = newCommandId();
      const action = file.bucket === 'staged' ? unstageGitFiles : stageGitFiles;
      const result = await action([file.fileId], requestId);
      if (!result.ok) {
        ui.showToast(result.error || 'Git action failed', 'error');
        return;
      }
      ui.showToast(file.bucket === 'staged' ? 'Unstaged' : 'Staged', 'success');
      await refreshGitSnapshot(newCommandId()).catch(() => undefined);
      onClose();
    } catch (err) {
      ui.showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="git-diff-overlay" role="dialog" aria-modal="true" aria-label={`Diff ${file.displayPath}`}>
      <div className="git-diff-backdrop" onClick={onClose} />
      <div className="git-diff-panel">
        <div className="git-diff-header">
          <button type="button" className="git-diff-back" onClick={onClose} aria-label="Back">
            ←
          </button>
          <div className="git-diff-title-wrap">
            <div className="git-diff-title">{file.displayPath}</div>
            {viewMode === 'diff' && diff && (
              <div className="git-diff-meta">
                +{diff.summary.insertions} -{diff.summary.deletions} · {diff.summary.hunksTotal} hunks
              </div>
            )}
            {viewMode === 'file' && content && !content.isBinary && (
              <div className="git-diff-meta">
                {content.language || 'text'}
                {content.truncated ? ' · truncated' : ''}
              </div>
            )}
          </div>
          {canMutate && (
            <button type="button" className="git-diff-stage-btn" onClick={() => void handleStageToggle()}>
              {file.bucket === 'staged' ? 'Unstage' : 'Stage'}
            </button>
          )}
        </div>

        <div className="git-view-segment-bar" role="tablist" aria-label="Diff or full file">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'diff'}
            className={`git-segment ${viewMode === 'diff' ? 'active' : ''}`}
            onClick={() => setViewMode('diff')}
          >
            Diff
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'file'}
            className={`git-segment ${viewMode === 'file' ? 'active' : ''}`}
            onClick={() => setViewMode('file')}
          >
            File
          </button>
        </div>

        <div className="git-diff-scroll">
          {loading && viewMode === 'diff' && !diff && <p className="git-diff-hint">Loading diff…</p>}
          {loading && viewMode === 'file' && !content && <p className="git-diff-hint">Loading file…</p>}
          {error && <p className="git-diff-error">{error}</p>}

          {viewMode === 'diff' && (
            <>
              {diff?.isBinary && <p className="git-diff-hint">Binary file — no text diff available.</p>}
              {diff?.chunks.map(chunk => (
                <div key={chunk.chunkId} className="git-diff-chunk">
                  <div className="git-diff-hunk-header">
                    @@ -{chunk.oldStart},{chunk.oldLines} +{chunk.newStart},{chunk.newLines} @@
                  </div>
                  {chunk.lines.map((line, index) => (
                    <div
                      key={`${chunk.chunkId}-${index}`}
                      className={`code-block-diff-line code-block-diff-line--${line.kind === 'insert' ? 'add' : line.kind === 'delete' ? 'rem' : 'ctx'}`}
                    >
                      {line.text}
                    </div>
                  ))}
                </div>
              ))}
              {diff?.pagination.nextHunkCursor && (
                <button
                  type="button"
                  className="git-diff-more"
                  disabled={loading}
                  onClick={() => void loadDiff(file, diff.pagination.nextHunkCursor ?? undefined)}
                >
                  Show next hunk
                </button>
              )}
            </>
          )}

          {viewMode === 'file' && content && (
            <>
              {content.isBinary && <p className="git-diff-hint">Binary file — content preview unavailable.</p>}
              {!content.isBinary && content.truncated && (
                <p className="git-diff-hint">Preview truncated to first ~512 KiB.</p>
              )}
              {!content.isBinary && (
                <pre className="git-file-content">{content.content}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
