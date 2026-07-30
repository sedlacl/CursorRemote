import { readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { resolve } from 'path';
import { updateVsixInstallDocs } from './update-vsix-install-docs.js';
import { parseBaseSemver } from './version-utils.js';

/**
 * Re-cuts a release that was tagged but never published, typically because the
 * release workflow failed. Tags are append-only here on purpose: moving one
 * needs a force push, so the failed version is retired and its changelog entry
 * carries over to a fresh patch version instead.
 */

const ROOT = process.cwd();
const PKG_PATH = resolve(ROOT, 'package.json');
const LOCK_PATH = resolve(ROOT, 'package-lock.json');
const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function nextPatch(current: string): string {
  const { major, minor, patch } = parseBaseSemver(current);
  return `${major}.${minor}.${patch + 1}`;
}

function tagExists(tag: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet refs/tags/${tag}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function requireCleanTree(): void {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  if (status) {
    console.error('Working tree is not clean. Commit or stash first:\n' + status);
    process.exit(1);
  }
}

function requireUnpublishedRelease(tag: string, repositoryUrl: string): void {
  const match = repositoryUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) {
    console.error(`Cannot determine GitHub repository from: ${repositoryUrl}`);
    process.exit(1);
  }

  const repository = `${match[1]}/${match[2]}`;
  const result = spawnSync(
    'gh',
    ['api', `repos/${repository}/releases/tags/${tag}`, '--silent'],
    { encoding: 'utf-8', shell: process.platform === 'win32' },
  );

  if (result.status === 0) {
    console.error(
      `${tag} already has a GitHub Release. Use "npm run release -- patch" instead of retagging it.`,
    );
    process.exit(1);
  }

  const error = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  if (!error.includes('HTTP 404')) {
    console.error(`Could not verify that ${tag} is unpublished:\n${error.trim()}`);
    process.exit(1);
  }
}

/** Moves the failed version's changelog entry onto the new version. */
function carryOverChangelog(from: string, to: string): void {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const heading = new RegExp(`^## \\[${from.replace(/\./g, '\\.')}\\][^\\n]*$`, 'm');

  if (!heading.test(changelog)) {
    console.warn(`⚠ No [${from}] section in CHANGELOG.md — add notes for ${to} by hand.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(CHANGELOG_PATH, changelog.replace(heading, `## [${to}] - ${today}`), 'utf-8');
  console.log(`✓ Moved CHANGELOG section ${from} → ${to}`);
}

function main(): void {
  requireCleanTree();

  const pkg = readJson<{
    version: string;
    repository: { url: string };
  }>(PKG_PATH);
  const current = pkg.version;
  const next = nextPatch(current);
  const currentTag = `v${current}`;
  const nextTag = `v${next}`;

  requireUnpublishedRelease(currentTag, pkg.repository.url);

  if (tagExists(nextTag)) {
    console.error(`Tag ${nextTag} already exists.`);
    process.exit(1);
  }

  console.log(`Retagging ${current} → ${next} (${current} was never published)`);

  pkg.version = next;
  writeJson(PKG_PATH, pkg);

  // Keep the lockfile's own version in step so `npm ci` reports the right build.
  const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>(LOCK_PATH);
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeJson(LOCK_PATH, lock);

  updateVsixInstallDocs(next);
  carryOverChangelog(current, next);

  execSync('git add package.json package-lock.json CHANGELOG.md README.md docs/setup-guide.md', {
    stdio: 'inherit',
  });
  execSync(`git commit -m "release: ${nextTag}"`, { stdio: 'inherit' });
  execSync(`git tag ${nextTag}`, { stdio: 'inherit' });

  console.log(`\n✓ Created commit and tag ${nextTag}`);
  console.log(`\nNext step:`);
  console.log(`  git push origin main && git push origin refs/tags/${nextTag}`);
}

main();
