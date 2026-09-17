import { basename, join } from 'path';
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

const CURSOR_IMAGE_RE = /cursor\.exe$/i;

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

export function buildWindowsBreakawaySpawn(
  scriptPath: string,
  configPath: string,
  comspec = 'cmd.exe',
): BreakawaySpawnPlan {
  return {
    executable: comspec,
    args: [
      '/c',
      'start',
      '',
      '/min',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ConfigPath',
      configPath,
    ],
  };
}

export function buildUnixBreakawaySpawn(scriptPath: string): BreakawaySpawnPlan {
  return {
    executable: '/bin/sh',
    args: [scriptPath],
  };
}

export function assertBreakawaySpawnDoesNotUseCursorImage(plan: BreakawaySpawnPlan): void {
  const exeBase = basename(plan.executable);
  if (CURSOR_IMAGE_RE.test(exeBase)) {
    throw new Error(`Breakaway launcher must not use Cursor as its executable: ${plan.executable}`);
  }
  for (const arg of plan.args) {
    const base = basename(arg);
    if (CURSOR_IMAGE_RE.test(base)) {
      throw new Error(`Breakaway launcher args must not invoke Cursor.exe directly: ${arg}`);
    }
  }
}

export function buildWindowsRelaunchScriptBody(): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = 'SilentlyContinue'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

function Write-Log([string]$Line) {
  try {
    Add-Content -LiteralPath $cfg.logPath -Value ((Get-Date).ToString('o') + ' ' + $Line)
  } catch {}
}

Write-Log 'breakaway launcher start'
Start-Sleep -Seconds 2

$deadline = (Get-Date).AddMilliseconds([int]$cfg.timeoutMs)
do {
  $alive = @(Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue)
  if ($alive.Count -eq 0) { break }
  & taskkill.exe /IM Cursor.exe /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

Start-Sleep -Milliseconds ([int]$cfg.graceMs)

Get-ChildItem Env: | Where-Object { $_.Name -match '^(ELECTRON_|VSCODE_|PIPE_)' } | ForEach-Object {
  Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}

$arg = '--remote-debugging-port=' + [string]$cfg.port
Write-Log ('spawning ' + $cfg.exe + ' ' + $arg)
Start-Process -FilePath $cfg.exe -ArgumentList $arg | Out-Null
Write-Log 'spawned'
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildUnixRelaunchScriptBody(
  config: CursorCdpRelaunchConfig,
  platform: 'darwin' | 'linux' | string,
): string {
  const killPattern = platform === 'darwin' ? 'Cursor' : 'cursor';
  const exe = shellSingleQuote(config.exe);
  const logPath = shellSingleQuote(config.logPath);
  const graceSec = config.graceMs / 1000;
  const timeoutSec = Math.ceil(config.timeoutMs / 1000);
  return `#!/bin/sh
set -e
EXE=${exe}
PORT=${config.port}
LOG=${logPath}
GRACE=${graceSec}
TIMEOUT=${timeoutSec}
KILL_PATTERN=${killPattern}

log() { echo "$(date -Iseconds) $1" >> "$LOG" 2>/dev/null || true; }
log "breakaway launcher start"
sleep 2

end=$(($(date +%s) + TIMEOUT))
while [ "$(date +%s)" -le "$end" ]; do
  if ! pgrep -x "$KILL_PATTERN" >/dev/null 2>&1; then
    break
  fi
  killall "$KILL_PATTERN" 2>/dev/null || pkill -x "$KILL_PATTERN" 2>/dev/null || true
  sleep 0.3
done

sleep "$GRACE"

for key in $(env | cut -d= -f1); do
  case "$key" in ELECTRON_*|VSCODE_*|PIPE_*) unset "$key";; esac
done

log "spawning $EXE --remote-debugging-port=$PORT"
"$EXE" --remote-debugging-port="$PORT" &
log "spawned"
`;
}

export { sanitizeCursorRelaunchEnv };
