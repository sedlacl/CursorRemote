import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CursorState } from '../src/server/types.js';
import { App } from '../src/client/app/App.js';

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
  handlers: Map<string, EventHandler>;
  emitted: Array<{ event: string; args: unknown[] }>;
  on(event: string, fn: EventHandler): void;
  emit(event: string, ...args: unknown[]): void;
  fire(event: string, ...args: unknown[]): void;
  connected: boolean;
  id: string;
}

function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve('fixtures/recordings', name), 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

function createTestEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost:3000/',
    pretendToBeVisual: true,
  });

  const window = dom.window;
  const document = window.document;
  const previousGlobals = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    navigator: (globalThis as any).navigator,
    HTMLElement: (globalThis as any).HTMLElement,
    FileReader: (globalThis as any).FileReader,
    Notification: (globalThis as any).Notification,
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
  };

  const mockSocket: MockSocket = {
    handlers: new Map(),
    emitted: [],
    connected: true,
    id: 'test-socket-id',
    on(event: string, fn: EventHandler) {
      this.handlers.set(event, fn);
    },
    emit(event: string, ...args: unknown[]) {
      this.emitted.push({ event, args });
    },
    fire(event: string, ...args: unknown[]) {
      const handler = this.handlers.get(event);
      if (handler) handler(...args);
    },
  };

  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() { /* noop */ }, removeEventListener() { /* noop */ } }),
    configurable: true,
  });
  Object.defineProperty(window, 'scrollTo', { value: () => undefined, configurable: true });
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(Date.now());
    return 0;
  };
  (window as any).Notification = { permission: 'denied' };

  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'FileReader', { value: window.FileReader, configurable: true });
  Object.defineProperty(globalThis, 'Notification', { value: (window as any).Notification, configurable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (window as any).requestAnimationFrame, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root;
  act(() => {
    root = createRoot(document.getElementById('app')!);
    root.render(React.createElement(App, { socket: mockSocket, skipAuth: true }));
  });

  return {
    dom,
    window,
    document,
    mockSocket,
    cleanup() {
      act(() => root.unmount());
      Object.defineProperty(globalThis, 'window', { value: previousGlobals.window, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: previousGlobals.document, configurable: true });
      Object.defineProperty(globalThis, 'navigator', { value: previousGlobals.navigator, configurable: true });
      Object.defineProperty(globalThis, 'HTMLElement', { value: previousGlobals.HTMLElement, configurable: true });
      Object.defineProperty(globalThis, 'FileReader', { value: previousGlobals.FileReader, configurable: true });
      Object.defineProperty(globalThis, 'Notification', { value: previousGlobals.Notification, configurable: true });
      Object.defineProperty(globalThis, 'requestAnimationFrame', { value: previousGlobals.requestAnimationFrame, configurable: true });
      dom.window.close();
    },
  };
}

function installFetchStub(data: unknown) {
  const previousFetch = (globalThis as any).fetch;
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({
      ok: true,
      json: async () => data,
    }),
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'fetch', { value: previousFetch, configurable: true });
  };
}

function fireFullState(mockSocket: MockSocket, state: CursorState) {
  act(() => mockSocket.fire('state:full', state));
}

function firePatch(mockSocket: MockSocket, patch: Partial<CursorState>) {
  act(() => mockSocket.fire('state:patch', patch));
}

// ─── Connection status rendering ───

describe('web: connection status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('shows connected when extractorStatus is ok', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const dot = env.document.getElementById('connection-dot')!;
    const text = env.document.getElementById('connection-text')!;
    assert.ok(dot.classList.contains('connected'));
    assert.match(text.textContent!, /Connected/i);
  });

  it('shows stale when extractorStatus is stale', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const dot = env.document.getElementById('connection-dot')!;
    assert.ok(
      dot.classList.contains('stale') || dot.classList.contains('reconnecting'),
      `Expected stale/reconnecting class, got: ${dot.className}`
    );
  });
});

// ─── Agent status rendering ───

describe('web: agent status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('shows idle when agent is idle', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });

  it('shows thinking label when shimmer active', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Planning next moves/i);
  });

  it('clears activity when shimmer stops', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[4].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });

  // Stop button behavior is covered by tests/header-bar.test.ts (isolated component).
  it('integration smoke: App still renders stop control in header', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    assert.ok(env.document.getElementById('btn-agent-stop'), 'Stop button should exist in App shell');
  });
});

