import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConversationRelationRegistry,
  type ConversationRelationEdge,
} from '../src/server/conversation-relation-registry.js';

function edge(
  overrides: Partial<ConversationRelationEdge> & Pick<ConversationRelationEdge, 'childComposerId' | 'parentComposerId'>,
): ConversationRelationEdge {
  return {
    childWindowId: 'win-1',
    parentWindowId: 'win-1',
    rootOrchestratorComposerId: 'composer-a',
    depth: 1,
    source: 'storage',
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ConversationRelationRegistry', () => {
  it('resolves A→B→C chain and rejects cycles', () => {
    const registry = new ConversationRelationRegistry();
    assert.equal(registry.recordEdge(edge({
      childComposerId: 'composer-b',
      parentComposerId: 'composer-a',
      depth: 1,
      rootOrchestratorComposerId: 'composer-a',
    })), true);
    assert.equal(registry.recordEdge(edge({
      childComposerId: 'composer-c',
      parentComposerId: 'composer-b',
      depth: 2,
      rootOrchestratorComposerId: 'composer-a',
    })), true);

    assert.equal(registry.resolveParent('composer-c', 'win-1')?.parentComposerId, 'composer-b');
    assert.equal(registry.resolveParent('composer-b', 'win-1')?.parentComposerId, 'composer-a');
    assert.equal(registry.resolveParent('composer-a', 'win-1'), null);

    assert.equal(registry.recordEdge(edge({
      childComposerId: 'composer-a',
      parentComposerId: 'composer-c',
      depth: 3,
    })), false);
  });

  it('prunes stale edges for unknown composer ids', () => {
    const registry = new ConversationRelationRegistry();
    registry.recordEdge(edge({
      childComposerId: 'composer-b',
      parentComposerId: 'composer-a',
    }));
    registry.pruneStale(new Set(['composer-a', 'composer-b']));
    assert.ok(registry.resolveParent('composer-b', 'win-1'));

    registry.pruneStale(new Set(['composer-a']));
    assert.equal(registry.resolveParent('composer-b', 'win-1'), null);
  });
});
