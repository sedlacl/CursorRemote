import { existsSync } from 'fs';
import { basename, join } from 'path';
import type { ChatElement } from './types.js';
import { markdownToWebHtml } from './plan-files.js';

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

interface CursorComposerHeader {
  bubbleId: string;
  type: number;
  grouping?: {
    capabilityType?: number;
    toolFormerTool?: number;
    hasThinking?: boolean;
    hasText?: boolean;
  };
}

interface CursorStoredComposer {
  composerId?: string;
  name?: string;
  subagentComposerIds?: string[];
  subagentInfo?: {
    parentComposerId?: string;
    rootParentConversationId?: string;
  };
  fullConversationHeadersOnly?: CursorComposerHeader[];
}

export interface ComposerStorageRelation {
  composerId: string;
  name?: string;
  parentComposerId?: string;
  rootOrchestratorComposerId?: string;
  subagentComposerIds: string[];
  isSubagent: boolean;
  depth: number;
}

interface CursorStoredBubble {
  bubbleId: string;
  type?: number;
  text?: string;
  richText?: string;
  thinking?: { text?: string; durationMs?: number };
  allThinkingBlocks?: Array<{ text?: string; durationMs?: number }>;
  serviceStatusUpdate?: { message?: string };
  toolFormerData?: {
    tool?: number;
    params?: unknown;
    result?: unknown;
    additionalData?: unknown;
  };
}

export interface CursorStorageHistoryResult {
  messages: ChatElement[];
  totalHeaders: number;
  loadedBubbles: number;
}