// ─── Message rendering ───

describe('web: message rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders human message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const humanEl = msgs.querySelector('.el-human');
    assert.ok(humanEl, 'Should render human message (.el-human)');
    assert.match(humanEl!.textContent!, /Fix the bug/);
  });

  it('renders assistant message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    assert.ok(msgs.querySelector('.el-assistant'), 'Should render assistant message (.el-assistant)');
  });

  it('renders tool element with filename', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render tool messages (.el-tool)');
  });

  it('updates messages on patch', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const initialCount = msgs.querySelectorAll('[data-id]').length;

    firePatch(env.mockSocket, {
      messages: fixture[4].state!.messages,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
    });
    const updatedCount = msgs.querySelectorAll('[data-id]').length;
    assert.ok(updatedCount > initialCount, `Expected more messages after patch, got ${initialCount} -> ${updatedCount}`);
  });

  it('renders loading tool icon as spinner', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      messages: [
        {
          type: 'tool',
          id: 'loading-tool',
          flatIndex: 1,
          toolCallId: 'tool-1',
          status: 'loading',
          action: 'Running',
          details: 'npm test',
        },
      ],
    });
    const spinner = env.document.querySelector('.tool-line.loading .tool-spinner');
    assert.ok(spinner, 'Loading tool should render a spinner icon');
    const icon = env.document.querySelector('.tool-line.loading .tool-icon');
    assert.equal(icon?.textContent, '');
  });
});

// ─── Run command / approval rendering ───

describe('web: approval widgets', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders run_command with command text', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCard = msgs.querySelector('.run-card');
    assert.ok(runCard, 'Should render run_command card');
    assert.match(runCard!.textContent!, /npm test/);
  });

  it('renders run_command with Skip and Run buttons', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const buttons = msgs.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ run buttons, got ${buttons.length}`);
  });

  it('preserves command text across updates', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[2].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCards = msgs.querySelectorAll('.run-card');
    const hasNpmTest = Array.from(runCards).some(
      card => card.textContent!.includes('npm test')
    );
    assert.ok(hasNpmTest, 'npm test should be preserved in run cards');
  });
});

// ─── Plan widget rendering ───

describe('web: plan widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders plan block with title and progress', () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const planEl = msgs.querySelector('.el-plan');
    assert.ok(planEl, 'Should render plan block (.el-plan)');
    assert.match(planEl!.textContent!, /Auth System/);
  });
});

// ─── Code block rendering ───

describe('web: code block rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders diff block with viewport', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const diffBlock = msgs.querySelector('.code-block-viewport');
    assert.ok(diffBlock, 'Should render a code block viewport');
  });

  it('preserves newlines in code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const codeEl = msgs.querySelector('.code-block-viewport pre code');
    if (codeEl) {
      const text = codeEl.textContent ?? '';
      assert.ok(text.includes('\n'), 'Code block text should preserve newlines');
    }
  });

  it('renders assistant message with code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const assistant = msgs.querySelector('.el-assistant');
    assert.ok(assistant, 'Should render assistant message (.el-assistant)');
  });
});

// ─── Fetch tool rendering ───

describe('web: fetch tool', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders fetch tool with action text and URL', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool (.el-tool)');
    assert.match(toolEl!.textContent!, /Fetch/);
    assert.match(toolEl!.textContent!, /reddit\.com/);
  });

  it('renders fetch tool with approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool');
    const actionRow = toolEl!.querySelector('.tool-actions-row');
    assert.ok(actionRow, 'Should have tool-actions-row with buttons');
    const buttons = actionRow!.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ action buttons, got ${buttons.length}`);
  });

  it('renders completed fetch tool without approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[3].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render fetch tool');
    const lastTool = toolEls[toolEls.length - 1];
    const actionRow = lastTool.querySelector('.tool-actions-row');
    assert.ok(!actionRow, 'Completed tool should not have action buttons');
  });
});

// ─── Mode/model pill rendering ───

describe('web: mode/model pills', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  it('renders mode and model from state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const modeText = env.document.getElementById('pill-mode-text')!;
    const modelText = env.document.getElementById('pill-model-text')!;
    const input = env.document.getElementById('message-input') as HTMLTextAreaElement;
    assert.ok(modeText.textContent!.length > 0, 'Mode text should be set');
    assert.ok(modelText.textContent!.length > 0, 'Model text should be set');
    assert.match(input.placeholder, /\/ for skills/);
    assert.match(input.placeholder, /@ for context/);
  });
});

