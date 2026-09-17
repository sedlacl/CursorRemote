import {
  readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync,
  readdirSync, statSync, copyFileSync, rmSync, lstatSync,
} from 'fs';
import { execSync } from 'child_process';
import { resolve, join, relative, sep, dirname } from 'path';
import { parseBaseSemver } from './version-utils.js';
import { MARKETPLACE_PUBLISHER, MARKETPLACE_DISPLAY_NAME } from './marketplace-identity.js';

const DEV_ROOT = resolve(process.cwd());
const PKG_PATH = resolve(DEV_ROOT, 'package.json');
const CHANGELOG_PATH = resolve(DEV_ROOT, 'CHANGELOG.md');

const EXCLUDE = [
  'temp/',
  'temp2',
  '.cursor/',
  '.claude/',
  'marketing/',
  '.git/',
  'node_modules/',
  'dist/',
  'data/',
  'releases/',
  '.env',
  'scripts/generate-keys.ts',
  'azure_token',
  'openvsx_token',
  '*.vsix',
];

export function resolvePublicRoot(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): string {
  const flagIdx = argv.indexOf('--public-root');
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    return resolve(argv[flagIdx + 1]);
  }
  if (env.CURSORREMOTE_PUBLIC_ROOT?.trim()) {
    return resolve(env.CURSORREMOTE_PUBLIC_ROOT.trim());
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new Error(
      'Cannot resolve public repo path: HOME and USERPROFILE are empty. Set CURSORREMOTE_PUBLIC_ROOT.',
    );
  }
  return resolve(home, 'Dev', 'CursorRemote');
}

export function toPosixRel(rel: string): string {
  return rel.split(sep).join('/');
}

export function isExcludedPath(relPosix: string): boolean {
  const n = relPosix.replace(/^\.\//, '');
  if (!n) return false;
  for (const pattern of EXCLUDE) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (n.endsWith(suffix) && !n.endsWith('/')) return true;
      continue;
    }
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (n === dir || n.startsWith(dir + '/')) return true;
      continue;
    }
    if (n === pattern || n.startsWith(pattern + '/')) return true;
  }
  return false;
}

export function assertPublicRepo(publicRoot: string, devRoot: string = DEV_ROOT): void {
  if (!existsSync(publicRoot)) {
    console.error(`✗ public repo not found at ${publicRoot}, set CURSORREMOTE_PUBLIC_ROOT`);
    process.exit(1);
  }
  if (!existsSync(join(publicRoot, '.git'))) {
    console.error(`✗ ${publicRoot} exists but is not a git repository. Refusing to sync or delete.`);
    console.error('  Clone the public CursorRemote repo there, or set CURSORREMOTE_PUBLIC_ROOT to that clone.');
    process.exit(1);
  }
  const pubReal = resolve(publicRoot);
  const devReal = resolve(devRoot);
  if (pubReal === devReal) {
    console.error('✗ Public repo path is the same as the dev repo. Refusing to sync (would delete excluded files).');
    process.exit(1);
  }
}

function getVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return parseBaseSemver(pkg.version as string).base;
}

