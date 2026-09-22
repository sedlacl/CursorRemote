import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHostRegistry } from '../src/server/hosts/chat-host-registry.js';
import { BaseChatHost, NO_CAPABILITIES } from '../src/server/hosts/chat-host.js';
import {
  outcomeToTasks,
  readBackgroundTasks,
  resetBackgroundTaskLogging,
  VERIFIED_VERSIONS,
} from '../src/server/hosts/claude-background-tasks.js';
import { parseVersionFromFolder } from '../src/server/hosts/claude-version.js';
import { cleanSessionTitle, parseSessionId } from '../src/server/hosts/claude-code-host.js';
import type { ChatHostId, ChatTab, CommandResult } from '../src/server/types.js';

function tab(overrides: Partial<ChatTab> & { composerId: string }): ChatTab {
  return {
    title: 'Chat',
    isActive: false,
    status: '',
    selectorPath: '',
    source: 'open',
    workStatus: 'idle',
    ...overrides,
  };
}

class FakeHost extends BaseChatHost {
  readonly capabilities = { ...NO_CAPABILITIES };
  readonly calls: string[] = [];
  private available = true;

  constructor(readonly id: ChatHostId, private tabs: ChatTab[] = []) {
    super();
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(value: boolean): void {
    this.available = value;
  }

  listTabs(): ChatTab[] {
    return this.tabs;
  }

  newChat(commandId: string): Promise<CommandResult> {
    this.calls.push('newChat');
    return Promise.resolve({ commandId, ok: true });
  }
}

// ─── routing contract ───

describe('ChatHostRegistry routing', () => {
  it('routes a tab with no host field to cursor', () => {
    const registry = new ChatHostRegistry();
    const cursor = new FakeHost('cursor');
    registry.register(cursor);

    // Tabs extracted before the host field existed must keep working.
    assert.equal(registry.forTab(tab({ composerId: 'a' }))?.id, 'cursor');
    assert.equal(registry.forTab(undefined)?.id, 'cursor');
  });

  it('routes a tab to the host named on it', () => {
    const registry = new ChatHostRegistry();
    registry.register(new FakeHost('cursor'));
    registry.register(new FakeHost('claude-code'));

    const claudeTab = tab({ composerId: 'claude:x', host: 'claude-code' });
    assert.equal(registry.forTab(claudeTab)?.id, 'claude-code');
  });

  it('sends tab-less commands to the host of the tab the user switched to', () => {
    const registry = new ChatHostRegistry();
    const cursor = new FakeHost('cursor', [tab({ composerId: 'a', isActive: true })]);
    const claude = new FakeHost('claude-code', [tab({ composerId: 'claude:x', host: 'claude-code' })]);
    registry.register(cursor);
    registry.register(claude);

    assert.equal(registry.forActiveTab(cursor.listTabs())?.id, 'cursor');

    registry.setActiveHost('claude-code');
    assert.equal(registry.forActiveTab(cursor.listTabs())?.id, 'claude-code');
  });

  it('falls back to the DOM-active tab when the recorded host is unavailable', () => {
    const registry = new ChatHostRegistry();
    const cursor = new FakeHost('cursor', [tab({ composerId: 'a', isActive: true })]);
    const claude = new FakeHost('claude-code');
    registry.register(cursor);
    registry.register(claude);

    // Panel closed since the switch — commands must not vanish into a dead host.
    registry.setActiveHost('claude-code');
    claude.setAvailable(false);
    assert.equal(registry.forActiveTab(cursor.listTabs())?.id, 'cursor');
  });

  it('merges Claude tabs after Cursor tabs with exactly one active', () => {
    const registry = new ChatHostRegistry();
    registry.register(new FakeHost('cursor', [
      tab({ composerId: 'a', isActive: true }),
      tab({ composerId: 'b' }),
    ]));
    registry.register(new FakeHost('claude-code', [
      tab({ composerId: 'claude:x', host: 'claude-code' }),
    ]));

    registry.setActiveHost('claude-code');
    const merged = registry.mergeTabs();

    assert.deepEqual(merged.map(t => t.composerId), ['a', 'b', 'claude:x']);
    assert.equal(merged.filter(t => t.isActive).length, 1);
    assert.equal(merged.find(t => t.isActive)?.host, 'claude-code');
  });

  it('answers unsupported operations with an error instead of throwing', async () => {
    const claude = new FakeHost('claude-code');
    const result = await claude.sendMessage('cmd-1', 'hi', []);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not supported by the claude-code host/);
  });
});

