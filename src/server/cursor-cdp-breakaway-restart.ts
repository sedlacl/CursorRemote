import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  assertBreakawaySpawnDoesNotUseCursorImage,
  buildUnixBreakawaySpawn,
  buildUnixRelaunchScriptBody,
  buildWindowsBreakawaySpawn,
  buildWindowsRelaunchScriptBody,
  ensureArgvRemoteDebuggingPort,
  resolveArgvJsonPath,
  resolveCursorExecutableForRelay,
  type CursorCdpRelaunchConfig,
} from '../shared/cursor-cdp-breakaway-restart.js';

const RELAUNCH_SCRIPT_NAME = 'cursor-cdp-breakaway-relaunch.ps1';
const RELAUNCH_SCRIPT_UNIX_NAME = 'cursor-cdp-breakaway-relaunch.sh';
const RELAUNCH_CONFIG_NAME = 'cursor-cdp-breakaway-relaunch.json';
const RELAUNCH_LOG_NAME = 'cursor-cdp-relaunch.log';

export async function scheduleCursorCdpBreakawayRestart(input: {
  port: number;
  dataDir: string;
}): Promise<void> {
  const { port, dataDir } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid remote debugging port: ${port}`);
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
  const config: CursorCdpRelaunchConfig = {
    exe,
    port,
    logPath,
    graceMs: 2000,
    timeoutMs: 45000,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  writeFileSync(logPath, `${new Date().toISOString()} scheduled breakaway relaunch\n`, 'utf-8');

  const platform = process.platform;
  let plan;
  if (platform === 'win32') {
    const scriptPath = join(dataDir, RELAUNCH_SCRIPT_NAME);
    writeFileSync(scriptPath, buildWindowsRelaunchScriptBody(), 'utf-8');
    plan = buildWindowsBreakawaySpawn(scriptPath, configPath, process.env.ComSpec ?? 'cmd.exe');
  } else if (platform === 'darwin' || platform === 'linux') {
    const scriptPath = join(dataDir, RELAUNCH_SCRIPT_UNIX_NAME);
    writeFileSync(scriptPath, buildUnixRelaunchScriptBody(config, platform), 'utf-8');
    chmodSync(scriptPath, 0o755);
    plan = buildUnixBreakawaySpawn(scriptPath);
  } else {
    throw new Error(`Restart with CDP is not supported on ${platform}`);
  }

  assertBreakawaySpawnDoesNotUseCursorImage(plan);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

  console.log(`[relay] Breakaway CDP relaunch scheduled (log=${logPath})`);
}
