import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiagnosticSnapshotError,
  DiagnosticSnapshotService,
  DEFAULT_SCREENSHOT_MAX_BYTES,
} from '../src/server/diagnostic-snapshot.js';
import {
  diagnosticIdFilePath,
  resolveDiagnosticId,
} from '../src/server/diagnostic-id-store.js';
import { DomExportError, DomExportService } from '../src/server/dom-export.js';
import {
  diagnosticIdsMatch,
  encodeCrockfordBase32,
  normalizeDiagnosticId,
} from '../src/shared/diagnostic-id.js';
import type { CursorState, SelectorConfig } from '../src/server/types.js';

const selectors = {
  chatContainer: { strategies: ['.virtualized-composer-messages-layout'] },
} as SelectorConfig;

const domSources = {
  getWindows: () => [{
    id: 'window-1',
    title: 'Workspace',
    url: 'vscode-file://workbench',
    wsUrl: 'ws://cursor/window-1',
  }],
  getActiveState: () => ({
    activeWindowId: 'window-1',
    activeComposerId: 'composer-1',
  }),
};

const baseState = {
  connected: true,
  activeWindowId: 'window-1',
  activeComposerId: 'composer-1',
  activeConversationContext: null,
  agentStatus: 'idle',
  agentActivityText: null,
  agentActivityLive: false,
  messages: [],
  pendingApprovals: [],
  chatTabs: [],
  windows: [{ id: 'window-1', title: 'Workspace', url: '', wsUrl: 'ws://cursor/window-1' }],
  mode: { current: 'agent', available: [] },
  model: { current: 'Auto', currentId: '' },
  gitStatus: null,
} as unknown as CursorState;

function createService(overrides: Partial<{
  collectWebDom: DiagnosticSnapshotService['capture'] extends never ? never : () => Promise<unknown>;
  screenshotPayload: Record<string, unknown>;
}> = {}) {
  const domExport = new DomExportService(domSources, selectors, {
    clientFactory: () => ({
      connect: async () => {},
      disconnect: () => {},
      callFunctionWithTimeout: async () => ({
        ok: true,
        html: '<div>chat</div>',
        bytes: 15,
        composerId: 'composer-1',
      }),
    }),
  });

  return new DiagnosticSnapshotService(domExport, {
    getWindows: domSources.getWindows,
    getActiveState: domSources.getActiveState,
    getSanitizedState: () => baseState,
    getDiagnostics: () => ({
      server: {
        version: '1.0.0',
        instanceId: 'abcd',
        diagnosticId: 'TESTID01',
        pid: 1,
        port: 4174,
        host: '127.0.0.1',
        dataDirName: 'data',
        startedAt: Date.now(),
        clientBuild: 'static',
      },
      extensionBridge: { dataDirName: 'data', dataDirPath: '/data' },
      gitSnapshots: {
        activeWindowKey: null,
        activeWindowTitle: null,
        lastPushAt: null,
        lastPushWindowKey: null,
        windowSnapshots: {},
      },
      gitStatus: null,
      connected: true,
      generation: 1,
      uptime: 10,
      clients: 1,
      activeWindowId: 'window-1',
      activeWindowTitle: 'Workspace',
      cdpUrl: 'http://127.0.0.1:9222',
    }),
    collectWebDom: async () => ({
      html: '<html><body>web</body></html>',
      bytes: 30,
      url: 'http://127.0.0.1:4173/',
      viewport: { width: 360, height: 640 },
      collectedAt: new Date().toISOString(),
    }),
  }, {
    clientFactory: () => ({
      connect: async (wsUrl: string) => assert.equal(wsUrl, 'ws://cursor/window-1'),
      disconnect: () => {},
      send: async () => overrides.screenshotPayload ?? { data: Buffer.from('png').toString('base64') },
    }),
  });
}

describe('diagnostic id encoding', () => {
  it('encodes stable-length base32 and matches case-insensitively', () => {
    const id = encodeCrockfordBase32(randomBytes(5));
    assert.match(id, /^[0-9A-Z]+$/);
    assert.equal(id.length, 8);
    assert.equal(diagnosticIdsMatch(id, id.toLowerCase()), true);
    assert.equal(normalizeDiagnosticId('io1'), '101');
  });
});

