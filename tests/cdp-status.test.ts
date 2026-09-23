import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCdpFailure,
  isCdpEndpointListening,
  parseRemoteDebuggingPort,
  upsertArgvRemoteDebuggingPort,
} from '../src/shared/cdp-status.js';
import { shouldOfferCdpRestart } from '../src/shared/cdp-restart-prompt.js';
import {
  argvJsonPathFromGlobalStorage,
  resolveCursorExecutablePath,
  sanitizeCursorRelaunchEnv,
  workspaceLaunchArgsFrom,
} from '../src/shared/cursor-cdp-relaunch.js';
import { defaultCursorState } from '../src/client/state/remoteStateStore.js';
import { getConnectionUiState } from '../src/client/view-models/connectionState.js';

describe('cdp status', () => {
  it('classifies refused and HTTP/JSON failures', () => {
    const refused = classifyCdpFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }));
    assert.equal(refused.reason, 'unavailable');

    const http = classifyCdpFailure(new Error('CDP target discovery failed: HTTP 404'));
    assert.equal(http.reason, 'wrong_port');

    const json = classifyCdpFailure(new Error('CDP target discovery failed: invalid JSON'));
    assert.equal(json.reason, 'wrong_port');

    const noTarget = classifyCdpFailure(new Error('No suitable CDP target found'));
    assert.equal(noTarget.reason, 'no_target');
  });

  it('parses CDP port and upserts argv.json', () => {
    assert.equal(parseRemoteDebuggingPort('http://127.0.0.1:19222'), 19222);
    const next = upsertArgvRemoteDebuggingPort('{\n  "enable-crash-reporter": true\n}\n', 9222);
    assert.match(next, /"remote-debugging-port": 9222/);
    assert.match(next, /"enable-crash-reporter": true/);
  });

  it('sanitizes Electron/VS Code env and prefers .code-workspace launch args', () => {
    const env = sanitizeCursorRelaunchEnv({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      VSCODE_IPC_HOOK: '\\\\.\\pipe\\foo',
      VSCODE_PID: '12',
      USERPROFILE: 'C:\\Users\\me',
    });
    assert.equal(env.PATH, 'C:\\Windows');
    assert.equal(env.USERPROFILE, 'C:\\Users\\me');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
    assert.equal(env.VSCODE_IPC_HOOK, undefined);
    assert.equal(env.VSCODE_PID, undefined);

    assert.deepEqual(
      workspaceLaunchArgsFrom({
        workspaceFile: { scheme: 'file', fsPath: 'R:\\proj\\app.code-workspace' },
        workspaceFolders: [
          { uri: { scheme: 'file', fsPath: 'R:\\proj\\a' } },
          { uri: { scheme: 'file', fsPath: 'R:\\proj\\b' } },
        ],
      }),
      ['R:\\proj\\app.code-workspace'],
    );
    assert.deepEqual(
      workspaceLaunchArgsFrom({
        workspaceFile: { scheme: 'untitled', fsPath: 'untitled:1' },
        workspaceFolders: [{ uri: { scheme: 'file', fsPath: 'R:\\proj\\a' } }],
      }),
      ['R:\\proj\\a'],
    );

    const argvPath = argvJsonPathFromGlobalStorage(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\ext.id',
    );
    assert.match(argvPath.replace(/\\/g, '/'), /\/Cursor\/argv\.json$/);
  });

  it('resolves Cursor.exe from appRoot when execPath is Node', () => {
    const exe = resolveCursorExecutablePath({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      appRoot: 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\app',
      platform: 'win32',
      exists: (p) => p.replace(/\\/g, '/').endsWith('/Cursor.exe'),
    });
    assert.equal(
      exe,
      'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
    );
  });
});

describe('CDP restart prompt', () => {
  it('treats a target list as listening and failures as off', async () => {
    const up = await isCdpEndpointListening('http://127.0.0.1:9222/', async () => ({
      ok: true,
      json: async () => [{ type: 'page' }],
    }));
    assert.equal(up, true);

    const down = await isCdpEndpointListening('http://127.0.0.1:9222', async () => {
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    });
    assert.equal(down, false);

    const notCdp = await isCdpEndpointListening('http://127.0.0.1:9222', async () => ({
      ok: true,
      json: async () => ({ status: 'ok' }),
    }));
    assert.equal(notCdp, false);
  });

  it('asks only when the setting is on, CDP is down, and this launch has not asked yet', () => {
    assert.equal(shouldOfferCdpRestart({
      promptEnabled: true,
      cdpListening: false,
      alreadyClaimedThisLaunch: false,
    }), true);
    assert.equal(shouldOfferCdpRestart({
      promptEnabled: false,
      cdpListening: false,
      alreadyClaimedThisLaunch: false,
    }), false);
    assert.equal(shouldOfferCdpRestart({
      promptEnabled: true,
      cdpListening: true,
      alreadyClaimedThisLaunch: false,
    }), false);
    assert.equal(shouldOfferCdpRestart({
      promptEnabled: true,
      cdpListening: false,
      alreadyClaimedThisLaunch: true,
    }), false);
  });
});

describe('connection UI when CDP is down', () => {
  it('shows a concrete CDP reason and restart action', () => {
    const ui = getConnectionUiState({
      ...defaultCursorState,
      connected: false,
      cdpUrl: 'http://127.0.0.1:9222',
      cdpDisconnectReason: 'unavailable',
      cdpLastError: 'fetch failed',
    }, true);
    assert.equal(ui.showRestartCursorCdp, true);
    assert.equal(ui.label, 'CDP unavailable');
    assert.match(ui.emptyHint, /127\.0\.0\.1:9222/);
  });
});
