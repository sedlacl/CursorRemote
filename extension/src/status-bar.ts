import * as vscode from 'vscode';
import type { ServerIdentity } from '../../src/shared/diagnostics.js';
import type { GitLocalStatusSummary } from './git-status-display.js';
import { formatGitTooltipLine } from './git-status-display.js';

export interface HealthData {
  ok: boolean;
  connected: boolean;
  agentStatus: string;
  clients: number;
  uptime: number;
  windows: { id: string; title: string }[];
  activeWindowId: string;
  mode: string | null;
  model: string | null;
  chatTabCount: number;
  pendingApprovalCount: number;
  generation: number;
  gitStatus?: { available: boolean; changedCount: number } | null;
  cdpUrl?: string;
  cdpDisconnectReason?: string | null;
  cdpLastError?: string | null;
  server?: ServerIdentity;
  extensionBridge?: { dataDirName: string; dataDirPath: string };
}

export type ServerState = 'running' | 'disconnected' | 'stopped' | 'error';

export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'workbench.action.quickOpen';
  updateStatusBar(item, 'stopped');
  item.show();
  context.subscriptions.push(item);
  return item;
}

export function updateStatusBar(
  item: vscode.StatusBarItem,
  state: ServerState,
  health?: HealthData,
  localGit?: GitLocalStatusSummary | null,
): void {
  switch (state) {
    case 'running':
      item.text = '$(radio-tower) Remote: Running';
      item.backgroundColor = undefined;
      item.color = '#3fa266';
      item.tooltip = buildTooltip(health, localGit);
      item.command = 'cursorRemote.status.focus';
      break;
    case 'disconnected':
      item.text = '$(radio-tower) Remote: Disconnected';
      item.backgroundColor = undefined;
      item.color = '#e5c07b';
      item.tooltip = 'Server running but CDP not connected — click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
    case 'stopped':
      item.text = '$(radio-tower) Remote: Stopped';
      item.backgroundColor = undefined;
      item.color = undefined;
      item.tooltip = 'Click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
    case 'error':
      item.text = '$(radio-tower) Remote: Error';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.color = undefined;
      item.tooltip = 'Server crashed — click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
  }
}

function buildTooltip(health?: HealthData, localGit?: GitLocalStatusSummary | null): string {
  if (!health) return 'Running';
  const lines = [
    health.server
      ? `Server v${health.server.version} :${health.server.port} [${health.server.instanceId}]`
      : 'Server: connected',
    `Clients: ${health.clients}`,
    `Agent: ${health.agentStatus}`,
  ];
  const gitLine = formatGitTooltipLine(localGit ?? null);
  if (gitLine) lines.push(gitLine);
  else if (health.gitStatus?.available) lines.push(`Git changes: ${health.gitStatus.changedCount}`);
  if (health.mode) lines.push(`Mode: ${health.mode}`);
  if (health.model) lines.push(`Model: ${health.model}`);
  const activeWindow = health.windows?.find(w => w.id === health.activeWindowId);
  if (activeWindow) lines.push(`Window: ${activeWindow.title}`);
  if (health.pendingApprovalCount > 0) lines.push(`Pending approvals: ${health.pendingApprovalCount}`);
  return lines.join('\n');
}
