import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isActionableApproval,
  isApproveActionLabel,
  isApproveAllLabel,
  isBackgroundApprovalLabel,
  isGarbageActionLabel,
  looksLikeButtonLabel,
  sanitizeApprovalCommandText,
} from '../src/server/approval-filter.js';

describe('isBackgroundApprovalLabel', () => {
  it('matches Run in background variants', () => {
    assert.equal(isBackgroundApprovalLabel('Run in background'), true);
    assert.equal(isBackgroundApprovalLabel('Run in Background'), true);
    assert.equal(isBackgroundApprovalLabel('  Run   in   background  '), true);
  });

  it('does not match normal shell approvals', () => {
    assert.equal(isBackgroundApprovalLabel('Run'), false);
    assert.equal(isBackgroundApprovalLabel('Skip'), false);
    assert.equal(isBackgroundApprovalLabel('Allow'), false);
    assert.equal(isBackgroundApprovalLabel('Accept'), false);
  });
});

describe('looksLikeButtonLabel', () => {
  it('rejects source code masquerading as button labels', () => {
    const sample = '+ + syncOpenTabWorkStatus(chatTabs); } catch { /* skip */ } // --- Mode extraction ---';
    assert.equal(looksLikeButtonLabel(sample), false);
  });

  it('accepts normal action labels', () => {
    assert.equal(looksLikeButtonLabel('Run'), true);
    assert.equal(looksLikeButtonLabel('Skip'), true);
    assert.equal(looksLikeButtonLabel('Run in background'), true);
  });
});

describe('isGarbageActionLabel', () => {
  it('detects test runner output masquerading as button labels', () => {
    const sample = '# fail 0 # cancelled 0 # skipped 0 # todo 0 # duration_ms 3631.857';
    assert.equal(isGarbageActionLabel(sample), true);
  });

  it('allows normal skip labels', () => {
    assert.equal(isGarbageActionLabel('Skip'), false);
    assert.equal(isGarbageActionLabel('Reject'), false);
  });
});

describe('isApproveActionLabel / sanitizeApprovalCommandText', () => {
  it('treats Allow/Run/Accept as approve labels, never as command text', () => {
    assert.equal(isApproveActionLabel('Allow'), true);
    assert.equal(isApproveActionLabel('Run'), true);
    assert.equal(isApproveActionLabel('Accept'), true);
    assert.equal(isApproveActionLabel('Accept All'), true);
    assert.equal(isApproveActionLabel('npm test'), false);
    assert.equal(sanitizeApprovalCommandText('Allow'), '');
    assert.equal(sanitizeApprovalCommandText('  Run  '), '');
    assert.equal(sanitizeApprovalCommandText('taskkill /PID 1'), 'taskkill /PID 1');
    assert.equal(isApproveAllLabel('Allow'), false);
    assert.equal(isApproveAllLabel('Accept All'), true);
    assert.equal(isApproveAllLabel('Approve All'), true);
  });
});

describe('isActionableApproval', () => {
  it('rejects background-only approvals', () => {
    assert.equal(
      isActionableApproval({
        description: 'Run in background',
        actions: [{ label: 'Run in background', type: 'approve' }],
      }),
      false
    );
  });

  it('rejects approvals whose approve label is actually source code', () => {
    assert.equal(
      isActionableApproval({
        description: 'Run in background',
        actions: [
          { label: 'Run in background', type: 'approve' },
          {
            label: '+ + syncOpenTabWorkStatus(chatTabs); } catch { /* skip */ }',
            type: 'reject',
          },
        ],
      }),
      false
    );
  });

  it('accepts normal shell approvals', () => {
    assert.equal(
      isActionableApproval({
        description: 'npm test',
        actions: [
          { label: 'Run', type: 'approve' },
          { label: 'Skip', type: 'reject' },
        ],
      }),
      true
    );
  });
});
