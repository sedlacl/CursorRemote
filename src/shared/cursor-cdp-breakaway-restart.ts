import { join } from 'path';
import { upsertArgvRemoteDebuggingPort } from './cdp-status.js';
import {
  argvJsonPathFromGlobalStorage,
  resolveCursorExecutablePath,
  sanitizeCursorRelaunchEnv,
} from './cursor-cdp-relaunch.js';

export interface CursorCdpRelaunchConfig {
  exe: string;
  port: number;
  logPath: string;
  graceMs: number;
  timeoutMs: number;
}

export interface BreakawaySpawnPlan {
  executable: string;
  args: string[];
}

/**
 * `tasklist /FO CSV /NH` rows look like `"Cursor.exe","1234","Console","1","500 K"`.
 * Embedded verbatim into the generated launcher, so it must stay self-contained.
 */
export function parseTasklistPids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const pid = Number(fields[1].replace(/"/g, '').trim());
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Matches `ps -A -o pid=,comm=,args=` rows by process name or by the resolved
 * executable path, so AppImage builds named after the image are found too.
 * Embedded verbatim into the generated launcher, so it must stay self-contained.
 */
export function parseUnixPids(stdout: string, exeName: string, exePath: string): number[] {
  const pids: number[] = [];
  const wantedName = exeName.toLowerCase();
  const wantedPath = exePath.toLowerCase();
  for (const line of stdout.split(/\r?\n/)) {
    const row = line.trim();
    if (!row) continue;
    const match = row.match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const comm = match[2].toLowerCase();
    const args = match[3].toLowerCase();
    const commName = comm.slice(comm.lastIndexOf('/') + 1);
    const hitName = commName === wantedName;
    const hitPath = args === wantedPath || args.startsWith(wantedPath + ' ');
    if (hitName || hitPath) pids.push(pid);
  }
  return pids;
}

export function resolveArgvJsonPath(dataDir: string): string {
  const normalized = dataDir.replace(/\\/g, '/');
  if (normalized.includes('/globalStorage/')) {
    return argvJsonPathFromGlobalStorage(dataDir);
  }
  if (process.env.APPDATA) {
    return join(process.env.APPDATA, 'Cursor', 'argv.json');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      return join(home, 'Library', 'Application Support', 'Cursor', 'argv.json');
    }
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? join(process.env.HOME, '.config') : '');
  if (xdg) {
    return join(xdg, 'Cursor', 'argv.json');
  }
  return join(dataDir, 'argv.json');
}

export function ensureArgvRemoteDebuggingPort(argvPath: string, port: number, readRaw: () => string, writeRaw: (next: string) => void): void {
  const raw = readRaw();
  const next = upsertArgvRemoteDebuggingPort(raw, port);
  writeRaw(next);
}

export function resolveCursorExecutableForRelay(input: {
  execPath: string;
  exists: (path: string) => boolean;
  localAppData?: string;
  cursorExecutableEnv?: string;
  cursorAppRootEnv?: string;
}): string | null {
  const fromEnv = input.cursorExecutableEnv?.trim();
  if (fromEnv && input.exists(fromEnv)) {
    return fromEnv;
  }

  const resolved = resolveCursorExecutablePath({
    execPath: input.execPath,
    appRoot: input.cursorAppRootEnv,
    platform: process.platform,
    exists: input.exists,
  });
  if (resolved) {
    return resolved;
  }

  if (process.platform === 'win32' && input.localAppData) {
    const candidate = join(input.localAppData, 'Programs', 'cursor', 'Cursor.exe');
    if (input.exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * The launcher runs under the relay's own Node-capable binary, which in an
 * installed extension is Cursor itself in `ELECTRON_RUN_AS_NODE` mode. It may
 * therefore never kill by image name — only the enumerated PIDs minus its own.
 */
export function buildRelaunchLauncherSource(): string {
  return `'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const selfPid = process.pid;

const parseTasklistPids = ${parseTasklistPids.toString()};
const parseUnixPids = ${parseUnixPids.toString()};

function log(line) {
  try {
    fs.appendFileSync(cfg.logPath, new Date().toISOString() + ' ' + line + '\\n');
  } catch (_) { /* ignore */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listTargets() {
  const exeName = path.basename(cfg.exe);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + exeName, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return parseTasklistPids(out).filter((pid) => pid !== selfPid);
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,comm=,args='], { encoding: 'utf8' });
    return parseUnixPids(out, exeName, cfg.exe).filter((pid) => pid !== selfPid);
  } catch (err) {
    log('enumerate failed ' + (err && err.message ? err.message : String(err)));
    return [];
  }
}

function killPid(pid, force) {
  if (pid === selfPid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (_) { /* already gone or not ours */ }
}

(async () => {
  log('launcher start pid=' + selfPid + ' exe=' + cfg.exe);
  const deadline = Date.now() + (cfg.timeoutMs || 45000);
  let attempts = 0;
  for (;;) {
    const pids = listTargets();
    if (pids.length === 0) {
      log('no target process left');
      break;
    }
    if (Date.now() > deadline) {
      log('timeout, still alive pids=' + pids.join(','));
      break;
    }
    attempts += 1;
    for (const pid of pids) killPid(pid, attempts > 5);
    await sleep(300);
  }

  await sleep(cfg.graceMs || 2000);

  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_|VSCODE_|PIPE_)/.test(key)) delete env[key];
  }

  const args = ['--remote-debugging-port=' + cfg.port];
  log('spawning ' + cfg.exe + ' ' + args.join(' '));
  const child = spawn(cfg.exe, args, { detached: true, stdio: 'ignore', env });
  child.once('error', (err) => {
    log('spawn error ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
  child.once('spawn', () => {
    child.unref();
    log('spawned pid=' + child.pid);
    process.exit(0);
  });
})().catch((err) => {
  log('fatal ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
`;
}

/**
 * `windowsHide` makes Node pass `CREATE_NO_WINDOW`, so no console appears; the
 * config path must be `argv[2]`, since `argv[1]` is the launcher script itself.
 */
export function buildLauncherSpawnPlan(
  execPath: string,
  launcherPath: string,
  configPath: string,
): BreakawaySpawnPlan {
  return {
    executable: execPath,
    args: [launcherPath, configPath],
  };
}

export { sanitizeCursorRelaunchEnv };
