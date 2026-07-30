import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { extractionFunction } from '../src/server/dom-extractor.js';
import {
  buildApprovalRegistry,
  filterContextLocalApprovals,
  resolveApprovalActionSelector,
} from '../src/server/approval-registry.js';
import type { CursorState } from '../src/server/types.js';
import type { WindowSnapshot } from '../src/server/window-monitor.js';
import { ApprovalBar } from '../src/client/components/decision/ApprovalBar.js';
import { HeaderBar } from '../src/client/components/shell/HeaderBar.js';
import {
  baseCursorState,
  createComponentTestEnv,
} from './helpers/component-test-env.js';

function extract(html: string): CursorState {
  const dom = new JSDOM(html);
  const previous = {
    document: (globalThis as { document?: Document }).document,
    Element: (globalThis as { Element?: typeof Element }).Element,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
  };
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });
  try {
    const state = extractionFunction(
      ['#container'],
      ['button.ui-shell-tool-call__run-btn'],
      ['Run'],
      ['button.ui-shell-tool-call__skip-btn'],
      ['Skip'],
      [],
      [],
      [],
      [],
      [],
    );
    assert.ok(state);
    return state;
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'Element', { value: previous.Element, configurable: true });
    Object.defineProperty(globalThis, 'HTMLElement', { value: previous.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, 'Node', { value: previous.Node, configurable: true });
    dom.window.close();
  }
}

