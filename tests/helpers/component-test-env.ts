import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CursorState } from '../../src/server/types.js';
import type { CommandClient } from '../../src/client/state/commandClient.js';
import { CommandClientContext } from '../../src/client/state/commandClient.js';
import { UiStateContext, type UiActions, type UiState } from '../../src/client/state/uiState.js';

export function baseCursorState(overrides: Partial<CursorState> = {}): CursorState {
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
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
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

export interface MockCommandClient extends CommandClient {
  emitted: Array<{ event: string; payload: Record<string, unknown> }>;
  awaited: Array<{ event: string; payload: Record<string, unknown> }>;
}

export function createMockCommandClient(): MockCommandClient {
  const emitted: MockCommandClient['emitted'] = [];
  const awaited: MockCommandClient['awaited'] = [];
  return {
    emitted,
    awaited,
    emit(eventName: string, payload: Record<string, unknown> = {}) {
      emitted.push({ event: eventName, payload });
    },
    async sendCommandAwaitResult(eventName: string, payload: Record<string, unknown> = {}) {
      awaited.push({ event: eventName, payload });
      return { commandId: String(payload.commandId || 'test-command-id'), ok: true };
    },
    resolveCommandResult() {
      return false;
    },
    newCommandId() {
      return 'test-command-id';
    },
  };
}

export function createMockUiState(overrides: Partial<UiState & UiActions> = {}): UiState & UiActions {
  return {
    activeSheet: null,
    queueSheetItem: null,
    tabSheetComposerId: null,
    planModelContext: null,
    activePlanModal: null,
    planModalBody: '',
    toasts: [],
    backgroundTaskContext: null,
    gitDiffFile: null,
    pendingSkillInsert: null,
    openSheet: () => undefined,
    closeSheet: () => undefined,
    openQueueSheet: () => undefined,
    openTabSheet: () => undefined,
    openPlanModelSheet: () => undefined,
    openPlanModal: () => undefined,
    closePlanModal: () => undefined,
    setPlanModalBody: () => undefined,
    showToast: () => undefined,
    removeToast: () => undefined,
    openGitSheet: () => undefined,
    openGitDiff: () => undefined,
    closeGitDiff: () => undefined,
    requestSkillInsert: () => undefined,
    clearPendingSkillInsert: () => undefined,
    ...overrides,
  };
}

export interface ComponentTestEnv {
  document: Document;
  command: MockCommandClient;
  ui: UiState & UiActions;
  render(element: React.ReactElement): void;
  cleanup(): void;
}

export function createComponentTestEnv(uiOverrides: Partial<UiState & UiActions> = {}): ComponentTestEnv {
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
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
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

  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (window as any).requestAnimationFrame, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const command = createMockCommandClient();
  const ui = createMockUiState(uiOverrides);
  let root: Root;

  const render = (element: React.ReactElement) => {
    act(() => {
      root = createRoot(document.getElementById('app')!);
      root.render(
        React.createElement(
          CommandClientContext.Provider,
          { value: command },
          React.createElement(
            UiStateContext.Provider,
            { value: ui },
            element,
          ),
        ),
      );
    });
  };

  return {
    document,
    command,
    ui,
    render,
    cleanup() {
      act(() => root.unmount());
      Object.defineProperty(globalThis, 'window', { value: previousGlobals.window, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: previousGlobals.document, configurable: true });
      Object.defineProperty(globalThis, 'navigator', { value: previousGlobals.navigator, configurable: true });
      Object.defineProperty(globalThis, 'HTMLElement', { value: previousGlobals.HTMLElement, configurable: true });
      Object.defineProperty(globalThis, 'requestAnimationFrame', { value: previousGlobals.requestAnimationFrame, configurable: true });
      dom.window.close();
    },
  };
}
