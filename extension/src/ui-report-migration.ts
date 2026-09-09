import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';

function copyMissingTree(source: string, target: string): number {
  if (!existsSync(source)) return 0;
  mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copied += copyMissingTree(from, to);
    } else if (entry.isFile() && !existsSync(to)) {
      copyFileSync(from, to);
      copied++;
    }
  }
  return copied;
}

/** Preserve reports accidentally written inside an installed VSIX before 0.3.12. */
export function migrateLegacyUiReports(extensionPath: string, dataDir: string): number {
  const target = join(dataDir, 'issues');
  const extensionParent = dirname(extensionPath);
  const currentDirName = basename(extensionPath);
  const candidateRoots = [extensionPath];
  if (existsSync(extensionParent)) {
    for (const entry of readdirSync(extensionParent, { withFileTypes: true })) {
      if (
        entry.isDirectory()
        && entry.name !== currentDirName
        && entry.name.startsWith('qjohn.cursor-remote-')
      ) {
        candidateRoots.push(join(extensionParent, entry.name));
      }
    }
  }
  return candidateRoots.reduce(
    (count, root) => count + copyMissingTree(join(root, 'docs', 'issues'), target),
    0,
  );
}