// ─── Attachment handling ───

describe('web: attachments', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  function baseState(): CursorState {
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
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      backgroundTasks: [],
      gitStatus: null,
      gitScm: null,
      agentStopSelectorPath: '',
      agentStopAvailable: false,
      agentStopSource: 'none',
      exploratoryUi: null,
    };
  }

  it('adds a pasted image only once when paste originates in textarea', async () => {
    fireFullState(env.mockSocket, baseState());
    class MockFileReader {
      result: string | ArrayBuffer | null = 'data:image/png;base64,ZmFrZQ==';
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { value: MockFileReader, configurable: true });
    Object.defineProperty(env.window, 'FileReader', { value: MockFileReader, configurable: true });

    const file = new env.window.File(['fake'], 'paste.png', { type: 'image/png' });
    const event = new env.window.Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: { items: Array<{ kind: string; type: string; getAsFile(): File }> };
    };
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });

    const input = env.document.getElementById('message-input')!;
    await act(async () => {
      input.dispatchEvent(event);
    });

    const chips = env.document.querySelectorAll('.attachment-chip');
    assert.equal(chips.length, 1);
  });
});

// ─── Background task indicator ───

describe('web: background tasks', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  function baseState(): CursorState {
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
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      backgroundTasks: [],
      gitStatus: null,
      gitScm: null,
      agentStopSelectorPath: '',
      agentStopAvailable: false,
      agentStopSource: 'none',
      exploratoryUi: null,
    };
  }

  it('shows background count and sends stop action from the sheet', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [
        { id: 'b1', label: 'npm run dev', stopSelectorPath: '#stop-one' },
        { id: 'b2', label: 'npm test --watch' },
      ],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    assert.equal(pill.textContent, 'Jobs:2');

    act(() => pill.click());
    const sheet = env.document.getElementById('sheet-background-tasks')!;
    assert.ok(!sheet.classList.contains('hidden'));
    assert.match(sheet.textContent || '', /npm run dev/);
    assert.match(sheet.textContent || '', /npm test --watch/);

    const stop = sheet.querySelector('.background-task-stop') as HTMLButtonElement;
    act(() => stop.click());

    const sent = env.mockSocket.emitted.find(item => item.event === 'command:click_action');
    assert.ok(sent, 'Expected stop to emit click_action');
    assert.equal((sent.args[0] as { selectorPath?: string }).selectorPath, '#stop-one');
  });

  it('counts collapsed background terminal summary rows in the pill', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [{ id: 'summary', label: '1 background terminal', expandSelectorPath: '#expand-summary' }],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    assert.equal(pill.textContent, 'Jobs:1');
    assert.ok(!pill.classList.contains('count-pill-idle'));

    act(() => pill.click());

    const sent = env.mockSocket.emitted.find(item => item.event === 'command:click_action');
    assert.ok(sent, 'Expected background summary click to emit click_action');
    assert.equal((sent.args[0] as { selectorPath?: string }).selectorPath, '#expand-summary');

    const sheet = env.document.getElementById('sheet-background-tasks')!;
    assert.ok(!sheet.classList.contains('hidden'));
  });

  it('replaces the collapsed summary row with a waiting hint, then lists detailed jobs', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [{ id: 'summary', label: '2 background tasks', expandSelectorPath: '#expand-summary' }],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    act(() => pill.click());

    const sheet = env.document.getElementById('sheet-background-tasks')!;
    assert.doesNotMatch(sheet.textContent || '', /2 background tasks/);
    assert.doesNotMatch(sheet.textContent || '', /No stop/);
    assert.match(sheet.textContent || '', /Collapsed in Cursor/);

    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [
        { id: 'summary', label: '2 background tasks', expandSelectorPath: '#expand-summary' },
        { id: 'b1', label: 'npm run dev', stopSelectorPath: '#stop-one' },
        { id: 'b2', label: 'npm test --watch', stopSelectorPath: '#stop-two' },
      ],
    });

    assert.match(sheet.textContent || '', /npm run dev/);
    assert.match(sheet.textContent || '', /npm test --watch/);
    assert.doesNotMatch(sheet.textContent || '', /2 background tasks/);
    assert.doesNotMatch(sheet.textContent || '', /Collapsed in Cursor/);
  });

  it('counts background task summary labels from Cursor chrome', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [{ id: 'summary', label: '2 background tasks' }],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    assert.equal(pill.textContent, 'Jobs:2');
  });

  it('adds toolbar background count and foreground waiting commands for the pill', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [
        { id: 'summary', label: '1 background terminal' },
        { id: 'waiting', label: 'Waiting for 1 command to finish' },
      ],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    assert.equal(pill.textContent, 'Jobs:2');
  });

  it('does not render foreground waiting commands in the background task sheet', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      backgroundTasks: [
        { id: 'summary', label: '1 background terminal' },
        { id: 'waiting', label: 'Waiting for 2 commands to finish', stopSelectorPath: '#stop-waiting' },
      ],
    });

    const pill = env.document.getElementById('pill-background-tasks') as HTMLButtonElement;
    assert.equal(pill.textContent, 'Jobs:3');

    act(() => pill.click());

    const sheet = env.document.getElementById('sheet-background-tasks')!;
    assert.ok(!sheet.classList.contains('hidden'));
    assert.doesNotMatch(sheet.textContent || '', /Waiting for 2 commands to finish/);
  });

  it('does not count foreground loading tool messages as background tasks', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      agentStopSelectorPath: '#stop-agent',
      messages: [
        {
          type: 'tool',
          id: 'loading-tool',
          flatIndex: 1,
          toolCallId: 'tool-1',
          status: 'loading',
          action: 'Running',
          details: 'npm test',
        },
      ],
    });

    const pill = env.document.getElementById('pill-background-tasks');
    assert.equal(pill, null, 'Expected zero active jobs to stay hidden');
  });
});

