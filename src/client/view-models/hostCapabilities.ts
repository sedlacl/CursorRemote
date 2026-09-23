import type { ChatHostCapabilities, ChatHostId, CursorState } from '../../server/types.js';

/**
 * Backend behind the active tab, as the server published it. Falls back to the
 * active tab's `host` for servers that predate `activeHost`.
 */
export function activeHostOf(state: Pick<CursorState, 'activeHost' | 'chatTabs'>): ChatHostId {
  return state.activeHost
    ?? state.chatTabs.find(tab => tab.isActive)?.host
    ?? 'cursor';
}

/**
 * Whether the active host can do `capability`. A server that publishes no
 * capabilities is a single-host (Cursor) server, where everything is allowed.
 */
export function hostCan(
  state: Pick<CursorState, 'hostCapabilities'>,
  capability: keyof ChatHostCapabilities,
): boolean {
  return state.hostCapabilities ? state.hostCapabilities[capability] : true;
}
