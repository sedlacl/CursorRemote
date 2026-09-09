import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import { StateManager } from '../src/server/state-manager.js';
import {
  loadStoredMessagesIfUnhydrated,
  looksLikeUnhydratedTranscript,
} from '../src/server/transcript-hydration.js';
import type { ChatElement, ChatTab, CursorState, HumanMessage } from '../src/server/types.js';

const PARENT_ID = '52121ca2-4b2e-4f7d-b548-db84e8dec6d2';
const CHILD_ID = '934ecc01-7d54-4185-bcc9-27a54c70f4e6';
const NEW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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
      [],
      [],
      [],
      [],
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

function tab(composerId: string, title: string): ChatTab {
  return {
    composerId,
    title,
    isActive: true,
    status: 'active',
    selectorPath: '',
    source: 'open',
    workStatus: 'idle',
  };
}

function human(id: string, text: string): HumanMessage {
  return { type: 'human', id, flatIndex: 0, text, mentions: [] };
}

function baseState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    messages: [],
    pendingApprovals: [],
    globalApprovalNotifications: [],
    inputAvailable: true,
    composerInputAvailable: true,
    activeConversationContext: null,
    chatTabs: [],
    activeComposerId: PARENT_ID,
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: 'win-1',
    composerQueue: { items: [] },
    questionnaire: null,
    backgroundTasks: [],
    subagents: { runningCount: 0, summary: '', items: [] },
    agentChanges: { fileCount: 0, reviewAvailable: false, undoAllAvailable: false },
    gitStatus: null,
    gitScm: null,
    agentStopSelectorPath: '',
    agentStopAvailable: false,
    agentStopSource: 'none',
    exploratoryUi: null,
    ...overrides,
  };
}

describe('transcript hydration', () => {
  it('marks an empty live transcript-root as unhydrated and ignores a true empty idle chat', () => {
    const generating = extract(`
      <div id="container" data-composer-id="${CHILD_ID}" data-composer-status="generating" class="composer-bar editor">
        <div class="composer-react-transcript-root" data-react-transcript-root="" tabindex="0"></div>
      </div>
    `);
    assert.equal(generating.messages.length, 0);
    assert.equal(generating._rawSignals?.transcriptRootEmpty, true);
    assert.equal(generating._rawSignals?.composerStatus, 'generating');
    assert.equal(looksLikeUnhydratedTranscript(generating), true);

    const parentLive = extract(`
      <div id="container" data-composer-id="${PARENT_ID}" data-composer-status="completed" class="composer-bar editor">
        <div class="composer-react-transcript-root" data-react-transcript-root="" tabindex="0"></div>
        <div id="composer-toolbar-section">
          <div>1 subagent running</div>
          <div>23 Files</div>
        </div>
      </div>
    `);
    assert.equal(parentLive.messages.length, 0);
    assert.equal(parentLive._rawSignals?.transcriptRootEmpty, true);
    assert.equal(parentLive.subagents.runningCount, 1);
    assert.equal(parentLive.agentChanges.fileCount, 23);
    assert.equal(looksLikeUnhydratedTranscript(parentLive), true);

    const idleEmpty = extract(`
      <div id="container" data-composer-id="${NEW_ID}" data-composer-status="idle" class="composer-bar editor">
        <div class="composer-react-transcript-root" data-react-transcript-root="" tabindex="0"></div>
      </div>
    `);
    assert.equal(idleEmpty.messages.length, 0);
    assert.equal(idleEmpty._rawSignals?.transcriptRootEmpty, true);
    assert.equal(looksLikeUnhydratedTranscript(idleEmpty), false);
  });

  it('restores cached parent messages instead of publishing an empty unhydrated return', () => {
    const manager = new StateManager(0);
    const parentMessages: ChatElement[] = [human('p1', 'parent prompt')];

    manager.onExtraction(baseState({
      activeComposerId: PARENT_ID,
      chatTabs: [tab(PARENT_ID, 'UI updates and log size')],
      messages: parentMessages,
    }));
    assert.equal(manager.getCurrentState().messages[0]?.id, 'p1');

    manager.onExtraction(baseState({
      activeComposerId: CHILD_ID,
      chatTabs: [tab(CHILD_ID, 'Changelog: vrstvy parametru')],
      messages: [human('c1', 'child prompt')],
    }));
    assert.equal(manager.getCurrentState().messages[0]?.id, 'c1');

    manager.onExtraction(baseState({
      activeComposerId: PARENT_ID,
      agentStatus: 'running_subagents',
      chatTabs: [tab(PARENT_ID, 'UI updates and log size')],
      messages: [],
      subagents: { runningCount: 1, summary: '1 subagent running', items: [] },
      agentChanges: { fileCount: 23, reviewAvailable: true, undoAllAvailable: true },
    }));

    assert.equal(manager.getCurrentState().messages.length, 1);
    assert.equal(manager.getCurrentState().messages[0]?.id, 'p1');
    assert.equal(manager.getCurrentState().agentStatus, 'running_subagents');
  });

  it('loads stored messages for generating empty composer without in-memory cache', async () => {
    const state = baseState({
      activeComposerId: CHILD_ID,
      chatTabs: [tab(CHILD_ID, 'Changelog: vrstvy parametru')],
      messages: [],
      agentStatus: 'generating',
      _rawSignals: { transcriptRootEmpty: true, composerStatus: 'generating' },
    });

    let loadedComposerId = '';
    const result = await loadStoredMessagesIfUnhydrated(state, async (composerId) => {
      loadedComposerId = composerId;
      return { messages: [human('stored-1', 'stored prompt')], loadedBubbles: 1 };
    });

    assert.equal(loadedComposerId, CHILD_ID);
    assert.ok(result);
    assert.equal(result!.loadedBubbles, 1);
    assert.equal(result!.messages.length, 1);
    assert.equal(result!.messages[0]?.id, 'stored-1');
    assert.equal((result!.messages[0] as HumanMessage).text, 'stored prompt');
  });

  it('still publishes a truly empty idle composer that was never seen', () => {
    const manager = new StateManager(0);
    manager.onExtraction(baseState({
      activeComposerId: PARENT_ID,
      chatTabs: [tab(PARENT_ID, 'UI updates and log size')],
      messages: [human('p1', 'parent prompt')],
    }));

    manager.onExtraction(baseState({
      activeComposerId: NEW_ID,
      chatTabs: [tab(NEW_ID, 'New chat')],
      messages: [],
      agentStatus: 'idle',
    }));

    assert.equal(manager.getCurrentState().activeComposerId, NEW_ID);
    assert.equal(manager.getCurrentState().messages.length, 0);
  });
});
