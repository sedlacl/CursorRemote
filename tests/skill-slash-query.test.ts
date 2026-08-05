import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillOption } from '../src/server/types.js';
import {
  applySkillSlashToken,
  filterSkillsByQuery,
  parseSkillSlashQuery,
} from '../src/client/utils/skillSlashQuery.js';

const skills: SkillOption[] = [
  { id: 'canvas', name: 'canvas', description: 'Live React canvas', source: 'user' },
  { id: 'create-rule', name: 'create-rule', description: 'Persistent rules', source: 'cursor' },
  { id: 'remote-cursor', name: 'remote-cursor', description: 'CursorRemote diagnostics', source: 'user' },
];

describe('skillSlashQuery', () => {
  it('parses an active /query at end of text and filters skills', () => {
    assert.equal(parseSkillSlashQuery('hello'), null);
    assert.equal(parseSkillSlashQuery('/foo bar'), null);
    assert.deepEqual(parseSkillSlashQuery('/'), { query: '', start: 0, end: 1 });
    assert.deepEqual(parseSkillSlashQuery('/can'), { query: 'can', start: 0, end: 4 });
    assert.deepEqual(parseSkillSlashQuery('note\n/re'), { query: 're', start: 5, end: 8 });

    const filtered = filterSkillsByQuery(skills, 'can');
    assert.deepEqual(filtered.map(s => s.name), ['canvas']);
    assert.equal(filterSkillsByQuery(skills, 'zzz').length, 0);
  });

  it('replaces the /query fragment with the selected skill token', () => {
    assert.equal(applySkillSlashToken('/can', '/canvas '), '/canvas ');
    assert.equal(applySkillSlashToken('pre\n/re', '/remote-cursor '), 'pre\n/remote-cursor ');
    assert.equal(applySkillSlashToken('keep me', '/canvas '), '/canvas keep me');
  });
});
