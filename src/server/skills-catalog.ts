import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import type { SkillOption } from './types.js';

const MAX_SKILLS = 200;
const MAX_DESCRIPTION = 160;

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end).trim();
  let name: string | undefined;
  let description: string | undefined;
  let pendingDesc = false;
  let descLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (pendingDesc) {
      if (/^\s+\S/.test(line) || line.trim() === '>-' || line.trim() === '|' || line.trim() === '>') {
        descLines.push(line.trim().replace(/^>-?\s*/, '').replace(/^\|\s*/, ''));
        continue;
      }
      if (/^[a-zA-Z0-9_-]+:/.test(line)) {
        description = descLines.join(' ').replace(/\s+/g, ' ').trim() || undefined;
        pendingDesc = false;
      } else {
        descLines.push(line.trim());
        continue;
      }
    }
    const nameMatch = line.match(/^name:\s*(.+)\s*$/);
    if (nameMatch) {
      name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      const rest = descMatch[1]!.trim();
      if (!rest || rest === '>' || rest === '>-' || rest === '|') {
        pendingDesc = true;
        descLines = [];
      } else {
        description = rest.replace(/^["']|["']$/g, '');
      }
    }
  }
  if (pendingDesc) {
    description = descLines.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }
  return { name, description };
}

function walkSkillFiles(root: string, out: string[], depth = 0): void {
  if (depth > 6 || out.length >= MAX_SKILLS * 2) return;
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSkillFiles(full, out, depth + 1);
    } else if (entry === 'SKILL.md' || entry === 'skill.md') {
      out.push(full);
    }
  }
}

function skillFromFile(filePath: string, source: SkillOption['source']): SkillOption | null {
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf8').slice(0, 8_000);
  } catch {
    return null;
  }
  const fm = parseFrontmatter(raw);
  const folderName = basename(dirname(filePath));
  const name = (fm.name || folderName).trim().replace(/^\/+/, '');
  if (!name) return null;
  const description = fm.description?.slice(0, MAX_DESCRIPTION);
  return {
    id: name,
    name,
    ...(description ? { description } : {}),
    source,
  };
}

export function listSkillCatalogRoots(projectRoot?: string): Array<{ root: string; source: SkillOption['source'] }> {
  const home = homedir();
  const roots: Array<{ root: string; source: SkillOption['source'] }> = [
    { root: join(home, '.cursor', 'skills-cursor'), source: 'cursor' },
    { root: join(home, '.cursor', 'skills'), source: 'user' },
  ];
  if (projectRoot) {
    roots.unshift({ root: join(projectRoot, '.cursor', 'skills'), source: 'project' });
  }
  return roots;
}

/** Filesystem catalog of Cursor Agent skills (own UI source — not slash-menu scrape). */
export function loadSkillCatalog(projectRoot?: string): SkillOption[] {
  const byId = new Map<string, SkillOption>();
  for (const { root, source } of listSkillCatalogRoots(projectRoot)) {
    const files: string[] = [];
    walkSkillFiles(root, files);
    for (const file of files) {
      const skill = skillFromFile(file, source);
      if (!skill) continue;
      // Prefer project > user > cursor when ids collide.
      const existing = byId.get(skill.id);
      if (!existing) {
        byId.set(skill.id, skill);
        continue;
      }
      const rank = { project: 3, user: 2, cursor: 1 } as const;
      if (rank[skill.source] > rank[existing.source]) {
        byId.set(skill.id, skill);
      }
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS);
}
