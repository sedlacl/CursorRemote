import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCdpTitle } from '../src/server/cdp-bridge.js';
import { resolveWorkspaceIdentity } from '../src/shared/workspace-identity.js';

test('resolveWorkspaceIdentity prefers workspaceName over first folder basename', () => {
  assert.equal(
    resolveWorkspaceIdentity({
      workspacePath: 'R:/Users/mujProfil/projects/IDS',
      workspaceName: 'Sd2-diagnostics (Workspace)',
      includeQualifier: false,
    }),
    'Sd2-diagnostics (Workspace)',
  );

  assert.equal(
    resolveWorkspaceIdentity({
      workspacePath: 'R:/External/cursor-ide-remote',
      workspaceName: 'cursor-ide-remote',
      includeQualifier: false,
    }),
    'cursor-ide-remote',
  );
});

test('resolveWorkspaceIdentity uses folder basename and remote qualifier', () => {
  assert.equal(
    resolveWorkspaceIdentity({
      workspacePath: 'R:/External/cursor-ide-remote',
      includeQualifier: false,
    }),
    'cursor-ide-remote',
  );

  assert.equal(
    resolveWorkspaceIdentity({
      workspacePath: '/home/user/other-repo',
      authority: 'wsl+Ubuntu',
      includeQualifier: true,
    }),
    'other-repo [WSL: Ubuntu]',
  );
});

test('parseCdpTitle extracts named workspace before profile segment', () => {
  assert.equal(
    parseCdpTitle('Canvas - Sd2-diagnostics (Workspace) - mujProfil - Cursor'),
    'Sd2-diagnostics (Workspace)',
  );

  assert.equal(
    parseCdpTitle('usy_aflex_initdatag01-dev (Workspace) - mujProfil - Cursor'),
    'usy_aflex_initdatag01-dev (Workspace)',
  );

  assert.equal(
    parseCdpTitle('cursor-ide-remote - Cursor'),
    'cursor-ide-remote',
  );
});
