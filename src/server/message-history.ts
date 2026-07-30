import type { ChatElement } from './types.js';

export function compareMessageOrder(a: ChatElement, b: ChatElement): number {
  const aHasHistoryIndex = a.historyIndex != null;
  const bHasHistoryIndex = b.historyIndex != null;
  if (aHasHistoryIndex && bHasHistoryIndex) {
    const historyDelta = a.historyIndex! - b.historyIndex!;
    if (historyDelta !== 0) return historyDelta;
  }
  // Never compare a global storage position with a DOM-local source index.
  // Partial storage reads therefore stay before live-only rows until they
  // receive their own historyIndex on a later merge.
  if (aHasHistoryIndex !== bHasHistoryIndex) return aHasHistoryIndex ? -1 : 1;
  const aHasTurnOrder = a.turnIndex != null && a.turnOrder != null;
  const bHasTurnOrder = b.turnIndex != null && b.turnOrder != null;
  if (aHasTurnOrder && bHasTurnOrder) {
    const turnDelta = a.turnIndex! - b.turnIndex!;
    if (turnDelta !== 0) return turnDelta;
    const rowDelta = a.turnOrder! - b.turnOrder!;
    if (rowDelta !== 0) return rowDelta;
  }
  return (a.historyIndex ?? a.flatIndex) - (b.historyIndex ?? b.flatIndex);
}

/** Merge DOM snapshots by stable message id; newest extraction wins per id. */
export function mergeMessages(existing: ChatElement[], incoming: ChatElement[]): ChatElement[] {
  if (incoming.length === 0) return existing.slice();
  const byId = new Map<string, ChatElement>();
  for (const msg of existing) byId.set(msg.id, msg);
  for (const msg of incoming) {
    const previous = byId.get(msg.id);
    byId.set(
      msg.id,
      previous?.historyIndex != null && msg.historyIndex == null
        ? { ...msg, historyIndex: previous.historyIndex }
        : msg,
    );
  }
  return Array.from(byId.values()).sort(compareMessageOrder);
}
