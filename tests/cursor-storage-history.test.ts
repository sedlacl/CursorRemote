import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { storedBubbleToChatElement } from '../src/server/cursor-storage-history.js';
import { mergeMessages } from '../src/server/message-history.js';
import type { ChatElement } from '../src/server/types.js';

const NOTIFICATION_BUBBLE_ID = '71b05679-37c9-4f2a-9846-3507c3620a5b';

const SUBAGENT_NOTIFICATION_XML = [
  '<timestamp>Tuesday, Aug 18, 2026, 12:37 PM (UTC+2)</timestamp>',
  '<system_notification>',
  'The following task has finished. If you were already aware, ignore this notification and do not restate prior responses.',
  '',
  '<task>',
  'kind: subagent',
  'status: success',
  'task_id: d7c925a8-24d4-43dc-929e-8458dfaad228',
  'title: Implement deleteSubjects scenario',
  'output_path: c:\\Users\\LukasSedlacek\\.cursor\\projects\\example\\agent-transcripts\\parent\\subagents\\d7c925a8-24d4-43dc-929e-8458dfaad228.jsonl',
  '</task>',
  '</system_notification>',
  '<user_query>Perform any necessary follow-up actions in response to the subagent completion above.</user_query>',
].join('\n');

describe('storedBubbleToChatElement', () => {
  it('maps type=1 subagent system_notification to a compact thought with live extractor id', () => {
    const mapped = storedBubbleToChatElement(
      { bubbleId: NOTIFICATION_BUBBLE_ID, type: 1 },
      { bubbleId: NOTIFICATION_BUBBLE_ID, type: 1, text: SUBAGENT_NOTIFICATION_XML },
      12,
    );
    assert.equal(mapped?.type, 'thought');
    assert.equal(mapped?.id, `transcript:notification:${NOTIFICATION_BUBBLE_ID}`);
    assert.ok(mapped && mapped.type === 'thought');
    assert.equal(mapped.thoughtKind, 'step_summary');
    assert.equal(mapped.action, 'Finished');
    assert.equal(mapped.detail, 'Implement deleteSubjects scenario');
    assert.equal(mapped.flatIndex, 12);
  });

  it('keeps ordinary type=1 bubbles as human messages', () => {
    const mapped = storedBubbleToChatElement(
      { bubbleId: 'human-1', type: 1 },
      { bubbleId: 'human-1', type: 1, text: 'doplň logical steps' },
      3,
    );
    assert.equal(mapped?.type, 'human');
    assert.equal(mapped?.id, 'human-1');
    assert.ok(mapped && mapped.type === 'human');
    assert.equal(mapped.text, 'doplň logical steps');
  });

  it('merges storage notification with the live extractor thought instead of adding a You bubble', () => {
    const stored = storedBubbleToChatElement(
      { bubbleId: NOTIFICATION_BUBBLE_ID, type: 1 },
      { bubbleId: NOTIFICATION_BUBBLE_ID, type: 1, text: SUBAGENT_NOTIFICATION_XML },
      12,
    );
    assert.ok(stored);
    const live: ChatElement = {
      type: 'thought',
      id: `transcript:notification:${NOTIFICATION_BUBBLE_ID}`,
      flatIndex: 18,
      duration: '',
      action: 'Finished',
      detail: 'Implement deleteSubjects scenario',
      thoughtKind: 'step_summary',
    };
    const merged = mergeMessages([{ ...stored, historyIndex: 12 }], [live]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, live.id);
    assert.equal(merged[0].type, 'thought');
    assert.equal(merged[0].historyIndex, 12);
  });
});
