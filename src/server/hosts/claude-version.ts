import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Detects the installed `anthropic.claude-code` extension version.
 *
 * Used as the gate on the `backgroundTasks` reader: the Map lives behind an
 * unminified property name in 2.1.x, but nothing guarantees it survives the
 * next bump. Reading the version from the extension folder name is enough —
 * the folders are `anthropic.claude-code-<version>-<platform>` and we only need
 * to know whether the probe has verified this exact version.
 */

const EXTENSION_PREFIX = 'anthropic.claude-code-';

/** Extension roots to search, in order. Cursor first, then plain VS Code. */
function extensionRoots(): string[] {
  const home = homedir();
  return [
    join(home, '.cursor', 'extensions'),
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
  ];
}

/**
 * Highest installed Claude Code version, or null when the extension is absent
 * or the folder name does not carry a parseable version.
 */
export function detectClaudeCodeVersion(): string | null {
  const found: string[] = [];

  for (const root of extensionRoots()) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const version = parseVersionFromFolder(entry);
      if (version) found.push(version);
    }
  }

  if (found.length === 0) return null;
  found.sort(compareVersions);
  return found[found.length - 1];
}

/** `anthropic.claude-code-2.1.278-win32-x64` → `2.1.278` */
export function parseVersionFromFolder(folderName: string): string | null {
  if (!folderName.startsWith(EXTENSION_PREFIX)) return null;
  const rest = folderName.slice(EXTENSION_PREFIX.length);
  const match = /^(\d+\.\d+\.\d+)/.exec(rest);
  return match ? match[1] : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
