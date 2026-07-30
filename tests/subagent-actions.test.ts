import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveSubagentAction,
  sanitizePatchForClient,
  sanitizeStateForClient,
  validateOpenSubagent,
  validateStopSubagent,
} from '../src/server/subagent-actions.js';
import { defaultCursorState } from '../src/client/state/remoteStateStore.js';

describe('subagent actions', () => {
  const state = {
    ...defaultCursorState,
    subagents: {
      runningCount: 1,
      summary: '1 subagent running',
      items: [{
        id: 'subagent:check api|gpt-5.6',
        title: 'Check API',
        model: 'GPT-5.6',
        status: 'running' as const,
        openAvailable: true,
        stopAvailable: true,
        _capabilities: {
          matchTitle: 'Check API',
          matchModel: 'GPT-5.6',
          openSelectorPath: 'path/to/card',
          stop: {
            kind: 'cardStop',
            matchTitle: 'Check API',
            matchModel: 'GPT-5.6',
            toolCallId: 'call_check_api',
          },
        },
      }],
    },
  };

  it('resolves actions only for known ids with server capabilities', () => {
    assert.equal(resolveSubagentAction(state, 'missing'), null);
    const resolved = resolveSubagentAction(state, 'subagent:check api|gpt-5.6');
    assert.ok(resolved);
    assert.equal(validateOpenSubagent(resolved), null);
    assert.equal(validateStopSubagent(resolved), null);
  });

  it('rejects stale or unavailable capabilities', () => {
    const stale = {
      ...state,
      subagents: {
        ...state.subagents,
        items: [{
          ...state.subagents.items[0]!,
          openAvailable: false,
          stopAvailable: false,
          _capabilities: undefined,
        }],
      },
    };
    assert.equal(validateOpenSubagent(resolveSubagentAction(stale, stale.subagents.items[0]!.id)), 'Subagent not found');
  });

  it('allows single-job stop via collapsed toolbar expand path', () => {
    const collapsed = {
      ...state,
      subagents: {
        runningCount: 1,
        summary: '1 subagent running',
        items: [{
          id: 'subagent:running subagent|',
          title: 'Running subagent',
          status: 'running' as const,
          openAvailable: false,
          stopAvailable: true,
          _capabilities: {
            matchTitle: 'Running subagent',
            toolbarExpandSelectorPath: 'path/to/expand',
            stop: { kind: 'singleJobAfterExpand' as const, matchTitle: 'Running subagent' },
          },
        }],
      },
    };
    const resolved = resolveSubagentAction(collapsed, 'subagent:running subagent|');
    assert.equal(validateStopSubagent(resolved), null);
  });

  it('strips server-only capability payloads before client emit', () => {
    const sanitized = sanitizeStateForClient(state);
    assert.equal(sanitized.subagents.items[0]?.openAvailable, true);
    assert.equal(sanitized.subagents.items[0]?._capabilities, undefined);
    const patch = sanitizePatchForClient({ subagents: state.subagents });
    assert.equal(patch.subagents?.items[0]?._capabilities, undefined);
  });
});
