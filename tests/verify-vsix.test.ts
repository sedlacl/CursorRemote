import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExpectedIdentity } from '../scripts/verify-vsix.js';
import { MARKETPLACE_PUBLISHER } from '../scripts/marketplace-identity.js';
import { isExcludedPath, resolvePublicRoot } from '../scripts/publish.js';
import { listZipEntries, readZipEntry, ZipReadError } from '../scripts/zip-vsix.js';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function makeStoreZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8');
    const payload = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    locals.push(Buffer.concat([local, payload]));
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('VSIX identity check uses marketplace publisher, not local package.json', () => {
  const expected = resolveExpectedIdentity({
    pkg: { publisher: 'cursor-remote-dev', name: 'cursor-remote', version: '0.4.2' },
  });
  assert.equal(expected.id, `${MARKETPLACE_PUBLISHER}.cursor-remote`);
  assert.notEqual(expected.id, 'cursor-remote-dev.cursor-remote');
  assert.equal(expected.version, '0.4.2');
});

test('zip-vsix lists and reads entries without Python', () => {
  const dir = join(process.cwd(), 'temp', 'zip-vsix-test');
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'sample.vsix');
  writeFileSync(zipPath, makeStoreZip({
    'extension/package.json': JSON.stringify({ publisher: 'qjohn', name: 'cursor-remote', version: '0.4.2' }),
  }));
  try {
    const names = listZipEntries(zipPath);
    assert.deepEqual(names, ['extension/package.json']);
    const inner = JSON.parse(readZipEntry(zipPath, 'extension/package.json').toString('utf8'));
    assert.equal(inner.publisher, 'qjohn');
    assert.throws(() => listZipEntries(join(dir, 'missing.vsix')), ZipReadError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public repo path uses USERPROFILE when HOME is empty', () => {
  const root = resolvePublicRoot({ HOME: '', USERPROFILE: 'C:\\Users\\Example' }, []);
  assert.match(root.replace(/\\/g, '/'), /Users\/Example\/Dev\/CursorRemote$/);
  const fromEnv = resolvePublicRoot({ CURSORREMOTE_PUBLIC_ROOT: 'D:\\pub' }, []);
  assert.match(fromEnv.replace(/\\/g, '/'), /pub$/);
  assert.equal(isExcludedPath('.git/config'), true);
  assert.equal(isExcludedPath('src/server/index.ts'), false);
});
