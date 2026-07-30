import { cleanTabTitle } from './dom-extractor.js';
import { filterActionableApprovals } from './approval-filter.js';
import type {
  Approval,
  ApprovalAction,
  ChatTab,
  GlobalApprovalNotification,
} from './types.js';
import type { WindowSnapshot } from './window-monitor.js';

export interface ResolvedApprovalTarget {
  approvalId: string;
  windowId: string;
  windowTitle: string;
  composerId: string;
  chatTitle: string;
  tabTitle: string;
  tabSource?: 'open' | 'sidebar';
  actions: ApprovalAction[];
  timestamp: number;
}

function activeChatTitle(chatTabs: ChatTab[]): string {
  const active = chatTabs.find((t) => t.isActive)
    ?? (chatTabs.length === 1 ? chatTabs[0] : undefined);
  return active ? cleanTabTitle(active.title) : '';
}

function resolveTabForComposer(
  chatTabs: ChatTab[],
  composerId: string,
  fallbackTitle: string,
): { tabTitle: string; tabSource?: 'open' | 'sidebar' } {
  if (composerId) {
    const byComposer = chatTabs.find((t) => t.composerId === composerId);
    if (byComposer) {
      return { tabTitle: cleanTabTitle(byComposer.title), tabSource: byComposer.source };
    }
  }
  if (fallbackTitle) {
    const byTitle = chatTabs.find((t) => cleanTabTitle(t.title) === fallbackTitle);
    if (byTitle) {
      return { tabTitle: cleanTabTitle(byTitle.title), tabSource: byTitle.source };
    }
  }
  const active = chatTabs.find((t) => t.isActive);
  if (active) {
    return { tabTitle: cleanTabTitle(active.title), tabSource: active.source };
  }
  return { tabTitle: fallbackTitle };
}

function approvalSummary(approval: Approval): string {
  return approval.title?.trim()
    || approval.command?.trim()
    || approval.description?.trim()
    || 'Pending approval';
}

function enrichApproval(
  approval: Approval,
  windowId: string,
  windowTitle: string,
  activeComposerId: string,
  chatTabs: ChatTab[],
  timestamp: number,
): Approval {
  const composerId = approval.composerId || activeComposerId || '';
  const chatTitle = approval.chatTitle || activeChatTitle(chatTabs);
  return {
    ...approval,
    windowId,
    composerId,
    chatTitle,
    title: approval.title || undefined,
    command: approval.command || undefined,
    description: approval.description || approvalSummary(approval),
  };
}

function toNotification(
  approval: Approval,
  windowTitle: string,
  timestamp: number,
): GlobalApprovalNotification {
  return {
    id: approval.id,
    windowId: approval.windowId || '',
    windowTitle,
    composerId: approval.composerId || '',
    chatTitle: approval.chatTitle || '',
    summary: approvalSummary(approval),
    title: approval.title,
    command: approval.command,
    reason: approval.reason,
    mode: approval.mode,
    timestamp,
  };
}

function toTarget(
  approval: Approval,
  chatTabs: ChatTab[],
  timestamp: number,
): ResolvedApprovalTarget {
  const tab = resolveTabForComposer(
    chatTabs,
    approval.composerId || '',
    approval.chatTitle || '',
  );
  return {
    approvalId: approval.id,
    windowId: approval.windowId || '',
    windowTitle: '',
    composerId: approval.composerId || '',
    chatTitle: approval.chatTitle || tab.tabTitle,
    tabTitle: tab.tabTitle,
    tabSource: tab.tabSource,
    actions: approval.actions,
    timestamp,
  };
}

export function filterContextLocalApprovals(
  approvals: Approval[],
  activeWindowId: string,
  activeComposerId: string,
): Approval[] {
  if (!activeComposerId) return [];
  return approvals.filter((entry) => {
    if (entry.windowId && entry.windowId !== activeWindowId) return false;
    if (entry.composerId && entry.composerId !== activeComposerId) return false;
    return true;
  });
}

export function buildApprovalRegistry(
  snapshots: Map<string, WindowSnapshot>,
): {
  notifications: GlobalApprovalNotification[];
  registry: Map<string, ResolvedApprovalTarget>;
} {
  const registry = new Map<string, ResolvedApprovalTarget>();
  const notifications: GlobalApprovalNotification[] = [];
  const seenIds = new Set<string>();

  for (const [windowId, snap] of snapshots) {
    const timestamp = snap.lastUpdated || Date.now();
    const chatTitle = activeChatTitle(snap.chatTabs);
    for (const raw of filterActionableApprovals(snap.pendingApprovals)) {
      const approval = enrichApproval(
        raw,
        windowId,
        snap.windowTitle,
        snap.activeComposerId,
        snap.chatTabs,
        timestamp,
      );
      if (seenIds.has(approval.id)) continue;
      seenIds.add(approval.id);
      const target = toTarget(approval, snap.chatTabs, timestamp);
      target.windowTitle = snap.windowTitle;
      registry.set(approval.id, target);
      notifications.push(toNotification(approval, snap.windowTitle, timestamp));
    }
  }

  notifications.sort((a, b) => a.timestamp - b.timestamp);
  return { notifications, registry };
}

export function enrichActiveWindowApprovals(
  approvals: Approval[],
  windowId: string,
  windowTitle: string,
  activeComposerId: string,
  chatTabs: ChatTab[],
): Approval[] {
  const chatTitle = activeChatTitle(chatTabs);
  return filterActionableApprovals(approvals).map((entry) =>
    enrichApproval(entry, windowId, windowTitle, activeComposerId, chatTabs, Date.now())
  );
}

export function resolveApprovalActionSelector(
  registry: ReadonlyMap<string, ResolvedApprovalTarget>,
  approvalId: string,
  actionType: ApprovalAction['type'],
): string | undefined {
  const target = registry.get(approvalId);
  if (!target) return undefined;
  const action = target.actions.find((a) => a.type === actionType);
  return action?.selectorPath;
}
