import type { AgentStatus, ChatElement } from '../types.js';

/**
 * One `[data-transcript-message]` row from the Claude Code chat webview.
 *
 * Selectors were probed 2026-09-23: articles live in
 * `[role="region"][aria-label="Claude Code conversation"]`. User rows are
 * `aria-label="You"`. Assistant prose is `aria-label="Claude"`. Tool rows are
 * `aria-label="Claude, <tool>"` (Bash, Write, …). Thinking rows are
 * `aria-label="Claude, thinking"` and often contain only the word "thinking".
 */
export interface ClaudeTranscriptRow {
  aria: string;
  testid: string;
  busy: boolean;
  text: string;
}

export interface ClaudeTranscriptRead {
  running: boolean;
  items: ClaudeTranscriptRow[];
}

const THINKING_ONLY = /^(thinking|thought)$/i;

/**
 * A user row's screen-reader heading is `You: <message>` and the visible body
 * repeats `<message>` with no separator. Drop that echo. A plain message is
 * left as it is.
 */
export function stripClaudeScreenReaderEcho(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const prefixed = compact.match(/^You:\s*(.*)$/);
  if (!prefixed) return compact;
  const rest = prefixed[1] ?? '';
  if (rest.length >= 2 && rest.length % 2 === 0) {
    const half = rest.length / 2;
    if (rest.slice(0, half) === rest.slice(half)) return rest.slice(0, half);
  }
  return rest;
}

export function claudeRowsToMessages(rows: readonly ClaudeTranscriptRow[]): ChatElement[] {
  const out: ChatElement[] = [];
  rows.forEach((row, index) => {
    const order = { flatIndex: index };
    const aria = row.aria.trim();
    const text = row.text.replace(/\s+/g, ' ').trim();

    if (aria === 'You') {
      const spoken = stripClaudeScreenReaderEcho(text);
      if (!spoken) return;
      out.push({
        type: 'human',
        id: `claude-human-${index}`,
        text: spoken,
        mentions: [],
        ...order,
      });
      return;
    }

    if (/thinking/i.test(aria)) {
      const body = text.replace(/^thinking\s*/i, '').trim();
      if (body.length < 2 || THINKING_ONLY.test(body)) return;
      out.push({
        type: 'thought',
        id: `claude-thought-${index}`,
        duration: '',
        detail: body,
        ...order,
      });
      return;
    }

    const tool = aria.match(/^Claude,\s+(.+)$/i);
    if (tool) {
      const name = tool[1].trim();
      if (!name) return;
      out.push({
        type: 'tool',
        id: `claude-tool-${index}`,
        toolCallId: `claude-tool-${index}`,
        status: row.busy ? 'loading' : 'completed',
        action: name,
        details: text.slice(0, 240),
        ...order,
      });
      return;
    }

    if (aria === 'Claude' || row.testid === 'assistant-message') {
      if (!text) return;
      out.push({
        type: 'assistant',
        id: `claude-assistant-${index}`,
        text,
        html: '',
        codeBlocks: [],
        ...order,
      });
    }
  });
  return out;
}

export function claudeTranscriptStatus(running: boolean): AgentStatus {
  return running ? 'generating' : 'idle';
}
