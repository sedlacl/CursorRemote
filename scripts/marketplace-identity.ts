/** Marketplace (Open VSX / public) identity — independent of the local dev package.json. */
export const MARKETPLACE_PUBLISHER = 'qjohn';
export const MARKETPLACE_DISPLAY_NAME = 'QJohn CursorRemote';

export const DEV_PUBLISHER = 'cursor-remote-dev';
export const DEV_DISPLAY_NAME = 'QJohn CursorRemote (Dev)';

export function marketplaceExtensionId(extensionName: string): string {
  return `${MARKETPLACE_PUBLISHER}.${extensionName}`;
}
