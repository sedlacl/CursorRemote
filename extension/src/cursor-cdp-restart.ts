import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import * as vscode from 'vscode';
import { upsertArgvRemoteDebuggingPort } from '../../src/shared/cdp-status.js';
import {
  argvJsonPathFromGlobalStorage,
  resolveCursorExecutablePath,
  workspaceLaunchArgsFrom,
} from '../../src/shared/cursor-cdp-relaunch.js';
import type { UnifiedOutputChannel } from './output-channel.js';

const RELAUNCH_SCRIPT_NAME = 'cursor-cdp-relaunch.cjs';
const RELAUNCH_CONFIG_NAME = 'cursor-cdp-relaunch.json';
const RELAUNCH_LOG_NAME = 'cursor-cdp-relaunch.log';

/** Standalone Node script: wait for Cursor PIDs to die, then spawn a GUI instance. */
const RELAUNCH_SCRIPT_SOURCE = `'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

function log(line) {
  try {
    fs.appendFileSync(cfg.logPath, new Date().toISOString() + ' ' + line + '\\n');
  } catch (_) { /* ignore */ }
}

function alive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(ELECTRON_|VSCODE_|PIPE_)/.test(key)) delete next[key];
  }
  return next;
}

(async () => {
  log('launcher start waitPids=' + JSON.stringify(cfg.waitPids) + ' exe=' + cfg.exe);
  const deadline = Date.now() + (cfg.timeoutMs || 45000);
  while (Date.now() < deadline) {
    const still = (cfg.waitPids || []).filter(alive);
    if (still.length === 0) break;
    await sleep(250);
  }
  const remaining = (cfg.waitPids || []).filter(alive);
  if (remaining.length) {
    log('timeout still alive pids=' + remaining.join(','));
  } else {
    log('parent processes exited');
  }
  await sleep(cfg.graceMs || 2000);
  const env = sanitize(process.env);
  log('spawning ' + cfg.exe + ' ' + JSON.stringify(cfg.args));
  const child = spawn(cfg.exe, cfg.args, {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: false,
  });
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
  log(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
`;

export { argvJsonPathFromGlobalStorage } from '../../src/shared/cursor-cdp-relaunch.js';

export function ensureArgvRemoteDebuggingPort(argvPath: string, port: number): void {
  const dir = dirname(argvPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const raw = existsSync(argvPath) ? readFileSync(argvPath, 'utf-8') : '';
  const next = upsertArgvRemoteDebuggingPort(raw, port);
  writeFileSync(argvPath, next, 'utf-8');
}

export function workspaceLaunchArgs(): string[] {
  return workspaceLaunchArgsFrom({
    workspaceFile: vscode.workspace.workspaceFile ?? null,
    workspaceFolders: vscode.workspace.workspaceFolders ?? [],
  });
}

export async function restartCursorWithRemoteDebugging(options: {
  port: number;
  globalStorageFsPath: string;
  output: UnifiedOutputChannel;
  appRoot?: string;
}): Promise<void> {
  const { port, globalStorageFsPath, output } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid remote debugging port: ${port}`);
  }

  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Restart with CDP is not supported on ${platform}`);
  }

  const argvPath = argvJsonPathFromGlobalStorage(globalStorageFsPath);
  ensureArgvRemoteDebuggingPort(argvPath, port);
  output.info(`[cdp-restart] Wrote remote-debugging-port=${port} to ${argvPath}`);

  const appRoot = options.appRoot ?? vscode.env.appRoot;
  const exe = resolveCursorExecutablePath({
    execPath: process.execPath,
    appRoot,
    platform,
    exists: existsSync,
  });
  if (!exe) {
    throw new Error(
      `Could not resolve Cursor executable (execPath=${process.execPath}, appRoot=${appRoot})`,
    );
  }

  output.info(
    `[cdp-restart] execPath=${process.execPath} ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? ''} resolvedExe=${exe} ppid=${process.ppid}`,
  );

  const dataDir = globalStorageFsPath;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const scriptPath = join(dataDir, RELAUNCH_SCRIPT_NAME);
  const configPath = join(dataDir, RELAUNCH_CONFIG_NAME);
  const logPath = join(dataDir, RELAUNCH_LOG_NAME);
  writeFileSync(scriptPath, RELAUNCH_SCRIPT_SOURCE, 'utf-8');

  const waitPids = [...new Set([process.ppid, process.pid].filter((pid) => pid > 0))];
  const config = {
    exe,
    args: [`--remote-debugging-port=${port}`, ...workspaceLaunchArgs()],
    waitPids,
    logPath,
    graceMs: 2000,
    timeoutMs: 45000,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  writeFileSync(logPath, `${new Date().toISOString()} scheduled relaunch\n`, 'utf-8');

  output.info(`[cdp-restart] Launching detached waiter; will quit after spawn. log=${logPath}`);

  const waiterEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, configPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: waiterEnv,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
