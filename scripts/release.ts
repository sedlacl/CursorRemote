import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { updateVsixInstallDocs } from './update-vsix-install-docs.js';
import { parseBaseSemver } from './version-utils.js';

const PKG_PATH = resolve(process.cwd(), 'package.json');
const LOCK_PATH = resolve(process.cwd(), 'package-lock.json');
const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');

type BumpType = 'patch' | 'minor' | 'major';

function bumpVersion(current: string, type: BumpType): string {
  const { major, minor, patch } = parseBaseSemver(current);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = process.argv.slice(2);
  const bumpType = args[0] as BumpType;

  if (!['patch', 'minor', 'major'].includes(bumpType)) {
    console.error('Usage: npm run release -- patch|minor|major');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const currentVersion = pkg.version as string;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(`Bumping ${currentVersion} → ${newVersion} (${bumpType})`);

  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`✓ Updated package.json`);

  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
  lock.version = newVersion;
  if (lock.packages?.['']) {
    lock.packages[''].version = newVersion;
  }
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
  console.log(`✓ Updated package-lock.json`);

  updateVsixInstallDocs(newVersion);

  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const versionHeader = `## [${newVersion}] - ${todayDate()}`;
  const unreleasedHeader = '## [Unreleased]';

  if (changelog.includes(`## [${newVersion}]`)) {
    console.log(`✓ CHANGELOG.md already has ${versionHeader.split(' - ')[0]}`);
  } else if (changelog.includes(unreleasedHeader)) {
    // Legacy: fold any leftover Unreleased block into the new version (do not keep Unreleased).
    const updated = changelog.replace(unreleasedHeader, versionHeader);
    writeFileSync(CHANGELOG_PATH, updated, 'utf-8');
    console.log(`✓ Updated CHANGELOG.md (replaced [Unreleased])`);
  } else {
    const insertAt = changelog.search(/\n## \[/);
    if (insertAt === -1) {
      writeFileSync(CHANGELOG_PATH, `${changelog.trimEnd()}\n\n${versionHeader}\n`, 'utf-8');
    } else {
      const updated =
        `${changelog.slice(0, insertAt)}\n${versionHeader}\n${changelog.slice(insertAt)}`;
      writeFileSync(CHANGELOG_PATH, updated, 'utf-8');
    }
    console.log(`✓ Updated CHANGELOG.md`);
  }

  execSync(
    `git add package.json package-lock.json CHANGELOG.md README.md docs/setup-guide.md`,
    { stdio: 'inherit' },
  );
  execSync(`git commit -m "release: v${newVersion}"`, { stdio: 'inherit' });
  execSync(`git tag v${newVersion}`, { stdio: 'inherit' });

  console.log(`\n✓ Created commit and tag v${newVersion}`);
  console.log(`\nNext steps:`);
  console.log(`  git push && git push --tags`);
  console.log(`  npm run publish:public -- --commit --push --ovsx`);
}

main();
