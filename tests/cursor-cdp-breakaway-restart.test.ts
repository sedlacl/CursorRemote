import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildLauncherSpawnPlan,
  buildRelaunchLauncherSource,
  parseTasklistPids,
  parseUnixPids,
  resolveArgvJsonPath,
  resolveCursorExecutableForRelay,
} from '../src/shared/cursor-cdp-breakaway-restart.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-relaunch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    // The relaunched stand-in may still hold its image open for a moment.
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

describe('cursor CDP relaunch launcher', () => {
  it('reads the config from argv[2], because argv[1] is the launcher itself', () => {
    const source = buildRelaunchLauncherSource();
    assert.match(source, /const configPath = process\.argv\[2\];/);
    assert.doesNotMatch(source, /process\.argv\[1\]/);

    const plan = buildLauncherSpawnPlan('C:\\Apps\\Cursor.exe', 'C:\\data\\relaunch.cjs', 'C:\\data\\relaunch.json');
    assert.deepEqual(plan.args, ['C:\\data\\relaunch.cjs', 'C:\\data\\relaunch.json']);
  });

  it('kills by enumerated PID and never by image name, so it cannot kill itself', () => {
    const source = buildRelaunchLauncherSource();
    assert.match(source, /\/PID', String\(pid\)/);
    assert.doesNotMatch(source, /\/IM/);
    assert.match(source, /if \(pid === selfPid\) return;/);
    assert.match(source, /filter\(\(pid\) => pid !== selfPid\)/);
  });

  it('parses tasklist CSV rows into PIDs', () => {
    const pids = parseTasklistPids(
      '"Cursor.exe","1234","Console","1","500 K"\r\n"Cursor.exe","5678","Console","1","12 K"\r\n',
    );
    assert.deepEqual(pids, [1234, 5678]);
    assert.deepEqual(parseTasklistPids('INFO: No tasks are running.\r\n'), []);
  });

  it('matches an AppImage by path, since its name exceeds the comm limit', () => {
    const ps = [
      '  901 Cursor-1.2.3-x8 /home/me/Apps/Cursor-1.2.3-x86_64.AppImage --no-sandbox',
      '  902 node            /usr/bin/node /srv/relay.js',
      '  903 cursor          /usr/share/cursor/cursor --type=renderer',
    ].join('\n');

    assert.deepEqual(
      parseUnixPids(ps, 'Cursor-1.2.3-x86_64.AppImage', '/home/me/Apps/Cursor-1.2.3-x86_64.AppImage'),
      [901],
    );
    assert.deepEqual(parseUnixPids(ps, 'cursor', '/usr/share/cursor/cursor'), [903]);
  });

  it('resolves argv.json from the extension globalStorage data dir', () => {
    const path = resolveArgvJsonPath(
      'C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\globalStorage\\qjohn.cursor-remote',
    );
    assert.match(path.replace(/\\/g, '/'), /\/Cursor\/argv\.json$/);
  });

  it('resolves Cursor.exe from LOCALAPPDATA when execPath is Node', () => {
    const exe = resolveCursorExecutableForRelay({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      exists: (p) => p.replace(/\\/g, '/').endsWith('/Programs/cursor/Cursor.exe'),
      localAppData: 'C:\\Users\\me\\AppData\\Local',
    });
    assert.equal(exe, 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe');
  });

  it('runs end to end against a stand-in executable and relaunches it', () => {
    const dir = makeTempDir();
    const launcherPath = join(dir, 'relaunch.cjs');
    const configPath = join(dir, 'relaunch.json');
    const logPath = join(dir, 'relaunch.log');

    // A uniquely named copy: nothing by that image name runs, so no process is killed.
    const isWindows = process.platform === 'win32';
    const source = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe') : '/bin/echo';
    const exe = join(dir, `cursor-remote-standin${isWindows ? '.exe' : ''}`);
    copyFileSync(source, exe);
    if (!isWindows) chmodSync(exe, 0o755);

    writeFileSync(launcherPath, buildRelaunchLauncherSource(), 'utf-8');
    writeFileSync(
      configPath,
      JSON.stringify({ exe, port: 9222, logPath, graceMs: 10, timeoutMs: 1000 }),
      'utf-8',
    );

    execFileSync(process.execPath, [launcherPath, configPath], { timeout: 30_000 });

    const log = readFileSync(logPath, 'utf-8');
    assert.match(log, /launcher start pid=\d+/);
    assert.match(log, /no target process left/);
    assert.match(log, /spawned pid=\d+/);
    assert.doesNotMatch(log, /spawn error/);
  });
});
