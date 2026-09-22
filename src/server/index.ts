import { createWriteStream, appendFileSync, mkdirSync } from 'fs';
import { checkLicense } from './license.js';
import { loadConfig, loadSelectors } from './config.js';
import { CDPBridge } from './cdp-bridge.js';
import { DOMExtractor } from './dom-extractor.js';
import { CommandExecutor } from './command-executor.js';
import { StateManager } from './state-manager.js';
import { WindowMonitor } from './window-monitor.js';
import { Relay } from './relay.js';
import { buildApprovalRegistry } from './approval-registry.js';
import { ExtensionFileBridge } from './extension-file-bridge.js';
import { SERVER_INSTANCE } from './server-info.js';
import type { Transport } from './transports/types.js';
import { TelegramTransport } from './transports/telegram/index.js';
import { RawTelegramTransport } from './transports/telegram-raw/index.js';
import { DomExportService } from './dom-export.js';
import type { CdpFailure } from '../shared/cdp-status.js';
import type { BackgroundTask, ChatTab } from './types.js';
import { ChatHostRegistry } from './hosts/chat-host-registry.js';
import { CursorHost } from './hosts/cursor-host.js';
import { ClaudeCodeHost } from './hosts/claude-code-host.js';
import { detectClaudeCodeVersion } from './hosts/claude-version.js';

try {
  mkdirSync('./temp', { recursive: true });
} catch {
  /* ignore */
}
const logStream = createWriteStream('./temp/server.log', { flags: 'a' });
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function writeLog(line: string): void {
  try {
    logStream.write(`${ts()} ${line}\n`);
  } catch {
    /* ignore write errors */
  }
}
if (process.env.LOG_FORMAT === 'json') {
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origLog(JSON.stringify({ ts: Date.now(), level: 'info', msg: line }));
    writeLog(line);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origWarn(JSON.stringify({ ts: Date.now(), level: 'warn', msg: line }));
    writeLog(`[WARN] ${line}`);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    origError(JSON.stringify({ ts: Date.now(), level: 'error', msg: line }));
    writeLog(`[ERROR] ${line}`);
  };
} else {
  console.log = (...args: unknown[]) => { const line = args.map(String).join(' '); origLog(`${ts()} ${line}`); writeLog(line); };
  console.warn = (...args: unknown[]) => { const line = args.map(String).join(' '); origWarn(`${ts()} [WARN] ${line}`); writeLog(`[WARN] ${line}`); };
  console.error = (...args: unknown[]) => { const line = args.map(String).join(' '); origError(`${ts()} [ERROR] ${line}`); writeLog(`[ERROR] ${line}`); };
}

process.on('uncaughtException', (err) => {
  const msg = `[CRASH] Uncaught exception: ${err.message}\n${err.stack ?? ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} ${msg}\n`);
  } catch {
    /* ignore */
  }
  origError(msg);
  setTimeout(() => process.exit(1), 100);
});

