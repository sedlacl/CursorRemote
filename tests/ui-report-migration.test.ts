import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { migrateLegacyUiReports } from '../extension/src/ui-report-migration.js';

describe('legacy UI report migration', () => {
  it('copies missing reports and artifacts without overwriting persistent files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-report-migration-'));
    try {
      const extensionsDir = join(root, 'extensions');
      const extensionPath = join(extensionsDir, 'qjohn.cursor-remote-0.3.12-universal');
      const previousExtensionPath = join(extensionsDir, 'qjohn.cursor-remote-0.3.11-universal');
      const dataDir = join(root, 'data');
      const legacyIssues = join(extensionPath, 'docs', 'issues');
      const previousIssues = join(previousExtensionPath, 'docs', 'issues');
      const persistentIssues = join(dataDir, 'issues');
      mkdirSync(join(legacyIssues, '.artifacts', 'REPORT01'), { recursive: true });
      mkdirSync(join(previousIssues, '.artifacts', 'OLDREPORT'), { recursive: true });
      mkdirSync(persistentIssues, { recursive: true });
      writeFileSync(join(legacyIssues, 'report.md'), 'legacy');
      writeFileSync(join(legacyIssues, '.artifacts', 'REPORT01', 'state.json'), '{}');
      writeFileSync(join(previousIssues, '.artifacts', 'OLDREPORT', 'state.json'), '{"old":true}');
      writeFileSync(join(persistentIssues, 'report.md'), 'persistent');

      assert.equal(migrateLegacyUiReports(extensionPath, dataDir), 2);
      assert.equal(readFileSync(join(persistentIssues, 'report.md'), 'utf8'), 'persistent');
      assert.equal(
        readFileSync(join(persistentIssues, '.artifacts', 'REPORT01', 'state.json'), 'utf8'),
        '{}',
      );
      assert.equal(
        readFileSync(join(persistentIssues, '.artifacts', 'OLDREPORT', 'state.json'), 'utf8'),
        '{"old":true}',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
