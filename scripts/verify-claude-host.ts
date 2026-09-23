/**
 * Manual verification harness for the Claude Code host.
 *
 * Read-only by default: it connects, lists tabs, checks that every control the
 * host depends on is present, and reports what the background-tasks reader
 * decides — without typing, clicking or sending anything.
 *
 * Each action that changes something in the IDE is behind its own flag, because
 * they are not reversible: `--send` really posts a message into a real Claude
 * session, `--new-chat` really creates one.
 *
 * Usage:
 *   npx tsx scripts/verify-claude-host.ts                    # read-only
 *   npx tsx scripts/verify-claude-host.ts --send "ping"      # sends for real
 *   npx tsx scripts/verify-claude-host.ts --new-chat
 *   npx tsx scripts/verify-claude-host.ts --switch <n>       # tab index from the listing
 *   npx tsx scripts/verify-claude-host.ts --stop
 *   npx tsx scripts/verify-claude-host.ts --approve | --reject
 *
 * `--new-chat`, `--switch`, `--stop` and the diff actions go through the
 * extension command bridge, so the CursorRemote extension must be running with
 * this build (F5 "CursorRemote: Extension Dev Host"). Without it they time out —
 * which is itself a useful result, and the script says so.
 */
import 'dotenv/config';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/server/config.js';
import { ClaudeCodeHost } from '../src/server/hosts/claude-code-host.js';
import { ExtensionFileBridge } from '../src/server/extension-file-bridge.js';
import { detectClaudeCodeVersion } from '../src/server/hosts/claude-version.js';
import type { StateManager } from '../src/server/state-manager.js';
import type { CommandResult } from '../src/server/types.js';

/**
 * Where the extension parks its request/result files. The server normally gets
 * this as DATA_DIR from the extension; standalone we have to find it, or the
 * bridge would write into ./data where nothing is listening.
 */
function resolveBridgeDataDir(): { dir: string; source: string } {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) return { dir: fromEnv, source: 'DATA_DIR' };

  const candidates = [
    join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'cursor-remote-dev.cursor-remote'),
    join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'qjohn.cursor-remote'),
    join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'cursor-remote-dev.cursor-remote'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return { dir, source: 'extension globalStorage' };
  }
  return { dir: join(process.cwd(), 'data'), source: 'fallback ./data (bridge will time out)' };
}