const APPROVAL_FIXTURE = `
  <div id="container" data-composer-id="composer-a">
    <div data-tool-call-id="call-taskkill-59284">
      <div class="ui-shell-tool-call">
        <div class="ui-tool-call-card">
          <div class="ui-tool-call-card__header">
            <span class="ui-shell-tool-call__description">Ukončí visící health-check proces taskkill</span>
          </div>
          <div class="ui-shell-tool-call__command">taskkill /PID 59284 /T /F</div>
          <div class="ui-shell-tool-call__approval-row">
            <span class="ui-shell-tool-call__policy">Auto-review</span>
            <div class="ui-shell-tool-call__reason">This would forcibly terminate a specific local process the user did not ask to kill.</div>
            <button type="button" class="ui-shell-tool-call__skip-btn">Skip</button>
            <button type="button" class="ui-shell-tool-call__run-btn">Run</button>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

describe('approval extraction detail', () => {
  it('preserves title, command, mode, reason and action labels', () => {
    const state = extract(APPROVAL_FIXTURE);
    assert.equal(state.pendingApprovals.length, 1);
    const approval = state.pendingApprovals[0];
    assert.ok(approval);
    assert.equal(approval.title, 'Ukončí visící health-check proces taskkill');
    assert.equal(approval.command, 'taskkill /PID 59284 /T /F');
    assert.equal(approval.mode, 'Auto-review');
    assert.match(approval.reason || '', /forcibly terminate/i);
    assert.notEqual(approval.description, 'Run');
    assert.equal(approval.composerId, 'composer-a');
    assert.deepEqual(
      approval.actions.map((action) => [action.type, action.label]).sort(),
      [['approve', 'Run'], ['reject', 'Skip']],
    );
  });
});

describe('approval provenance filtering', () => {
  it('hides foreign composer approval from local bar but keeps global notification', () => {
    const foreignApproval = {
      id: 'tool:foreign',
      description: 'taskkill /PID 1 /T /F',
      title: 'Foreign task',
      command: 'taskkill /PID 1 /T /F',
      composerId: 'composer-a',
      windowId: 'win-a',
      actions: [
        { label: 'Skip', type: 'reject' as const, selectorPath: '#skip' },
        { label: 'Run', type: 'approve' as const, selectorPath: '#run' },
      ],
    };
    const localFiltered = filterContextLocalApprovals(
      [foreignApproval],
      'win-a',
      'composer-b',
    );
    assert.deepEqual(localFiltered, []);

    const snapshot = new Map<string, WindowSnapshot>([
      ['win-a', {
        windowId: 'win-a',
        windowTitle: 'Project A',
        messages: [],
        chatTabs: [{ composerId: 'composer-a', title: 'Shell task', isActive: true, status: 'active', selectorPath: '', source: 'open', workStatus: 'idle' }],
        pendingApprovals: [foreignApproval],
        agentStatus: 'waiting_approval',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
        composerQueue: { items: [] },
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: '' },
        lastUpdated: 1000,
        activeComposerId: 'composer-a',
      }],
    ]);
    const { notifications, registry } = buildApprovalRegistry(snapshot);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.chatTitle, 'Shell task');
    assert.ok(registry.has('tool:foreign'));

    const env = createComponentTestEnv();
    env.render(React.createElement(ApprovalBar, {
      state: baseCursorState({
        activeWindowId: 'win-a',
        activeComposerId: 'composer-b',
        pendingApprovals: localFiltered,
        globalApprovalNotifications: notifications,
      }),
    }));
    assert.ok(env.document.querySelector('#approval-bar')?.classList.contains('hidden'));
    env.cleanup();

    const headerEnv = createComponentTestEnv();
    headerEnv.render(React.createElement(HeaderBar, {
      state: baseCursorState({
        agentStatus: 'waiting_approval',
        globalApprovalNotifications: notifications,
      }),
      socketConnected: true,
      serverHealth: null,
      sendPending: false,
    }));
    const notify = headerEnv.document.querySelector('#global-approval-notification');
    assert.ok(notify);
    assert.match(notify?.textContent || '', /Needs approval · Shell task/);
    assert.equal(headerEnv.document.querySelector('#agent-status-text')?.textContent, 'Idle');
    headerEnv.cleanup();
  });
});

describe('navigate_to_approval registry resolve', () => {
  it('resolves action selectors and rejects unknown approval ids', () => {
    const approval = {
      id: 'tool:known',
      description: 'npm test',
      composerId: 'composer-z',
      windowId: 'win-z',
      actions: [
        { label: 'Skip', type: 'reject' as const, selectorPath: '#skip-z' },
        { label: 'Run', type: 'approve' as const, selectorPath: '#run-z' },
      ],
    };
    const snapshot = new Map<string, WindowSnapshot>([
      ['win-z', {
        windowId: 'win-z',
        windowTitle: 'Repo',
        messages: [],
        chatTabs: [{ composerId: 'composer-z', title: 'Tests', isActive: true, status: 'active', selectorPath: '', source: 'open', workStatus: 'idle' }],
        pendingApprovals: [approval],
        agentStatus: 'waiting_approval',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
        composerQueue: { items: [] },
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: '' },
        lastUpdated: 2000,
        activeComposerId: 'composer-z',
      }],
    ]);
    const { registry } = buildApprovalRegistry(snapshot);
    assert.equal(
      resolveApprovalActionSelector(registry, 'tool:known', 'approve'),
      '#run-z',
    );
    assert.equal(
      resolveApprovalActionSelector(registry, 'tool:unknown', 'approve'),
      undefined,
    );
    const target = registry.get('tool:known');
    assert.equal(target?.tabTitle, 'Tests');
    assert.equal(target?.composerId, 'composer-z');
  });
});

describe('ApprovalBar local detail rendering', () => {
  it('renders Skip/Run labels and detail fields for matching composer', () => {
    const env = createComponentTestEnv();
    env.render(React.createElement(ApprovalBar, {
      state: baseCursorState({
        activeWindowId: 'win-a',
        activeComposerId: 'composer-a',
        pendingApprovals: [{
          id: 'tool:local',
          description: 'Ukončí visící health-check proces taskkill',
          title: 'Ukončí visící health-check proces taskkill',
          command: 'taskkill /PID 59284 /T /F',
          mode: 'Auto-review',
          reason: 'Side effect outside authorized workflow.',
          composerId: 'composer-a',
          windowId: 'win-a',
          actions: [
            { label: 'Skip', type: 'reject', selectorPath: '#skip' },
            { label: 'Run', type: 'approve', selectorPath: '#run' },
          ],
        }],
      }),
    }));

    const text = env.document.body.textContent || '';
    assert.match(text, /Ukončí visící health-check proces taskkill/);
    assert.match(text, /taskkill \/PID 59284 \/T \/F/);
    assert.match(text, /Auto-review/);
    assert.match(text, /Side effect outside authorized workflow/);
    assert.ok(env.document.querySelector('#btn-reject')?.textContent?.includes('Skip'));
    assert.ok(env.document.querySelector('#btn-approve')?.textContent?.includes('Run'));
    env.cleanup();
  });
});
