import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  normalizeDomAttributeValue,
  resolveSubagentStopElement,
} from '../src/server/subagent-stop-resolver.js';

function withDom(html: string, run: (document: Document) => void): void {
  const dom = new JSDOM(html);
  run(dom.window.document);
}

describe('subagent stop resolver', () => {
  it('finds card stop via data-tool-call-id even when legacy absolute path is stale', () => {
    withDom(`
      <div id="container" data-composer-id="composer-card-stop">
        <div data-tool-call-id="call_abc123">
          <div class="subagent-task-card" data-chrome="card">
            <div class="subagent-task-card-title" title="Probe worker">Probe worker</div>
            <button type="button" class="task-subagent-header-pill-button task-subagent-header-pill-button--stop">Stop</button>
          </div>
        </div>
      </div>
    `, (document) => {
      const result = resolveSubagentStopElement(document, {
        stop: {
          kind: 'cardStop',
          matchTitle: 'Probe worker',
          toolCallId: 'call_abc123',
          composerId: 'composer-card-stop',
        },
        legacyStopSelectorPath: 'div#workbench.parts.auxiliarybar > div:nth-of-type(99) > button',
      });
      assert.equal(result.ok, true);
      assert.match(result.element?.className || '', /task-subagent-header-pill-button--stop/);
    });
  });

  it('finds stop via data-subagent-task-action on current Cursor cards', () => {
    withDom(`
      <div id="container" data-composer-id="composer-new-stop">
        <div data-tool-call-id="call_new_stop">
          <div data-subagent-task-card="true">
            <div data-subagent-task-card-header="true" role="button">
              <span>Probe worker</span>
              <span data-subagent-task-model="true">Explorer</span>
              <button type="button" data-subagent-task-action="stop">Stop</button>
            </div>
          </div>
        </div>
      </div>
    `, (document) => {
      const result = resolveSubagentStopElement(document, {
        stop: {
          kind: 'cardStop',
          matchTitle: 'Probe worker',
          matchModel: 'Explorer',
          toolCallId: 'call_new_stop',
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.element?.getAttribute('data-subagent-task-action'), 'stop');
    });
  });

  it('rejects ambiguous toolbar stop when two jobs share the same title', () => {
    withDom(`
      <div id="composer-toolbar-section">
        <div class="composer-toolbar-background-job-item">
          <div class="composer-toolbar-background-job-item-text">Probe worker</div>
          <div class="composer-toolbar-background-job-item-stop" data-click-ready="true">Stop</div>
        </div>
        <div class="composer-toolbar-background-job-item">
          <div class="composer-toolbar-background-job-item-text">Probe worker</div>
          <div class="composer-toolbar-background-job-item-stop" data-click-ready="true">Stop</div>
        </div>
      </div>
    `, (document) => {
      const result = resolveSubagentStopElement(document, {
        stop: {
          kind: 'toolbarStop',
          matchTitle: 'Probe worker',
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ambiguous');
    });
  });

  it('normalizes whitespace and newlines in data-tool-call-id values', () => {
    assert.equal(
      normalizeDomAttributeValue('call_abc\nfc_tail'),
      'call_abc fc_tail',
    );
    withDom(`
      <div data-tool-call-id="call_abc
fc_tail">
        <button class="task-subagent-header-pill-button--stop">Stop</button>
      </div>
    `, (document) => {
      const result = resolveSubagentStopElement(document, {
        stop: {
          kind: 'cardStop',
          matchTitle: 'Any',
          toolCallId: 'call_abc fc_tail',
        },
      });
      assert.equal(result.ok, true);
    });
  });
});
