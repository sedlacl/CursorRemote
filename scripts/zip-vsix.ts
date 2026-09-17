import { inflateRawSync } from 'zlib';
import { readFileSync, existsSync } from 'fs';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipReadError('Not a ZIP archive (EOCD not found)');
}

export function listZipEntries(archivePath: string): string[] {
  const { names } = readCentralDirectory(archivePath);
  return names;
}

export function readZipEntry(archivePath: string, entryName: string): Buffer {
  const { buf, records } = readCentralDirectory(archivePath);
  const rec = records.find(r => r.name === entryName);
  if (!rec) throw new ZipReadError(`Entry not found: ${entryName}`);
  return extractLocal(buf, rec);
}

function readCentralDirectory(archivePath: string): {
  buf: Buffer;
  names: string[];
  records: Array<{ name: string; offset: number; method: number; compSize: number }>;
} {
  if (!existsSync(archivePath)) {
    throw new ZipReadError(`File not found: ${archivePath}`);
  }
  const buf = readFileSync(archivePath);
  if (buf.length < 22) {
    throw new ZipReadError('File is too small to be a ZIP archive');
  }
  const eocd = findEocd(buf);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const records: Array<{ name: string; offset: number; method: number; compSize: number }> = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  while (pos < end) {
    if (buf.readUInt32LE(pos) !== CEN_SIG) {
      throw new ZipReadError('Corrupt ZIP central directory');
    }
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    records.push({ name, offset: localOff, method, compSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, names: records.map(r => r.name), records };
}

function extractLocal(
  buf: Buffer,
  rec: { name: string; offset: number; method: number; compSize: number },
): Buffer {
  const pos = rec.offset;
  if (buf.readUInt32LE(pos) !== LOC_SIG) {
    throw new ZipReadError(`Corrupt ZIP local header for ${rec.name}`);
  }
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const dataStart = pos + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + rec.compSize);
  if (rec.method === 0) return Buffer.from(data);
  if (rec.method === 8) {
    try {
      return inflateRawSync(data);
    } catch (err) {
      throw new ZipReadError(
        `Failed to inflate ${rec.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  throw new ZipReadError(`Unsupported ZIP compression method ${rec.method} for ${rec.name}`);
}
