import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function baseVersion(version: string): string {
  return version.split(/[-+]/)[0] ?? version;
}

async function importFreshServerInfo() {
  const moduleUrl = pathToFileURL(resolve('src/server/server-info.ts')).href;
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test('SERVER_INSTANCE.version appends git build id only for -local workspace packages', async () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string };
  const previousPackageRoot = process.env.PACKAGE_ROOT;
  process.env.PACKAGE_ROOT = resolve('.');
  // Keep the diagnostic ID store out of the repo data dir.
  const previousDataDir = process.env.DATA_DIR;
  const tempDataDir = mkdtempSync(join(tmpdir(), 'cursor-remote-server-info-'));
  process.env.DATA_DIR = tempDataDir;

  try {
    const serverInfo = await importFreshServerInfo();
    if (pkg.version.includes('-local')) {
      assert.match(
        serverInfo.SERVER_INSTANCE.version,
        new RegExp(`^${baseVersion(pkg.version)}\\+[0-9a-f]+(?:\\.dirty)?$`),
      );
    } else {
      // Release versions ship as-is so the VSIX and the reported version stay identical.
      assert.equal(serverInfo.SERVER_INSTANCE.version, pkg.version);
    }
  } finally {
    if (previousPackageRoot === undefined) {
      delete process.env.PACKAGE_ROOT;
    } else {
      process.env.PACKAGE_ROOT = previousPackageRoot;
    }
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  }
});
