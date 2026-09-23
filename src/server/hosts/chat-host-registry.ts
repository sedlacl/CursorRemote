import type { ChatHostCapabilities, ChatTab, CursorState } from '../types.js';
import {
  neutralConversationState,
  type ChatHost,
  type ChatHostId,
} from './chat-host.js';

/**
 * Owns the set of backends and decides which one a command or a published
 * state belongs to.
 *
 *  - The **primary** host is the first one registered (Cursor). It is native to
 *    the extracted DOM state: tabs without a `host` field are its tabs, and its
 *    conversation fields are the extractor's own.
 *  - The **active** host is the one behind the tab the user last switched to.
 *    Tab-less commands (`set_mode`, `new_chat`, `stop`, …) go to it, and the
 *    published state's conversation fields describe it and nothing else.
 *
 * Nothing here names a concrete host, so a third backend (e.g. Codex) is one
 * more `register()` call.
 */
export class ChatHostRegistry {
  private readonly hosts = new Map<ChatHostId, ChatHost>();
  private primaryId: ChatHostId | null = null;

  /**
   * Host of the tab the user last switched to. Recorded rather than inferred:
   * a webview panel has no probed "this session is focused" signal, and the
   * Cursor DOM keeps marking its own composer active beside it.
   */
  private activeHostId: ChatHostId | null = null;

  register(host: ChatHost): void {
    this.hosts.set(host.id, host);
    this.primaryId ??= host.id;
    this.activeHostId ??= host.id;
  }

  get(id: ChatHostId): ChatHost | null {
    return this.hosts.get(id) ?? null;
  }

  all(): ChatHost[] {
    return [...this.hosts.values()];
  }

  /** The host native to the extracted state. */
  primary(): ChatHost {
    const host = this.primaryId ? this.hosts.get(this.primaryId) : undefined;
    if (!host) throw new Error('ChatHostRegistry has no hosts registered');
    return host;
  }

  /** The host owning a tab; tabs without a `host` field belong to the primary. */
  forTab(tab: Pick<ChatTab, 'host'> | null | undefined): ChatHost | null {
    return tab?.host ? this.get(tab.host) : this.primary();
  }

  setActiveHost(id: ChatHostId): void {
    if (this.hosts.has(id)) this.activeHostId = id;
  }

  /** Recorded active host id — may be unavailable; see {@link activeHost}. */
  getActiveHost(): ChatHostId {
    return this.activeHostId ?? this.primary().id;
  }

  /**
   * The host commands and state follow right now: the recorded one while it is
   * connected and has a tab to show, otherwise the primary. A closed panel must
   * not swallow commands, nor blank the conversation.
   */
  activeHost(): ChatHost {
    const recorded = this.activeHostId ? this.hosts.get(this.activeHostId) : undefined;
    if (recorded && recorded.id !== this.primaryId) {
      if (recorded.isAvailable() && recorded.listTabs().length > 0) return recorded;
    }
    return this.primary();
  }

  /**
   * Refusal when a client issued a command while looking at another host's
   * tab. Covers the race where the tab changed between tap and delivery, and
   * any client that still thinks it is on a different backend.
   */
  checkActiveHost(expected: ChatHostId | undefined): string | null {
    if (!expected) return null;
    const active = this.activeHost();
    if (active.id === expected) return null;
    const expectedLabel = this.get(expected)?.label ?? expected;
    return `The active tab is now ${active.label}, not ${expectedLabel} — command not sent`;
  }

  /**
   * The published state: every host's tabs merged with exactly one active, and
   * the conversation fields replaced by the active host's view when that host
   * is not native to the extraction.
   */
  composeState(extracted: CursorState): CursorState {
    const primaryId = this.primary().id;
    const active = this.activeHost();

    const nativeTabs = extracted.chatTabs.map(tab => ({ ...tab, host: tab.host ?? primaryId }));
    const foreign = this.all().filter(host => host.id !== primaryId);

    let chatTabs: ChatTab[];
    if (active.id === primaryId) {
      chatTabs = [
        ...nativeTabs,
        ...foreign.flatMap(host => host.listTabs().map(tab => ({ ...tab, isActive: false }))),
      ];
    } else {
      chatTabs = [
        ...nativeTabs.map(tab => ({ ...tab, isActive: false })),
        ...foreign.flatMap(host => {
          const tabs = host.listTabs();
          if (host.id !== active.id) return tabs.map(tab => ({ ...tab, isActive: false }));
          const activeIndex = Math.max(0, tabs.findIndex(tab => tab.isActive));
          return tabs.map((tab, index) => ({ ...tab, isActive: index === activeIndex }));
        }),
      ];
    }

    const next: CursorState = {
      ...extracted,
      chatTabs,
      activeHost: active.id,
      hostCapabilities: { ...active.capabilities } satisfies ChatHostCapabilities,
    };

    const view = active.conversationView();
    if (!view) return next;

    const { composerId, ...fields } = view;
    return {
      ...next,
      ...neutralConversationState(),
      backgroundTasks: active.listBackgroundTasks(),
      ...fields,
      activeComposerId: composerId ?? next.activeComposerId,
    };
  }
}
