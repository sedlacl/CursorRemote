import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { devPackageVersion, versionForFilename } from './version-utils.js';

const ROOT = resolve(process.cwd());
const PKG_PATH = resolve(ROOT, 'package.json');
const RELEASES_DIR = resolve(ROOT, 'releases');

function resolveCursorCli(): string {
  if (process.env.CURSOR_CLI?.trim()) return process.env.CURSOR_CLI.trim();
  return process.platform === 'win32' ? 'cursor.cmd' : 'cursor';
}

function main(): void {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { version: string };
  const devVersion = devPackageVersion(pkg.version);
  const vsixPath = resolve(RELEASES_DIR, `cursor-remote-dev-${versionForFilename(devVersion)}.vsix`);

  execSync('npm run package:dev', { cwd: ROOT, stdio: 'inherit' });

  if (!existsSync(vsixPath)) {
    throw new Error(`VSIX not found after build: ${vsixPath}`);
  }

  const cursor = resolveCursorCli();
  console.log(`\n[cursor-install] Installing ${vsixPath}`);
  execSync(`${cursor} --install-extension ${JSON.stringify(vsixPath)} --force`, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  console.log(`[cursor-install] ✓ Installed QJohn CursorRemote (Dev) v${devVersion}`);
}

main();
