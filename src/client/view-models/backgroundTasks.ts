import type { BackgroundTask, CursorState } from '../../server/types.js';
import type { GitStatusInfo } from '../../shared/extension-bridge.js';
import type { GitScmSnapshot } from '../../shared/git-scm.js';

export function getVisibleBackgroundTasks(state: CursorState): BackgroundTask[] {
  return state.backgroundTasks || [];
}

const summaryRe = /^(\d+)\s+background\s+(?:terminal|task)s?$/i;
const waitingRe = /^Waiting for (\d+) commands? to finish$/i;

export function isForegroundWaitingBackgroundTask(task: BackgroundTask): boolean {
  return waitingRe.test(task.label.trim());
}

/** Collapsed Cursor chrome row like `2 background tasks` — an aggregate, not an individual job. */
export function isSummaryBackgroundTask(task: BackgroundTask): boolean {
  return summaryRe.test(task.label.trim());
}

export function getBackgroundTaskCount(tasks: BackgroundTask[]): number {
  let maxSummaryCount = 0;
  let maxWaitingCount = 0;
  let detailedCount = 0;

  for (const task of tasks) {
    const label = task.label.trim();
    const summaryMatch = label.match(summaryRe);
    const waitingMatch = label.match(waitingRe);
    if (summaryMatch) {
      maxSummaryCount = Math.max(maxSummaryCount, parseInt(summaryMatch[1], 10));
    } else if (waitingMatch) {
      maxWaitingCount = Math.max(maxWaitingCount, parseInt(waitingMatch[1], 10));
    } else {
      detailedCount++;
    }
  }

  if (maxSummaryCount > 0 || maxWaitingCount > 0) {
    return Math.max(maxSummaryCount + maxWaitingCount, detailedCount, maxSummaryCount, maxWaitingCount);
  }
  return detailedCount;
}

export function getBackgroundTasksForSheet(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter(task => !isForegroundWaitingBackgroundTask(task));
}

export interface BackgroundTasksSheetModel {
  /** Individual jobs only; aggregate summary rows are never listed. */
  rows: BackgroundTask[];
  /** How many jobs Cursor claims exist, from collapsed summary rows. */
  summaryCount: number;
  /** Present while Cursor keeps the job list collapsed behind a chevron. */
  expandSelectorPath?: string;
  /** Cursor reports more jobs than we can list, so the list is known to be partial. */
  incomplete: boolean;
}

export function getBackgroundTasksSheetModel(tasks: BackgroundTask[]): BackgroundTasksSheetModel {
  const visible = getBackgroundTasksForSheet(tasks);
  const rows = visible.filter(task => !isSummaryBackgroundTask(task));
  const summaryRows = visible.filter(isSummaryBackgroundTask);
  const summaryCount = summaryRows.reduce((max, task) => {
    const match = task.label.trim().match(summaryRe);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

  return {
    rows,
    summaryCount,
    expandSelectorPath: summaryRows.find(task => task.expandSelectorPath)?.expandSelectorPath,
    incomplete: summaryCount > rows.length,
  };
}

function gitStatusFromScm(scm: GitScmSnapshot): GitStatusInfo {
  const changedCount = scm.repos.reduce(
    (sum, repo) => sum
      + repo.counts.staged
      + repo.counts.changes
      + repo.counts.untracked
      + repo.counts.conflicts,
    0,
  );
  return {
    available: true,
    changedCount,
    repoLabel: scm.repos[0]?.label,
    updatedAt: scm.updatedAt,
    source: 'vscode.git',
    windowKey: scm.windowKey,
  };
}

export function getVisibleGitStatus(state: CursorState): GitStatusInfo | null {
  if (state.gitStatus?.available) {
    return state.gitStatus;
  }
  if (state.gitScm) {
    return gitStatusFromScm(state.gitScm);
  }
  return null;
}
