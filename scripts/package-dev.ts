import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { devPackageVersion, versionForFilename } from './version-utils.js';

const ROOT = resolve(process.cwd());
const PKG_PATH = resolve(ROOT, 'package.json');
const RELEASES_DIR = resolve(ROOT, 'releases');

const DEV_PUBLISHER = 'cursor-remote-dev';
const DEV_DISPLAY_NAME = 'QJohn CursorRemote (Dev)';

function main(): void {
  const backup = readFileSync(PKG_PATH, 'utf-8');
  const pkg = JSON.parse(backup) as Record<string, unknown>;
  const devVersion = devPackageVersion(String(pkg.version));

  const devPkg = {
    ...pkg,
    version: devVersion,
    publisher: DEV_PUBLISHER,
    displayName: DEV_DISPLAY_NAME,
  };

  writeFileSync(PKG_PATH, JSON.stringify(devPkg, null, 2) + '\n', 'utf-8');

  const vsixName = `cursor-remote-dev-${versionForFilename(devVersion)}.vsix`;
  const vsixPath = resolve(RELEASES_DIR, vsixName);

  try {
    console.log(`[package:dev] Building QJohn CursorRemote (Dev) v${devVersion}`);
    execSync('npm run build && npm run build:ext', { cwd: ROOT, stdio: 'inherit' });

    if (!existsSync(RELEASES_DIR)) mkdirSync(RELEASES_DIR, { recursive: true });

    execSync(
      `npx @vscode/vsce package --no-dependencies --out ${JSON.stringify(vsixPath)}`,
      { cwd: ROOT, stdio: 'inherit' },
    );

    console.log(`\n[package:dev] ✓ ${vsixPath}`);
    console.log(`[package:dev] Install: cursor --install-extension ${vsixName}`);
    console.log(`[package:dev] Extension ID: ${DEV_PUBLISHER}.${String(pkg.name)} (no marketplace updates)`);
  } finally {
    writeFileSync(PKG_PATH, backup, 'utf-8');
  }
}

main();
