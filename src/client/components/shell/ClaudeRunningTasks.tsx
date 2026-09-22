import React from 'react';
import type { CursorState } from '../../../server/types.js';

export interface ClaudeRunningTasksProps {
  state: CursorState;
}

/**
 * Persistent Running tasks list, shown only while a Claude Code tab is active.
 *
 * The point is not having to type `/tasks` in the Claude panel to see what is
 * running — that command opens a window in the IDE and the relay never sends
 * it. Rows come from the same extractor tick as everything else, so the list
 * updates through the existing `state:patch` with no extra poller.
 *
 * Read-only by design: rows get a stop control only once a probe confirms a
 * real stop path for a background task. A kill button that silently does
 * nothing would be worse than no button.
 *
 * Cursor tabs keep their own composer badge and sheet; this subview is not
 * mixed into them.
 */
export function ClaudeRunningTasks({ state }: ClaudeRunningTasksProps) {
  const activeTab = state.chatTabs.find(tab => tab.isActive);
  if (activeTab?.host !== 'claude-code') return null;

  const tasks = state.backgroundTasks ?? [];
  // Collapsed when empty, so a Claude tab without background bashes does not
  // look like a Cursor tab reporting a hollow "0 tasks".
  if (tasks.length === 0) return null;

  return (
    <section className="claude-running-tasks" aria-label="Running tasks">
      <span className="claude-running-tasks-title">
        Running tasks ({tasks.length})
      </span>
      <ul className="claude-running-tasks-list">
        {tasks.map(task => (
          <li key={task.id} className="claude-running-task">
            <span className="claude-running-task-label" title={task.label}>
              {task.label}
            </span>
            {task.detail && (
              <span className="claude-running-task-status">{task.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