function normalizePublicPackageJson(publicRoot: string): void {
  const pkgPath = resolve(publicRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  pkg.publisher = MARKETPLACE_PUBLISHER;
  pkg.displayName = MARKETPLACE_DISPLAY_NAME;
  pkg.version = parseBaseSemver(String(pkg.version)).base;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✓ Normalized public package.json for marketplace (publisher ${MARKETPLACE_PUBLISHER})`);
}

function getChangelogSection(version: string): string {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);
  if (start === -1) return '';

  const afterHeader = changelog.indexOf('\n', start);
  const nextSection = changelog.indexOf('\n## [', afterHeader + 1);
  const body = nextSection === -1
    ? changelog.slice(afterHeader + 1)
    : changelog.slice(afterHeader + 1, nextSection);

  return body.trim();
}

function devTreeClean(): boolean {
  const status = execSync('git status --porcelain', { cwd: DEV_ROOT, encoding: 'utf-8' });
  return status.trim().length === 0;
}

function walkFiles(root: string, out: string[] = [], base = root): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const rel = toPosixRel(relative(base, full));
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (isExcludedPath(rel + '/')) continue;
      walkFiles(full, out, base);
    } else if (st.isFile()) {
      if (!isExcludedPath(rel)) out.push(rel);
    }
  }
  return out;
}

function walkAllRel(root: string, out: string[] = [], base = root): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const rel = toPosixRel(relative(base, full));
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (st.isDirectory()) {
      out.push(rel);
      walkAllRel(full, out, base);
    } else {
      out.push(rel);
    }
  }
  return out;
}

function syncToPublic(publicRoot: string): void {
  assertPublicRepo(publicRoot);
  console.log(`\n$ node-sync ${DEV_ROOT} → ${publicRoot} (exclude ${EXCLUDE.length} patterns, delete extras except excluded/.git)\n`);

  const srcFiles = walkFiles(DEV_ROOT);
  for (const rel of srcFiles) {
    const from = join(DEV_ROOT, rel);
    const to = join(publicRoot, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  const destRels = walkAllRel(publicRoot);
  const srcSet = new Set(srcFiles);
  const destDirs: string[] = [];
  for (const rel of destRels) {
    if (isExcludedPath(rel) || isExcludedPath(rel + '/')) continue;
    const destPath = join(publicRoot, rel);
    const st = statSync(destPath);
    if (st.isDirectory()) {
      destDirs.push(rel);
      continue;
    }
    if (!srcSet.has(rel)) {
      rmSync(destPath, { force: true });
    }
  }
  destDirs.sort((a, b) => b.length - a.length);
  for (const rel of destDirs) {
    const destPath = join(publicRoot, rel);
    try {
      if (readdirSync(destPath).length === 0) rmSync(destPath, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
}

function publicDiffSummary(publicRoot: string): string {
  return execSync('git diff --stat && echo "---" && git diff --cached --stat && echo "---" && git status --short', {
    cwd: publicRoot,
    encoding: 'utf-8',
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  });
}

function publicHasChanges(publicRoot: string): boolean {
  execSync('git add -A', { cwd: publicRoot, stdio: 'inherit' });
  const status = execSync('git status --porcelain', { cwd: publicRoot, encoding: 'utf-8' });
  return status.trim().length > 0;
}

function ensureTag(version: string, cwd: string, label: string): void {
  try {
    execSync(`git tag v${version}`, { cwd, stdio: 'inherit' });
    console.log(`✓ Tagged v${version} in ${label}`);
  } catch {
    console.log(`⚠ Tag v${version} already exists in ${label}, skipping`);
  }
}

function commitAndTag(version: string, body: string, publicRoot: string): void {
  const message = body ? `v${version}\n\n${body}` : `v${version}`;
  const msgFile = resolve(publicRoot, '.git', 'COMMIT_MSG_TMP');
  writeFileSync(msgFile, message, 'utf-8');
  try {
    execSync(`git commit -F ${JSON.stringify(msgFile)}`, { cwd: publicRoot, stdio: 'inherit' });
  } finally {
    try { unlinkSync(msgFile); } catch {}
  }

  ensureTag(version, publicRoot, 'public');
  ensureTag(version, DEV_ROOT, 'dev');
}

const OVSX_TOKEN_PATH = resolve(DEV_ROOT, 'openvsx_token');
const RELEASES_DIR = resolve(DEV_ROOT, 'releases');

function vsixPath(version: string): string {
  return resolve(RELEASES_DIR, `cursor-remote-${version}.vsix`);
}

function withMarketplacePackageJson<T>(fn: () => T): T {
  const backup = readFileSync(PKG_PATH, 'utf-8');
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    writeFileSync(PKG_PATH, backup, 'utf-8');
  };
  const pkg = JSON.parse(backup) as Record<string, unknown>;
  pkg.publisher = MARKETPLACE_PUBLISHER;
  pkg.displayName = MARKETPLACE_DISPLAY_NAME;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  process.once('SIGINT', () => { restore(); process.exit(130); });
  process.once('SIGTERM', () => { restore(); process.exit(143); });
  try {
    return fn();
  } finally {
    restore();
  }
}

function packageVsix(version: string): string {
  const out = vsixPath(version);
  mkdirSync(RELEASES_DIR, { recursive: true });

  console.log('\n— Packaging .vsix —');
  return withMarketplacePackageJson(() => {
    execSync(`npx @vscode/vsce package --no-dependencies --out ${JSON.stringify(out)}`, {
      cwd: DEV_ROOT,
      stdio: 'inherit',
    });
    return out;
  });
}

function verifyVsix(vsix: string, version: string): void {
  console.log('\n— Verifying .vsix contents —');
  execSync(
    `npx tsx scripts/verify-vsix.ts ${JSON.stringify(vsix)} --publisher ${MARKETPLACE_PUBLISHER} --version ${JSON.stringify(version)}`,
    {
      cwd: DEV_ROOT,
      stdio: 'inherit',
    },
  );
}

function publishToOpenVsx(vsix: string): void {
  if (!existsSync(OVSX_TOKEN_PATH)) {
    console.error('✗ openvsx_token file not found. Create it with your Open VSX access token.');
    process.exit(1);
  }

  const token = readFileSync(OVSX_TOKEN_PATH, 'utf-8').trim();
  if (!token) {
    console.error('✗ openvsx_token file is empty.');
    process.exit(1);
  }

  console.log('\n— Publishing to Open VSX —');
  execSync(`npx ovsx publish ${JSON.stringify(vsix)}`, {
    cwd: DEV_ROOT,
    stdio: 'inherit',
    env: { ...process.env, OVSX_PAT: token },
  });

  console.log('✓ Published to Open VSX');
}

function createGitHubRelease(version: string, body: string, vsix: string, publicRoot: string): void {
  console.log('\n— Creating GitHub Release —');
  const notesFile = resolve(publicRoot, '.git', 'RELEASE_NOTES_TMP');
  writeFileSync(notesFile, body, 'utf-8');
  try {
    execSync(
      `gh release create v${version} ${JSON.stringify(vsix)} --title "v${version}" --notes-file ${JSON.stringify(notesFile)} --latest`,
      { cwd: publicRoot, stdio: 'inherit' },
    );
  } finally {
    try { unlinkSync(notesFile); } catch {}
  }
  console.log(`✓ Created GitHub Release v${version} with .vsix asset`);
}

function runRegressionTests(): void {
  console.log('\n— Running regression tests —');
  execSync('npm test', { cwd: DEV_ROOT, stdio: 'inherit' });
  console.log('✓ All regression tests passed\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const doCommit = args.includes('--commit');
  const doPush = args.includes('--push');
  const doOvsx = args.includes('--ovsx');
  const skipTests = args.includes('--skip-tests');
  const packageOnly = args.includes('--package-only');

  const version = getVersion();
  const changelogBody = getChangelogSection(version);

  if (!skipTests && !packageOnly) {
    runRegressionTests();
  } else if (skipTests) {
    console.warn('⚠ Skipping regression tests (--skip-tests)');
  }

  if (packageOnly) {
    const vsix = packageVsix(version);
    verifyVsix(vsix, version);
    console.log(`\n✓ Packaged and verified ${vsix} (no publish)`);
    return;
  }

  let publicRoot: string;
  try {
    publicRoot = resolvePublicRoot();
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`Publishing v${version} → ${publicRoot}`);
  assertPublicRepo(publicRoot);

  if (!devTreeClean()) {
    console.warn('⚠ Dev repo has uncommitted changes. Proceeding anyway (syncing working tree).\n');
  }

  syncToPublic(publicRoot);
  normalizePublicPackageJson(publicRoot);

  if (!publicHasChanges(publicRoot)) {
    console.log('\nNo changes to publish. Public repo is up to date.');
  } else {
    console.log('\n— Public repo changes —');
    console.log(publicDiffSummary(publicRoot));

    if (!doCommit) {
      console.log('Files synced. Review the public repo, then run again with --commit:');
      console.log(`  npm run publish:public -- --commit`);
      console.log(`\nOr commit manually:`);
      console.log(`  cd ${publicRoot} && git add -A && git commit && git push`);
      if (!doOvsx) return;
    } else {
      if (!changelogBody) {
        console.error(`✗ No changelog entry found for v${version}.`);
        console.error(`  Add a ## [${version}] - YYYY-MM-DD section in CHANGELOG.md (implementation date),`);
        console.error(`  keep package.json in sync, then run:`);
        console.error(`  npm run release -- patch|minor|major`);
        console.error(`  npm run publish:public -- --commit`);
        process.exit(1);
      }

      commitAndTag(version, changelogBody, publicRoot);

      if (doPush) {
        execSync('git push && git push --tags', { cwd: publicRoot, stdio: 'inherit' });
        console.log('✓ Pushed public repo to origin');
        execSync('git push && git push --tags', { cwd: DEV_ROOT, stdio: 'inherit' });
        console.log('✓ Pushed dev repo to origin');
      } else {
        console.log(`\n✓ Committed v${version} to public repo`);
        console.log(`\nNext steps:`);
        console.log(`  cd ${publicRoot} && git push && git push --tags`);
        console.log(`  cd ${DEV_ROOT} && git push --tags`);
      }
    }
  }

  if (doOvsx) {
    const vsix = packageVsix(version);
    verifyVsix(vsix, version);

    publishToOpenVsx(vsix);

    if (changelogBody && doPush) {
      createGitHubRelease(version, changelogBody, vsix, publicRoot);
    }
  }
}

const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('publish.ts');
if (isDirect) {
  main();
}