async function main(): Promise<void> {
  console.log(`=== CursorRemote v${SERVER_INSTANCE.version} [${SERVER_INSTANCE.instanceId}] pid=${SERVER_INSTANCE.pid} ===`);
  console.log();

  checkLicense();

  const config = loadConfig();
  const selectors = loadSelectors(config);

  console.log(`[main] CDP URL: ${config.cdpUrl}`);
  console.log(`[main] Server: http://${config.serverHost}:${config.serverPort}`);
  console.log(`[main] Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`[main] Debounce: ${config.debounceMs}ms`);
  console.log(`[main] Telegram: ${config.telegram.enabled ? 'enabled' : 'disabled'}`);
  console.log();

  const stateManager = new StateManager(config.debounceMs);
  stateManager.onCdpStatus({ cdpUrl: config.cdpUrl, reason: null, lastError: null });
  const commandExecutor = new CommandExecutor(selectors);
  const extensionBridge = new ExtensionFileBridge(config.dataDir, stateManager);

  const cdpBridge = new CDPBridge(config);

  const extractor = new DOMExtractor(
    selectors,
    (state, errorMessage) => {
      if (state) {
        // Claude tabs and background tasks ride the existing extractor tick, so
        // they reach the client through the same `state:patch` as everything
        // else — no second poller, and `/tasks` is never opened.
        state.chatTabs = mergeClaudeTabs(state.chatTabs);
        state.backgroundTasks = mergeClaudeBackgroundTasks(state.backgroundTasks);
        stateManager.onExtraction(state);
      } else {
        stateManager.onExtractionFailure(errorMessage ?? 'Extraction failed');
      }
    },
    () => cdpBridge.windows.find(w => w.id === cdpBridge.activeTargetId)?.title ?? ''
  );

  const windowMonitor = new WindowMonitor(cdpBridge, stateManager, extractor, config, selectors);

  // Adapter seam: the relay routes chat commands through a host, never through
  // the Cursor executor directly. Cursor is always registered; Claude Code only
  // contributes tabs once its webview panel is actually open.
  const hostRegistry = new ChatHostRegistry();
  hostRegistry.register(new CursorHost(commandExecutor, stateManager));
  const claudeHost = new ClaudeCodeHost({
    cdpUrl: config.cdpUrl,
    bridge: extensionBridge,
    claudeVersion: detectClaudeCodeVersion(),
  });
  hostRegistry.register(claudeHost);

  /** Claude tabs are appended after Cursor's, never interleaved. */
  function mergeClaudeTabs(cursorTabs: ChatTab[]): ChatTab[] {
    const claudeTabs = claudeHost.listTabs();
    if (claudeTabs.length === 0) return cursorTabs;
    const withHost = cursorTabs.map(tab => ({ ...tab, host: tab.host ?? 'cursor' as const }));
    return hostRegistry.getActiveHost() === 'claude-code'
      ? [...withHost.map(tab => ({ ...tab, isActive: false })),
         ...claudeTabs.map((tab, i) => ({ ...tab, isActive: i === 0 }))]
      : [...withHost, ...claudeTabs];
  }

  /**
   * Claude background tasks only appear while a Claude tab is active — mixing
   * them into the Cursor composer badge would misreport what that tab is doing.
   */
  function mergeClaudeBackgroundTasks(cursorTasks: BackgroundTask[]): BackgroundTask[] {
    if (hostRegistry.getActiveHost() !== 'claude-code') return cursorTasks;
    return claudeHost.listBackgroundTasks();
  }

  const claudeRefreshTimer = setInterval(() => {
    void claudeHost.refresh().catch(err => {
      console.warn(`[main] Claude host refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, Math.max(config.pollIntervalMs, 1000));
  claudeRefreshTimer.unref?.();

  const refreshGlobalApprovals = (): void => {
    const { notifications, registry } = buildApprovalRegistry(windowMonitor.getAllSnapshots());
    stateManager.setGlobalApprovals(notifications, registry);
  };

  windowMonitor.on('window:update', () => {
    refreshGlobalApprovals();
  });
  const domExportService = new DomExportService(
    {
      getWindows: () => cdpBridge.windows,
      getActiveState: () => {
        const state = stateManager.getCurrentState();
        return {
          activeWindowId: state.activeWindowId,
          activeComposerId: state.activeComposerId,
        };
      },
    },
    selectors,
  );

  cdpBridge.on('connected', () => {
    const client = cdpBridge.getClient();
    stateManager.onCdpStatus({ cdpUrl: config.cdpUrl, reason: null, lastError: null });
    stateManager.onConnectionChanged(true);
    stateManager.updateWindows(cdpBridge.windows, cdpBridge.activeTargetId);
    commandExecutor.setClient(client);
    if (client) {
      extractor.start(client, config.pollIntervalMs);
    }
  });

  cdpBridge.on('disconnected', () => {
    stateManager.onConnectionChanged(false);
    commandExecutor.setClient(null);
    extractor.stop();
  });

  cdpBridge.on('error', (_err: Error, failure?: CdpFailure) => {
    const classified = failure ?? cdpBridge.getLastFailure();
    console.error(`[main] CDP error: ${classified?.message ?? 'unknown'}`);
    stateManager.onCdpStatus({
      cdpUrl: config.cdpUrl,
      reason: classified?.reason ?? 'connect_error',
      lastError: classified?.message ?? 'CDP connection failed',
    });
  });

  const transports: Transport[] = [];

  extensionBridge.start();

  const relay = new Relay(
    config,
    stateManager,
    commandExecutor,
    cdpBridge,
    extensionBridge,
    domExportService,
    windowMonitor,
    () => {
      extractor.requestPoll(0);
    },
    undefined,
    hostRegistry,
  );
  await relay.start();

  windowMonitor.start();
  refreshGlobalApprovals();

  console.log('[main] Connecting to Cursor IDE (degraded mode until CDP is up)...');
  void cdpBridge.connect();

  if (config.telegram.enabled && config.telegram.botToken) {
    const TgTransport = config.telegram.impl === 'raw' ? RawTelegramTransport : TelegramTransport;
    if (config.telegram.impl === 'raw') {
      console.log('[telegram] Using raw Bot API transport (no Grammy)');
    }
    const telegram = new TgTransport(
      config.telegram,
      windowMonitor,
      stateManager,
      commandExecutor,
      cdpBridge
    );

    const names = telegram.registeredUserNames;
    if (names.length > 0) {
      console.log(`[telegram] Registered user(s): ${names.join(', ')}`);
      console.log(`[telegram] To register a different user: /register ${telegram.registerToken}`);
    } else {
      console.log(`[telegram] To register, send in your Telegram group: /register ${telegram.registerToken}`);
    }

    telegram.start().catch(err => {
      console.error(`[telegram] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
    transports.push(telegram);
  }

  const shutdown = async () => {
    console.log('\n[main] Shutting down...');
    windowMonitor.stop();
    extractor.stop();
    for (const transport of transports) {
      await transport.stop();
    }
    extensionBridge.stop();
    await cdpBridge.disconnect();
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    const msg = `[main] Unhandled rejection: ${String(reason)}`;
    try {
      appendFileSync('./temp/server.log', `${ts()} [ERROR] ${msg}\n`);
    } catch {
      /* ignore */
    }
    console.error(msg);
  });
}

main().catch((err) => {
  const msg = `[main] Fatal error: ${err instanceof Error ? err.message : String(err)}\n${err instanceof Error ? err.stack ?? '' : ''}`;
  try {
    appendFileSync('./temp/server.log', `${ts()} [ERROR] ${msg}\n`);
  } catch {
    /* ignore */
  }
  console.error(msg);
  setTimeout(() => process.exit(1), 100);
});
