import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  copyToClipboard,
  copyWithExecCommand,
} from '../src/client/utils/clipboard.js';

describe('clipboard utils', () => {
  let previous: {
    window: unknown;
    document: unknown;
    navigator: unknown;
  };

  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://192.168.1.10:3000/',
      pretendToBeVisual: true,
    });
    previous = {
      window: (globalThis as any).window,
      document: (globalThis as any).document,
      navigator: (globalThis as any).navigator,
    };
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true });
  });

  it('falls back to execCommand when navigator.clipboard is missing (HTTP LAN)', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    let copied = '';
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string) => {
        if (command !== 'copy') return false;
        const active = document.activeElement as HTMLTextAreaElement | null;
        copied = active?.value ?? '';
        return true;
      },
    });

    const result = await copyToClipboard('{"diag":1}');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.method, 'execCommand');
    assert.equal(copied, '{"diag":1}');
  });

  it('selects the full textarea range for iOS-style execCommand copy', () => {
    let selectionStart = -1;
    let selectionEnd = -1;
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: (command: string) => {
        if (command !== 'copy') return false;
        const active = document.activeElement as HTMLTextAreaElement | null;
        selectionStart = active?.selectionStart ?? -1;
        selectionEnd = active?.selectionEnd ?? -1;
        return true;
      },
    });

    const text = 'GBEJ93RD';
    assert.equal(copyWithExecCommand(text), true);
    assert.equal(selectionStart, 0);
    assert.equal(selectionEnd, text.length);
  });
});
