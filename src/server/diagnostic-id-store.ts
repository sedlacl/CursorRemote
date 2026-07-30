import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  encodeCrockfordBase32,
  isValidDiagnosticId,
  normalizeDiagnosticId,
} from '../shared/diagnostic-id.js';

const FILE_NAME = 'diagnostic-id.json';
const FILE_VERSION = 1;
/** Keep the store small; oldest instances are dropped first. */
const MAX_ENTRIES = 16;

export interface DiagnosticIdEntry {
  id: string;
  workspace: string;
  port: string;
  updatedAt: string;
}

export interface ResolveDiagnosticIdOptions {
  /** Runtime data directory (same one used for sessions and license). */
  dataDir: string;
  /** Workspace root the relay serves; part of the instance key. */
  workspace: string;
  /** Listening port as configured; part of the instance key. */
  port: string;
  /** `DIAGNOSTIC_ID` env override — wins over the stored value, never persisted. */
  override?: string;
  now?: () => Date;
}

export interface ResolvedDiagnosticId {
  id: string;
  source: 'env' | 'stored' | 'generated';
  /** False when the ID lives only in memory (I/O failed or env override). */
  persisted: boolean;
}

interface DiagnosticIdFile {
  version: number;
  instances: Record<string, DiagnosticIdEntry>;
}

export function generateDiagnosticId(): string {
  return encodeCrockfordBase32(randomBytes(5));
}

export function diagnosticIdFilePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

/**
 * Instance key — two relays must never share an ID, so both the workspace and
 * the port take part. A port change therefore yields a fresh ID by design.
 */
export function diagnosticInstanceKey(workspace: string, port: string): string {
  const normalizedWorkspace = resolve(workspace).replace(/\\/g, '/').toLowerCase();
  return `${normalizedWorkspace}#${port}`;
}

function readFile(path: string): DiagnosticIdFile | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DiagnosticIdFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    const instances = parsed.instances;
    if (!instances || typeof instances !== 'object') return null;
    return { version: FILE_VERSION, instances: instances as Record<string, DiagnosticIdEntry> };
  } catch {
    return null;
  }
}

function readEntry(file: DiagnosticIdFile | null, key: string): DiagnosticIdEntry | null {
  const entry = file?.instances[key];
  if (!entry || typeof entry !== 'object') return null;
  if (!isValidDiagnosticId(entry.id)) return null;
  return entry;
}

function writeEntry(
  path: string,
  dataDir: string,
  file: DiagnosticIdFile | null,
  key: string,
  entry: DiagnosticIdEntry,
): boolean {
  try {
    const instances: Record<string, DiagnosticIdEntry> = {};
    for (const [existingKey, existing] of Object.entries(file?.instances ?? {})) {
      if (existingKey === key) continue;
      if (!isValidDiagnosticId(existing?.id)) continue;
      instances[existingKey] = existing;
    }
    instances[key] = entry;

    const pruned = Object.entries(instances)
      .sort(([, a], [, b]) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''))
      .slice(0, MAX_ENTRIES);

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ version: FILE_VERSION, instances: Object.fromEntries(pruned) }, null, 2)}\n`,
      'utf-8',
    );
    return true;
  } catch (error) {
    console.warn(`[diagnostic-id] Could not persist ID to ${path}:`, error);
    return false;
  }
}

/**
 * Resolve the diagnostic ID for this relay instance, reusing the one stored on
 * disk so it stays stable across restarts. Any I/O problem degrades to an
 * in-memory ID — diagnostics must never prevent the relay from starting.
 */
export function resolveDiagnosticId(options: ResolveDiagnosticIdOptions): ResolvedDiagnosticId {
  const now = options.now ?? (() => new Date());

  const override = options.override?.trim();
  if (override) {
    if (isValidDiagnosticId(override)) {
      return { id: normalizeDiagnosticId(override), source: 'env', persisted: false };
    }
    console.warn(`[diagnostic-id] Ignoring invalid DIAGNOSTIC_ID override "${override}"`);
  }

  const path = diagnosticIdFilePath(options.dataDir);
  const key = diagnosticInstanceKey(options.workspace, options.port);
  const file = readFile(path);
  const stored = readEntry(file, key);
  const id = stored ? normalizeDiagnosticId(stored.id) : generateDiagnosticId();

  const persisted = writeEntry(path, options.dataDir, file, key, {
    id,
    workspace: resolve(options.workspace),
    port: options.port,
    updatedAt: now().toISOString(),
  });

  return { id, source: stored ? 'stored' : 'generated', persisted };
}
