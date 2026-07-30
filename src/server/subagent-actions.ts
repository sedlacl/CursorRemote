import type { CursorState, SubagentItem, SubagentItemCapabilities } from './types.js';
import {
  sanitizePatchForClient as sanitizeApprovalPatch,
  sanitizeStateForClient as sanitizeApprovalState,
} from './approval-sanitize.js';

export type SubagentItemWithCapabilities = SubagentItem;

export function sanitizeSubagentsForClient(subagents: CursorState['subagents']): CursorState['subagents'] {
  return {
    ...subagents,
    items: subagents.items.map(sanitizeSubagentItemForClient),
  };
}

export function sanitizeSubagentItemForClient(item: SubagentItem): SubagentItem {
  const { _capabilities: _ignored, ...clientItem } = item;
  return clientItem;
}

export function sanitizeStateForClient(state: CursorState): CursorState {
  const approvalSafe = sanitizeApprovalState(state);
  return {
    ...approvalSafe,
    subagents: sanitizeSubagentsForClient(approvalSafe.subagents),
  };
}

export function sanitizePatchForClient(patch: Partial<CursorState>): Partial<CursorState> {
  const approvalSafe = sanitizeApprovalPatch(patch);
  if (!patch.subagents) return approvalSafe;
  return {
    ...approvalSafe,
    subagents: sanitizeSubagentsForClient(patch.subagents),
  };
}

export interface ResolvedSubagentAction {
  item: SubagentItem;
  capabilities: SubagentItemCapabilities;
}

export function resolveSubagentAction(
  state: CursorState,
  subagentId: string | undefined,
): ResolvedSubagentAction | null {
  const normalized = subagentId?.trim();
  if (!normalized) return null;
  const item = state.subagents.items.find(entry => entry.id === normalized);
  if (!item?._capabilities) return null;
  return { item, capabilities: item._capabilities };
}

export function validateOpenSubagent(action: ResolvedSubagentAction | null): string | null {
  if (!action) return 'Subagent not found';
  if (!action.item.openAvailable) return 'Open is not available for this subagent';
  if (!action.capabilities.openSelectorPath) return 'Open target is unavailable';
  return null;
}

export function validateStopSubagent(action: ResolvedSubagentAction | null): string | null {
  if (!action) return 'Subagent not found';
  if (!action.item.stopAvailable) return 'Stop is not available for this subagent';
  if (action.item.status !== 'running') return 'Subagent is not running';
  const kind = action.capabilities.stop?.kind;
  if (!kind) return 'Stop target is unavailable';
  if (kind === 'singleJobAfterExpand' && !action.capabilities.toolbarExpandSelectorPath) {
    return 'Stop target is unavailable';
  }
  return null;
}
