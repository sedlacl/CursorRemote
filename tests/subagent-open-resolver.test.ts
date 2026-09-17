import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { resolveSubagentOpenElement } from '../src/server/subagent-open-resolver.js';

function withDom(html: string, run: (document: Document) => void): void {
  const dom = new JSDOM(html);
  run(dom.window.document);
}

describe('subagent open resolver', () => {
  it('clicks the toolbar job title, not the Stop control', () => {
    withDom(`
      <div id="composer-toolbar-section">
        <div>1 subagent running</div>
        <div class="composer-toolbar-background-job-item composer-toolbar-background-job-item-clickable">
          <div class="composer-toolbar-background-job-item-text">Plná sada PDS a aflexExt + RAM</div>
          <div class="composer-toolbar-background-job-item-stop" data-click-ready="true">Stop</div>
        </div>
      </div>
    `, (document) => {
      const result = resolveSubagentOpenElement(document, {
        matchTitle: 'Plná sada PDS a aflexExt + RAM',
        openSelectorPath: 'div:nth-of-type(99)',
      });
      assert.equal(result.ok, true);
      assert.equal(result.element?.className, 'composer-toolbar-background-job-item-text');
    });
  });
});