function report(label: string, result: CommandResult): void {
  const mark = result.ok ? 'OK  ' : 'FAIL';
  console.log(`  [${mark}] ${label}${result.ok ? '' : ` — ${result.error ?? 'no error given'}`}`);

}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const config = loadConfig();
  const version = detectClaudeCodeVersion();
  const bridgeDir = resolveBridgeDataDir();

  console.log(`CDP:            ${config.cdpUrl}`);
  console.log(`Claude Code:    ${version ?? 'not installed'}`);
  console.log(`Bridge dataDir: ${bridgeDir.dir}`);
  console.log(`                (${bridgeDir.source})\n`);

  const bridge = new ExtensionFileBridge(bridgeDir.dir, {} as StateManager);
  bridge.start();

  const host = new ClaudeCodeHost({
    cdpUrl: config.cdpUrl,
    bridge,
    claudeVersion: version,
  });

  // ─── read-only ──────────────────────────────────────────────────────────
  console.log('1. Extension command bridge');
  const info = bridge.readVsCodeBridgeInfo();
  if (!info) {
    console.log(`  [--  ] nothing is watching ${bridgeDir.dir}`);
    console.log('         new_chat / switch_tab / diff actions will fail fast.');
  } else {
    const blocked = bridge.checkVsCodeBridge('claude-vscode.editor.open');
    console.log(`  [${blocked ? '--  ' : 'OK  '}] ${info.extensionId}@${info.extensionVersion} `
      + `(protocol ${info.protocol}, pid ${info.pid})`);
    if (blocked) console.log(`         ${blocked}`);
  }

  console.log('\n2. Connection');
  const connected = await host.reconnectNow();
  console.log(`  connected=${connected} available=${host.isAvailable()}`);
  if (!connected) {
    console.log('\n  No Claude Code chat surface is open. Open the panel (or a Claude editor tab) and re-run.');
    return;
  }

  console.log('\n3. Tabs');
  await host.refresh();
  const tabs = host.listTabs();
  if (tabs.length === 0) {
    console.log('  (none)');
  }
  tabs.forEach((tab, i) => {
    console.log(`  [${i}] ${tab.title}`);
    console.log(`      ${tab.composerId}`);
  });

  console.log('\n4. Background tasks');
  console.log(`  reported: ${JSON.stringify(host.listBackgroundTasks())}`);
  console.log(`  capability open: ${host.capabilities.backgroundTasks}`);
  console.log('  (false is the expected, correct result on 2.1.278 — see docs/claude-code-adapter.md)');

  console.log('\n5. Controls the host depends on');
  const controls = await inspectControls(host);
  for (const [name, present] of Object.entries(controls)) {
    console.log(`  [${present ? 'OK  ' : '--  '}] ${name}`);
  }
  console.log('  Stop and permission controls only exist while a turn runs / a prompt is pending.');

  // ─── actions ────────────────────────────────────────────────────────────
  const wantsAction = flag('send') || flag('new-chat') || flag('switch')
    || flag('stop') || flag('approve') || flag('reject');
  if (!wantsAction) {
    console.log('\nRead-only run finished. Add a flag to exercise an action (see the header comment).');
    host.disconnect();
    return;
  }

  console.log('\n6. Actions');

  if (flag('stop')) {
    report('stop turn', await host.stopTurn('verify-stop'));
  }

  if (flag('approve')) {
    report('approve', await host.approve({ commandId: 'verify-approve' }));
  }

  if (flag('reject')) {
    report('reject', await host.reject({ commandId: 'verify-reject' }));
  }

  if (flag('switch')) {
    const index = Number(value('switch') ?? '0');
    const tab = tabs[index];
    if (!tab) {
      console.log(`  [FAIL] switch tab — no tab at index ${index}`);
    } else {
      report(`switch to "${tab.title}"`, await host.switchTab('verify-switch', {
        composerId: tab.composerId,
        title: tab.title,
      }));
    }
  }

  if (flag('new-chat')) {
    report('new conversation', await host.newChat('verify-new-chat'));
  }

  if (flag('send')) {
    const text = value('send');
    if (!text) {
      console.log('  [FAIL] send — --send needs the message text');
    } else {
      console.log(`  sending into the active session: ${JSON.stringify(text)}`);
      report('send message', await host.sendMessage('verify-send', text, []));
    }
  }

  host.disconnect();
}

/** Presence check only — nothing is focused, typed or clicked. */
async function inspectControls(host: ClaudeCodeHost): Promise<Record<string, boolean>> {
  const webview = (host as unknown as {
    webview: { evaluateInPanel(fn: string): Promise<unknown> };
  }).webview;

  try {
    const found = await webview.evaluateInPanel(`(d) => {
      const visible = (sel) => {
        const el = d.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const labelled = (re) => Array.from(d.querySelectorAll('button, [role="button"]'))
        .some(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return re.test(((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')));
        });

      return {
        'message input': visible('[role="textbox"][aria-label="Message input"]'),
        'send button': visible('[aria-label="Send message"]'),
        'new session button': visible('[aria-label="New session"]'),
        'session history button': visible('[aria-label="Session history"]'),
        'stop control (only while running)': labelled(/\\b(stop|interrupt)\\b/i),
        'permission controls (only while pending)': labelled(/\\b(allow|deny|approve|reject)\\b/i),
      };
    }`);
    return (found ?? {}) as Record<string, boolean>;
  } catch (err) {
    console.log(`  (control inspection failed: ${err instanceof Error ? err.message : String(err)})`);
    return {};
  }
}

main().catch(err => {
  console.error('verify-claude-host failed:', err);
  process.exit(1);
});
