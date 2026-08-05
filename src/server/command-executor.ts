import type { CdpClient } from './cdp-client.js';
import { attachFilesToComposer } from './message-attachments.js';
import { parseInternalTranscriptLink } from '../shared/internal-links.js';
import type { SelectorConfig, CommandResult, MessageAttachment, PlanModelOption } from './types.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const FOCUS_DELAY_MS = 100;

const CHAT_SCROLL_HELPERS_JS = `
  function findChatScrollTarget(strategies) {
    let container = null;
    for (const sel of strategies) {
      try {
        container = document.querySelector(sel);
        if (container) break;
      } catch {}
    }
    if (!container) return null;

    const candidates = Array.from(container.querySelectorAll('*'))
      .filter(el => el.scrollHeight > el.clientHeight + 40)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          messageCount: el.querySelectorAll(
            '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
          ).length,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          visibleArea: Math.max(0, rect.width) * Math.max(0, rect.height),
          top: rect.top,
        };
      })
      .filter(x => x.clientHeight > 80 && x.visibleArea > 0)
      .sort((a, b) =>
        (b.messageCount - a.messageCount) ||
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
      );

    const picked = candidates.find(x => x.messageCount > 0) || candidates[0];
    return picked?.el || null;
  }
`;

// Resolves the currently-open model picker menu element across Cursor versions.
// Older builds expose `[data-testid="model-picker-menu"]`; newer builds (~3.5.17)
// removed the testid and render the picker as a generic `[role="menu"]` opened
// via `.ui-model-picker__trigger`, so we cascade through several lookups.
// Stable across model-picker renders — Cursor's React 19 useId-generated IDs
// (`_r_ld_`, `_r_qm_`, …) change on every mount, so they round-trip badly as
// model identifiers. Treat anything matching this pattern as no-id and fall
// back to the synthetic `label::<text>` form.
const REACT_USE_ID_RE = /^_r_[a-z0-9]+_$/;

// Shared in-browser helpers for reading and clicking model-picker rows. Both
// the read path (`get_model_options`) and the write path (`set_model` /
// `set_plan_model`) use the same `collectModelItems()` / `pickModelById()`
// implementations so the round-trip is consistent — there's exactly one
// definition of "what counts as a model row" and "how to map an id back to a
// row." Inject as `${MODEL_ITEM_HELPERS_JS}` inside an evaluate().
export const MODEL_ITEM_HELPERS_JS = `
  const REACT_USE_ID_RE = ${REACT_USE_ID_RE.toString()};

  // Row label, excluding text from descendant <button> elements (each row has
  // an inner "Edit" button whose text would otherwise pollute the label).
  const labelOf = (el) => {
    const clone = el.cloneNode(true);
    for (const b of Array.from(clone.querySelectorAll('button'))) b.remove();
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };

  // Returns the DOM id only if it's stable; React useId values round-trip badly.
  const stableIdOf = (el) => {
    const raw = el.id || '';
    if (!raw || REACT_USE_ID_RE.test(raw)) return '';
    return raw;
  };

  // Top-level rows under the menu — drops items contained inside another
  // candidate so per-row Edit buttons don't show up as separate "models."
  const modelRowsIn = (menu) => {
    if (!menu) return [];
    const raw = Array.from(menu.querySelectorAll('[id], [role="menuitem"], button, [data-testid]'));
    return raw.filter(item => !raw.some(other => other !== item && other.contains(item)));
  };

  const clickModelRow = (item) => {
    const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
    clickable.click();
  };

  const collectModelItems = (menu) => {
    const items = modelRowsIn(menu);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = labelOf(item);
      if (!label) continue;
      // Skip pure action-button entries that survived the nesting filter
      // (defensive — e.g. floating Edit/Configure buttons not inside a row).
      if (/^(edit|configure|remove|delete|star)$/i.test(label)) continue;
      const stableId = stableIdOf(item);
      const key = stableId || label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
      const cls = clickable.className || item.className || '';
      const aria = clickable.getAttribute?.('aria-checked') || item.getAttribute?.('aria-checked') || '';
      const selected = /selected|active|checked/.test(cls) || aria === 'true';
      out.push({
        id: stableId || ('label::' + label),
        label,
        selected,
      });
    }
    return out;
  };

  // Finds and clicks the row whose id (or synthesized label::id) matches the
  // requested target. Targets can be: a real DOM id ("model-opus"), a
  // synthesized "label::<text>" (when the row has no stable id), an unstable
  // React useId ("_r_ld_"), or the bare label text. Returns true on success.
  const pickModelById = (menu, targetId) => {
    if (!menu || !targetId) return false;
    const isLabelId = targetId.startsWith('label::');
    const isUnstable = REACT_USE_ID_RE.test(targetId);
    const labelTarget = (isLabelId ? targetId.slice(7) : '').trim().toLowerCase();
    const targetLc = targetId.toLowerCase();
    const fuzzy = (isLabelId || isUnstable) ? '' : targetLc.replace(/[-_]/g, ' ');

    if (!isLabelId && !isUnstable) {
      const byId = document.getElementById(targetId);
      if (byId && (byId === menu || menu.contains(byId))) {
        clickModelRow(byId);
        return true;
      }
    }

    const rows = modelRowsIn(menu);
    // Pass 1: exact match (preferred — avoids "GPT-5" matching "GPT-5.5").
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      const stableId = stableIdOf(item);
      if (isLabelId || isUnstable) {
        if (labelLc === labelTarget || labelLc === targetLc) {
          clickModelRow(item);
          return true;
        }
      } else {
        if (stableId === targetId || ('label::' + label) === targetId) {
          clickModelRow(item);
          return true;
        }
      }
    }
    // Pass 2: fuzzy/substring fallback for label::-style targets, in case the
    // live row has extra text (e.g. a "Premium" badge, subtitle) beyond what
    // collectModelItems captured. Guarded by length to avoid partial matches
    // like "GPT-5" matching "GPT-5.5".
    for (const item of rows) {
      const label = labelOf(item);
      if (!label) continue;
      const labelLc = label.toLowerCase();
      if (isLabelId || isUnstable) {
        if (labelTarget.length >= 4 && labelLc.includes(labelTarget)) {
          clickModelRow(item);
          return true;
        }
      } else if (fuzzy && labelLc.includes(fuzzy)) {
        clickModelRow(item);
        return true;
      }
    }
    return false;
  };
`;

