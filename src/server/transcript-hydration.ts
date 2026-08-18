import type { CdpClient } from './cdp-client.js';
import type { ChatElement, CursorState } from './types.js';
import { COMPOSER_UUID_RE } from '../shared/internal-links.js';

export const EMPTY_TRANSCRIPT_RETRY_MS = 280;
export const EMPTY_TRANSCRIPT_NUDGE_COOLDOWN_MS = 2500;

const LIVE_AGENT_STATUSES = new Set<CursorState['agentStatus']>([
  'generating',
  'running_subagents',
  'running_tool',
  'thinking',
]);

export function resolveComposerCacheKey(
  state: Pick<CursorState, 'activeComposerId' | 'chatTabs'>,
): string {
  if (COMPOSER_UUID_RE.test(state.activeComposerId || '')) return state.activeComposerId;
  const tab =
    state.chatTabs.find((t) => t.isActive && t.source === 'open')
    ?? state.chatTabs.find((t) => t.isActive);
  const tabId = tab?.composerId || '';
  return COMPOSER_UUID_RE.test(tabId) ? tabId : '';
}

function isLiveComposerStatus(status?: string): boolean {
  return !!status && /running|generating|loading|thinking/.test(status.toLowerCase());
}

function isLiveComposer(state: {
  agentStatus?: CursorState['agentStatus'];
  subagents?: CursorState['subagents'];
  agentChanges?: CursorState['agentChanges'];
}): boolean {
  if (state.agentStatus && LIVE_AGENT_STATUSES.has(state.agentStatus)) return true;
  if ((state.subagents?.runningCount ?? 0) > 0) return true;
  if ((state.agentChanges?.fileCount ?? 0) > 0) return true;
  return false;
}

/**
 * Empty DOM snapshot that is not a real new chat — Cursor has not hydrated
 * `.composer-react-transcript-root` yet, or the composer is clearly live.
 */
export function looksLikeUnhydratedTranscript(state: {
  messages: readonly unknown[];
  agentStatus?: CursorState['agentStatus'];
  subagents?: CursorState['subagents'];
  agentChanges?: CursorState['agentChanges'];
  _rawSignals?: CursorState['_rawSignals'];
}): boolean {
  if (state.messages.length > 0) return false;
  const raw = state._rawSignals;
  if (raw?.transcriptRootEmpty && isLiveComposerStatus(raw.composerStatus)) return true;
  return isLiveComposer(state);
}

export function restoreCachedMessagesIfUnhydrated(
  incoming: ChatElement[],
  cached: ChatElement[] | undefined,
): ChatElement[] {
  if (incoming.length > 0) return incoming;
  if (cached && cached.length > 0) return cached.slice();
  return incoming;
}

const TRANSCRIPT_NUDGE_HELPERS_JS = `
  function findTranscriptNudgePoint() {
    const root = document.querySelector('.composer-react-transcript-root[data-react-transcript-root]')
      || document.querySelector('.composer-react-transcript-root');
    const scroll = document.querySelector('.virtualized-composer-messages-scroll-container')
      || root?.parentElement
      || document.querySelector('.composer-bar.editor');
    const el = scroll || root;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    return {
      x: Math.max(1, r.left + r.width / 2),
      y: Math.max(1, r.top + Math.min(r.height / 2, 240)),
    };
  }
`;

/** Gentle wheel tick so Cursor's virtualized transcript mounts rows. */
export async function nudgeUnhydratedTranscript(client: CdpClient): Promise<boolean> {
  const loc = await client.evaluate(`
    (() => {
      ${TRANSCRIPT_NUDGE_HELPERS_JS}
      const point = findTranscriptNudgePoint();
      return point ? { ok: true, ...point } : { ok: false };
    })()
  `) as { ok?: boolean; x?: number; y?: number } | null;
  if (!loc?.ok || loc.x == null || loc.y == null) return false;
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: loc.x,
    y: loc.y,
    deltaX: 0,
    deltaY: -160,
  });
  return true;
}
