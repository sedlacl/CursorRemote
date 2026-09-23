import * as vscode from 'vscode';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isCdpEndpointListening, parseRemoteDebuggingPort } from '../../src/shared/cdp-status.js';
import {
  cdpRestartPromptClaimFileName,
  shouldOfferCdpRestart,
} from '../../src/shared/cdp-restart-prompt.js';
import { scheduleCursorCdpBreakawayRestart } from '../../src/server/cursor-cdp-breakaway-restart.js';
import type { UnifiedOutputChannel } from './output-channel.js';

const SETTING = 'promptRestartWithoutCdp';
const RESTART = 'Restart Cursor';
const DONT_ASK = "Don't ask again";

function launchPid(): string {
  const fromEnv = process.env.VSCODE_PID?.trim();
  if (fromEnv) return fromEnv;
  return String(process.ppid || process.pid);
}

/** Exclusive claim for this Cursor process. False when another window already asked. */
function claimThisLaunch(dataDir: string, pid: string): boolean {
  mkdirSync(dataDir, { recursive: true });
  const name = cdpRestartPromptClaimFileName(pid);
  try {
    writeFileSync(join(dataDir, name), pid, { flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
  try {
    for (const entry of readdirSync(dataDir)) {
      if (entry.startsWith('cdp-restart-prompt.') && entry !== name) {
        unlinkSync(join(dataDir, entry));
      }
    }
  } catch {
    /* stale claims are optional */
  }
  return true;
}

export async function promptRestartCursorIfCdpDown(
  context: vscode.ExtensionContext,
  log: UnifiedOutputChannel,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const promptEnabled = config.get<boolean>(SETTING, true);
  if (!promptEnabled) {
    log.info('[extension] CDP restart prompt is off (cursorRemote.promptRestartWithoutCdp).');
    return;
  }

  const cdpUrl = config.get<string>('cdpUrl', 'http://127.0.0.1:9222');
  const cdpListening = await isCdpEndpointListening(cdpUrl, (url, init) => fetch(url, init));
  if (cdpListening) {
    log.info(`[extension] CDP is listening at ${cdpUrl}.`);
    return;
  }

  const dataDir = context.globalStorageUri.fsPath;
  const claimed = claimThisLaunch(dataDir, launchPid());
  if (!shouldOfferCdpRestart({
    promptEnabled: true,
    cdpListening: false,
    alreadyClaimedThisLaunch: !claimed,
  })) {
    log.info('[extension] CDP restart prompt already shown for this Cursor launch.');
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    'CursorRemote: remote debugging (CDP) is not enabled, so the web client cannot connect. Restart Cursor to turn it on? This closes every Cursor window.',
    RESTART,
    'Not now',
    DONT_ASK,
  );

  if (choice === DONT_ASK) {
    await config.update(SETTING, false, vscode.ConfigurationTarget.Global);
    log.info('[extension] CDP restart prompt turned off from the dialog.');
    return;
  }
  if (choice !== RESTART) {
    log.info('[extension] CDP restart declined.');
    return;
  }

  const port = parseRemoteDebuggingPort(cdpUrl);
  if (port == null) {
    const message = `CursorRemote: cannot restart — CDP URL is invalid (${cdpUrl}).`;
    log.warn(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  try {
    log.info(`[extension] Scheduling Cursor restart with CDP port ${port}.`);
    await scheduleCursorCdpBreakawayRestart({ port, dataDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[extension] CDP restart failed: ${message}`);
    void vscode.window.showErrorMessage(`CursorRemote: restart failed. ${message}`);
  }
}