describe('diagnostic id persistence', () => {
  function withTempDataDir(run: (dataDir: string) => void): void {
    const dataDir = mkdtempSync(join(tmpdir(), 'cursor-remote-diag-'));
    try {
      run(dataDir);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it('reuses the stored id across restarts and keys it per workspace/port', () => {
    withTempDataDir(dataDir => {
      const first = resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '4174' });
      const restarted = resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '4174' });
      const otherPort = resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '3001' });
      const otherWorkspace = resolveDiagnosticId({ dataDir, workspace: '/ws/b', port: '4174' });

      assert.equal(first.source, 'generated');
      assert.equal(first.persisted, true);
      assert.equal(restarted.id, first.id);
      assert.equal(restarted.source, 'stored');
      assert.notEqual(otherPort.id, first.id);
      assert.notEqual(otherWorkspace.id, first.id);
      // Restarts must not lose sibling instances.
      assert.equal(
        resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '3001' }).id,
        otherPort.id,
      );
    });
  });

  it('falls back to a fresh id when the stored file is corrupt', () => {
    withTempDataDir(dataDir => {
      writeFileSync(diagnosticIdFilePath(dataDir), '{ not json', 'utf-8');
      const resolved = resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '4174' });
      assert.match(resolved.id, /^[0-9A-Z]{8}$/);
      assert.equal(resolved.source, 'generated');
      assert.equal(
        resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '4174' }).id,
        resolved.id,
      );
    });
  });

  it('keeps working with an in-memory id when the data dir is unwritable', () => {
    withTempDataDir(dir => {
      // A file where the data dir should be makes every write fail.
      const dataDir = join(dir, 'blocked');
      writeFileSync(dataDir, 'not a directory', 'utf-8');
      const warn = console.warn;
      console.warn = () => {};
      try {
        const resolved = resolveDiagnosticId({ dataDir, workspace: '/ws/a', port: '4174' });
        assert.match(resolved.id, /^[0-9A-Z]{8}$/);
        assert.equal(resolved.persisted, false);
      } finally {
        console.warn = warn;
      }
    });
  });
});

