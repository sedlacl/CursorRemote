/** Basename of a workspace folder path (matches CDP extractWorkspaceName). */
export function basenameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
}

export function authorityToQualifier(authority: string): string {
  if (!authority) return '';
  if (authority.startsWith('wsl+')) {
    return `[WSL: ${authority.slice(4)}]`;
  }
  if (authority.startsWith('ssh-remote+')) {
    const hex = authority.slice('ssh-remote+'.length);
    try {
      const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: string };
      return decoded.hostName ? `[SSH: ${decoded.hostName}]` : '[SSH]';
    } catch {
      return `[SSH: ${hex.substring(0, 16)}]`;
    }
  }
  return `[${authority}]`;
}

export interface WorkspaceIdentityInput {
  workspacePath?: string;
  workspaceName?: string;
  authority?: string;
  includeQualifier?: boolean;
}

/** Stable workspace key shared by extension push and CDP window titles. */
export function resolveWorkspaceIdentity(input: WorkspaceIdentityInput): string {
  const folderBasename = input.workspacePath
    ? basenameFromPath(input.workspacePath)
    : null;
  const trimmedName = input.workspaceName?.trim();
  const basename = trimmedName || folderBasename || 'unknown';
  if (input.includeQualifier === false || !input.authority) return basename;
  const qualifier = authorityToQualifier(input.authority);
  return qualifier ? `${basename} ${qualifier}` : basename;
}
