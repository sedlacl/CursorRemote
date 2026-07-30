import 'dotenv/config';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveDiagnosticId } from './diagnostic-id-store.js';

export function getServerModuleDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

function moduleDir(): string {
  return getServerModuleDir();
}

function toDevBuildVersion(version: string, packageRoot: string): string {
  if (!version.includes('-local')) return version;

  const baseVersion = version.split(/[-+]/)[0] ?? version;
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: packageRoot,
      encoding: 'utf-8',
    }).trim();
    const dirty = execSync('git status --porcelain', {
      cwd: packageRoot,
      encoding: 'utf-8',
    }).trim();
    return `${baseVersion}+${dirty ? `${hash}.dirty` : hash}`;
  } catch {
    return version;
  }
}

function loadPackageVersion(): string {
  const candidates = [
    process.env.PACKAGE_ROOT?.trim(),
    process.cwd(),
    join(moduleDir(), '..', '..'),
    join(moduleDir(), '..'),
  ].filter((value): value is string => !!value);

  for (const dir of candidates) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === 'cursor-remote' && pkg.version) {
        return toDevBuildVersion(pkg.version, dir);
      }
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
}

function loadDiagnosticId(): string {
  const dataDir = process.env.DATA_DIR?.trim() || resolve(process.cwd(), 'data');
  const resolved = resolveDiagnosticId({
    dataDir,
    workspace: process.cwd(),
    port: process.env.SERVER_PORT?.trim() || 'default',
    override: process.env.DIAGNOSTIC_ID,
  });
  console.log(
    `[diagnostic-id] ${resolved.id} (${resolved.source}${resolved.persisted ? '' : ', in-memory only'})`,
  );
  return resolved.id;
}

export const SERVER_INSTANCE = {
  instanceId: randomBytes(4).toString('hex'),
  /** Short Crockford base32 ID visible in the web UI and debug API; stable across restarts. */
  diagnosticId: loadDiagnosticId(),
  startedAt: Date.now(),
  pid: process.pid,
  version: loadPackageVersion(),
};
