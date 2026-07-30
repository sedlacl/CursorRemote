import { cleanTabTitle } from './dom-extractor.js';
import type { ActiveConversationContext, ChatTab, CursorState } from './types.js';
import type { ConversationRelationRegistry, ConversationRelationEdge } from './conversation-relation-registry.js';
import type { ComposerStorageRelation } from './cursor-storage-history.js';

export type { ActiveConversationContext };

export function activeTabTitle(chatTabs: ChatTab[]): string {
  const active = chatTabs.find(tab => tab.isActive)
    ?? (chatTabs.length === 1 ? chatTabs[0] : undefined);
  return active ? cleanTabTitle(active.title) : '';
}

export function resolveParentTitle(
  parentComposerId: string,
  chatTabs: ChatTab[],
  fallback?: string,
): string | undefined {
  const byComposer = chatTabs.find(tab => tab.composerId === parentComposerId);
  if (byComposer) return cleanTabTitle(byComposer.title);
  return fallback?.trim() || undefined;
}

export function buildActiveConversationContext(
  state: Pick<
    CursorState,
    'activeComposerId' | 'activeWindowId' | 'chatTabs' | 'composerInputAvailable' | 'inputAvailable'
  >,
  registry: ConversationRelationRegistry,
  storageRelation?: ComposerStorageRelation | null,
): ActiveConversationContext | null {
  const composerId = state.activeComposerId?.trim();
  if (!composerId) return null;

  const composerInputAvailable = state.composerInputAvailable ?? state.inputAvailable;
  const windowId = state.activeWindowId;
  let edge: ConversationRelationEdge | null = windowId
    ? registry.resolveParent(composerId, windowId)
    : null;

  if (!edge && storageRelation?.isSubagent && storageRelation.parentComposerId) {
    edge = {
      childComposerId: composerId,
      childWindowId: windowId,
      parentComposerId: storageRelation.parentComposerId,
      parentWindowId: windowId,
      parentTitle: resolveParentTitle(storageRelation.parentComposerId, state.chatTabs),
      rootOrchestratorComposerId: storageRelation.rootOrchestratorComposerId || storageRelation.parentComposerId,
      depth: storageRelation.depth,
      source: 'storage',
      updatedAt: Date.now(),
    };
  }

  if (!edge) {
    return {
      kind: 'orchestrator',
      composerId,
      depth: 0,
      returnToParentAvailable: false,
      composerInputAvailable,
    };
  }

  const parentTitle = edge.parentTitle
    ?? resolveParentTitle(edge.parentComposerId, state.chatTabs);

  return {
    kind: 'subagent',
    composerId,
    depth: edge.depth,
    parentComposerId: edge.parentComposerId,
    parentWindowId: edge.parentWindowId,
    parentTitle,
    rootOrchestratorComposerId: edge.rootOrchestratorComposerId,
    returnToParentAvailable: true,
    composerInputAvailable,
  };
}
