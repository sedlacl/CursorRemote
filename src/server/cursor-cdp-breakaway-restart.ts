import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  buildLauncherSpawnPlan,
  buildRelaunchLauncherSource,
  ensureArgvRemoteDebuggingPort,
  resolveArgvJsonPath,
  resolveCursorExecutableForRelay,
  type CursorCdpRelaunchConfig,
} from '../shared/cursor-cdp-breakaway-restart.js';

const LAUNCHER_NAME = 'cursor-cdp-relaunch.cjs';
const RELAUNCH_CONFIG_NAME = 'cursor-cdp-relaunch.json';
const RELAUNCH_LOG_NAME = 'cursor-cdp-relaunch.log';

export async function scheduleCursorCdpBreakawayRestart(input: {
  port: number;
  dataDir: string;
}): Promise<void> {
  const { port, dataDir } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid remote debugging port: ${port}`);
  }

  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Restart with CDP is not supported on ${platform}`);
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const argvPath = resolveArgvJsonPath(dataDir);
  const argvDir = dirname(argvPath);
  if (!existsSync(argvDir)) {
    mkdirSync(argvDir, { recursive: true });
  }
  ensureArgvRemoteDebuggingPort(
    argvPath,
    port,
    () => (existsSync(argvPath) ? readFileSync(argvPath, 'utf-8') : ''),
    (next) => writeFileSync(argvPath, next, 'utf-8'),
  );

  const exe = resolveCursorExecutableForRelay({
    execPath: process.execPath,
    exists: existsSync,
    localAppData: process.env.LOCALAPPDATA,
    cursorExecutableEnv: process.env.CURSOR_EXECUTABLE,
    cursorAppRootEnv: process.env.CURSOR_APP_ROOT,
  });
  if (!exe) {
    throw new Error(
      'Could not resolve Cursor executable. Set CURSOR_EXECUTABLE or run the relay from the installed extension.',
    );
  }

  const logPath = join(dataDir, RELAUNCH_LOG_NAME);
  const configPath = join(dataDir, RELAUNCH_CONFIG_NAME);
  const launcherPath = join(dataDir, LAUNCHER_NAME);
  const config: CursorCdpRelaunchConfig = {
    exe,
    port,
    logPath,
    graceMs: 2000,
    timeoutMs: 45000,
  };
  writeFileSync(launcherPath, buildRelaunchLauncherSource(), 'utf-8');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  writeFileSync(logPath, `${new Date().toISOString()} scheduled relaunch\n`, 'utf-8');

  const plan = buildLauncherSpawnPlan(process.execPath, launcherPath, configPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  console.log(`[relay] CDP relaunch launcher started (log=${logPath})`);
}
