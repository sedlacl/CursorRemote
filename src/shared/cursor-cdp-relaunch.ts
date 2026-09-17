import { dirname, join } from 'path';

/** `argv.json` lives in the user-data dir (`%APPDATA%/Cursor`), not under `User/`. */
export function argvJsonPathFromGlobalStorage(globalStorageFsPath: string): string {
  return join(globalStorageFsPath, '..', '..', '..', 'argv.json');
}

const RELAUNCH_STRIP_ENV = /^(ELECTRON_|VSCODE_|PIPE_)/;
const NODE_EXE_RE = /(?:^|[/\\])node(?:\.exe)?$/i;

export function sanitizeCursorRelaunchEnv(
  env: NodeJS.Dict<string>,
): NodeJS.Dict<string> {
  const next: NodeJS.Dict<string> = { ...env };
  for (const key of Object.keys(next)) {
    if (RELAUNCH_STRIP_ENV.test(key)) {
      delete next[key];
    }
  }
  return next;
}

export interface WorkspaceLaunchInput {
  workspaceFile?: { scheme: string; fsPath: string } | null;
  workspaceFolders?: Array<{ uri: { scheme: 'file' | string; fsPath: string } }>;
}

/** CLI paths so a relaunch restores a named `.code-workspace` when present. */
export function workspaceLaunchArgsFrom(input: WorkspaceLaunchInput): string[] {
  const file = input.workspaceFile;
  if (file && file.scheme === 'file' && file.fsPath) {
    return [file.fsPath];
  }
  const args: string[] = [];
  for (const folder of input.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file' && folder.uri.fsPath) {
      args.push(folder.uri.fsPath);
    }
  }
  return args;
}

export function looksLikeNodeExecutable(execPath: string): boolean {
  return NODE_EXE_RE.test(execPath.replace(/\\/g, '/'));
}

export function resolveCursorExecutablePath(input: {
  execPath: string;
  appRoot?: string;
  platform: NodeJS.Platform | string;
  exists: (path: string) => boolean;
}): string | null {
  const { execPath, appRoot, platform, exists } = input;
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const exeName = win ? 'Cursor.exe' : 'Cursor';
  const candidates: string[] = [];

  if (execPath && !looksLikeNodeExecutable(execPath)) {
    candidates.push(execPath);
  }
  if (appRoot) {
    const installRoot = join(appRoot, '..', '..');
    candidates.push(join(installRoot, exeName));
    if (mac) {
      candidates.push(join(appRoot, '..', '..', 'MacOS', 'Cursor'));
    }
    if (!win && !mac) {
      candidates.push(join(installRoot, 'cursor'));
    }
  }
  if (execPath) {
    candidates.push(join(dirname(execPath), exeName));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}
