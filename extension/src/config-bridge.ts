import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join } from 'path';

export function buildEnvFromConfig(
  context: vscode.ExtensionContext,
  licenseKey: string | undefined
): Record<string, string> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const clientSrcDir = context.extensionMode === vscode.ExtensionMode.Development
    ? join(context.extensionPath, 'src', 'client')
    : '';
  return {
    CDP_URL: config.get<string>('cdpUrl', 'http://127.0.0.1:9222'),
    SERVER_PORT: String(config.get<number>('serverPort', 3000)),
    SERVER_HOST: config.get<string>('serverHost', '127.0.0.1'),
    POLL_INTERVAL_MS: String(config.get<number>('pollIntervalMs', 500)),
    DEBOUNCE_MS: String(config.get<number>('debounceMs', 300)),
    LOG_LEVEL: config.get<string>('logLevel', 'info'),
    WEBAPP_PASSWORD: config.get<string>('webappPassword', ''),
    WINDOW_TITLE_QUALIFIER: String(config.get<boolean>('windowTitleQualifier', true)),
    TELEGRAM_ENABLED: String(config.get<boolean>('telegram.enabled', false)),
    TELEGRAM_BOT_TOKEN: config.get<string>('telegram.botToken', ''),
    TELEGRAM_ALLOWED_USERS: config.get<string>('telegram.allowedUsers', ''),
    TELEGRAM_IMPL: config.get<string>('telegram.impl', 'grammy'),
    LICENSE_KEY: licenseKey ?? '',
    DATA_DIR: context.globalStorageUri.fsPath,
    UI_REPORTS_DIR: join(context.globalStorageUri.fsPath, 'issues'),
    PACKAGE_ROOT: context.extensionPath,
    LOG_FORMAT: 'json',
    ...(clientSrcDir && existsSync(clientSrcDir) ? { CLIENT_SRC_DIR: clientSrcDir } : {}),
  };
}
