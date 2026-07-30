import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';

function extract(html: string) {
  const dom = new JSDOM(html);
  const previous = {
    document: (globalThis as { document?: Document }).document,
    Element: (globalThis as { Element?: typeof Element }).Element,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
  };
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });
  try {
    const state = extractionFunction(
      ['#container'],
      ['button.ui-shell-tool-call__run-btn'],
      ['Run'],
      ['button.ui-shell-tool-call__skip-btn'],
      ['Skip'],
      [
        '#workbench\\.parts\\.auxiliarybar [contenteditable="true"]',
        '#workbench\\.parts\\.auxiliarybar textarea',
        '.composer-bar [contenteditable="true"]',
        '.composer-bar textarea',
        '[contenteditable="true"]',
        'textarea',
      ],
      [],
      [],
      [],
      [],
    );
    assert.ok(state);
    return state;
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'Element', { value: previous.Element, configurable: true });
    Object.defineProperty(globalThis, 'HTMLElement', { value: previous.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, 'Node', { value: previous.Node, configurable: true });
    dom.window.close();
  }
}

describe('subagent composer input extraction', () => {
  it('sets composerInputAvailable false when only global textarea exists outside composer bar', () => {
    const state = extract(`
      <div id="workbench.parts.auxiliarybar">
        <div id="container" data-composer-id="composer-child">
          <div class="composer-bar editor" data-composer-id="composer-child">
            <div class="composer-messages-container"></div>
          </div>
        </div>
      </div>
      <textarea id="editor-textarea">code editor elsewhere</textarea>
    `);

    assert.equal(state.composerInputAvailable, false);
    assert.equal(state.inputAvailable, true);
  });

  it('sets composerInputAvailable true when composer bar has textarea', () => {
    const state = extract(`
      <div id="workbench.parts.auxiliarybar">
        <div id="container" data-composer-id="composer-parent">
          <div class="composer-bar editor" data-composer-id="composer-parent">
            <textarea id="message-input"></textarea>
          </div>
        </div>
      </div>
      <textarea id="editor-textarea">code editor elsewhere</textarea>
    `);

    assert.equal(state.composerInputAvailable, true);
    assert.equal(state.inputAvailable, true);
  });
});
