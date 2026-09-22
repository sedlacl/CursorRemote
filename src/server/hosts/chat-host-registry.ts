import type { ChatTab } from '../types.js';
import type { ChatHost, ChatHostId } from './chat-host.js';

/**
 * Routes a command to the host that owns the tab it targets.
 *
 * The relay asks the registry, never the host id directly — that is the point
 * of the adapter seam. Routing rules follow the plan:
 *
 *  - tab-scoped commands (`switch_tab`, `send_message`) route by `tab.host`
 *  - tab-less commands (`new_chat`, `stop`) route by the currently active tab
 *  - an unknown or missing host falls back to `cursor`, which is what every
 *    tab extracted before this field existed implicitly was
 */
export class ChatHostRegistry {
  private readonly hosts = new Map<ChatHostId, ChatHost>();

  /**
   * Host of the tab the user last switched to.
   *
   * Cursor marks its own active tab in the extracted DOM, but the Claude panel
   * has no probed "this session is focused" signal yet, so the relay records
   * the switch instead of inferring it. Reset to `cursor` whenever a Cursor tab
   * is activated, which keeps the two in sync without a host switcher in the UI.
   */
  private activeHostId: ChatHostId = 'cursor';

  register(host: ChatHost): void {
    this.hosts.set(host.id, host);
  }

  get(id: ChatHostId): ChatHost | null {
    return this.hosts.get(id) ?? null;
  }

  all(): ChatHost[] {
    return [...this.hosts.values()];
  }

  /** The host owning a tab, defaulting to Cursor for pre-host-field tabs. */
  forTab(tab: Pick<ChatTab, 'host'> | null | undefined): ChatHost | null {
    return this.get(tab?.host ?? 'cursor');
  }

  setActiveHost(id: ChatHostId): void {
    this.activeHostId = id;
  }

  getActiveHost(): ChatHostId {
    return this.activeHostId;
  }

  /** The host owning the active tab; Cursor when nothing is active. */
  forActiveTab(tabs: readonly ChatTab[]): ChatHost | null {
    if (this.activeHostId !== 'cursor') {
      const host = this.get(this.activeHostId);
      if (host?.isAvailable()) return host;
    }
    const active = tabs.find(tab => tab.isActive);
    return this.forTab(active);
  }

  /**
   * Merged tab list across hosts, Cursor tabs first so the existing bar keeps
   * its order and Claude sessions append rather than reshuffle it.
   */
  mergeTabs(): ChatTab[] {
    const cursorTabs = this.get('cursor')?.listTabs() ?? [];
    const otherTabs = this.all()
      .filter(host => host.id !== 'cursor')
      .flatMap(host => host.listTabs());

    if (this.activeHostId === 'cursor' || otherTabs.length === 0) {
      return [...cursorTabs, ...otherTabs];
    }

    // Exactly one tab is active across the merged list, or the client's tab bar
    // would highlight a Cursor tab while commands route to Claude.
    let claimed = false;
    const activeOther = otherTabs.map(tab => {
      if (!claimed && tab.host === this.activeHostId) {
        claimed = true;
        return { ...tab, isActive: true };
      }
      return { ...tab, isActive: false };
    });

    return claimed
      ? [...cursorTabs.map(tab => ({ ...tab, isActive: false })), ...activeOther]
      : [...cursorTabs, ...otherTabs];
  }
}
