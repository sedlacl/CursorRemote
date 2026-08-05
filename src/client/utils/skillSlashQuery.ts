import type { SkillOption } from '../../server/types.js';

export interface SkillSlashQuery {
  /** Query after `/` (may be empty). */
  query: string;
  /** Index of `/` in the composer text. */
  start: number;
  /** Exclusive end of the `/query` fragment (usually `text.length`). */
  end: number;
}

/** Active `/query` fragment at the end of the text (start of line or after newline, no trailing space). */
export function parseSkillSlashQuery(text: string): SkillSlashQuery | null {
  const match = /(^|\n)\/([^\s]*)$/.exec(text);
  if (!match) return null;
  const start = match.index + match[1].length;
  return {
    query: match[2],
    start,
    end: text.length,
  };
}

export function filterSkillsByQuery(options: SkillOption[], query: string): SkillOption[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return options;
  return options.filter(skill =>
    skill.name.toLowerCase().includes(q)
    || (skill.description || '').toLowerCase().includes(q),
  );
}

/** Replace the active `/query` fragment, or prepend the token when none is active. */
export function applySkillSlashToken(text: string, token: string): string {
  const parsed = parseSkillSlashQuery(text);
  if (parsed) {
    return `${text.slice(0, parsed.start)}${token}${text.slice(parsed.end)}`;
  }
  const remainder = text.replace(/^\s*\/[^\s]*\s*/, '');
  return `${token}${remainder}`;
}
