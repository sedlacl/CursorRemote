import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { AssistantMessage as AssistantMessageType } from '../src/server/types.js';
import { createComponentTestEnv } from './helpers/component-test-env.js';
import { buildAssistantContentSegments } from '../src/client/utils/assistantContent.js';
import { AssistantMessage } from '../src/client/components/messages/messageTypes.js';

const FIXTURE_HTML = `
<p>Protože se výjimka úplně neztratí — náš error handler ji překryje generickým textem:</p>
<ol>
  <li><code>HeaderExtractor</code> zabalí <code>SAXException</code> do obyčejného CXF <code>Fault</code>.</li>
  <li><code>prepareContext()</code> uloží tento <code>Fault</code> do <code>sourceError</code>, ale zároveň předvyplní:</li>
</ol>
<div class="composer-message-codeblock"><div class="ui-code-block"><code>context.setMessage(fallbackMessage);</code></div></div>
<ol start="3">
  <li>Error endpoint nad nevalidním XML selže.</li>
  <li>Catch použije <code>sourceError</code> jen tehdy, pokud je <code>context.message</code> prázdná. Ta už ale obsahuje generický fallback:</li>
</ol>
<div class="composer-message-codeblock"><div class="ui-code-block"><code>if (context.getMessage() == null || context.getMessage().isBlank()) {
  context.setMessage(resolveFallbackFaultMessage(context));
}</code></div></div>
<ol start="5">
  <li>Speciální větev nepomůže.</li>
  <li><code>applySoapFault()</code> následně vytvoří nový <code>Fault</code>.</li>
</ol>
<p>Takže přesněji: Generic fallback původní výjimku v <code>sourceError</code> má.</p>`;

function fixtureMessage(overrides: Partial<AssistantMessageType> = {}): AssistantMessageType {
  return {
    type: 'assistant',
    id: '4a661664-694c-48cd-b71a-8e4c77806dd6',
    flatIndex: 725,
    turnIndex: 158,
    turnOrder: 725,
    text: 'Protože se výjimka úplně neztratí',
    html: FIXTURE_HTML,
    codeBlocks: [
      { blockKind: 'code', code: 'context.setMessage(fallbackMessage);' },
      {
        blockKind: 'code',
        code: 'if (context.getMessage() == null || context.getMessage().isBlank()) {\n  context.setMessage(resolveFallbackFaultMessage(context));\n}',
      },
    ],
    ...overrides,
  };
}

function bubbleChildKinds(root: ParentNode): string[] {
  const bubble = root.querySelector('.assistant-bubble');
  assert.ok(bubble, 'assistant bubble missing');
  return Array.from(bubble.children).map((child) => {
    if (child.classList.contains('assistant-content')) return 'prose';
    if (child.classList.contains('native-code-block')) return 'native-code-block';
    return child.className || child.tagName.toLowerCase();
  });
}

function contentSequence(root: ParentNode): string[] {
  const content = root.querySelector('.assistant-content');
  assert.ok(content, 'assistant content missing');
  const seq: string[] = [];
  for (const child of Array.from(content.children)) {
    if (child.classList.contains('native-code-block')) {
      seq.push('native-code-block');
      continue;
    }
    if (child.querySelector('ol, p')) {
      seq.push('prose');
      continue;
    }
    if (child.querySelector('pre')) {
      seq.push('markdown-pre');
      continue;
    }
    seq.push('segment');
  }
  return seq;
}

describe('assistant native code block ordering', () => {
  let env: ReturnType<typeof createComponentTestEnv>;

  beforeEach(() => {
    env = createComponentTestEnv();
    env.render(React.createElement(React.Fragment));
  });

  afterEach(() => env.cleanup());

  describe('buildAssistantContentSegments', () => {
    it('orders prose and code blocks like the live Cursor transcript', () => {
      const message = fixtureMessage();
      const segments = buildAssistantContentSegments(message.html || '', message.codeBlocks || []);
      assert.deepEqual(
        segments.map((segment) => (segment.kind === 'html' ? 'prose' : 'native-code-block')),
        ['prose', 'native-code-block', 'prose', 'native-code-block', 'prose'],
      );
      assert.match(segments[0]?.kind === 'html' ? segments[0].html : '', /Protože se výjimka/);
      assert.match(segments[2]?.kind === 'html' ? segments[2].html : '', /Error endpoint nad nevalidním XML/);
      assert.match(segments[4]?.kind === 'html' ? segments[4].html : '', /Takže přesněji/);
    });

    it('keeps markdown pre blocks inline without duplicating composer native blocks', () => {
      const html = `
<p>Inline example</p>
<pre><code>keep me inline</code></pre>
<div class="composer-message-codeblock"><code>native only</code></div>
<p>After block</p>`;
      const segments = buildAssistantContentSegments(html, [{ blockKind: 'code', code: 'native only' }]);
      assert.deepEqual(
        segments.map((segment) => (segment.kind === 'html' ? 'prose' : 'native-code-block')),
        ['prose', 'native-code-block', 'prose'],
      );
      const proseWithPre = segments.find((segment) => segment.kind === 'html' && segment.html.includes('<pre'));
      assert.ok(proseWithPre, 'expected markdown pre to stay in prose segment');
      assert.equal(segments.filter((segment) => segment.kind === 'codeBlock').length, 1);
    });

    it('appends unused codeBlocks as fallback without duplicating slotted ones', () => {
      const html = '<p>Only prose</p><div class="composer-message-codeblock"><code>first</code></div><p>tail</p>';
      const segments = buildAssistantContentSegments(html, [
        { blockKind: 'code', code: 'first' },
        { blockKind: 'code', code: 'fallback only' },
      ]);
      const codeSegments = segments.filter((segment) => segment.kind === 'codeBlock');
      assert.equal(codeSegments.length, 2);
      assert.equal(codeSegments[0]?.index, 0);
      assert.equal(codeSegments[1]?.index, 1);
      assert.equal(codeSegments[1]?.item.code, 'fallback only');
    });
  });

  describe('AssistantMessage component', () => {
    it('renders inline native code blocks between prose segments', () => {
      env.render(React.createElement(AssistantMessage, { message: fixtureMessage(), showRoleLabel: false }));
      const kinds = bubbleChildKinds(env.document);
      assert.deepEqual(kinds, ['prose'], 'code blocks must live inside assistant-content, not after the bubble');
      assert.deepEqual(
        contentSequence(env.document),
        ['prose', 'native-code-block', 'prose', 'native-code-block', 'prose'],
      );
      assert.equal(env.document.querySelectorAll('.native-code-block').length, 2);
      assert.equal(env.document.querySelectorAll('.composer-message-codeblock').length, 0);
    });
  });
});