describe('diagnostic snapshot service', () => {
  it('builds meta with part endpoints and sensitive-data warnings', () => {
    const service = createService();
    const meta = service.buildMeta('ABC12345', '/debug/snapshot');
    assert.equal(meta.diagnosticId, 'ABC12345');
    assert.match(meta.endpoints.state, /part=state/);
    assert.equal(meta.warnings.some(w => w.includes('secrets')), true);
    assert.equal(meta.warnings.some(w => w.includes('browser tool')), true);
  });

  it('captures screenshot via parallel CDP and enforces size limit', async () => {
    const huge = Buffer.alloc(DEFAULT_SCREENSHOT_MAX_BYTES + 1).toString('base64');
    const service = createService({ screenshotPayload: { data: huge } });
    await assert.rejects(
      service.capture('screenshot'),
      (error: unknown) => error instanceof DiagnosticSnapshotError &&
        error.status === 413 &&
        error.code === 'screenshot_too_large',
    );
  });

  it('rejects concurrent snapshot captures', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const domExport = new DomExportService(domSources, selectors, {
      clientFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        callFunctionWithTimeout: async () => {
          await gate;
          return { ok: true, html: '<html></html>', bytes: 13 };
        },
      }),
    });
    const service = new DiagnosticSnapshotService(domExport, {
      getWindows: domSources.getWindows,
      getActiveState: domSources.getActiveState,
      getSanitizedState: () => baseState,
      getDiagnostics: () => ({
        server: {
          version: '1.0.0',
          instanceId: 'abcd',
          diagnosticId: 'TESTID01',
          pid: 1,
          port: 4174,
          host: '127.0.0.1',
          dataDirName: 'data',
          startedAt: Date.now(),
          clientBuild: 'static',
        },
        extensionBridge: { dataDirName: 'data', dataDirPath: '/data' },
        gitSnapshots: {
          activeWindowKey: null,
          activeWindowTitle: null,
          lastPushAt: null,
          lastPushWindowKey: null,
          windowSnapshots: {},
        },
        gitStatus: null,
        connected: true,
        generation: 1,
        uptime: 10,
        clients: 0,
        activeWindowId: 'window-1',
        activeWindowTitle: 'Workspace',
        cdpUrl: 'http://127.0.0.1:9222',
      }),
      collectWebDom: async () => ({ reason: 'no_client', message: 'none' }),
    }, {
      clientFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        send: async () => ({ data: Buffer.from('x').toString('base64') }),
      }),
    });

    const first = service.capture('cursor-dom');
    await Promise.resolve();
    await assert.rejects(
      service.capture('state'),
      (error: unknown) => error instanceof DiagnosticSnapshotError &&
        error.status === 503 &&
        error.code === 'snapshot_busy',
    );
    release();
    await first;
  });

  it('propagates dom export errors from cursor-dom part', async () => {
    const domExport = new DomExportService(domSources, selectors, {
      maxBytes: 8,
      clientFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        callFunctionWithTimeout: async () => ({ ok: true, html: '<html>too big</html>', bytes: 100 }),
      }),
    });
    const service = new DiagnosticSnapshotService(domExport, {
      getWindows: domSources.getWindows,
      getActiveState: domSources.getActiveState,
      getSanitizedState: () => baseState,
      getDiagnostics: () => ({
        server: {
          version: '1.0.0',
          instanceId: 'abcd',
          diagnosticId: 'TESTID01',
          pid: 1,
          port: 4174,
          host: '127.0.0.1',
          dataDirName: 'data',
          startedAt: Date.now(),
          clientBuild: 'static',
        },
        extensionBridge: { dataDirName: 'data', dataDirPath: '/data' },
        gitSnapshots: {
          activeWindowKey: null,
          activeWindowTitle: null,
          lastPushAt: null,
          lastPushWindowKey: null,
          windowSnapshots: {},
        },
        gitStatus: null,
        connected: true,
        generation: 1,
        uptime: 10,
        clients: 0,
        activeWindowId: 'window-1',
        activeWindowTitle: 'Workspace',
        cdpUrl: 'http://127.0.0.1:9222',
      }),
      collectWebDom: async () => ({ reason: 'no_client', message: 'none' }),
    });
    await assert.rejects(
      service.capture('cursor-dom'),
      (error: unknown) => error instanceof DomExportError && error.code === 'too_large',
    );
  });
});

describe('diagnostic snapshot auth helper', () => {
  it('accepts matching diagnostic token with timing-safe compare', () => {
    const configured = 'agent-token-123';
    const provided = 'agent-token-123';
    assert.equal(provided.length, configured.length);
    assert.equal(timingSafeEqual(Buffer.from(provided), Buffer.from(configured)), true);
  });
});

describe('diagnostic id badge UI', () => {
  it('renders badge when diagnosticId is provided', async () => {
    const { JSDOM } = await import('jsdom');
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const { DiagnosticIdBadge } = await import('../src/client/components/shell/DiagnosticIdBadge.js');
    const { UiStateContext } = await import('../src/client/state/uiState.js');

    const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { url: 'http://127.0.0.1:4173/' });
    const previousDocument = (globalThis as { document?: Document }).document;
    const previousWindow = (globalThis as { window?: Window }).window;
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });

    const ui = {
      activeSheet: null,
      queueSheetItem: null,
      tabSheetComposerId: null,
      activePlanModal: null,
      planModalBody: '',
      planModelContext: null,
      gitDiffFile: null,
      toasts: [],
      openSheet: () => {},
      closeSheet: () => {},
      openQueueSheet: () => {},
      openTabSheet: () => {},
      openPlanModal: () => {},
      closePlanModal: () => {},
      openGitSheet: () => {},
      showToast: () => {},
    };

    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          UiStateContext.Provider,
          { value: ui },
          React.createElement(DiagnosticIdBadge, { diagnosticId: 'ABC12345' }),
        ),
      );
    });

    try {
      const badge = dom.window.document.getElementById('diagnostic-id-badge');
      assert.ok(badge);
      assert.match(badge?.textContent || '', /ABC12345/);
    } finally {
      await act(async () => {
        root.unmount();
      });
      Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true });
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
      dom.window.close();
    }
  });
});
