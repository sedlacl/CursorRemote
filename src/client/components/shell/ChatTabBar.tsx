import React from 'react';
import type { ChatTab } from '../../../server/types.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import { buildChatTabGroups } from '../../view-models/chatTabs.js';

export interface ChatTabBarProps {
  tabs: ChatTab[];
}

export function ChatTabBar({ tabs }: ChatTabBarProps) {
  const command = useCommandClient();
  const ui = useUiState();
  const { openTabs, listTabs: sidebarTabs } = buildChatTabGroups(tabs);
  const visibleTabCount = openTabs.length + sidebarTabs.length;

  const renderTab = (tab: ChatTab) => (
    <div
      key={`${tab.source}:${tab.composerId}:${tab.title}`}
      // Claude sessions sit in the same bar as Cursor chats, so the chip carries
      // the host as a modifier — the tint is the only thing telling them apart.
      className={`tab-chip host-${tab.host ?? 'cursor'} ${tab.isActive ? 'active' : ''}`}
    >
      <button
        type="button"
        className={`tab-item ${tab.isActive ? 'active' : ''}`}
        title={tab.title || 'Chat'}
        onClick={() => command.emit('command:switch_tab', {
          composerId: tab.composerId,
          selectorPath: tab.selectorPath,
          tabTitle: tab.title,
          tabSource: tab.source,
        })}
      >
        <span className={`tab-status ${tab.workStatus}`} aria-hidden="true" />
        {tab.host === 'claude-code' && (
          <span className="tab-host-badge" aria-label="Claude Code session">CC</span>
        )}
        <span className="tab-title">{tab.title || 'Chat'}</span>
      </button>
      <button
        type="button"
        className="tab-menu-btn"
        aria-label={`Actions for tab ${tab.title || 'Chat'}`}
        onClick={() => ui.openTabSheet(tab.composerId)}
      >
        ⋯
      </button>
    </div>
  );

  if (visibleTabCount === 0) {
    return (
      <nav id="tab-bar" className="tab-bar">
        <div id="tab-list" className="tab-list" />
        <button
          id="btn-new-chat"
          className="tab-new-btn"
          aria-label="New Chat"
          onClick={() => command.emit('command:new_chat')}
        >
          +
        </button>
      </nav>
    );
  }

  if (visibleTabCount === 1) {
    const singleTab = openTabs[0] ?? sidebarTabs[0];
    return (
      <nav id="tab-bar" className="tab-bar">
        <div id="tab-list" className="tab-list">
          {renderTab(singleTab)}
        </div>
        <button
          id="btn-new-chat"
          className="tab-new-btn"
          aria-label="New Chat"
          onClick={() => command.emit('command:new_chat')}
        >
          +
        </button>
      </nav>
    );
  }

  return (
    <nav id="tab-bar" className="tab-bar">
      <div id="tab-list" className="tab-list">
        {openTabs.length > 0 && (
          <>
            <span className="tab-group-label">Open</span>
            {openTabs.map(renderTab)}
          </>
        )}
        {openTabs.length > 0 && sidebarTabs.length > 0 && (
          <span className="tab-group-divider" aria-hidden="true" />
        )}
        {sidebarTabs.length > 0 && (
          <>
            <span className="tab-group-label">List</span>
            {sidebarTabs.map(renderTab)}
          </>
        )}
      </div>
      <button
        id="btn-new-chat"
        className="tab-new-btn"
        aria-label="New Chat"
        onClick={() => command.emit('command:new_chat')}
      >
        +
      </button>
    </nav>
  );
}
