import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DomExportError,
  DomExportService,
} from '../src/server/dom-export.js';
import type { SelectorConfig } from '../src/server/types.js';

const selectors = {
  chatContainer: { strategies: ['.virtualized-composer-messages-layout'] },
} as SelectorConfig;

const sources = {
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

describe('DOM export service', () => {
  it('uses a parallel target connection and enforces the server byte limit', async () => {
    let disconnected = false;
    let receivedArgs: unknown[] = [];
    const service = new DomExportService(sources, selectors, {
      maxBytes: 64,
      clientFactory: () => ({
        connect: async (wsUrl) => assert.equal(wsUrl, 'ws://cursor/window-1'),
        disconnect: () => { disconnected = true; },
        callFunctionWithTimeout: async (_fn, args) => {
          receivedArgs = args;
          return { ok: true, html: '<div data-composer-id="composer-1">chat</div>', bytes: 47 };
        },
      }),
    });

    const result = await service.export({ scope: 'chat' });
    assert.equal(result.windowId, 'window-1');
    assert.equal(result.composerId, 'composer-1');
    assert.equal(result.html.includes('>chat<'), true);
    assert.deepEqual(receivedArgs.slice(0, 3), [
      'chat',
      'composer-1',
      ['.virtualized-composer-messages-layout'],
    ]);
    assert.equal(disconnected, true);

    const oversized = new DomExportService(sources, selectors, {
      maxBytes: 8,
      clientFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        callFunctionWithTimeout: async () => ({ ok: true, html: '<html>too large</html>', bytes: 22 }),
      }),
    });
    await assert.rejects(
      oversized.export({ scope: 'document' }),
      (error: unknown) => error instanceof DomExportError &&
        error.status === 413 &&
        error.code === 'too_large',
    );
  });

  it('rejects concurrent exports while the first connection remains active', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new DomExportService(sources, selectors, {
      clientFactory: () => ({
        connect: async () => {},
        disconnect: () => {},
        callFunctionWithTimeout: async () => {
          await gate;
          return { ok: true, html: '<html></html>', bytes: 13 };
        },
      }),
    });

    const first = service.export({ scope: 'document' });
    await Promise.resolve();
    await assert.rejects(
      service.export({ scope: 'document' }),
      (error: unknown) => error instanceof DomExportError &&
        error.status === 503 &&
        error.code === 'export_busy',
    );
    release();
    await first;
  });
});

describe('DOM export client', () => {
  it('requests the relay dom-export route with auth and scope query', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://127.0.0.1:4173/' });
    const previousDocument = (globalThis as { document?: Document }).document;
    const previousWindow = (globalThis as { window?: Window }).window;
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers || {}).entries()),
      });
      return new Response('<!-- CursorRemote raw DOM export metadata: {"scope":"chat"} -->\n<html></html>', {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="cursor-dom-chat-2026-07-29.html"',
        },
      });
    }) as typeof fetch;

    try {
      const { downloadDomExport } = await import('../src/client/state/domExport.js');
      const filename = await downloadDomExport('chat', { windowId: 'win-1', composerId: 'composer-1' });
      assert.match(calls[0]?.url || '', /\/debug\/dom-export\?scope=chat/);
      assert.match(calls[0]?.url || '', /windowId=win-1/);
      assert.match(calls[0]?.url || '', /composerId=composer-1/);
      assert.equal(filename, 'cursor-dom-chat-2026-07-29.html');
    } finally {
      globalThis.fetch = previousFetch;
      Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true });
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
      dom.window.close();
    }
  });
});
