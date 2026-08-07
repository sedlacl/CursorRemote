import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { encodeCrockfordBase32 } from '../shared/diagnostic-id.js';
import {
  DiagnosticSnapshotError,
  DiagnosticSnapshotService,
  type DiagnosticStateSnapshot,
} from './diagnostic-snapshot.js';
import { DomExportError } from './dom-export.js';

const DEFAULT_WEB_DOM_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_WEB_SCREENSHOT_MAX_BYTES = 2.5 * 1024 * 1024;
const NOTE_MAX_CHARS = 2000;
const ARTIFACTS_REL = join('docs', 'issues', '.artifacts');
const ISSUES_REL = join('docs', 'issues');

export interface UiReportClientInput {
  diagnosticId: string;
  webDomHtml: string;
  clientUrl?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  note?: string;
  webScreenshotPngBase64?: string;
}

export interface UiReportCaptureResult {
  issueId: string;
  issuePath: string;
  artifactsDir: string;
  agentPrompt: string;
  warnings: string[];
  capturedAt: string;
}

export class UiReportError extends Error {
  constructor(
    public readonly status: 400 | 413 | 422 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UiReportError';
  }
}

export interface UiReportServiceOptions {
  packageRoot: string;
  diagnosticId: string;
  webDomMaxBytes?: number;
  webScreenshotMaxBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export function generateUiReportIssueId(): string {
  return encodeCrockfordBase32(randomBytes(5));
}

/** Trim, strip NULs, cap length. Empty after trim → undefined. */
export function sanitizeUiReportNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const trimmed = note.replace(/\u0000/g, '').trim();
  if (!trimmed) return undefined;
  return trimmed.length > NOTE_MAX_CHARS ? trimmed.slice(0, NOTE_MAX_CHARS) : trimmed;
}

/** Accept raw base64 or data-URL; return Buffer or null when empty/invalid. */
export function decodeWebScreenshotPng(base64: unknown): { buffer: Buffer } | { error: string } | null {
  if (base64 == null || base64 === '') return null;
  if (typeof base64 !== 'string') return { error: 'web_screenshot_invalid' };
  let raw = base64.trim();
  const dataUrlMatch = /^data:image\/png;base64,(.+)$/i.exec(raw);
  if (dataUrlMatch) raw = dataUrlMatch[1] ?? '';
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return { error: 'web_screenshot_invalid' };
  try {
    const buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    if (buffer.length === 0) return { error: 'web_screenshot_invalid' };
    return { buffer };
  } catch {
    return { error: 'web_screenshot_invalid' };
  }
}

function dateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function errorCode(error: unknown): string {
  if (error instanceof DomExportError) return error.code;
  if (error instanceof DiagnosticSnapshotError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  return 'capture_failed';
}

function summarizeState(state: DiagnosticStateSnapshot | null): string {
  if (!state) return '- state: capture failed';
  const lines = [
    `- connected: ${state.connected}`,
    `- agentStatus: ${state.agentStatus}`,
    `- messageCount: ${state.messageCount}`,
    `- pendingApprovalCount: ${state.pendingApprovalCount}`,
    `- activeWindowId: ${state.activeWindowId || '—'}`,
    `- activeComposerId: ${state.activeComposerId || '—'}`,
    `- mode: ${state.mode?.current ?? '—'}`,
    `- model: ${state.model?.current ?? '—'}`,
    `- subagents.runningCount: ${state.subagents.runningCount}`,
  ];
  return lines.join('\n');
}

export function buildUiReportMarkdown(input: {
  issueId: string;
  diagnosticId: string;
  date: string;
  capturedAt: string;
  clientUrl?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  note?: string;
  artifactsAbs: string;
  issueAbs: string;
  state: DiagnosticStateSnapshot | null;
  warnings: string[];
  artifactFiles: string[];
}): string {
  const note = input.note?.trim() || '';
  const noteBlock = note ? `\n## User note\n\n${note}\n` : '';
  const symptom = note
    || 'Observed from mobile/web Debug **Report** capture. Fill in after inspecting artifacts.';
  const warningBlock = input.warnings.length > 0
    ? `\n## Capture warnings\n\n${input.warnings.map((w) => `- ${w}`).join('\n')}\n`
    : '';
  const files = input.artifactFiles.map((f) => `- \`${join(input.artifactsAbs, f)}\``).join('\n');

  return `# UI report ${input.issueId}

- Status: open
- Date: ${input.date}
- Diagnostic ID: ${input.diagnosticId}
- Issue ID: ${input.issueId}
- Captured at: ${input.capturedAt}
- Client URL: ${input.clientUrl || '—'}
- User-Agent: ${input.userAgent || '—'}
- Viewport: ${input.viewport ? `${input.viewport.width}×${input.viewport.height}` : '—'}
- Report: \`${input.artifactsAbs}\`
- Area: web-ui | extractor | relay | other
${noteBlock}
## Symptom

${symptom}

## Repro

observed in session ${input.diagnosticId} (issue ${input.issueId})

## Evidence

${summarizeState(input.state)}

Artifacts (gitignored raw files):

${files || '- (none)'}

Issue markdown: \`${input.issueAbs}\`
${warningBlock}
## Likely cause

_Pending agent analysis — do not invent a cause without reading the artifacts._

## Suggested fix (not applied)

_Pending._

## Out of scope / follow-ups

Raw HTML/PNG must stay under \`.artifacts/\` (gitignored). Do not commit them.
`;
}

export function buildUiReportAgentPrompt(input: {
  issueId: string;
  issuePath: string;
  artifactsDir: string;
}): string {
  return [
    'CursorRemote UI report',
    `Issue ID: ${input.issueId}`,
    `Issue: ${input.issuePath}`,
    `Artifacts: ${input.artifactsDir}`,
    'Please analyze the artifacts and update the issue (Symptom / Evidence / Likely cause). Do not commit or fix code unless asked.',
  ].join('\n');
}

export class UiReportService {
  private readonly packageRoot: string;
  private readonly diagnosticId: string;
  private readonly webDomMaxBytes: number;
  private readonly webScreenshotMaxBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private running = false;

  constructor(
    private readonly snapshot: DiagnosticSnapshotService,
    options: UiReportServiceOptions,
  ) {
    this.packageRoot = resolve(options.packageRoot);
    this.diagnosticId = options.diagnosticId;
    this.webDomMaxBytes = options.webDomMaxBytes ?? DEFAULT_WEB_DOM_MAX_BYTES;
    this.webScreenshotMaxBytes = options.webScreenshotMaxBytes ?? DEFAULT_WEB_SCREENSHOT_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? generateUiReportIssueId;
  }

  async capture(input: UiReportClientInput): Promise<UiReportCaptureResult> {
    if (this.running) {
      throw new UiReportError(503, 'ui_report_busy', 'Another UI report capture is already running');
    }

    const note = sanitizeUiReportNote(input.note);
    if (!note) {
      throw new UiReportError(422, 'note_required', 'A short error description is required');
    }

    const html = typeof input.webDomHtml === 'string' ? input.webDomHtml : '';
    if (!html.trim()) {
      throw new UiReportError(422, 'web_dom_required', 'webDomHtml is required');
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > this.webDomMaxBytes) {
      throw new UiReportError(413, 'web_dom_too_large', 'Web client DOM exceeds configured size limit');
    }

    this.running = true;
    const warnings: string[] = [];
    const artifactFiles: string[] = [];
    const capturedAt = this.now().toISOString();
    const date = dateStamp(this.now());
    const issueId = this.idFactory();
    const artifactsRel = join(ARTIFACTS_REL, issueId);
    const artifactsAbs = join(this.packageRoot, artifactsRel);
    const issueRel = join(ISSUES_REL, `${date}-ui-report-${issueId}.md`);
    const issueAbs = join(this.packageRoot, issueRel);

    try {
      mkdirSync(artifactsAbs, { recursive: true });
      mkdirSync(join(this.packageRoot, ISSUES_REL), { recursive: true });

      writeFileSync(join(artifactsAbs, 'web-dom.html'), html, 'utf8');
      artifactFiles.push('web-dom.html');

      const decodedShot = decodeWebScreenshotPng(input.webScreenshotPngBase64);
      let webScreenshotBytes: number | null = null;
      if (decodedShot && 'error' in decodedShot) {
        warnings.push(`web-screenshot: ${decodedShot.error}`);
      } else if (decodedShot && 'buffer' in decodedShot) {
        if (decodedShot.buffer.length > this.webScreenshotMaxBytes) {
          warnings.push('web-screenshot: too_large');
        } else {
          writeFileSync(join(artifactsAbs, 'web-screenshot.png'), decodedShot.buffer);
          artifactFiles.push('web-screenshot.png');
          webScreenshotBytes = decodedShot.buffer.length;
        }
      } else if (input.webScreenshotPngBase64 != null && String(input.webScreenshotPngBase64).trim() === '') {
        // Explicit empty — treat as unavailable.
        warnings.push('web-screenshot: unavailable');
      } else if (input.webScreenshotPngBase64 == null) {
        warnings.push('web-screenshot: unavailable');
      }

      const meta = {
        issueId,
        diagnosticId: this.diagnosticId,
        clientDiagnosticId: input.diagnosticId || null,
        capturedAt,
        clientUrl: input.clientUrl ?? null,
        userAgent: input.userAgent ?? null,
        viewport: input.viewport ?? null,
        webDomBytes: bytes,
        webScreenshotBytes,
        note,
      };
      writeFileSync(join(artifactsAbs, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      artifactFiles.push('meta.json');

      let state: DiagnosticStateSnapshot | null = null;
      try {
        state = this.snapshot.buildStateSnapshot();
        writeFileSync(join(artifactsAbs, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
        artifactFiles.push('state.json');
      } catch (error) {
        warnings.push(`state: ${errorCode(error)}`);
      }

      try {
        const chat = await this.snapshot.captureCursorDom('chat');
        writeFileSync(join(artifactsAbs, 'cursor-dom-chat.html'), chat.html, 'utf8');
        artifactFiles.push('cursor-dom-chat.html');
      } catch (error) {
        warnings.push(`cursor-dom-chat: ${errorCode(error)}`);
      }

      try {
        const doc = await this.snapshot.captureCursorDom('document');
        writeFileSync(join(artifactsAbs, 'cursor-dom-document.html'), doc.html, 'utf8');
        artifactFiles.push('cursor-dom-document.html');
      } catch (error) {
        warnings.push(`cursor-dom-document: ${errorCode(error)}`);
      }

      try {
        const shot = await this.snapshot.captureScreenshot();
        writeFileSync(join(artifactsAbs, 'cursor-screenshot.png'), Buffer.from(shot.dataBase64, 'base64'));
        artifactFiles.push('cursor-screenshot.png');
      } catch (error) {
        warnings.push(`cursor-screenshot: ${errorCode(error)}`);
      }

      const markdown = buildUiReportMarkdown({
        issueId,
        diagnosticId: this.diagnosticId,
        date,
        capturedAt,
        clientUrl: input.clientUrl,
        userAgent: input.userAgent,
        viewport: input.viewport,
        note,
        artifactsAbs,
        issueAbs,
        state,
        warnings,
        artifactFiles,
      });
      writeFileSync(issueAbs, markdown, 'utf8');

      const issuePath = relative(this.packageRoot, issueAbs).replace(/\\/g, '/');
      const artifactsDir = relative(this.packageRoot, artifactsAbs).replace(/\\/g, '/');
      const agentPrompt = buildUiReportAgentPrompt({ issueId, issuePath, artifactsDir });

      return {
        issueId,
        issuePath,
        artifactsDir,
        agentPrompt,
        warnings,
        capturedAt,
      };
    } finally {
      this.running = false;
    }
  }
}
