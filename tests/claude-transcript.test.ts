import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeRowsToMessages } from '../src/server/hosts/claude-transcript.js';

describe('claudeRowsToMessages', () => {
  it('maps user, assistant, tool, and skips collapsed thinking', () => {
    const messages = claudeRowsToMessages([
      { aria: 'You', testid: '', busy: false, text: 'podivej se na adapter' },
      { aria: 'Claude, thinking', testid: 'assistant-message', busy: false, text: 'thinking' },
      { aria: 'Claude', testid: 'assistant-message', busy: false, text: 'Kouknu na to.' },
      { aria: 'Claude, Bash', testid: 'assistant-message', busy: false, text: 'rg adapter src' },
      { aria: 'Claude, Write', testid: 'assistant-message', busy: true, text: 'writing file' },
    ]);

    assert.deepEqual(messages.map(m => m.type), ['human', 'assistant', 'tool', 'tool']);
    assert.equal(messages[0].type === 'human' ? messages[0].text : '', 'podivej se na adapter');
    assert.equal(messages[2].type === 'tool' ? messages[2].action : '', 'Bash');
    assert.equal(messages[2].type === 'tool' ? messages[2].status : '', 'completed');
    assert.equal(messages[3].type === 'tool' ? messages[3].status : '', 'loading');
  });

  it('drops the screen-reader heading echoed onto a user message', () => {
    const messages = claudeRowsToMessages([
      {
        aria: 'You',
        testid: '',
        busy: false,
        text: 'You: jak jse dnes v prazejak jse dnes v praze',
      },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type === 'human' ? messages[0].text : '', 'jak jse dnes v praze');
  });

  it('keeps a thinking row when it has a real body', () => {
    const messages = claudeRowsToMessages([
      { aria: 'Claude, thinking', testid: 'assistant-message', busy: false, text: 'thinking The session list is a separate webview.' },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'thought');
    assert.equal(messages[0].type === 'thought' ? messages[0].detail : '', 'The session list is a separate webview.');
  });
});
