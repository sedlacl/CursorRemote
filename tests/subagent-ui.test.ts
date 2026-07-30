import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import React from 'react';
import { act } from 'react';
import { MultitaskStatusStrip, resolveHeaderStopTarget } from '../src/client/components/shell/MultitaskStatusStrip.js';
import { createComponentTestEnv } from './helpers/component-test-env.js';

describe('MultitaskStatusStrip subagent controls', () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
  });

  const singleRunningSubagent = {
    runningCount: 1,
    summary: '1 subagent running',
    items: [{
      id: 'subagent:probe|gpt-5.6',
      title: 'Probe task',
      model: 'GPT-5.6',
      status: 'running' as const,
      openAvailable: true,
      stopAvailable: true,
    }],
  };

  it('resolveHeaderStopTarget returns the sole running stoppable item', () => {
    assert.equal(resolveHeaderStopTarget(singleRunningSubagent)?.id, 'subagent:probe|gpt-5.6');
    assert.equal(resolveHeaderStopTarget({
      ...singleRunningSubagent,
      items: [
        singleRunningSubagent.items[0]!,
        { ...singleRunningSubagent.items[0]!, id: 'subagent:two|gpt-5.6', title: 'Two' },
      ],
    }), null);
    assert.equal(resolveHeaderStopTarget({
      ...singleRunningSubagent,
      items: [{ ...singleRunningSubagent.items[0]!, stopAvailable: false }],
    }), null);
  });

  it('shows header Stop for one running subagent and targets its id', async () => {
    const env = createComponentTestEnv();
    cleanup = env.cleanup;
    const confirmCalls: string[] = [];
    (globalThis as { window: Window }).window.confirm = ((message?: string) => {
      confirmCalls.push(String(message || ''));
      return true;
    }) as typeof window.confirm;

    env.render(
      React.createElement(MultitaskStatusStrip, { subagents: singleRunningSubagent }),
    );
    await act(async () => {});

    const headerStopBtn = env.document.querySelector('.multitask-header-stop-btn') as HTMLButtonElement | null;
    assert.ok(headerStopBtn, 'header Stop should be visible');
    assert.equal(headerStopBtn.getAttribute('aria-label'), 'Stop Probe task');

    await act(async () => {
      headerStopBtn.click();
    });
    assert.equal(confirmCalls.length, 1);
    assert.match(confirmCalls[0]!, /Probe task/);
    assert.equal(env.command.awaited.at(-1)?.event, 'command:stop_subagent');
    assert.equal(env.command.awaited.at(-1)?.payload.subagentId, 'subagent:probe|gpt-5.6');
    assert.equal(env.command.awaited.at(-1)?.payload.selectorPath, undefined);
  });

  it('hides unsafe summary Stop when multiple running subagents are stoppable', async () => {
    const env = createComponentTestEnv();
    cleanup = env.cleanup;
    env.render(
      React.createElement(MultitaskStatusStrip, {
        subagents: {
          runningCount: 2,
          summary: '2 subagents running',
          items: [
            singleRunningSubagent.items[0]!,
            { ...singleRunningSubagent.items[0]!, id: 'subagent:two|gpt-5.6', title: 'Two' },
          ],
        },
      }),
    );
    await act(async () => {});
    assert.equal(env.document.querySelector('.multitask-header-stop-btn'), null);
    assert.equal(env.document.querySelectorAll('.subagent-stop-btn').length, 2);
  });

  it('sends open_subagent by id and confirms before stop_subagent', async () => {
    const env = createComponentTestEnv();
    cleanup = env.cleanup;
    const confirmCalls: string[] = [];
    (globalThis as { window: Window }).window.confirm = ((message?: string) => {
      confirmCalls.push(String(message || ''));
      return true;
    }) as typeof window.confirm;

    env.render(
      React.createElement(MultitaskStatusStrip, { subagents: singleRunningSubagent }),
    );
    await act(async () => {});

    const openBtn = env.document.querySelector('.subagent-open-btn') as HTMLButtonElement | null;
    const stopBtn = env.document.querySelector('.subagent-stop-btn') as HTMLButtonElement | null;
    assert.ok(openBtn);
    assert.ok(stopBtn);

    await act(async () => {
      openBtn.click();
    });
    assert.equal(env.command.awaited.at(-1)?.event, 'command:open_subagent');
    assert.equal(env.command.awaited.at(-1)?.payload.subagentId, 'subagent:probe|gpt-5.6');
    assert.equal(env.command.awaited.at(-1)?.payload.selectorPath, undefined);

    await act(async () => {
      stopBtn.click();
    });
    assert.equal(confirmCalls.length, 1);
    assert.match(confirmCalls[0]!, /Probe task/);
    assert.equal(env.command.awaited.at(-1)?.event, 'command:stop_subagent');
    assert.equal(env.command.awaited.at(-1)?.payload.subagentId, 'subagent:probe|gpt-5.6');
  });
});
