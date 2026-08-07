import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DomExportService } from '../src/server/dom-export.js';
import { DiagnosticSnapshotService } from '../src/server/diagnostic-snapshot.js';
import {
  UiReportError,
  UiReportService,
  buildUiReportAgentPrompt,
  decodeWebScreenshotPng,
  sanitizeUiReportNote,
} from '../src/server/ui-report.js';
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
  subagents: { runningCount: 0, summary: '', items: [] },
} as unknown as CursorState;

function createSnapshot(options: {
  holdChat?: Promise<void>;
  screenshotData?: string;
} = {}) {
  const domExport = new DomExportService(domSources, selectors, {
    clientFactory: () => ({
      connect: async () => {},
      disconnect: () => {},
      callFunctionWithTimeout: async (_fn, args) => {
        if (options.holdChat) await options.holdChat;
        const scope = String(args[0]);
        return {
          ok: true,
          html: `<div data-scope="${scope}">cursor</div>`,
          bytes: 40,
          composerId: 'composer-1',
        };
      },
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
      uptime: 12,
      clients: 1,
      activeWindowId: 'window-1',
      activeWindowTitle: 'Workspace',
      cdpUrl: 'http://127.0.0.1:9222',
    }),
    collectWebDom: async () => ({ reason: 'no_client', message: 'unused' }),
  }, {
    clientFactory: () => ({
      connect: async () => {},
      disconnect: () => {},
      send: async () => ({ data: options.screenshotData ?? Buffer.from('png').toString('base64') }),
    }),
  });
}

describe('UI report service', () => {
  const tempRoots: string[] = [];
  after(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitizes note and accepts PNG screenshot payload', () => {
    assert.equal(sanitizeUiReportNote('  hello\u0000world  '), 'helloworld');
    assert.equal(sanitizeUiReportNote('   '), undefined);
    assert.equal(sanitizeUiReportNote(null), undefined);
    assert.equal(sanitizeUiReportNote(1), undefined);
    const long = 'x'.repeat(2500);
    assert.equal(sanitizeUiReportNote(long)?.length, 2000);

    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const decoded = decodeWebScreenshotPng(tinyPng.toString('base64'));
    assert.ok(decoded && 'buffer' in decoded);
    assert.deepEqual([...decoded.buffer], [...tinyPng]);

    const fromDataUrl = decodeWebScreenshotPng(
      `data:image/png;base64,${tinyPng.toString('base64')}`,
    );
    assert.ok(fromDataUrl && 'buffer' in fromDataUrl);
    assert.equal(decodeWebScreenshotPng(null), null);
    assert.equal(decodeWebScreenshotPng(''), null);
    assert.deepEqual(decodeWebScreenshotPng('not!base64'), { error: 'web_screenshot_invalid' });
  });

  it('writes issue markdown and artifacts from client web DOM + screenshot + note', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-report-'));
    tempRoots.push(root);

    const service = new UiReportService(createSnapshot(), {
      packageRoot: root,
      diagnosticId: 'TESTID01',
      now: () => new Date('2026-08-06T10:00:00.000Z'),
      idFactory: () => 'REPORT01',
    });

    const webPng = Buffer.from('web-png-bytes');
    const result = await service.capture({
      diagnosticId: 'TESTID01',
      webDomHtml: '<html><body>web client</body></html>',
      clientUrl: 'http://192.168.1.10:3001/',
      userAgent: 'TestAgent/1.0',
      viewport: { width: 390, height: 844 },
      note: '  Copy JSON failed on iPhone  ',
      webScreenshotPngBase64: webPng.toString('base64'),
    });

    assert.equal(result.issueId, 'REPORT01');
    assert.equal(result.issuePath, 'docs/issues/2026-08-06-ui-report-REPORT01.md');
    assert.equal(result.artifactsDir, 'docs/issues/.artifacts/REPORT01');
    assert.equal(result.warnings.length, 0);

    const issue = readFileSync(join(root, result.issuePath), 'utf8');
    assert.match(issue, /Issue ID: REPORT01/);
    assert.match(issue, /## User note\n\nCopy JSON failed on iPhone/);
    assert.match(issue, /## Symptom\n\nCopy JSON failed on iPhone/);
    assert.match(issue, /web-dom\.html/);
    assert.match(issue, /web-screenshot\.png/);

    assert.match(
      readFileSync(join(root, result.artifactsDir, 'web-dom.html'), 'utf8'),
      /web client/,
    );
    assert.equal(
      readFileSync(join(root, result.artifactsDir, 'web-screenshot.png')).toString(),
      'web-png-bytes',
    );
    const meta = JSON.parse(readFileSync(join(root, result.artifactsDir, 'meta.json'), 'utf8'));
    assert.equal(meta.note, 'Copy JSON failed on iPhone');
    assert.equal(meta.webScreenshotBytes, webPng.length);

    const state = JSON.parse(readFileSync(join(root, result.artifactsDir, 'state.json'), 'utf8'));
    assert.equal(state.diagnostics.server.diagnosticId, 'TESTID01');
    assert.match(
      readFileSync(join(root, result.artifactsDir, 'cursor-dom-chat.html'), 'utf8'),
      /data-scope="chat"/,
    );
    assert.match(
      readFileSync(join(root, result.artifactsDir, 'cursor-dom-document.html'), 'utf8'),
      /data-scope="document"/,
    );
    assert.ok(readFileSync(join(root, result.artifactsDir, 'cursor-screenshot.png')).length > 0);

    const prompt = buildUiReportAgentPrompt({
      issueId: result.issueId,
      issuePath: result.issuePath,
      artifactsDir: result.artifactsDir,
    });
    assert.match(prompt, /CursorRemote UI report/);
    assert.match(prompt, /REPORT01/);
  });

  it('rejects empty note / empty web DOM and concurrent captures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-report-'));
    tempRoots.push(root);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new UiReportService(createSnapshot({ holdChat: gate }), {
      packageRoot: root,
      diagnosticId: 'TESTID01',
      idFactory: () => 'BUSY0001',
    });

    await assert.rejects(
      () => service.capture({ diagnosticId: 'TESTID01', webDomHtml: '<html/>', note: '   ' }),
      (error: unknown) => error instanceof UiReportError && error.code === 'note_required',
    );

    await assert.rejects(
      () => service.capture({ diagnosticId: 'TESTID01', webDomHtml: '   ', note: 'x' }),
      (error: unknown) => error instanceof UiReportError && error.code === 'web_dom_required',
    );

    const first = service.capture({
      diagnosticId: 'TESTID01',
      webDomHtml: '<html/>',
      note: 'busy race',
    });
    await assert.rejects(
      () => service.capture({ diagnosticId: 'TESTID01', webDomHtml: '<html/>', note: 'busy race' }),
      (error: unknown) => error instanceof UiReportError && error.code === 'ui_report_busy',
    );
    release();
    const busyResult = await first;
    assert.ok(busyResult.warnings.some((w) => w.startsWith('web-screenshot:')));
  });
});
