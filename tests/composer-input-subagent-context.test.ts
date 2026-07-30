import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { ComposerInput } from '../src/client/components/shell/ComposerInput.js';
import {
  baseCursorState,
  createComponentTestEnv,
} from './helpers/component-test-env.js';

describe('ComposerInput subagent context UI', () => {
  it('hides message input and shows back button for subagent without composer input', () => {
    const env = createComponentTestEnv();
    env.render(
      React.createElement(ComposerInput, {
        state: baseCursorState({
          inputAvailable: true,
          composerInputAvailable: false,
          activeConversationContext: {
            kind: 'subagent',
            composerId: 'composer-c',
            depth: 2,
            parentComposerId: 'composer-b',
            parentWindowId: 'win-1',
            parentTitle: 'Child B',
            rootOrchestratorComposerId: 'composer-a',
            returnToParentAvailable: true,
            composerInputAvailable: false,
          },
        }),
        setSendPending: () => undefined,
      }),
    );

    assert.equal(env.document.getElementById('message-input'), null);
    const backBtn = env.document.querySelector('.composer-return-parent-btn') as HTMLButtonElement | null;
    assert.ok(backBtn);
    assert.match(backBtn.textContent || '', /Zpět k Child B/i);
    assert.equal(backBtn.getAttribute('aria-label'), 'Vrátit se k rodičovské konverzaci: Child B');
    env.cleanup();
  });

  it('renders normal composer for orchestrator context', () => {
    const env = createComponentTestEnv();
    env.render(
      React.createElement(ComposerInput, {
        state: baseCursorState({
          inputAvailable: true,
          composerInputAvailable: true,
          activeConversationContext: {
            kind: 'orchestrator',
            composerId: 'composer-a',
            depth: 0,
            returnToParentAvailable: false,
            composerInputAvailable: true,
          },
        }),
        setSendPending: () => undefined,
      }),
    );

    assert.ok(env.document.getElementById('message-input'));
    assert.equal(env.document.querySelector('.composer-return-parent-btn'), null);
    env.cleanup();
  });
});
