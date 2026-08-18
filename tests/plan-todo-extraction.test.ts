import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { CursorState, PlanBlock } from '../src/server/types.js';

function withDom<T>(html: string, fn: () => T): T {
  const dom = new JSDOM(html);
  const previous = {
    document: (globalThis as any).document,
    Element: (globalThis as any).Element,
    HTMLElement: (globalThis as any).HTMLElement,
    Node: (globalThis as any).Node,
  };

  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });

  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'Element', { value: previous.Element, configurable: true });
    Object.defineProperty(globalThis, 'HTMLElement', { value: previous.HTMLElement, configurable: true });
    Object.defineProperty(globalThis, 'Node', { value: previous.Node, configurable: true });
    dom.window.close();
  }
}

function extract(): CursorState {
  const state = extractionFunction(
    ['#container'],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
  assert.ok(state);
  return state;
}

function planRow(opts: {
  id: string;
  index: string;
  label: string;
  title: string;
  expanded: boolean;
  itemsHtml?: string;
  countText?: string;
  clickId: string;
}): string {
  const countText = opts.countText ?? '1/2';
  const expandedAttr = opts.expanded ? 'true' : 'false';
  const expandedClass = opts.expanded ? 'todo-summary-expanded-content expanded' : 'todo-summary-expanded-content';
  return `
    <div class="virtualized-composer-messages-row" data-message-role="human" data-message-kind="human"
         data-message-id="${opts.id}" data-message-index="${opts.index}">
      <div class="plan-execution-with-todos-wrapper">
        <div class="plan-execution-message-content">
          <span class="plan-execution-label">${opts.label}</span>
          <span class="plan-execution-title">${opts.title}</span>
        </div>
        <button id="${opts.clickId}" class="todo-summary-content todo-summary-content-clickable"
                type="button" aria-expanded="${expandedAttr}"
                aria-label="Plan progress: ${opts.title}, 1 of 2">${countText}</button>
        <div class="${expandedClass}">
          <div class="todo-summary-list">
            <ul class="ui-todo-list">${opts.itemsHtml ?? ''}</ul>
          </div>
        </div>
      </div>
    </div>`;
}

const CURRENT_ITEMS = `
  <li id="todo-scenario-05" class="ui-todo-item">
    <span class="ui-todo-item__content ui-todo-item__content--in-progress">Write 05.deleteSubjects.js</span>
  </li>
  <li id="todo-run-test" class="ui-todo-item ui-todo-item--pending">
    <span class="ui-todo-item__content">Run tests</span>
  </li>`;

describe('dom extractor: plan todo expand', () => {
  it('reads both expanded plan blocks from li.ui-todo-item and does not click', () => {
    const clicks: string[] = [];
    const state = withDom(
      `<div id="container">
        ${planRow({
          id: '59399f68-196c-478b-8683-2761786d0639',
          index: '14',
          label: 'Build Plan in Parallel',
          title: 'Plan',
          expanded: true,
          itemsHtml: CURRENT_ITEMS,
          clickId: 'click-a',
        })}
        ${planRow({
          id: 'ce6a4d9e-3917-47e3-85ad-e990f2ea5981',
          index: '18',
          label: 'Build',
          title: 'Scénář delete subjektů (varianta 2)',
          expanded: true,
          itemsHtml: CURRENT_ITEMS,
          clickId: 'click-b',
        })}
      </div>`,
      () => {
        document.querySelectorAll('.todo-summary-content-clickable').forEach((btn) => {
          btn.addEventListener('click', () => clicks.push(btn.id));
        });
        return extract();
      },
    );

    const plans = state.messages.filter((m): m is PlanBlock => m.type === 'plan');
    assert.equal(plans.length, 2);
    assert.equal(plans[0]?.label, 'Build Plan in Parallel');
    assert.equal(plans[0]?.title, 'Plan');
    assert.equal(plans[1]?.label, 'Build');
    assert.equal(plans[1]?.title, 'Scénář delete subjektů (varianta 2)');
    for (const plan of plans) {
      assert.equal(plan.todosCompleted, 1);
      assert.equal(plan.todosTotal, 2);
      assert.deepEqual(plan.todos, [
        { text: 'Write 05.deleteSubjects.js', status: 'in_progress' },
        { text: 'Run tests', status: 'pending' },
      ]);
    }
    assert.deepEqual(clicks, []);
  });

  it('does not click an already-expanded header when item selectors miss', () => {
    const clicks: string[] = [];
    withDom(
      `<div id="container">
        ${planRow({
          id: 'plan-expanded-empty',
          index: '3',
          label: 'Build Plan in Parallel',
          title: 'Plan',
          expanded: true,
          itemsHtml: '',
          clickId: 'click-expanded',
        })}
      </div>`,
      () => {
        document.getElementById('click-expanded')?.addEventListener('click', () => clicks.push('expanded'));
        extract();
        extract();
      },
    );
    assert.deepEqual(clicks, []);
  });

  it('expands a collapsed plan once and still reads legacy .todo-summary-item', () => {
    const clicks: string[] = [];
    const { collapsedClicks, legacy } = withDom(
      `<div id="container">
        ${planRow({
          id: 'plan-collapsed',
          index: '1',
          label: 'Build Plan in Parallel',
          title: 'Plan',
          expanded: false,
          itemsHtml: '',
          clickId: 'click-collapsed',
        })}
        <div class="virtualized-composer-messages-row" data-message-role="human" data-message-kind="human"
             data-message-id="plan-legacy" data-message-index="2">
          <div class="plan-execution-with-todos-wrapper">
            <div class="plan-execution-message-content">
              <span class="plan-execution-label">Build</span>
              <span class="plan-execution-title">Legacy</span>
            </div>
            <button id="click-legacy" class="todo-summary-content todo-summary-content-clickable"
                    type="button" aria-expanded="true">1/1</button>
            <div class="todo-summary-item">
              <div class="todo-summary-item-content todo-completed">Old selector item</div>
            </div>
          </div>
        </div>
      </div>`,
      () => {
        document.getElementById('click-collapsed')?.addEventListener('click', () => clicks.push('collapsed'));
        document.getElementById('click-legacy')?.addEventListener('click', () => clicks.push('legacy'));
        extract();
        const second = extract();
        const legacyPlan = second.messages.find((m): m is PlanBlock => m.type === 'plan' && m.id === 'plan-legacy');
        return {
          collapsedClicks: clicks.filter((c) => c === 'collapsed').length,
          legacy: legacyPlan,
        };
      },
    );

    assert.equal(collapsedClicks, 1);
    assert.equal(legacy?.title, 'Legacy');
    assert.deepEqual(legacy?.todos, [{ text: 'Old selector item', status: 'completed' }]);
    assert.deepEqual(clicks, ['collapsed']);
  });
});
