import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConversationRelationRegistry,
  type ConversationRelationEdge,
} from '../src/server/conversation-relation-registry.js';
import {
  resolveReturnToParentTarget,
  resolveReturnToParentTab,
  executeReturnToParentNavigation,
} from '../src/server/return-to-parent.js';
import type { ComposerStorageRelation } from '../src/server/cursor-storage-history.js';
import type { ChatTab } from '../src/server/types.js';

function chatTab(overrides: Partial<ChatTab> & Pick<ChatTab, 'composerId' | 'title' | 'source'>): ChatTab {
  return {
    isActive: false,
    status: 'idle',
    selectorPath: '',
    workStatus: 'idle',
    ...overrides,
  };
}

function edge(
  overrides: Partial<ConversationRelationEdge> & Pick<ConversationRelationEdge, 'childComposerId' | 'parentComposerId'>,
): ConversationRelationEdge {
  return {
    childWindowId: 'win-1',
    parentWindowId: 'win-1',
    parentTitle: 'Parent chat',
    rootOrchestratorComposerId: 'composer-a',
    depth: 1,
    source: 'storage',
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('return_to_parent target resolution', () => {
  it('resolves parent for grandchild via registry then storage fallback', () => {
    const registry = new ConversationRelationRegistry();
    registry.recordEdge(edge({
      childComposerId: 'composer-b',
      parentComposerId: 'composer-a',
      parentTitle: 'Orchestrator',
      depth: 1,
    }));
    registry.recordEdge(edge({
      childComposerId: 'composer-c',
      parentComposerId: 'composer-b',
      parentTitle: 'Child B',
      depth: 2,
    }));

    const cToB = resolveReturnToParentTarget('composer-c', 'win-1', registry, () => null);
    assert.equal(cToB?.parentComposerId, 'composer-b');
    assert.equal(cToB?.parentTitle, 'Child B');

    const bToA = resolveReturnToParentTarget('composer-b', 'win-1', registry, () => null);
    assert.equal(bToA?.parentComposerId, 'composer-a');
    assert.equal(bToA?.parentTitle, 'Orchestrator');
  });

  it('returns null for unknown child without guessing from title', () => {
    const registry = new ConversationRelationRegistry();
    const storageLoader = (): ComposerStorageRelation | null => null;
    assert.equal(resolveReturnToParentTarget('missing-child', 'win-1', registry, storageLoader), null);
  });
});

describe('return_to_parent tab resolution', () => {
  // Cursor sidebar cells carry no composer id, so the parent tab only matches by title.
  const parentTarget = {
    childComposerId: 'child-1',
    parentComposerId: 'f30f0a3d-2a79-4831-8cf8-091aca056edc',
    parentWindowId: 'win-1',
    parentTitle: 'Kubernetes deployment diagnostics',
    tabTitle: 'Kubernetes deployment diagnostics',
    tabSource: 'open' as const,
  };

  it('matches a sidebar-only parent by title and keeps the sidebar source', () => {
    const tabs = [
      chatTab({ composerId: 'child-1', title: 'Search real infra and firewall repos', source: 'open', isActive: true }),
      chatTab({ composerId: 'tab-17', title: 'Kubernetes deployment diagnostics', source: 'sidebar' }),
    ];

    const tab = resolveReturnToParentTab(parentTarget, tabs);

    assert.equal(tab.matchedBy, 'title');
    assert.equal(tab.tabSource, 'sidebar');
    assert.equal(tab.tabTitle, 'Kubernetes deployment diagnostics');
  });

  it('reports a missing parent instead of guessing an open tab', () => {
    const tabs = [
      chatTab({ composerId: 'child-1', title: 'Search real infra and firewall repos', source: 'open', isActive: true }),
    ];

    assert.equal(resolveReturnToParentTab(parentTarget, tabs).matchedBy, 'none');
  });

  it('prefers the open editor tab when the title exists in both places', () => {
    const tabs = [
      chatTab({ composerId: 'tab-17', title: 'Kubernetes deployment diagnostics', source: 'sidebar' }),
      chatTab({
        composerId: 'f30f0a3d-2a79-4831-8cf8-091aca056edc',
        title: 'Kubernetes deployment diagnostics',
        source: 'open',
      }),
    ];

    const tab = resolveReturnToParentTab(parentTarget, tabs);

    assert.equal(tab.matchedBy, 'composer');
    assert.equal(tab.tabSource, 'open');
  });
});

describe('return_to_parent navigation sequencing', () => {
  it('plans two consecutive parent hops C→B→A by composer id', () => {
    const registry = new ConversationRelationRegistry();
    registry.recordEdge(edge({
      childComposerId: 'composer-b',
      parentComposerId: 'composer-a',
      parentTitle: 'A',
      depth: 1,
    }));
    registry.recordEdge(edge({
      childComposerId: 'composer-c',
      parentComposerId: 'composer-b',
      parentTitle: 'B',
      depth: 2,
    }));

    const hops: string[] = [];
    let current = 'composer-c';
    for (let i = 0; i < 2; i++) {
      const target = resolveReturnToParentTarget(current, 'win-1', registry, () => null);
      assert.ok(target, `hop ${i} should resolve`);
      hops.push(target.parentComposerId);
      current = target.parentComposerId;
    }

    assert.deepEqual(hops, ['composer-b', 'composer-a']);
  });

  it('unknown child yields error and performs no switchTab', async () => {
    const registry = new ConversationRelationRegistry();
    const switchCalls: unknown[] = [];
    const result = await executeReturnToParentNavigation(
      'cmd-1',
      'missing-child',
      'win-1',
      registry,
      () => null,
      {
        switchTab: async (...args) => {
          switchCalls.push(args);
          return { ok: true };
        },
        getActiveComposerId: () => '',
        getActiveWindowId: () => 'win-1',
        getChatTabs: () => [],
      },
      { verify: false },
    );
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    assert.match(result.error, /Parent conversation unavailable/i);
    assert.equal(switchCalls.length, 0);
  });
});