// ─── fail-closed background tasks ───

function fakeWebview(evaluate: () => unknown) {
  return {
    isConnected: () => true,
    evaluateInPanel: async () => evaluate(),
  };
}

describe('Claude backgroundTasks reader is fail-closed', () => {
  beforeEach(() => resetBackgroundTaskLogging());

  it('reports no tasks for a version whose schema was never probed', async () => {
    let evaluated = false;
    const webview = fakeWebview(() => {
      evaluated = true;
      return { found: true, sessionId: 's', entries: [{ key: 'k', value: { label: 'npm test' } }] };
    });

    const outcome = await readBackgroundTasks(webview, '99.0.0');

    assert.equal(outcome.status, 'unverified-version');
    assert.deepEqual(outcomeToTasks(outcome), []);
    // The locator must not even run against an unverified build.
    assert.equal(evaluated, false);
  });

  it('reports no tasks when the named locator is not satisfied', async () => {
    const version = VERIFIED_VERSIONS[0];
    if (!version) return; // No verified version yet — the gate above covers it.

    const outcome = await readBackgroundTasks(
      fakeWebview(() => ({ found: false, reason: 'no-session-locator' })),
      version,
    );
    assert.equal(outcome.status, 'no-locator');
    assert.deepEqual(outcomeToTasks(outcome), []);
  });

  it('reports no tasks when backgroundTasks is not a Map or object', async () => {
    const version = VERIFIED_VERSIONS[0];
    if (!version) return;

    const outcome = await readBackgroundTasks(
      fakeWebview(() => ({ found: false, reason: 'backgroundTasks-not-map-or-object:undefined' })),
      version,
    );
    assert.equal(outcome.status, 'bad-shape');
    assert.deepEqual(outcomeToTasks(outcome), []);
  });

  it('reports no tasks when the webview client is gone', async () => {
    const outcome = await readBackgroundTasks(null, '2.1.278');
    assert.equal(outcome.status, 'error');
    assert.deepEqual(outcomeToTasks(outcome), []);
  });

  it('keeps VERIFIED_VERSIONS as the only gate that opens the reader', () => {
    // Guards the contract: a Claude Code bump must re-probe before its
    // backgroundTasks shape is trusted. Adding a version here is a deliberate
    // act, never a side effect of some other change.
    for (const version of VERIFIED_VERSIONS) {
      assert.match(version, /^\d+\.\d+\.\d+$/);
    }
  });
});

describe('Claude tab ids', () => {
  it('never mistakes a webview id for a session id', () => {
    // Both are UUIDs, so only the prefix can tell them apart. Handing a webview
    // id to claude-vscode.editor.open would open the wrong session, or none.
    const uuid = 'c1a7cd01-1c74-4331-97cc-08d735518ca4';
    assert.equal(parseSessionId(`claude:session:${uuid}`), uuid);
    assert.equal(parseSessionId(`claude:panel:${uuid}`), null);
    assert.equal(parseSessionId(`claude:${uuid}`), null);
    assert.equal(parseSessionId('composer-123'), null);
  });

  it('rejects a session id that is not a UUID', () => {
    assert.equal(parseSessionId('claude:session:not-a-uuid'), null);
  });

  it('strips the relative timestamp a session row renders inline', () => {
    // Row textContent reads "Claude code adapter implementacenow".
    assert.equal(cleanSessionTitle('Claude code adapter implementacenow'), 'Claude code adapter implementace');
    assert.equal(cleanSessionTitle('Refactor parser2h'), 'Refactor parser');
    assert.equal(cleanSessionTitle('Plain title'), 'Plain title');
  });
});

describe('Claude Code version detection', () => {
  it('parses the version out of the extension folder name', () => {
    assert.equal(
      parseVersionFromFolder('anthropic.claude-code-2.1.278-win32-x64'),
      '2.1.278',
    );
    assert.equal(parseVersionFromFolder('anthropic.claude-code-2.1.278'), '2.1.278');
    assert.equal(parseVersionFromFolder('ms-python.python-2024.1.0'), null);
  });
});
