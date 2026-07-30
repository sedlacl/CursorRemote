import type { ConversationRelationRegistry } from './conversation-relation-registry.js';
import type { ComposerStorageRelation, CursorStorageHistory } from './cursor-storage-history.js';

export async function indexStorageRelationsForComposer(
  storage: CursorStorageHistory,
  registry: ConversationRelationRegistry,
  composerId: string,
  windowId: string,
): Promise<ComposerStorageRelation | null> {
  const relation = await storage.loadComposerRelation(composerId);
  if (!relation) return null;

  if (relation.isSubagent && relation.parentComposerId) {
    const parentRelation = await storage.loadComposerRelation(relation.parentComposerId);
    registry.upsertFromStorage({
      childComposerId: relation.composerId,
      childWindowId: windowId,
      parentComposerId: relation.parentComposerId,
      parentWindowId: windowId,
      parentTitle: parentRelation?.name,
      rootOrchestratorComposerId: relation.rootOrchestratorComposerId || relation.parentComposerId,
      depth: relation.depth,
    });
  }

  for (const childId of relation.subagentComposerIds) {
    const childRelation = await storage.loadComposerRelation(childId);
    if (!childRelation?.isSubagent || !childRelation.parentComposerId) continue;
    const parentRelation = await storage.loadComposerRelation(childRelation.parentComposerId);
    registry.upsertFromStorage({
      childComposerId: childRelation.composerId,
      childWindowId: windowId,
      parentComposerId: childRelation.parentComposerId,
      parentWindowId: windowId,
      parentTitle: parentRelation?.name,
      rootOrchestratorComposerId: childRelation.rootOrchestratorComposerId || childRelation.parentComposerId,
      depth: childRelation.depth,
    });
  }

  return relation;
}