describe('web: git status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  function baseState(): CursorState {
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
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      backgroundTasks: [],
      gitStatus: null,
      gitScm: null,
      agentStopSelectorPath: '',
      agentStopAvailable: false,
      agentStopSource: 'none',
      exploratoryUi: null,
    };
  }

  it('shows git count and opens git review sheet', async () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      gitStatus: {
        available: true,
        changedCount: 3,
        repoLabel: 'cursor-ide-remote',
        updatedAt: Date.now(),
        source: 'vscode.git',
      },
      gitScm: {
        version: 2,
        snapshotId: 'git:test:1:abc',
        updatedAt: Date.now(),
        windowKey: 'cursor-ide-remote',
        repos: [{
          repoId: 'repo:abc',
          rootUri: 'file:///workspace/repo',
          label: 'repo',
          branch: 'main',
          ahead: 0,
          behind: 0,
          counts: { staged: 1, changes: 2, conflicts: 0, untracked: 0 },
        }],
        files: [{
          fileId: 'repo:abc|changes|src/a.ts',
          repoId: 'repo:abc',
          bucket: 'changes',
          path: 'src/a.ts',
          originalPath: null,
          displayPath: 'src/a.ts',
          status: 'MODIFIED',
          isRename: false,
          isBinary: false,
          isLarge: false,
          isConflict: false,
          updatedAt: Date.now(),
        }],
      },
    });

    const pill = env.document.getElementById('pill-git-status') as HTMLButtonElement;
    assert.ok(pill, 'Expected git status pill to be rendered');
    assert.equal(pill.textContent, 'F:3');

    await act(async () => {
      pill.click();
    });

    const sheet = env.document.getElementById('sheet-git-review');
    assert.ok(sheet, 'Expected git review sheet to open');
    assert.ok(!sheet!.classList.contains('hidden'));
    assert.match(sheet!.textContent || '', /cursor-ide-remote · main/);
    assert.ok(env.document.querySelector('.git-file-row'), 'Expected at least one git file row');
  });

  it('keeps git pill visible for clean repositories', () => {
    fireFullState(env.mockSocket, {
      ...baseState(),
      gitStatus: {
        available: true,
        changedCount: 0,
        repoLabel: 'cursor-ide-remote',
        updatedAt: Date.now(),
        source: 'vscode.git',
      },
    });

    const pill = env.document.getElementById('pill-git-status') as HTMLButtonElement;
    assert.ok(pill, 'Expected git status pill to be rendered');
    assert.equal(pill.textContent, 'F:0');
    assert.ok(pill.classList.contains('count-pill-idle'));
  });
});

