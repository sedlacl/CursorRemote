import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { createOutputChannel } from './output-channel.js';
import { createStatusBar } from './status-bar.js';
import { ServerManager } from './server-manager.js';
import { LicenseManager } from './license-manager.js';
import { StatusTreeView } from './tree-view.js';
import { SetupPanel } from './setup-panel.js';
import { GitStateBridge } from './git-state-bridge.js';
import { VsCodeCommandBridge } from './vscode-command-bridge.js';

let serverManager: ServerManager | undefined;

async function ensurePassword(): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const current = config.get<string>('webappPassword', '');
  if (current) return;

  const generated = randomBytes(16).toString('base64url');
  await config.update('webappPassword', generated, vscode.ConfigurationTarget.Global);

  // Fire-and-forget — don't block activate() waiting for user interaction
  vscode.window.showInformationMessage(
    `CursorRemote: A web client password has been generated: ${generated}`,
    'Copy to Clipboard',
    'Open Settings'
  ).then(action => {
    if (action === 'Copy to Clipboard') {
      vscode.env.clipboard.writeText(generated);
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'cursorRemote.webappPassword');
    }
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = createOutputChannel();
  const extensionMode = context.extensionMode === vscode.ExtensionMode.Development ? 'development' : 'installed';
  outputChannel.info(
    `[extension] CursorRemote activate (${extensionMode}) path=${context.extensionPath}`
  );
  if (
    context.extensionMode === vscode.ExtensionMode.Development
    && context.extensionPath.replace(/\\/g, '/').includes('/.cursor/extensions/')
  ) {
    outputChannel.warn(
      '[extension] Development host is using an installed extension copy — launch via F5 "CursorRemote: Extension Dev Host", not by opening the workspace in a normal window.'
    );
  }

  const statusBarItem = createStatusBar(context);

  const licenseManager = new LicenseManager(context, () => {
    if (serverManager && serverManager.serverState === 'stopped') {
      serverManager.start();
    }
  });

  serverManager = new ServerManager(
    context,
    outputChannel,
    statusBarItem,
    () => licenseManager.getKey()
  );

  serverManager.startDirWatcher();

  const extensionVersion = context.extension.packageJSON?.version ?? 'unknown';
  const gitStateBridge = new GitStateBridge(context, outputChannel, serverManager);
  gitStateBridge.start();
  serverManager.setLocalGitStatusProvider(() => gitStateBridge.getLocalGitStatus());
  gitStateBridge.onDidChangeLocalGitStatus(() => {
    serverManager.refreshStatusBar();
  });

  // Lets the server drive `claude-vscode.*` chrome (open/focus a session,
  // new conversation, accept/reject diff) — commands have no CDP equivalent.
  const vsCodeCommandBridge = new VsCodeCommandBridge(context, outputChannel);
  vsCodeCommandBridge.start();

  const treeView = new StatusTreeView(serverManager, licenseManager, extensionVersion, gitStateBridge);

  context.subscriptions.push(
    outputChannel,
    gitStateBridge,
    vsCodeCommandBridge,
    vscode.window.registerTreeDataProvider('cursorRemote.status', treeView),
    vscode.commands.registerCommand('cursorRemote.start', () => serverManager!.start()),
    vscode.commands.registerCommand('cursorRemote.stop', () => serverManager!.stop(true)),
    vscode.commands.registerCommand('cursorRemote.restart', () => serverManager!.restart()),
    vscode.commands.registerCommand('cursorRemote.openWebClient', () => serverManager!.openWebClient()),
    vscode.commands.registerCommand('cursorRemote.showLogs', () => outputChannel.show()),
    vscode.commands.registerCommand('cursorRemote.enterLicenseKey', async () => {
      await licenseManager.promptForKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.buyLicense', () => licenseManager.openBuyLink()),
    vscode.commands.registerCommand('cursorRemote.clearLicenseKey', async () => {
      await licenseManager.clearKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.openSetup', () => SetupPanel.createOrShow(context)),
    vscode.commands.registerCommand('cursorRemote.refreshGitStatus', () => gitStateBridge.explicitRefreshGitStatus()),
    vscode.commands.registerCommand('cursorRemote.openSourceControl', async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
    }),
  );

  ensurePassword().catch(err => {
    outputChannel.warn(`Password auto-generation failed: ${err}`);
  });

  const config = vscode.workspace.getConfiguration('cursorRemote');
  if (config.get<boolean>('autoStart', true)) {
    licenseManager.checkLicense().then(valid => {
      if (valid) {
        serverManager!.start();
      }
    });
  }
}

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop();
    serverManager.dispose();
  }
}
