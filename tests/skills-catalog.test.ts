import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it } from 'node:test';
import { loadSkillCatalog } from '../src/server/skills-catalog.js';

describe('skills catalog', () => {
  it('reads SKILL.md frontmatter from a project .cursor/skills tree', () => {
    const root = join(tmpdir(), `cursor-remote-skills-${Date.now()}`);
    const skillDir = join(root, '.cursor', 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill for unit test\n---\n\n# Demo\n',
      'utf8',
    );
    try {
      const options = loadSkillCatalog(root);
      const demo = options.find(s => s.id === 'demo-skill');
      assert.ok(demo);
      assert.equal(demo?.source, 'project');
      assert.match(demo?.description || '', /Demo skill/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
