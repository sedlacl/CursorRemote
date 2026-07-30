import { cleanTabTitle } from './dom-extractor.js';
import type { ChatTab, CursorState } from './types.js';
import type { ConversationRelationRegistry, ConversationRelationEdge } from './conversation-relation-registry.js';
import type { ComposerStorageRelation } from './cursor-storage-history.js';

export interface ReturnToParentTarget {
  childComposerId: string;
  parentComposerId: string;
  parentWindowId: string;
  parentTitle: string;
  tabTitle: string;
  tabSource: 'open' | 'sidebar';
}

export function resolveReturnToParentTarget(
  childComposerId: string,
  windowId: string,
  registry: ConversationRelationRegistry,
  loadStorageRelation: (composerId: string) => ComposerStorageRelation | null | Promise<ComposerStorageRelation | null>,
): ReturnToParentTarget | null {
  const normalizedChild = childComposerId?.trim();
  if (!normalizedChild || !windowId) return null;

  let edge: ConversationRelationEdge | null = registry.resolveParent(normalizedChild, windowId);
  if (!edge) {
    const storage = loadStorageRelation(normalizedChild);
    const resolved = storage instanceof Promise ? null : storage;
    if (resolved?.isSubagent && resolved.parentComposerId) {
      edge = {
        childComposerId: normalizedChild,
        childWindowId: windowId,
        parentComposerId: resolved.parentComposerId,
        parentWindowId: windowId,
        parentTitle: undefined,
        rootOrchestratorComposerId: resolved.rootOrchestratorComposerId || resolved.parentComposerId,
        depth: resolved.depth,
        source: 'storage',
        updatedAt: Date.now(),
      };
    }
  }

  if (!edge?.parentComposerId) return null;
  return {
    childComposerId: normalizedChild,
    parentComposerId: edge.parentComposerId,
    parentWindowId: edge.parentWindowId || windowId,
    parentTitle: edge.parentTitle || 'Rodičovská konverzace',
    tabTitle: edge.parentTitle || '',
    tabSource: 'open',
  };
}

export interface ReturnToParentTabMatch {
  tabTitle: string;
  tabSource: 'open' | 'sidebar';
  /** How the tab was located — `none` means the parent is neither an open tab nor a sidebar entry. */
  matchedBy: 'composer' | 'title' | 'none';
}

function titleKey(raw: string): string {
  return cleanTabTitle(raw || '').toLowerCase();
}

/**
 * Sidebar cells carry no composer id in Cursor's DOM, so a parent that is only in the
 * history list can be matched by title alone — but it must keep the tab's real source,
 * otherwise the click is dispatched against the editor tab bar where it does not exist.
 */
export function resolveReturnToParentTab(
  target: ReturnToParentTarget,
  chatTabs: ChatTab[],
): ReturnToParentTabMatch {
  const byComposer = chatTabs.find(tab => tab.composerId === target.parentComposerId);
  if (byComposer) {
    return {
      tabTitle: cleanTabTitle(byComposer.title),
      tabSource: byComposer.source,
      matchedBy: 'composer',
    };
  }

  const wanted = titleKey(target.tabTitle || target.parentTitle);
  if (wanted) {
    const matches = chatTabs.filter(tab => titleKey(tab.title) === wanted);
    const preferred = matches.find(tab => tab.source === 'open') ?? matches[0];
    if (preferred) {
      return {
        tabTitle: cleanTabTitle(preferred.title),
        tabSource: preferred.source,
        matchedBy: 'title',
      };
    }
  }

  return {
    tabTitle: target.tabTitle || target.parentTitle,
    tabSource: target.tabSource,
    matchedBy: 'none',
  };
}

export function parentNotOpenError(parentTitle: string): string {
  const name = parentTitle?.trim() || 'Parent conversation';
  return `Parent chat "${name}" is not open in this Cursor window. Open it in Cursor (chat history / agent sidebar) and try again.`;
}

export function resolveChildComposerAfterOpen(
  before: Pick<CursorState, 'activeComposerId' | 'chatTabs'>,
  after: Pick<CursorState, 'activeComposerId' | 'chatTabs'>,
  matchTitle?: string,
): string | null {
  if (after.activeComposerId && after.activeComposerId !== before.activeComposerId) {
    return after.activeComposerId;
  }
  const normalizedTitle = matchTitle?.trim().toLowerCase();
  if (normalizedTitle) {
    const activeOpen = after.chatTabs.find(tab => tab.isActive && tab.source === 'open');
    if (activeOpen && cleanTabTitle(activeOpen.title).toLowerCase() === normalizedTitle) {
      return activeOpen.composerId;
    }
    const byTitle = after.chatTabs.find(
      tab => tab.source === 'open' && cleanTabTitle(tab.title).toLowerCase() === normalizedTitle,
    );
    if (byTitle) return byTitle.composerId;
  }
  const beforeActive = before.chatTabs.find(tab => tab.isActive)?.composerId;
  const afterActive = after.chatTabs.find(tab => tab.isActive && tab.source === 'open');
  if (afterActive && afterActive.composerId !== beforeActive) return afterActive.composerId;
  return null;
}

export interface ReturnToParentNavigationDeps {
  switchTab: (
    commandId: string,
    tabTitle: string,
    composerId: string,
    tabSource: 'open' | 'sidebar',
  ) => Promise<{ ok: boolean; error?: string }>;
  switchWindow?: (windowId: string) => Promise<void>;
  getActiveComposerId: () => string;
  getActiveWindowId: () => string;
  getChatTabs: () => ChatTab[];
}

export async function executeReturnToParentNavigation(
  commandId: string,
  childComposerId: string | undefined,
  windowId: string,
  registry: ConversationRelationRegistry,
  loadStorageRelation: (composerId: string) => ComposerStorageRelation | null,
  deps: ReturnToParentNavigationDeps,
  options?: { verify?: boolean },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const activeChild = childComposerId?.trim() || deps.getActiveComposerId();
  if (!activeChild) {
    return { ok: false, error: 'No active conversation' };
  }

  const target = resolveReturnToParentTarget(activeChild, windowId, registry, loadStorageRelation);
  if (!target) {
    return { ok: false, error: 'Parent conversation unavailable' };
  }

  const activeWindowId = deps.getActiveWindowId();
  if (target.parentWindowId && target.parentWindowId !== activeWindowId) {
    if (!deps.switchWindow) {
      return { ok: false, error: 'Parent conversation is in another window' };
    }
    await deps.switchWindow(target.parentWindowId);
  }

  const tab = resolveReturnToParentTab(target, deps.getChatTabs());
  if (tab.matchedBy === 'none') {
    return { ok: false, error: parentNotOpenError(target.parentTitle) };
  }
  const tabResult = await deps.switchTab(
    commandId,
    tab.tabTitle,
    target.parentComposerId,
    tab.tabSource,
  );
  if (!tabResult.ok) {
    return { ok: false, error: tabResult.error || 'Failed to switch to parent conversation' };
  }

  if (options?.verify !== false && deps.getActiveComposerId() !== target.parentComposerId) {
    return { ok: false, error: 'Navigation did not reach parent conversation' };
  }

  return { ok: true };
}