export function getDefaultCursorStateDbPath(): string | undefined {
  const appData = process.env.APPDATA;
  if (!appData) return undefined;
  return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

export class CursorStorageHistory {
  constructor(private readonly dbPath: string | undefined = getDefaultCursorStateDbPath()) {}

  async loadComposerRelation(composerId: string): Promise<ComposerStorageRelation | null> {
    if (!composerId || !this.dbPath || !existsSync(this.dbPath)) return null;
    const db = await this.openDatabase();
    try {
      return readComposerRelationFromDb(db, composerId);
    } finally {
      db.close();
    }
  }

  async loadComposerHistory(composerId: string): Promise<CursorStorageHistoryResult | null> {
    if (!composerId || !this.dbPath || !existsSync(this.dbPath)) return null;

    const db = await this.openDatabase();
    try {
      const composerRaw = readKv(db, `composerData:${composerId}`);
      if (!composerRaw) return null;

      const composer = safeJsonParse<CursorStoredComposer>(composerRaw);
      const headers = composer?.fullConversationHeadersOnly ?? [];
      if (headers.length === 0) {
        return { messages: [], totalHeaders: 0, loadedBubbles: 0 };
      }

      const bubbleIds = headers.map((header) => header.bubbleId).filter(Boolean);
      const bubbles = readBubbleBatch(db, composerId, bubbleIds);
      const messages: ChatElement[] = [];

      headers.forEach((header, index) => {
        const bubble = bubbles.get(header.bubbleId);
        if (!bubble) return;
        const converted = storedBubbleToChatElement(header, bubble, index);
        if (converted) messages.push({ ...converted, historyIndex: index });
      });

      return { messages, totalHeaders: headers.length, loadedBubbles: bubbles.size };
    } finally {
      db.close();
    }
  }

  private async openDatabase(): Promise<SqliteDatabase> {
    const sqliteSpecifier = 'node:sqlite';
    const sqliteModule = await import(sqliteSpecifier);
    const DatabaseSync = (sqliteModule as unknown as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
    return new DatabaseSync(this.dbPath!, { readOnly: true });
  }
}

function readComposerRelationFromDb(db: SqliteDatabase, composerId: string): ComposerStorageRelation | null {
  const composerRaw = readKv(db, `composerData:${composerId}`);
  if (!composerRaw) return null;
  const composer = safeJsonParse<CursorStoredComposer>(composerRaw);
  if (!composer) return null;

  const parentComposerId = composer.subagentInfo?.parentComposerId?.trim() || undefined;
  const rootOrchestratorComposerId =
    composer.subagentInfo?.rootParentConversationId?.trim()
    || parentComposerId
    || composerId;
  const isSubagent = !!parentComposerId;
  let depth = 0;
  if (isSubagent && parentComposerId) {
    const visited = new Set<string>([composerId]);
    let current = parentComposerId;
    while (current && !visited.has(current)) {
      visited.add(current);
      depth += 1;
      const parentRaw = readKv(db, `composerData:${current}`);
      const parentComposer = parentRaw ? safeJsonParse<CursorStoredComposer>(parentRaw) : null;
      const nextParent = parentComposer?.subagentInfo?.parentComposerId?.trim();
      if (!nextParent) break;
      current = nextParent;
    }
  }

  return {
    composerId,
    name: typeof composer.name === 'string' ? composer.name.trim() || undefined : undefined,
    parentComposerId,
    rootOrchestratorComposerId,
    subagentComposerIds: Array.isArray(composer.subagentComposerIds)
      ? composer.subagentComposerIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
    isSubagent,
    depth,
  };
}

function readKv(db: SqliteDatabase, key: string): string | undefined {
  const row = db
    .prepare('select value from cursorDiskKV where key = ?')
    .get(key) as { value?: string | Uint8Array | Buffer } | undefined;
  return valueToString(row?.value);
}

function readBubbleBatch(
  db: SqliteDatabase,
  composerId: string,
  bubbleIds: string[]
): Map<string, CursorStoredBubble> {
  const out = new Map<string, CursorStoredBubble>();
  const chunkSize = 200;
  for (let i = 0; i < bubbleIds.length; i += chunkSize) {
    const chunk = bubbleIds.slice(i, i + chunkSize);
    const keys = chunk.map((bubbleId) => `bubbleId:${composerId}:${bubbleId}`);
    const placeholders = keys.map(() => '?').join(',');
    const rows = db
      .prepare(`select key, value from cursorDiskKV where key in (${placeholders})`)
      .all(...keys) as Array<{ key: string; value?: string | Uint8Array | Buffer }>;

    for (const row of rows) {
      const raw = valueToString(row.value);
      if (!raw) continue;
      const bubble = safeJsonParse<CursorStoredBubble>(raw);
      const bubbleId = row.key.split(':').pop() ?? bubble?.bubbleId;
      if (bubble && bubbleId) out.set(bubbleId, bubble);
    }
  }
  return out;
}

function storedBubbleToChatElement(
  header: CursorComposerHeader,
  bubble: CursorStoredBubble,
  flatIndex: number
): ChatElement | null {
  const id = bubble.bubbleId || header.bubbleId;
  const text = (bubble.text ?? '').trim();

  if (header.type === 1 || bubble.type === 1) {
    return {
      type: 'human',
      id,
      flatIndex,
      text: text || richTextToPlainText(bubble.richText),
      mentions: [],
    };
  }

  const thinkingText = getThinkingText(bubble);
  if (thinkingText && !text && !bubble.toolFormerData) {
    return {
      type: 'thought',
      id,
      flatIndex,
      duration: formatDurationMs(bubble.thinking?.durationMs),
      action: thinkingText,
      detail: thinkingText,
    };
  }

  if (bubble.toolFormerData && !text) {
    return {
      type: 'tool',
      id,
      flatIndex,
      toolCallId: id,
      status: 'completed',
      action: formatToolAction(bubble.toolFormerData),
      details: summarizeToolPayload(bubble.toolFormerData),
    };
  }

  if (text || thinkingText || bubble.serviceStatusUpdate?.message) {
    const markdown = text || thinkingText || bubble.serviceStatusUpdate?.message || '';
    return {
      type: 'assistant',
      id,
      flatIndex,
      text: markdown,
      html: markdownToWebHtml(markdown),
      codeBlocks: [],
    };
  }

  return null;
}

function valueToString(value: string | Uint8Array | Buffer | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('utf8');
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function richTextToPlainText(raw: string | undefined): string {
  if (!raw) return '';
  const parsed = safeJsonParse<{ root?: { children?: unknown[] } }>(raw);
  if (!parsed) return '';
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as { text?: unknown; children?: unknown[] };
    if (typeof record.text === 'string') parts.push(record.text);
    if (Array.isArray(record.children)) record.children.forEach(visit);
  };
  visit(parsed.root);
  return parts.join('').trim();
}

function getThinkingText(bubble: CursorStoredBubble): string {
  const direct = bubble.thinking?.text?.trim();
  if (direct) return direct;
  return (bubble.allThinkingBlocks ?? [])
    .map((block) => block.text?.trim())
    .filter(Boolean)
    .join('\n\n');
}

function formatDurationMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatToolAction(tool: NonNullable<CursorStoredBubble['toolFormerData']>): string {
  const params = parseMaybeJsonObject(tool.params);

  const commandDescription =
    getString(params, 'commandDescription') ||
    getPathString(params, ['parsingResult', 'commandDescription']);
  if (commandDescription) return commandDescription;

  const command = getString(params, 'command');
  if (command) return `Run command: ${firstLine(command)}`;

  const targetFile = getString(params, 'targetFile') || getString(params, 'effectiveUri');
  if (targetFile) return `Read file ${basename(targetFile)}`;

  switch (tool.tool) {
    case 15:
      return 'Run command';
    case 40:
      return 'Read file';
    default:
      return tool.tool == null ? 'Tool call' : `Tool call ${tool.tool}`;
  }
}

function summarizeToolPayload(tool: NonNullable<CursorStoredBubble['toolFormerData']>): string {
  const result = parseMaybeJsonObject(tool.result);
  const params = parseMaybeJsonObject(tool.params);

  const output = getString(result, 'output');
  if (output) return normalizeToolDetail(output);

  const contents = getString(result, 'contents');
  if (contents) return summarizeFileContents(contents);

  const totalLines = result?.totalLinesInFile;
  if (typeof totalLines === 'number') return `${totalLines} lines`;

  const command = getString(params, 'command');
  if (command) return firstLine(command);

  const targetFile = getString(params, 'targetFile') || getString(params, 'effectiveUri');
  if (targetFile) return targetFile;

  const payload = tool.result ?? tool.params ?? tool.additionalData;
  if (payload == null) return '';
  try {
    return normalizeToolDetail(JSON.stringify(payload));
  } catch {
    return normalizeToolDetail(String(payload));
  }
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = safeJsonParse<unknown>(value);
  return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getPathString(record: Record<string, unknown> | undefined, path: string[]): string {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return '';
    current = current[key];
  }
  return typeof current === 'string' ? current.trim() : '';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

function normalizeToolDetail(text: string): string {
  return stripAnsi(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, 1000);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

function summarizeFileContents(contents: string): string {
  const normalized = normalizeToolDetail(contents);
  const lines = normalized.split('\n').filter((line) => line.trim().length > 0);
  return lines.slice(0, 3).join('\n');
}
