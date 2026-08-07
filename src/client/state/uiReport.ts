import { getAuthToken } from './socketClient.js';

export interface UiReportResponse {
  issueId: string;
  issuePath: string;
  artifactsDir: string;
  agentPrompt: string;
  warnings: string[];
  capturedAt: string;
}

export interface CaptureUiReportOptions {
  diagnosticId?: string | null;
  note: string;
  webScreenshotPngBase64?: string | null;
}

function collectWebDomHtml(): string {
  return document.documentElement.outerHTML;
}

export async function captureUiReport(
  options: CaptureUiReportOptions,
): Promise<UiReportResponse> {
  const note = options.note?.trim() ?? '';
  if (!note) {
    throw new Error('UI report failed: note_required');
  }

  const html = collectWebDomHtml();
  const token = getAuthToken();
  const screenshot = options.webScreenshotPngBase64?.trim() || undefined;

  const response = await fetch('/debug/ui-report', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      diagnosticId: options.diagnosticId ?? undefined,
      webDomHtml: html,
      clientUrl: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      note,
      ...(screenshot ? { webScreenshotPngBase64: screenshot } : {}),
    }),
  });

  if (!response.ok) {
    let code = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) code = body.error;
    } catch {
      // Keep status-only error.
    }
    throw new Error(`UI report failed: ${code}`);
  }

  return response.json() as Promise<UiReportResponse>;
}
