import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBreakawaySpawnDoesNotUseCursorImage,
  buildWindowsBreakawaySpawn,
  buildWindowsRelaunchScriptBody,
  resolveArgvJsonPath,
  resolveCursorExecutableForRelay,
} from '../src/shared/cursor-cdp-breakaway-restart.js';

describe('cursor CDP breakaway restart', () => {
  it('builds a Windows breakaway spawn via cmd and powershell, not Cursor.exe', () => {
    const plan = buildWindowsBreakawaySpawn(
      'C:\\temp\\relaunch.ps1',
      'C:\\temp\\relaunch.json',
      'C:\\Windows\\System32\\cmd.exe',
    );
    assert.match(plan.executable.replace(/\\/g, '/'), /cmd\.exe$/i);
    assert.ok(plan.args.includes('powershell.exe'));
    assert.ok(plan.args.includes('-ConfigPath'));
    assert.equal(plan.args.includes('C:\\temp\\relaunch.json'), true);
    assert.equal(plan.args.some((arg) => /cursor\.exe$/i.test(arg)), false);
    assertBreakawaySpawnDoesNotUseCursorImage(plan);
  });

  it('rejects breakaway plans that invoke Cursor.exe directly', () => {
    assert.throws(() => assertBreakawaySpawnDoesNotUseCursorImage({
      executable: 'C:\\Apps\\Cursor.exe',
      args: [],
    }));
  });

  it('resolves argv.json from extension globalStorage data dir', () => {
    const path = resolveArgvJsonPath(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\qjohn.cursor-remote',
    );
    assert.match(path.replace(/\\/g, '/'), /\/Cursor\/argv\.json$/);
  });

  it('includes mandatory ConfigPath in generated PowerShell launcher', () => {
    const body = buildWindowsRelaunchScriptBody();
    assert.match(body, /param\(\s*\[Parameter\(Mandatory = \$true\)\]/);
    assert.match(body, /\[string\]\$ConfigPath/);
    assert.match(body, /taskkill\.exe \/IM Cursor\.exe \/F/);
    assert.match(body, /breakaway launcher start/);
  });

  it('resolves Cursor.exe from LOCALAPPDATA when execPath is Node', () => {
    const exe = resolveCursorExecutableForRelay({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      exists: (p) => p.replace(/\\/g, '/').endsWith('/Programs/cursor/Cursor.exe'),
      localAppData: 'C:\\Users\\me\\AppData\\Local',
    });
    assert.equal(exe, 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe');
  });
});