// Back-compat alias for tests that imported the old name.
export const MODEL_ITEM_COLLECTOR_JS = MODEL_ITEM_HELPERS_JS;

// Inject as `${MODEL_MENU_LOOKUP_JS}` inside an evaluate; call `findModelMenu()`.
export const MODEL_MENU_LOOKUP_JS = `
  const findModelMenu = () => {
    const byTestId = document.querySelector('[data-testid="model-picker-menu"]');
    if (byTestId) return byTestId;
    const triggers = document.querySelectorAll(
      '.ui-model-picker__trigger[aria-expanded="true"],' +
      '.composer-unified-dropdown-model[aria-expanded="true"],' +
      '.composer-unified-dropdown[aria-expanded="true"]'
    );
    for (const t of Array.from(triggers)) {
      const controls = t.getAttribute('aria-controls');
      if (controls) {
        const byControls = document.getElementById(controls);
        if (byControls) return byControls;
      }
    }
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) return openMenu;
    const visibleMenus = document.querySelectorAll('[role="menu"]:not([hidden])');
    for (const m of Array.from(visibleMenus)) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return m;
    }
    return null;
  };
`;

export class CommandExecutor {
  private selectors: SelectorConfig;
  private client: CdpClient | null = null;

  constructor(selectors: SelectorConfig) {
    this.selectors = selectors;
  }

  setClient(client: CdpClient | null): void {
    this.client = client;
  }

