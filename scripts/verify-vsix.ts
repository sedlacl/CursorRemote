import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { MARKETPLACE_PUBLISHER } from './marketplace-identity.js';
import { listZipEntries, readZipEntry, ZipReadError } from './zip-vsix.js';

const DEV_ROOT = resolve(process.cwd());
const PKG_PATH = resolve(DEV_ROOT, 'package.json');

const REQUIRED_FILES = [
  'extension/dist/extension.cjs',
  'extension/dist/server/bundle.mjs',
  'extension/dist/client/index.html',
  'extension/package.json',
  'extension/selectors.json',
  'extension/media/icon.png',
];

/** Vite emits content-hashed bundles, so the client assets can only be matched by shape. */
const REQUIRED_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'dist/client/assets/*.js', re: /^extension\/dist\/client\/assets\/.+\.js$/ },
  { label: 'dist/client/assets/*.css', re: /^extension\/dist\/client\/assets\/.+\.css$/ },
];

const FORBIDDEN_PATTERNS = [
  'node_modules/',
  '.env',
  'openvsx_token',
  'azure_token',
  'src/',
  'scripts/',
  '.cursor/',
];

export function parseVerifyArgs(argv: string[]): {
  vsixArg?: string;
  publisher?: string;
  version?: string;
  name?: string;
} {
  let vsixArg: string | undefined;
  let publisher: string | undefined;
  let version: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--publisher') {
      publisher = argv[++i];
    } else if (a === '--version') {
      version = argv[++i];
    } else if (a === '--name') {
      name = argv[++i];
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown argument: ${a}`);
    } else if (!vsixArg) {
      vsixArg = a;
    }
  }
  return { vsixArg, publisher, version, name };
}

export function resolveExpectedIdentity(opts: {
  pkg: { publisher?: string; name?: string; version?: string };
  publisher?: string;
  version?: string;
  name?: string;
}): { id: string; version: string } {
  const name = opts.name ?? String(opts.pkg.name ?? 'cursor-remote');
  const publisher = opts.publisher ?? MARKETPLACE_PUBLISHER;
  const version = opts.version ?? String(opts.pkg.version ?? '');
  return { id: `${publisher}.${name}`, version };
}

function main(): void {
  const { vsixArg, publisher, version, name } = parseVerifyArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as {
    publisher?: string;
    name?: string;
    version?: string;
  };

  let vsixPath: string;
  if (vsixArg) {
    vsixPath = resolve(DEV_ROOT, vsixArg);
  } else {
    vsixPath = resolve(DEV_ROOT, 'releases', `cursor-remote-${pkg.version}.vsix`);
  }

  console.log(`Verifying ${vsixPath}\n`);

  let files: string[];
  try {
    files = listZipEntries(vsixPath);
  } catch (err) {
    const detail = err instanceof ZipReadError ? err.message : String(err);
    console.error(`✗ Could not read VSIX archive ${vsixPath}: ${detail}`);
    if (!existsSync(vsixPath)) {
      console.error('  The file does not exist. Package it first, then re-run verification.');
    } else {
      console.error('  The file exists but could not be parsed as a ZIP/VSIX (not a missing-build issue).');
    }
    process.exit(1);
  }

  let errors = 0;

  console.log('— Required files —');
  for (const required of REQUIRED_FILES) {
    const found = files.some(f => f === required || f.endsWith('/' + required));
    if (found) {
      console.log(`  ✓ ${required}`);
    } else {
      console.error(`  ✗ MISSING: ${required}`);
      errors++;
    }
  }

  for (const { label, re } of REQUIRED_PATTERNS) {
    if (files.some(f => re.test(f))) {
      console.log(`  ✓ ${label}`);
    } else {
      console.error(`  ✗ MISSING: ${label}`);
      errors++;
    }
  }

  console.log('\n— Forbidden patterns —');
  for (const pattern of FORBIDDEN_PATTERNS) {
    const matches = files.filter(f => {
      const inner = f.replace(/^extension\//, '');
      if (pattern.endsWith('/')) {
        return inner.startsWith(pattern);
      }
      const segments = inner.split('/');
      return segments.some(seg => seg === pattern);
    });
    if (matches.length === 0) {
      console.log(`  ✓ No ${pattern}`);
    } else {
      console.error(`  ✗ FOUND ${matches.length} files matching "${pattern}":`);
      for (const m of matches.slice(0, 5)) console.error(`      ${m}`);
      if (matches.length > 5) console.error(`      … and ${matches.length - 5} more`);
      errors++;
    }
  }

  const expected = resolveExpectedIdentity({ pkg, publisher, version, name });
  const innerPkgFile = files.find(f => f === 'extension/package.json');
  if (innerPkgFile) {
    const innerPkg = JSON.parse(readZipEntry(vsixPath, 'extension/package.json').toString('utf-8')) as {
      publisher?: string;
      name?: string;
      version?: string;
    };
    const actualId = `${innerPkg.publisher}.${innerPkg.name}`;
    if (actualId === expected.id) {
      console.log(`\n✓ Extension ID match: ${actualId} (marketplace identity, independent of local package.json publisher)`);
    } else {
      console.error(`\n✗ Extension ID mismatch: VSIX has ${actualId}, expected marketplace id ${expected.id}`);
      errors++;
    }
    if (innerPkg.version === expected.version) {
      console.log(`\n✓ Version match: ${expected.version}`);
    } else {
      console.error(`\n✗ Version mismatch: VSIX has ${innerPkg.version}, expected ${expected.version}`);
      errors++;
    }
  }

  const totalFiles = files.filter(f => !f.endsWith('/')).length;
  console.log(`\nTotal files in VSIX: ${totalFiles}`);

  if (errors > 0) {
    console.error(`\n✗ ${errors} verification error(s). Fix before publishing.`);
    process.exit(1);
  }

  console.log('\n✓ VSIX verification passed.');
}

const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('verify-vsix.ts');
if (isDirect) {
  main();
}
