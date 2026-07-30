import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import { StateManager } from '../src/server/state-manager.js';
import { defaultCursorState } from '../src/client/state/remoteStateStore.js';
import type { CursorState } from '../src/server/types.js';

function extract(
  html: string,
  options: { approveTextMatch?: string[]; rejectTextMatch?: string[] } = {},
): CursorState {
  const dom = new JSDOM(html);
  const previous = {
    document: (globalThis as any).document,
    Element: (globalThis as any).Element,
    HTMLElement: (globalThis as any).HTMLElement,
    Node: (globalThis as any).Node,
  };
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });
  try {
    const state = extractionFunction(
      ['#container'],
      [],
      options.approveTextMatch ?? [],
      [],
      options.rejectTextMatch ?? [],
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

describe('Multitask and conversation state', () => {
  it('ignores completed notification text containing runners but keeps Run actions', () => {
    const completed = extract(`
      <div id="container" data-composer-id="composer-approval" data-composer-status="completed">
        <div class="virtualized-composer-messages-row" data-index="38" data-pair-index="1">
          <div data-react-transcript-row-kind="notification" class="agent-transcript-notification">
            <button type="button">Hide empty debug runners</button>
          </div>
        </div>
        <div id="composer-toolbar-section">
          <div>1 File</div>
          <div data-click-ready="true">Undo All</div>
          <div data-click-ready="true">Review</div>
        </div>
      </div>
    `, { approveTextMatch: ['Run'] });

    assert.deepEqual(completed.pendingApprovals, []);
    assert.equal(completed.questionnaire, null);
    assert.equal(completed.agentStatus, 'idle');

    const actionable = extract(`
      <div id="container" data-composer-id="composer-approval">
        <button type="button">Run command</button>
      </div>
    `, { approveTextMatch: ['Run'] });
    assert.equal(actionable.pendingApprovals.length, 1);
    assert.equal(actionable.pendingApprovals[0]?.actions[0]?.label, 'Run command');
    assert.equal(actionable.agentStatus, 'waiting_approval');
  });

  it('extracts roleless transcript activity and completed notification rows in turn order', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-activity">
        <div class="virtualized-composer-messages-row" data-index="26" data-pair-index="1"
             data-find-row-key="activity-group:default:activity-1:thinking">
          <div data-react-transcript-row-key="activity-group:default:activity-1:thinking"
               data-react-transcript-row-kind="activityGroup">
            <div class="agent-transcript-row agent-transcript-row-activity">
              <div class="agent-transcript-activity-group-collapsible ui-step-group-collapsible">
                <button class="ui-collapsible-header" data-component="collapsible-header">
                  <span class="ui-collapsible-action">Explored</span>
                  <span class="ui-collapsible-details">
                    <span data-summary-variant="expanded">724154.txt</span>
                    <span data-summary-variant="compact">1 file</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="virtualized-composer-messages-row" data-index="38" data-pair-index="1"
             data-find-row-key="notification:group:job-1+job-2">
          <div data-react-transcript-row-key="notification:group:job-1+job-2"
               data-react-transcript-row-kind="notification">
            <div class="agent-transcript-row agent-transcript-row-notification">
              <div class="agent-transcript-notification">
                <div class="agent-transcript-notification-collapsible ui-step-group-collapsible">
                  <button class="ui-collapsible-header" data-component="collapsible-header">
                    <span class="ui-collapsible-action">Finished</span>
                    <span class="ui-collapsible-details">8 background tasks</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.deepEqual(
      state.messages.map(message => ({
        type: message.type,
        action: message.type === 'thought' ? message.action : undefined,
        detail: message.type === 'thought' ? message.detail : undefined,
        turnIndex: message.turnIndex,
        turnOrder: message.turnOrder,
      })),
      [
        { type: 'thought', action: 'Explored', detail: '724154.txt', turnIndex: 1, turnOrder: 26 },
        { type: 'thought', action: 'Finished', detail: '8 background tasks', turnIndex: 1, turnOrder: 38 },
      ],
    );
  });

  it('orders DOM turns locally and preserves authoritative stored history order', () => {
    const state = extract(`
      <div id="container" data-composer-id="2538345c-d1b7-4831-a973-769dbbaf30a0">
        <div class="virtualized-composer-messages-row" data-index="10" data-pair-index="0"
             data-sticky="false">
          <div data-message-role="ai" data-message-kind="assistant"
               data-message-id="13ba8bd2-eb8e-4689-a967-43b60ee5755a">
            <div class="markdown-root">Bezpečnější cesta: nejdřív ověřím jen názvy souborů.</div>
          </div>
        </div>
        <div class="virtualized-composer-messages-row" data-index="5" data-pair-index="1"
             data-sticky="true"
             data-find-row-key="human:b02166c4-423c-4dbe-a736-30f495ddfd0e">
          <div data-message-role="human" data-message-kind="human"
               data-message-index="54"
               data-message-id="b02166c4-423c-4dbe-a736-30f495ddfd0e">
            <div class="aislash-editor-input-readonly">
              jo, extensions doinstaluj taky - jen zapnute
            </div>
          </div>
        </div>
        <div class="virtualized-composer-messages-row" data-index="25" data-pair-index="1"
             data-sticky="false">
          <div data-message-role="ai" data-message-kind="tool"
               data-message-id="9b9fd749-ef31-401b-b4d5-bb0c72110134"
               data-tool-call-id="call-050562f5-e8a3-4287-b2c3-464305c3a525-26"
               data-tool-status="completed">
            <span class="ui-tool-call-line-action">Waited</span>
            <span class="ui-tool-call-line-details">for RESULT ok= in shell</span>
          </div>
        </div>
        <div class="virtualized-composer-messages-row" data-index="37" data-pair-index="1"
             data-sticky="false">
          <div data-message-role="ai" data-message-kind="assistant"
               data-message-id="1bd3d505-7189-4640-8ac4-a21c0ab6b19a">
            <div class="markdown-root">Hotovo — na VM je 32 zapnutých extensionů.</div>
          </div>
        </div>
      </div>
    `);

    assert.deepEqual(
      state.messages.map(message => message.type),
      ['assistant', 'human', 'tool', 'assistant'],
    );
    assert.deepEqual(state.messages.map(message => message.flatIndex), [10, 54, 25, 37]);
    assert.deepEqual(
      state.messages.map(message => [message.turnIndex, message.turnOrder]),
      [[0, 10], [1, 5], [1, 25], [1, 37]],
    );
    assert.equal(
      state.messages[1]?.type === 'human' ? state.messages[1].text : '',
      'jo, extensions doinstaluj taky - jen zapnute',
    );

    const manager = new StateManager(0);
    const liveCurrentTurn = state.messages.filter(message => message.turnIndex === 1);
    manager.onExtraction({ ...state, messages: liveCurrentTurn });
    assert.deepEqual(
      manager.getCurrentState().messages.map(message => message.type),
      ['human', 'tool', 'assistant'],
    );

    const storedHistory = state.messages.map(message => {
      const { turnIndex: _turnIndex, turnOrder: _turnOrder, ...stored } = message;
      if (stored.id === '13ba8bd2-eb8e-4689-a967-43b60ee5755a') {
        return { ...stored, flatIndex: 41, historyIndex: 41 };
      }
      if (stored.id === 'b02166c4-423c-4dbe-a736-30f495ddfd0e') {
        return { ...stored, flatIndex: 54, historyIndex: 54 };
      }
      if (stored.id === '9b9fd749-ef31-401b-b4d5-bb0c72110134') {
        return { ...stored, flatIndex: 74, historyIndex: 74 };
      }
      return { ...stored, flatIndex: 90, historyIndex: 90 };
    });
    storedHistory.push({
      type: 'assistant',
      id: 'stored-only-between-turn-items',
      flatIndex: 60,
      historyIndex: 60,
      text: 'Stored-only progress',
      html: '<p>Stored-only progress</p>',
      codeBlocks: [],
    });
    manager.mergeStoredHistory(storedHistory);
    assert.deepEqual(
      manager.getCurrentState().messages.map(message => [
        message.type,
        message.id,
        message.flatIndex,
        message.historyIndex,
      ]),
      [
        ['assistant', '13ba8bd2-eb8e-4689-a967-43b60ee5755a', 41, 41],
        ['human', 'b02166c4-423c-4dbe-a736-30f495ddfd0e', 54, 54],
        ['assistant', 'stored-only-between-turn-items', 60, 60],
        ['tool', '9b9fd749-ef31-401b-b4d5-bb0c72110134', 25, 74],
        ['assistant', '1bd3d505-7189-4640-8ac4-a21c0ab6b19a', 37, 90],
      ],
    );
  });

  it('extracts confirmed activity-group Thought and Explored rows without duplicated detail', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-1">
        <div class="virtualized-composer-messages-row" data-index="24">
          <div data-message-role="ai" data-message-kind="thinking" data-message-id="thought-1"
               data-react-transcript-row-kind="activityGroup">
            <div class="agent-transcript-activity-group-collapsible ui-step-group-collapsible">
              <button class="ui-collapsible-header" data-component="collapsible-header">
                <span class="ui-collapsible-action">Thought</span>
                <span class="ui-collapsible-details"><span>briefly</span><span>briefly</span></span>
              </button>
            </div>
          </div>
        </div>
        <div class="virtualized-composer-messages-row" data-index="26">
          <div data-message-role="ai" data-message-kind="thinking" data-message-id="explored-1"
               data-react-transcript-row-kind="activityGroup">
            <div class="agent-transcript-activity-group-collapsible ui-step-group-collapsible">
              <button class="ui-collapsible-header" data-component="collapsible-header">
                <span class="ui-collapsible-action">Explored</span>
                <span class="ui-collapsible-details">
                  <style>.generated { display: none; }</style>
                  <span data-summary-variant="expanded">724155.txt</span>
                  <span data-summary-variant="compact">1 file</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.deepEqual(state.messages.map(message => ({
      type: message.type,
      action: message.type === 'thought' ? message.action : undefined,
      detail: message.type === 'thought' ? message.detail : undefined,
    })), [
      { type: 'thought', action: 'Thought', detail: 'briefly' },
      { type: 'thought', action: 'Explored', detail: '724155.txt' },
    ]);
  });

  it('matches toolbar stop capability to subagent cards by title', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-subagent-stop">
        <div class="subagent-task-card" data-chrome="card">
          <div class="subagent-task-card-title" title="Probe worker">Probe worker</div>
          <div class="task-subagent-model-hover-trigger">GPT-5.6</div>
          <div class="ui-subagent-status-indicator--running-loader"></div>
        </div>
      </div>
      <div id="composer-toolbar-section">
        <div>1 subagent running</div>
        <div class="composer-toolbar-background-job-item">
          <div class="composer-toolbar-background-job-item-text">Probe worker</div>
          <div class="composer-toolbar-background-job-item-stop" data-click-ready="true">Stop</div>
        </div>
      </div>
    `);

    const item = state.subagents.items.find(entry => entry.title === 'Probe worker');
    assert.ok(item);
    assert.equal(item.openAvailable, true);
    assert.equal(item.stopAvailable, true);
    assert.ok(item._capabilities?.openSelectorPath);
    assert.equal(item._capabilities?.stop?.kind, 'toolbarStop');
    assert.equal(item._capabilities?.stop?.matchTitle, 'Probe worker');
  });

  it('extracts card header Stop pill as stop capability', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-card-stop">
        <div data-tool-call-id="call_card_stop_1">
          <div class="subagent-task-card" data-chrome="card">
            <div class="subagent-task-card-title" title="Stop v hlavičce">Stop v hlavičce</div>
            <div class="task-subagent-model-hover-trigger">Composer 2.5 Fast</div>
            <div class="ui-subagent-status-indicator--running-loader"></div>
            <button type="button" class="task-subagent-header-pill-button task-subagent-header-pill-button--stop">Stop</button>
          </div>
        </div>
      </div>
    `);

    const item = state.subagents.items[0];
    assert.ok(item);
    assert.equal(item.title, 'Stop v hlavičce');
    assert.equal(item.stopAvailable, true);
    assert.equal(item._capabilities?.stop?.kind, 'cardStop');
    assert.equal(item._capabilities?.stop?.toolCallId, 'call_card_stop_1');
    assert.equal(item._capabilities?.stop?.composerId, 'composer-card-stop');
  });

  it('marks collapsed toolbar summary as single-job stop when jobs are hidden', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-collapsed-subagent">
      </div>
      <div id="composer-toolbar-section">
        <div class="composer-toolbar-section-header" style="cursor: pointer">
          <span class="codicon codicon-chevron-right"></span>
          <div class="composer-toolbar-section-header-label">1 subagent running</div>
        </div>
      </div>
    `);

    assert.equal(state.subagents.runningCount, 1);
    assert.equal(state.subagents.items.length, 1);
    assert.equal(state.subagents.items[0]?.title, 'Running subagent');
    assert.equal(state.subagents.items[0]?.stopAvailable, true);
    assert.equal(state.subagents.items[0]?._capabilities?.stop?.kind, 'singleJobAfterExpand');
    assert.ok(state.subagents.items[0]?._capabilities?.toolbarExpandSelectorPath);
  });

  it('keeps a completed parent busy while a Multitask subagent runs and extracts agent changes', () => {
    const state = extract(`
      <div id="container" data-composer-id="composer-1" data-composer-status="completed" data-mode="multitask">
        <div class="subagent-task-card" data-chrome="card">
          <div class="subagent-task-card-title" title="Check API">Check API</div>
          <div class="task-subagent-model-hover-trigger">GPT-5.6</div>
          <div class="ui-subagent-status-indicator--running-loader"></div>
          <div data-shimmer="true">Investigating</div>
        </div>
      </div>
      <div id="composer-toolbar-section">
        <div>1 subagent running</div>
        <div>2 Files</div>
        <div data-click-ready="true">Undo All</div>
        <div data-click-ready="true">Review</div>
      </div>
    `);

    assert.equal(state.mode.current, 'multitask');
    assert.equal(state.agentStatus, 'running_subagents');
    assert.equal(state.subagents.runningCount, 1);
    assert.deepEqual(state.subagents.items.map(item => ({
      title: item.title,
      model: item.model,
      status: item.status,
    })), [{ title: 'Check API', model: 'GPT-5.6', status: 'running' }]);
    assert.equal(state.subagents.items[0]?.openAvailable, true);
    assert.equal(state.subagents.items[0]?.stopAvailable, false);
    assert.ok(state.subagents.items[0]?._capabilities?.openSelectorPath);
    assert.equal(state.backgroundTasks.length, 0);
    assert.equal(state.agentChanges.fileCount, 2);
    assert.equal(state.agentChanges.reviewAvailable, true);
    assert.equal(state.agentChanges.undoAllAvailable, true);
  });

  it('diffs Multitask, agent-change, stop and exploratory state onto the socket patch', async () => {
    const manager = new StateManager(0);
    const patches: Partial<CursorState>[] = [];
    manager.on('state:patch', patch => patches.push(patch));
    manager.onExtraction({
      ...structuredClone(defaultCursorState),
      connected: true,
      agentStatus: 'running_subagents',
      subagents: {
        runningCount: 1,
        summary: '1 subagent running',
        items: [{ id: 'subagent:one', title: 'One', status: 'running', openAvailable: false, stopAvailable: false }],
      },
      agentChanges: {
        fileCount: 1,
        reviewAvailable: true,
        undoAllAvailable: false,
        reviewSelectorPath: '#review',
      },
      agentStopSelectorPath: '#stop',
      agentStopAvailable: true,
      agentStopSource: 'composer',
      exploratoryUi: { stickyTitle: 'One', cloudWidgets: [], subagentTrays: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 5));

    const patch = patches.at(-1);
    assert.ok(patch);
    assert.equal(patch.subagents?.runningCount, 1);
    assert.equal(patch.agentChanges?.fileCount, 1);
    assert.equal(patch.agentStopAvailable, true);
    assert.equal(patch.agentStopSource, 'composer');
    assert.equal(patch.exploratoryUi?.stickyTitle, 'One');
  });
});