  async sendMessage(
    commandId: string,
    text: string | undefined,
    attachments: MessageAttachment[] = []
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.chatInput.strategies;
      const fileInputStrategies = this.selectors.composerFileInput?.strategies ?? [
        ".composer-bar input[type='file']",
        "#workbench\\.parts\\.auxiliarybar input[type='file']",
      ];
      const trimmed = (text || '').trim();
      const hasAttachments = attachments.length > 0;
      if (!trimmed && !hasAttachments) {
        throw new Error('Message must include text or attachments');
      }

      // Step 1: Find and focus the input element (evaluate only for DOM query + focus)
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          let input = null;
          let matchedSelector = '';
          for (const sel of strategies) {
            try {
              input = document.querySelector(sel);
              if (input) { matchedSelector = sel; break; }
            } catch {}
          }
          if (!input) return { ok: false, error: 'Chat input not found (tried ' + strategies.length + ' selectors)' };

          const info = input.tagName + '.' + Array.from(input.classList).join('.') + ' | sel=' + matchedSelector;
          input.scrollIntoView({ block: 'center', behavior: 'instant' });
          input.focus();
          input.click();
          return { ok: true, info };
        })()
      `) as { ok: boolean; error?: string; info?: string } | null;

      if (!result?.ok) {
        throw new Error(result?.error ?? 'Failed to focus input');
      }

      console.log(`[command-executor] Focused: ${result.info}`);
      await sleep(FOCUS_DELAY_MS);

      if (hasAttachments) {
        await attachFilesToComposer(client, fileInputStrategies, attachments);
        console.log(`[command-executor] Attached ${attachments.length} file(s) via composer file input`);
        await sleep(250);
      }

      if (trimmed) {
        if (!hasAttachments) {
          // Clear any existing text via Ctrl+A then Delete (CDP Input domain)
          await client.pressKey('a', 'KeyA', 65, 2); // 2 = Ctrl modifier
          await sleep(50);
          await client.pressKey('Backspace', 'Backspace', 8);
          await sleep(50);
        }

        // Prefer resolved skill names from own UI (`/remote-cursor …`). Typing the
        // slash token then a space lets Cursor Lexical create a cursor_skill chip
        // when the name matches (probe-verified); wrong names stay plain text.
        const skillMatch = trimmed.match(/^\/([^\s]+)(\s+)([\s\S]*)$/);
        if (skillMatch) {
          const skillToken = `/${skillMatch[1]}`;
          const rest = skillMatch[3] || '';
          await client.typeText(skillToken);
          await sleep(80);
          await client.typeText(' ');
          await sleep(120);
          if (rest) {
            await client.typeText(rest);
          }
          console.log(`[command-executor] Text inserted with skill token ${skillToken} (${trimmed.length} chars)`);
        } else {
          await client.typeText(trimmed);
          console.log(`[command-executor] Text inserted via Input.insertText (${trimmed.length} chars)`);
        }
        await sleep(150);
      }

      await client.pressKey('Enter', 'Enter', 13);
      console.log(`[command-executor] Enter pressed via CDP Input.dispatchKeyEvent`);
    });
  }

  async clickApproval(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await client.click(selectorPath);
    });
  }

  async approveAll(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const selector = await this.findApproveAllButton(client);
      if (!selector) {
        throw new Error('"Accept All" button not found');
      }
      await client.click(selector);
    });
  }

  async reject(
    commandId: string,
    selectorPath: string
  ): Promise<CommandResult> {
    return this.clickApproval(commandId, selectorPath);
  }

  async scrollChatUp(commandId: string, times: number = 5): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      for (let i = 0; i < times; i++) {
        const before = await client.evaluate(`
          (() => {
            ${CHAT_SCROLL_HELPERS_JS}
            const target = findChatScrollTarget(${JSON.stringify(containerSelectors)});
            if (!target) return { ok: false, error: 'Chat scroll target not found' };
            const r = target.getBoundingClientRect();
            const messages = target.querySelectorAll(
              '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
            );
            return {
              ok: true,
              x: Math.max(1, r.left + r.width / 2),
              y: Math.max(1, r.top + Math.min(r.height / 2, 320)),
              before: target.scrollTop,
              firstMessage: messages[0]?.getAttribute('data-message-index')
                || messages[0]?.getAttribute('data-index') || '',
              lastMessage: messages[messages.length - 1]?.getAttribute('data-message-index')
                || messages[messages.length - 1]?.getAttribute('data-index') || '',
              messageCount: messages.length,
              scrollHeight: target.scrollHeight,
              clientHeight: target.clientHeight,
            };
          })()
        `) as {
          ok: boolean;
          error?: string;
          x?: number;
          y?: number;
          before?: number;
          firstMessage?: string;
          lastMessage?: string;
          messageCount?: number;
          scrollHeight?: number;
          clientHeight?: number;
        } | null;
        if (!before?.ok) throw new Error(before?.error ?? 'Failed to find chat scroll target');

        // Cursor's virtualized transcript reacts more reliably to native wheel
        // input than to assigning scrollTop directly. Send a burst like a user
        // dragging/scrolling upward, then additionally pin to top as a fallback.
        for (let j = 0; j < 2; j++) {
          await client.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: before.x ?? 1,
            y: before.y ?? 1,
            deltaX: 0,
            deltaY: -600,
          });
          await sleep(80);
        }

        const result = await client.evaluate(`
          (() => {
            ${CHAT_SCROLL_HELPERS_JS}
            const target = findChatScrollTarget(${JSON.stringify(containerSelectors)});
            if (!target) return { ok: false, error: 'Chat scroll target not found after wheel' };
            if (target.scrollTop > 24) {
              target.scrollTop = Math.max(0, target.scrollTop - target.clientHeight * 1.5);
              target.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
            const messages = target.querySelectorAll(
              '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
            );
            return {
              ok: true,
              after: target.scrollTop,
              firstMessage: messages[0]?.getAttribute('data-message-index')
                || messages[0]?.getAttribute('data-index') || '',
              lastMessage: messages[messages.length - 1]?.getAttribute('data-message-index')
                || messages[messages.length - 1]?.getAttribute('data-index') || '',
              messageCount: messages.length,
              scrollHeight: target.scrollHeight,
              clientHeight: target.clientHeight,
            };
          })()
        `) as {
          ok: boolean;
          error?: string;
          after?: number;
          firstMessage?: string;
          lastMessage?: string;
          messageCount?: number;
          scrollHeight?: number;
          clientHeight?: number;
        } | null;
        if (!result?.ok) throw new Error(result?.error ?? 'Failed to scroll chat up');
        console.log(
          `[command-executor] Chat scroll up ${i + 1}/${times}: ` +
          `top ${Math.round(before.before ?? 0)} -> ${Math.round(result.after ?? 0)}, ` +
          `messages=${result.messageCount ?? 0}, first=${before.firstMessage || '?'}->${result.firstMessage || '?'}, ` +
          `last=${before.lastMessage || '?'}->${result.lastMessage || '?'}, ` +
          `h=${result.clientHeight ?? 0}/${result.scrollHeight ?? 0}`
        );
        await sleep(450);
      }
      console.log(`[command-executor] Scrolled chat up ${times} times`);
    });
  }

  async scrollChatToBottom(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const containerSelectors = this.selectors.chatContainer.strategies;
      const result = await client.evaluate(`
        (() => {
          ${CHAT_SCROLL_HELPERS_JS}
          const target = findChatScrollTarget(${JSON.stringify(containerSelectors)});
          if (!target) return { ok: false, error: 'Chat scroll target not found' };
          const before = target.scrollTop;
          target.scrollTop = target.scrollHeight;
          target.dispatchEvent(new Event('scroll', { bubbles: true }));
          return {
            ok: true,
            before,
            after: target.scrollTop,
            messageCount: target.querySelectorAll(
              '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
            ).length,
            scrollHeight: target.scrollHeight,
            clientHeight: target.clientHeight,
          };
        })()
      `) as {
        ok: boolean;
        error?: string;
        before?: number;
        after?: number;
        messageCount?: number;
        scrollHeight?: number;
        clientHeight?: number;
      } | null;
      if (!result?.ok) throw new Error(result?.error ?? 'Failed to scroll chat to bottom');
      console.log(
        `[command-executor] Scrolled chat to bottom: ` +
        `top ${Math.round(result.before ?? 0)} -> ${Math.round(result.after ?? 0)}, ` +
        `messages=${result.messageCount ?? 0}, h=${result.clientHeight ?? 0}/${result.scrollHeight ?? 0}`
      );
    });
  }

  async openTranscriptLink(
    commandId: string,
    composerId?: string,
    linkHref?: string,
    linkLabel?: string,
  ): Promise<CommandResult> {
    const resolvedComposerId = composerId
      || (linkHref ? parseInternalTranscriptLink(linkHref)?.composerId : undefined);
    if (!resolvedComposerId) {
      return { commandId, ok: false, error: 'Missing or invalid transcript link target' };
    }

    return this.withRetry(commandId, async (client) => {
      const domClicked = await this.clickTranscriptLinkInChat(
        client,
        resolvedComposerId,
        linkHref,
        linkLabel,
      );
      if (domClicked) return;

      const sidebarClicked = await this.clickComposerInSidebar(client, resolvedComposerId);
      if (sidebarClicked) {
        console.log(`[command-executor] Opened transcript via sidebar: ${resolvedComposerId}`);
        return;
      }

      try {
        await this.clickOpenComposerTab(client, resolvedComposerId, linkLabel);
        console.log(`[command-executor] Opened transcript via open tab: ${resolvedComposerId}`);
        return;
      } catch {
        // Fall through to title-based sidebar matching.
      }

      if (linkLabel?.trim()) {
        const titleClicked = await this.clickSidebarTabByTitle(client, linkLabel.trim());
        if (titleClicked) {
          console.log(`[command-executor] Opened transcript via title fallback: ${linkLabel}`);
          return;
        }
      }

      throw new Error(`Transcript chat not found: ${resolvedComposerId}`);
    });
  }

  async switchTab(
    commandId: string,
    tabTitle: string,
    selectorPath?: string,
    composerId?: string,
    tabSource?: 'open' | 'sidebar'
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const preferOpenTab = tabSource === 'open'
        || (tabSource !== 'sidebar' && this.isComposerUuid(composerId));
      if (preferOpenTab) {
        try {
          await this.clickOpenComposerTab(client, composerId, tabTitle);
          console.log(`[command-executor] Switched open tab: ${tabTitle}`);
          return;
        } catch (err) {
          // The chat may have been closed in the editor since the last extraction.
          const fallbackTitle = tabTitle?.trim();
          if (!fallbackTitle) throw err;
          const clicked = await this.clickSidebarTabByTitle(client, fallbackTitle);
          if (!clicked) throw err;
          console.log(`[command-executor] Switched tab via sidebar fallback: ${tabTitle}`);
          return;
        }
      }

      if (tabSource === 'sidebar' && this.isComposerUuid(composerId)) {
        const clicked = await this.clickComposerInSidebar(client, composerId!);
        if (clicked) {
          console.log(`[command-executor] Switched sidebar tab by composer: ${tabTitle}`);
          return;
        }
      }

      if (selectorPath && tabSource !== 'sidebar') {
        try {
          await client.click(selectorPath);
          console.log(`[command-executor] Switched tab via selector: ${tabTitle}`);
          return;
        } catch {
          // Fall through to title-based sidebar matching.
        }
      }

      const clicked = await client.evaluate(`
        (() => {
          const title = ${JSON.stringify(tabTitle)};
          const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
          const target = norm(title);
          function cleanTabTitle(raw) {
            let t = (raw || '').trim().replace(/\\s+/g, ' ');
            t = t.replace(/(@[\\w./]+)+\\s*$/, '');
            return t.trim().substring(0, 120);
          }
          function glassCompositeForBtn(btn) {
            const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
            const rawAgent = (labelEl?.textContent || '').trim();
            if (!rawAgent) return { composite: '', agentOnly: '' };
            const group = btn.closest('.ui-sidebar-group');
            const gt = group?.querySelector('.ui-sidebar-group-label-title');
            const rawGroup = (gt?.textContent || '').trim();
            let composite = cleanTabTitle(rawAgent);
            if (rawGroup) {
              const g = cleanTabTitle(rawGroup);
              if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
            }
            return { composite: norm(composite), agentOnly: norm(rawAgent) };
          }
          const glassBtns = Array.from(document.querySelectorAll(
            '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
          ));
          if (glassBtns.length > 0) {
            const rows = glassBtns.map((btn) => ({
              btn,
              ...glassCompositeForBtn(btn),
            })).filter((r) => r.composite);
            const byComp = rows.filter((r) => r.composite === target);
            if (byComp.length === 1) {
              byComp[0].btn.click();
              return true;
            }
            const byAgent = rows.filter((r) => r.agentOnly === target);
            if (byAgent.length === 1) {
              byAgent[0].btn.click();
              return true;
            }
            if (byComp.length > 1 || byAgent.length > 1) {
              throw new Error('Ambiguous tab title for glass sidebar: ' + title);
            }
          }
          const editorTabs = document.querySelectorAll(
            '.tabs-container .tab[aria-label*="Chat Editors"], .editor-group-container.has-composer-editor .tab[role="tab"]'
          );
          for (const tab of Array.from(editorTabs)) {
            const ariaLabel = tab.getAttribute('aria-label') || '';
            const rawTitle = (ariaLabel.split(',')[0] || (tab.textContent || '')).trim();
            const text = norm(rawTitle);
            if (text === target) {
              tab.click();
              return true;
            }
          }
          const cells = document.querySelectorAll('.agent-sidebar-cell');
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text === target) {
              cell.click();
              return true;
            }
          }
          for (const cell of Array.from(cells)) {
            const titleEl = cell.querySelector('.agent-sidebar-cell-text');
            const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
            if (text.startsWith(target) || target.startsWith(text)) {
              cell.click();
              return true;
            }
          }
          return false;
        })()
      `) as boolean;
      if (!clicked) throw new Error('Tab not found: ' + tabTitle);
      console.log(`[command-executor] Switched tab: ${tabTitle}`);
    });
  }

  async closeTab(
    commandId: string,
    tabTitle: string,
    composerId?: string,
    tabSource?: 'open' | 'sidebar'
  ): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      if (tabSource !== 'open' && !this.isComposerUuid(composerId)) {
        throw new Error('Close is only supported for open editor tabs');
      }
      await this.clickOpenComposerTabClose(client, composerId, tabTitle);
      console.log(`[command-executor] Closed open tab: ${tabTitle}`);
    });
  }

  async newChat(commandId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.newChatButton?.strategies ?? [];
      const result = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!result) throw new Error('New Chat button not found');
      console.log(`[command-executor] New chat created`);
    });
  }

  async setMode(commandId: string, modeId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.modeDropdown?.strategies ?? [];

      // Click the dropdown trigger to open the menu
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened) throw new Error('Mode dropdown not found');

      await sleep(250);

      // Click the mode item whose ID ends with the modeId
      const selected = await client.evaluate(`
        (() => {
          const modeId = ${JSON.stringify(modeId)};
          const items = document.querySelectorAll('[id*="composer-mode-"][id$="-' + modeId + '"]');
          for (const item of Array.from(items)) {
            const clickable = item.querySelector('.composer-unified-context-menu-item') || item;
            clickable.click();
            return true;
          }
          return false;
        })()
      `) as boolean;
      if (!selected) throw new Error(`Mode "${modeId}" not found in dropdown`);
      console.log(`[command-executor] Mode set to: ${modeId}`);
    });
  }

  async clickAction(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const questionnaireFallbacks = selectorPath.includes('questionnaire')
        ? [
            '.composer-questionnaire-toolbar .composer-questionnaire-toolbar-actions .composer-run-button:not([data-disabled="true"])',
            '.composer-questionnaire-toolbar .composer-skip-button',
          ]
        : [];
      const strategies = [
        selectorPath,
        ...questionnaireFallbacks,
      ].filter((sel, index, all) => !!sel && all.indexOf(sel) === index);

      let lastError: string | undefined;
      for (const sel of strategies) {
        try {
          await client.click(sel);
          console.log(`[command-executor] Clicked action: ${sel.substring(0, 80)}`);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      throw new Error(lastError || 'Action element not found');
    });
  }

  async openSubagent(commandId: string, selectorPath: string): Promise<CommandResult> {
    return this.clickAction(commandId, selectorPath);
  }

  async stopSubagent(
    commandId: string,
    capabilities: import('./types.js').SubagentItemCapabilities,
    options: { dryRun?: boolean } = {},
  ): Promise<CommandResult> {
    if (!capabilities.stop) {
      throw new Error('Subagent stop descriptor is unavailable');
    }
    return this.withRetry(commandId, async (client) => {
      const { buildSubagentStopResolveEvaluateScript } = await import('./subagent-stop-resolver.js');
      const clicked = await client.evaluate(
        buildSubagentStopResolveEvaluateScript(capabilities, { dryRun: options.dryRun }),
      ) as { ok?: boolean; code?: string; kind?: string };

      if (!clicked?.ok) {
        const code = clicked?.code;
        throw new Error(code === 'ambiguous'
          ? 'Multiple matching subagent stop buttons found'
          : code === 'invalid_kind'
            ? 'Subagent stop kind is invalid'
            : 'Subagent stop button not found');
      }
      if (!options.dryRun) {
        console.log(`[command-executor] Stopped subagent (${capabilities.stop!.kind}): ${capabilities.matchTitle}`);
      }
    });
  }

  async extractToolContent(toolCallId: string): Promise<{ code: string; language?: string; filename?: string } | null> {
    if (!this.client || !this.client.isConnected()) return null;

    const result = await this.client.evaluate(`
      (() => {
        const tcId = ${JSON.stringify(toolCallId)};
        const tool = document.querySelector('[data-tool-call-id="' + tcId + '"]');
        const wrapper = tool?.closest(
          '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
        )
          || tool
          || (() => {
            for (const el of document.querySelectorAll(
              '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
            )) {
              const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
              if (inner) return el;
            }
            return null;
          })();
        if (!wrapper) return null;

        const wasCollapsed = !!wrapper.querySelector('.composer-tool-former-message');
        if (wasCollapsed) {
          const header = wrapper.querySelector('.composer-tool-former-message') || wrapper.querySelector('.ui-collapsible-header');
          if (header) header.click();
        }

        function extract() {
          // Edit tool: look for code content in the diff viewer
          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();

            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          // Shell tool output
          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          // Generic expanded content
          const preEl = wrapper.querySelector('pre');
          if (preEl) {
            return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };
          }

          // Full text fallback
          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        }

        if (wasCollapsed) {
          return '__NEED_WAIT__';
        }
        return extract();
      })()
    `) as { code: string; language?: string; filename?: string } | '__NEED_WAIT__' | null;

    if (result === '__NEED_WAIT__') {
      await sleep(600);
      const expanded = await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const tool = document.querySelector('[data-tool-call-id="' + tcId + '"]');
          const wrapper = tool?.closest(
            '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
          )
            || tool
            || (() => {
              for (const el of document.querySelectorAll(
                '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
              )) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return null;

          const codeContent = wrapper.querySelector('.ui-default-code__content');
          if (codeContent) {
            const lines = codeContent.querySelectorAll('.ui-default-code__line-content');
            const code = lines.length > 0
              ? Array.from(lines).map(l => l.textContent || '').join('\\n')
              : (codeContent.textContent || '').trim();
            const headerEl = wrapper.querySelector('.ui-code-block-header');
            const language = headerEl?.getAttribute('data-language') || undefined;
            const filenameEl = wrapper.querySelector('.ui-edit-tool-call__filename')
              || wrapper.querySelector('.ui-code-block-filename');
            const filename = filenameEl ? (filenameEl.textContent || '').trim() : undefined;
            return { code, language, filename };
          }

          const shellOutput = wrapper.querySelector('.composer-terminal-output') || wrapper.querySelector('.xterm-rows');
          if (shellOutput) {
            return { code: (shellOutput.textContent || '').trim(), language: 'bash', filename: undefined };
          }

          const preEl = wrapper.querySelector('pre');
          if (preEl) return { code: (preEl.textContent || '').trim(), language: undefined, filename: undefined };

          const text = (wrapper.textContent || '').trim();
          if (text.length > 0) return { code: text, language: undefined, filename: undefined };
          return null;
        })()
      `) as { code: string; language?: string; filename?: string } | null;

      // Collapse back
      await this.client.evaluate(`
        (() => {
          const tcId = ${JSON.stringify(toolCallId)};
          const tool = document.querySelector('[data-tool-call-id="' + tcId + '"]');
          const wrapper = tool?.closest(
            '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
          )
            || tool
            || (() => {
              for (const el of document.querySelectorAll(
                '[data-flat-index], .virtualized-composer-messages-row, .composer-rendered-message[data-message-role]',
              )) {
                const inner = el.querySelector('[data-tool-call-id="' + tcId + '"]');
                if (inner) return el;
              }
              return null;
            })();
          if (!wrapper) return;
          const header = wrapper.querySelector('.ui-collapsible-header') || wrapper.querySelector('.composer-tool-former-message');
          if (header) header.click();
        })()
      `);

      return expanded;
    }

    return result;
  }

  async setModel(commandId: string, modelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      const strategies = this.selectors.modelDropdown?.strategies ?? [];

      // Step 1: Open the dropdown via JS .click() (same pattern as setMode).
      // Skip any trigger whose id starts with `plan-exec-model` (those belong
      // to the plan-execution picker, not the composer's model picker) — same
      // filter as openModelMenuAndReadOptions.
      const opened = await client.evaluate(`
        (() => {
          const strategies = ${JSON.stringify(strategies)};
          for (const sel of strategies) {
            try {
              const candidates = document.querySelectorAll(sel);
              for (const c of Array.from(candidates)) {
                const cId = c.getAttribute('id') || '';
                if (cId.startsWith('plan-exec-model')) continue;
                c.click();
                return true;
              }
            } catch {}
          }
          return false;
        })()
      `) as boolean;
      if (!opened) throw new Error('Model dropdown trigger not found');

      await sleep(300);

      // Step 2: Verify menu opened
      const menuVisible = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (!menuVisible) throw new Error('Model picker did not open');

      // Step 3: Find and click the model item via the shared helper so
      // setModel, setPlanModel, web client, and Telegram all resolve the
      // same way.
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(modelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Model "${modelId}" not found in dropdown`);

      await sleep(200);

      // Step 4: Verify dropdown closed (confirms selection was accepted)
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        console.warn(`[command-executor] Model dropdown still open — pressing Escape`);
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }

      console.log(`[command-executor] Model set to: ${modelId} (menu closed: ${!menuStillOpen})`);
    });
  }

  async getModelOptions(commandId: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openModelMenuAndReadOptions(client);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async getPlanModelOptions(commandId: string, selectorPath: string): Promise<CommandResult> {
    const result = await this.withRetryValue(commandId, async (client) => {
      return await this.openPlanModelMenuAndReadOptions(client, selectorPath);
    });
    if (!result.ok) return result;
    return { commandId, ok: true, data: result.data };
  }

  async setPlanModel(commandId: string, selectorPath: string, planModelId: string): Promise<CommandResult> {
    return this.withRetry(commandId, async (client) => {
      await this.openPlanModelMenu(client, selectorPath);
      const selected = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          ${MODEL_ITEM_HELPERS_JS}
          return pickModelById(findModelMenu(), ${JSON.stringify(planModelId)});
        })()
      `) as boolean;
      if (!selected) throw new Error(`Plan model "${planModelId}" not found`);

      await sleep(200);
      const menuStillOpen = await client.evaluate(`
        (() => {
          ${MODEL_MENU_LOOKUP_JS}
          return findModelMenu() !== null;
        })()
      `) as boolean;
      if (menuStillOpen) {
        await client.pressKey('Escape', 'Escape', 27);
        await sleep(100);
      }
      console.log(`[command-executor] Plan model set to: ${planModelId}`);
    });
  }

  private async withRetry(
    commandId: string,
    action: (client: CdpClient) => Promise<void>
  ): Promise<CommandResult> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await action(this.client);
        return { commandId, ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async withRetryValue<T>(
    commandId: string,
    action: (client: CdpClient) => Promise<T>
  ): Promise<CommandResult & { data?: T }> {
    if (!this.client || !this.client.isConnected()) {
      return { commandId, ok: false, error: 'Not connected to Cursor' };
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await action(this.client);
        return { commandId, ok: true, data };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[command-executor] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError}`
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return { commandId, ok: false, error: lastError };
  }

  private async openPlanModelMenu(client: CdpClient, selectorPath: string): Promise<void> {
    const opened = await client.evaluate(`
      (() => {
        const selector = ${JSON.stringify(selectorPath)};
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      })()
    `) as boolean;
    if (!opened) throw new Error('Plan model dropdown trigger not found');

    await sleep(300);
    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Plan model picker did not open');
  }

  private async openPlanModelMenuAndReadOptions(
    client: CdpClient,
    selectorPath: string
  ): Promise<{ options: PlanModelOption[] }> {
    await this.openPlanModelMenu(client, selectorPath);

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async openModelMenuAndReadOptions(
    client: CdpClient
  ): Promise<{ options: PlanModelOption[] }> {
    const strategies = this.selectors.modelDropdown?.strategies ?? [];

    const opened = await client.evaluate(`
      (() => {
        const strategies = ${JSON.stringify(strategies)};
        for (const sel of strategies) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of Array.from(candidates)) {
              const cId = c.getAttribute('id') || '';
              if (!cId.startsWith('plan-exec-model')) {
                c.click();
                return true;
              }
            }
          } catch {}
        }
        return false;
      })()
    `) as boolean;
    if (!opened) throw new Error('Model dropdown trigger not found');

    await sleep(300);

    const menuVisible = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        return findModelMenu() !== null;
      })()
    `) as boolean;
    if (!menuVisible) throw new Error('Model picker did not open');

    const options = await client.evaluate(`
      (() => {
        ${MODEL_MENU_LOOKUP_JS}
        ${MODEL_ITEM_HELPERS_JS}
        return collectModelItems(findModelMenu());
      })()
    `) as PlanModelOption[];

    await client.pressKey('Escape', 'Escape', 27);
    await sleep(100);
    return { options };
  }

  private async findFirstMatchingSelector(
    client: CdpClient,
    strategies: string[]
  ): Promise<string | null> {
    for (const selector of strategies) {
      try {
        if (await client.exists(selector)) return selector;
      } catch {
        // invalid selector, skip
      }
    }
    return null;
  }

  private async findApproveAllButton(client: CdpClient): Promise<string | null> {
    const found = await client.evaluate(`
      (() => {
        const keywords = ${JSON.stringify(this.selectors.approveButton.textMatch ?? [])};
        const strategies = ${JSON.stringify(this.selectors.approveButton.strategies)};
        const containerStrategies = ${JSON.stringify(this.selectors.chatContainer.strategies)};
        let root = null;
        for (const sel of containerStrategies) {
          try {
            root = document.querySelector(sel);
            if (root) break;
          } catch {}
        }
        if (!root) root = document.body;

        // Skip menu-trigger buttons (e.g. Cursor's "Auto-Run in Sandbox"
        // mode dropdown) — they open a settings menu, not an approval.
        const isMenuTrigger = (b) => {
          const p = b.getAttribute('aria-haspopup');
          return p === 'menu' || p === 'true' || p === 'listbox';
        };

        for (const selector of strategies) {
          try {
            const buttons = root.querySelectorAll(selector);
            for (const btn of Array.from(buttons)) {
              if (isMenuTrigger(btn)) continue;
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text.includes('all')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
              }
            }
          } catch {}
        }

        const allButtons = root.querySelectorAll('button');
        for (const btn of Array.from(allButtons)) {
          if (isMenuTrigger(btn)) continue;
          const text = (btn.textContent || '').trim().toLowerCase();
          for (const kw of keywords) {
            if (kw.toLowerCase().includes('all') && text.includes(kw.toLowerCase())) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
        }

        return false;
      })()
    `) as boolean;

    if (!found) {
      throw new Error('"Accept All" button not found');
    }
    return '__clicked_inline__';
  }

  private isComposerUuid(value?: string): boolean {
    return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private async clickTranscriptLinkInChat(
    client: CdpClient,
    transcriptId: string,
    linkHref?: string,
    linkLabel?: string,
  ): Promise<boolean> {
    const containerSelectors = this.selectors.chatContainer.strategies;
    const result = await client.evaluate(`
      (() => {
        const transcriptId = ${JSON.stringify(transcriptId)};
        const linkHref = ${JSON.stringify(linkHref ?? '')};
        const linkLabel = ${JSON.stringify(linkLabel ?? '')};
        const containerSelectors = ${JSON.stringify(containerSelectors)};

        function hrefMatches(href) {
          const h = (href || '').trim();
          if (!h) return false;
          if (h === transcriptId || (linkHref && h === linkHref)) return true;
          if (h.includes(transcriptId)) return true;
          if (linkHref && h.includes(linkHref)) return true;
          try {
            const path = new URL(h, 'http://cursor.local/').pathname;
            if (path.includes(transcriptId)) return true;
          } catch {}
          return false;
        }

        function norm(s) {
          return (s || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        }

        function collectAnchors(root) {
          const out = [];
          const seen = new Set();
          function walk(node) {
            if (!node || seen.has(node)) return;
            seen.add(node);
            if (node.querySelectorAll) {
              for (const a of Array.from(node.querySelectorAll('a[href]'))) {
                if (!out.includes(a)) out.push(a);
              }
            }
            if (node.shadowRoot) walk(node.shadowRoot);
            for (const child of Array.from(node.children || [])) walk(child);
          }
          walk(root);
          return out;
        }

        function clickAnchor(a, via) {
          a.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = a.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          // Cursor transcript cites are plain <a href="uuid"> — DOM click matches IDE behavior.
          a.click();
          return { ok: true, via };
        }

        const roots = [];
        for (const sel of containerSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) roots.push(el);
          } catch {}
        }
        if (!roots.includes(document.body)) roots.push(document.body);

        const seenAnchors = new Set();
        const anchors = [];
        for (const root of roots) {
          for (const a of collectAnchors(root)) {
            if (seenAnchors.has(a)) continue;
            seenAnchors.add(a);
            anchors.push(a);
          }
        }

        // Prefer the latest matching cite (usually the most recent assistant message).
        for (let i = anchors.length - 1; i >= 0; i--) {
          const a = anchors[i];
          if (!hrefMatches(a.getAttribute('href') || '')) continue;
          const clicked = clickAnchor(a, 'href');
          if (clicked) return clicked;
        }

        if (linkLabel) {
          const target = norm(linkLabel);
          for (let i = anchors.length - 1; i >= 0; i--) {
            const a = anchors[i];
            const text = norm(a.textContent || '');
            if (text === target || (target.length >= 6 && text.includes(target))) {
              const clicked = clickAnchor(a, 'label');
              if (clicked) return clicked;
            }
          }
        }

        return { ok: false };
      })()
    `) as { ok: boolean; via?: string } | null;

    if (!result?.ok) return false;
    console.log(
      `[command-executor] Opened transcript via DOM link (${result.via ?? 'unknown'}): ${transcriptId}`,
    );
    return true;
  }

  private async clickComposerInSidebar(client: CdpClient, composerId: string): Promise<boolean> {
    return await client.evaluate(`
      (() => {
        const composerId = ${JSON.stringify(composerId)};

        const glassBtns = document.querySelectorAll(
          '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
        );
        for (const btn of Array.from(glassBtns)) {
          const cid = btn.getAttribute('data-composer-id')
            || btn.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === composerId) {
            btn.click();
            return true;
          }
        }

        const cells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(cells)) {
          const cid = cell.getAttribute('data-composer-id')
            || cell.closest('[data-composer-id]')?.getAttribute('data-composer-id');
          if (cid === composerId) {
            cell.click();
            return true;
          }
        }

        const matches = document.querySelectorAll('[data-composer-id="' + composerId + '"]');
        for (const el of Array.from(matches)) {
          const clickable = el.closest(
            '.glass-sidebar-agent-menu-btn, .agent-sidebar-cell, .ui-sidebar-menu-item, button, [role="button"]'
          ) || el;
          if (clickable instanceof HTMLElement) {
            clickable.click();
            return true;
          }
        }

        return false;
      })()
    `) as boolean;
  }

  private async clickSidebarTabByTitle(client: CdpClient, tabTitle: string): Promise<boolean> {
    return await client.evaluate(`
      (() => {
        const title = ${JSON.stringify(tabTitle)};
        const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
        const target = norm(title);
        function cleanTabTitle(raw) {
          let t = (raw || '').trim().replace(/\\s+/g, ' ');
          t = t.replace(/(@[\\w./]+)+\\s*$/, '');
          return t.trim().substring(0, 120);
        }
        function glassCompositeForBtn(btn) {
          const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
          const rawAgent = (labelEl?.textContent || '').trim();
          if (!rawAgent) return { composite: '', agentOnly: '' };
          const group = btn.closest('.ui-sidebar-group');
          const gt = group?.querySelector('.ui-sidebar-group-label-title');
          const rawGroup = (gt?.textContent || '').trim();
          let composite = cleanTabTitle(rawAgent);
          if (rawGroup) {
            const g = cleanTabTitle(rawGroup);
            if (g) composite = (g + ' / ' + cleanTabTitle(rawAgent)).substring(0, 120);
          }
          return { composite: norm(composite), agentOnly: norm(rawAgent) };
        }
        const glassBtns = Array.from(document.querySelectorAll(
          '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
        ));
        if (glassBtns.length > 0) {
          const rows = glassBtns.map((btn) => ({
            btn,
            ...glassCompositeForBtn(btn),
          })).filter((r) => r.composite);
          const byComp = rows.filter((r) => r.composite === target);
          if (byComp.length === 1) {
            byComp[0].btn.click();
            return true;
          }
          const byAgent = rows.filter((r) => r.agentOnly === target);
          if (byAgent.length === 1) {
            byAgent[0].btn.click();
            return true;
          }
        }
        const cells = document.querySelectorAll('.agent-sidebar-cell');
        for (const cell of Array.from(cells)) {
          const titleEl = cell.querySelector('.agent-sidebar-cell-text');
          const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
          if (text === target) {
            cell.click();
            return true;
          }
        }
        for (const cell of Array.from(cells)) {
          const titleEl = cell.querySelector('.agent-sidebar-cell-text');
          const text = norm(titleEl ? (titleEl.textContent || '') : (cell.textContent || ''));
          if (text.startsWith(target) || target.startsWith(text)) {
            cell.click();
            return true;
          }
        }
        return false;
      })()
    `) as boolean;
  }

  private async clickOpenComposerTab(
    client: CdpClient,
    composerId?: string,
    tabTitle?: string
  ): Promise<void> {
    const point = await client.evaluate(`
      (() => {
        const composerId = ${JSON.stringify(composerId ?? '')};
        const title = ${JSON.stringify(tabTitle ?? '')};
        const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
        const target = norm(title);
        const tabs = Array.from(document.querySelectorAll(
          '.tabs-container .tab[aria-label*="Chat Editors"], .editor-group-container.has-composer-editor .tab[role="tab"]'
        ));
        let tab = null;
        if (composerId) {
          tab = tabs.find(t => t.getAttribute('data-resource-name') === composerId) || null;
        }
        if (!tab && target) {
          tab = tabs.find(t => {
            const aria = t.getAttribute('aria-label') || '';
            const raw = (aria.split(',')[0] || (t.textContent || '')).trim();
            return norm(raw) === target;
          }) || null;
        }
        if (!tab) return null;
        tab.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = tab.getBoundingClientRect();
        return { x: r.left + Math.min(r.width * 0.35, 48), y: r.top + r.height / 2 };
      })()
    `) as { x: number; y: number } | null;

    if (!point) throw new Error('Open tab not found: ' + (tabTitle || composerId || 'unknown'));
    await client.clickAtCoords(point.x, point.y);
  }

  private async clickOpenComposerTabClose(
    client: CdpClient,
    composerId?: string,
    tabTitle?: string
  ): Promise<void> {
    const point = await client.evaluate(`
      (() => {
        const composerId = ${JSON.stringify(composerId ?? '')};
        const title = ${JSON.stringify(tabTitle ?? '')};
        const norm = s => s.trim().replace(/\\s+/g, ' ').toLowerCase();
        const target = norm(title);
        const tabs = Array.from(document.querySelectorAll(
          '.tabs-container .tab[aria-label*="Chat Editors"], .editor-group-container.has-composer-editor .tab[role="tab"]'
        ));
        let tab = null;
        if (composerId) {
          tab = tabs.find(t => t.getAttribute('data-resource-name') === composerId) || null;
        }
        if (!tab && target) {
          tab = tabs.find(t => {
            const aria = t.getAttribute('aria-label') || '';
            const raw = (aria.split(',')[0] || (t.textContent || '')).trim();
            return norm(raw) === target;
          }) || null;
        }
        if (!tab) return null;
        const closeBtn = tab.querySelector('.action-label.codicon-close, a.codicon-close[aria-label*="Close"]');
        if (!closeBtn) return null;
        tab.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = closeBtn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `) as { x: number; y: number } | null;

    if (!point) throw new Error('Tab close button not found: ' + (tabTitle || composerId || 'unknown'));
    await client.clickAtCoords(point.x, point.y);
  }

  private async clickElementCenter(client: CdpClient, selector: string): Promise<void> {
    const rect = await client.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;

    if (!rect || rect.width === 0 || rect.height === 0) {
      throw new Error(`Element not clickable: ${selector}`);
    }

    await client.clickAtCoords(rect.x, rect.y);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
