export type ConversationRelationSource = 'storage' | 'open_subagent' | 'extraction';

export interface ConversationRelationEdge {
  childComposerId: string;
  childWindowId: string;
  parentComposerId: string;
  parentWindowId: string;
  parentTitle?: string;
  rootOrchestratorComposerId: string;
  depth: number;
  source: ConversationRelationSource;
  updatedAt: number;
  openSubagentItemId?: string;
}

function edgeKey(windowId: string, childComposerId: string): string {
  return `${windowId}:${childComposerId}`;
}

export class ConversationRelationRegistry {
  private readonly edges = new Map<string, ConversationRelationEdge>();

  recordEdge(edge: ConversationRelationEdge): boolean {
    if (!edge.childComposerId || !edge.parentComposerId) return false;
    if (edge.childComposerId === edge.parentComposerId) return false;
    if (this.wouldCreateCycle(edge.childComposerId, edge.parentComposerId, edge.childWindowId)) {
      return false;
    }
    this.edges.set(edgeKey(edge.childWindowId, edge.childComposerId), {
      ...edge,
      updatedAt: edge.updatedAt || Date.now(),
    });
    return true;
  }

  resolveParent(childComposerId: string, windowId: string): ConversationRelationEdge | null {
    if (!childComposerId || !windowId) return null;
    return this.edges.get(edgeKey(windowId, childComposerId)) ?? null;
  }

  getEdge(childComposerId: string, windowId: string): ConversationRelationEdge | null {
    return this.resolveParent(childComposerId, windowId);
  }

  listEdges(): ConversationRelationEdge[] {
    return Array.from(this.edges.values());
  }

  upsertFromStorage(params: {
    childComposerId: string;
    childWindowId: string;
    parentComposerId: string;
    parentWindowId: string;
    parentTitle?: string;
    rootOrchestratorComposerId: string;
    depth: number;
  }): boolean {
    return this.recordEdge({
      childComposerId: params.childComposerId,
      childWindowId: params.childWindowId,
      parentComposerId: params.parentComposerId,
      parentWindowId: params.parentWindowId,
      parentTitle: params.parentTitle,
      rootOrchestratorComposerId: params.rootOrchestratorComposerId,
      depth: params.depth,
      source: 'storage',
      updatedAt: Date.now(),
    });
  }

  pruneStale(validComposerIds: ReadonlySet<string>): void {
    for (const [key, edge] of this.edges) {
      if (
        !validComposerIds.has(edge.childComposerId)
        || !validComposerIds.has(edge.parentComposerId)
      ) {
        this.edges.delete(key);
      }
    }
  }

  private wouldCreateCycle(childComposerId: string, parentComposerId: string, windowId: string): boolean {
    const visited = new Set<string>();
    let current: string | undefined = parentComposerId;
    while (current) {
      if (current === childComposerId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.resolveParent(current, windowId)?.parentComposerId;
    }
    return false;
  }
}

export function computeDepthFromParentChain(
  composerId: string,
  windowId: string,
  resolveParentId: (childComposerId: string) => string | undefined,
): number {
  let depth = 0;
  let current: string | undefined = composerId;
  const visited = new Set<string>();
  while (current) {
    const parentId = resolveParentId(current);
    if (!parentId || visited.has(current)) break;
    visited.add(current);
    depth += 1;
    current = parentId;
  }
  return depth;
}