describe('web: debug panel', () => {
  let env: ReturnType<typeof createTestEnv>;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    restoreFetch = installFetchStub({
      server: {
        version: '0.1.46-local',
        instanceId: 'debug-test',
        pid: 123,
        port: 3002,
        host: '127.0.0.1',
        dataDirName: 'qjohn.cursor-remote',
        startedAt: Date.now(),
        clientBuild: 'vite-dev',
      },
      gitStatus: null,
      gitScm: null,
      gitSnapshots: {
        activeWindowKey: 'cursor-ide-remote',
        activeWindowTitle: 'cursor-ide-remote',
        lastPushAt: Date.now(),
        lastPushWindowKey: 'cursor-ide-remote',
        windowSnapshots: {
          'cursor-ide-remote': {
            windowKey: 'cursor-ide-remote',
            changedCount: 36,
            updatedAt: Date.now(),
            repoBreakdown: [{ rootUri: 'file:///a', label: 'a', changedCount: 20 }],
          },
        },
      },
      generation: 1,
      uptime: 5,
      clients: 1,
      connected: true,
      extensionBridge: {},
      activeWindowId: '',
      activeWindowTitle: null,
      cdpUrl: 'http://127.0.0.1:19222',
    });
    env = createTestEnv();
  });

  afterEach(() => {
    restoreFetch?.();
    env.cleanup();
  });

  it('opens debug sheet from server version badge and does not render debug pill', async () => {
    await act(async () => {
      await Promise.resolve();
    });

    const pill = env.document.getElementById('pill-debug');
    assert.equal(pill, null, 'Expected debug pill to be removed');

    const badge = env.document.getElementById('server-version-badge') as HTMLButtonElement;
    assert.ok(badge, 'Expected server version badge to be rendered');

    await act(async () => {
      badge.click();
    });

    const sheet = env.document.getElementById('sheet-debug');
    assert.ok(sheet, 'Expected debug sheet to open');
    assert.equal(sheet?.classList.contains('hidden'), false);
    assert.ok(sheet?.textContent?.includes('not sanitized'));

    firePatch(env.mockSocket, {
      activeWindowId: 'window-1',
      activeComposerId: 'composer-1',
    });
    const chatExport = env.document.getElementById('debug-export-chat') as HTMLButtonElement;
    const documentExport = env.document.getElementById('debug-export-document') as HTMLButtonElement;
    assert.equal(chatExport.disabled, false);
    assert.equal(documentExport.disabled, false);

    let warning = '';
    let exportRequested = false;
    const previousConfirm = env.window.confirm;
    env.window.confirm = (message?: string) => {
      warning = message ?? '';
      return false;
    };
    Object.defineProperty(globalThis, 'fetch', {
      value: async () => {
        exportRequested = true;
        throw new Error('Unexpected export request');
      },
      configurable: true,
    });
    await act(async () => {
      documentExport.click();
    });
    env.window.confirm = previousConfirm;
    assert.match(warning, /chats, code, terminal output, local paths, and secrets/i);
    assert.equal(exportRequested, false);
  });

  it('sends kill server command from debug sheet', async () => {
    await act(async () => {
      await Promise.resolve();
    });

    const badge = env.document.getElementById('server-version-badge') as HTMLButtonElement;
    await act(async () => {
      badge.click();
    });

    const killButton = env.document.getElementById('debug-kill-server') as HTMLButtonElement;
    assert.ok(killButton, 'Expected kill button in debug sheet');

    await act(async () => {
      killButton.click();
    });

    const sent = env.mockSocket.emitted.find(item => item.event === 'command:kill_server');
    assert.ok(sent, 'Expected kill button to emit kill_server command');
  });
});

// ─── Questionnaire widget rendering (detailed cases: tests/questionnaire-bar.test.ts) ───

describe('web: questionnaire widget integration', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => env.cleanup());

  function baseState(): CursorState {
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
      inputAvailable: true,
      chatTabs: [],
      activeComposerId: '',
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
      backgroundTasks: [],
      gitStatus: null,
      gitScm: null,
      agentStopSelectorPath: '',
      agentStopAvailable: false,
      agentStopSource: 'none',
      exploratoryUi: null,
      exploratoryUi: null,
    };
  }

  it('integration smoke: App wires questionnaire bar when state has questions', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{
        number: '1.', text: 'Q?', isActive: true,
        options: [{ letter: 'A', label: 'Yes', isFreeform: false, isSelected: false, selectorPath: 'sp-a' }],
      }],
      activeIndex: 0,
      totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip',
      continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'));
  });
});
