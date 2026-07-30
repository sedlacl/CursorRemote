/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Length of a diagnostic ID: 5 random bytes encoded as Crockford base32. */
export const DIAGNOSTIC_ID_LENGTH = 8;

/** Encode bytes as uppercase Crockford base32 (no padding). */
export function encodeCrockfordBase32(bytes: Uint8Array | Buffer): string {
  let value = 0n;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = Number((value >> BigInt(bits)) & 0x1fn);
      out += CROCKFORD[index]!;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[Number((value << BigInt(5 - bits)) & 0x1fn)]!;
  }
  return out;
}

/** Normalize user/agent input for case-insensitive Crockford matching. */
export function normalizeDiagnosticId(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/L/g, '1');
}

/** True when the value is a well-formed diagnostic ID (after normalization). */
export function isValidDiagnosticId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = normalizeDiagnosticId(value);
  if (normalized.length !== DIAGNOSTIC_ID_LENGTH) return false;
  return [...normalized].every(char => CROCKFORD.includes(char));
}

export function diagnosticIdsMatch(expected: string, provided: string): boolean {
  return normalizeDiagnosticId(expected) === normalizeDiagnosticId(provided);
}
