/**
 * Read-only shape of the Claude Code chat transcript.
 *
 * Dumps tags, roles, and data/aria keys — not message text.
 *
 * Usage: npx tsx scripts/probe-claude-transcript.ts
 */
import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';

interface CDPTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const CLAUDE_MARKER = 'extensionId=Anthropic.claude-code';

function inPanel(fn: string): string {
  return `
    (() => {
      const f = document.getElementById('active-frame');
      if (!f || !f.contentDocument) return { __noFrame: true };
      return (${fn})(f.contentDocument);
    })()
  `;
}

const SHAPE_JS = inPanel(`(d) => {
  const visible = document.visibilityState;
  const input = d.querySelector('[role="textbox"][aria-label="Message input"]');
  const interesting = Array.from(d.querySelectorAll('[role], [data-message-id], [data-testid], article, [class*="message"], [class*="Message"]'))
    .slice(0, 40)
    .map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      testid: el.getAttribute('data-testid'),
      aria: el.getAttribute('aria-label'),
      cls: String(el.className || '').split(/\\s+/).slice(0, 3).join(' '),
      data: Array.from(el.attributes || []).map((a) => a.name).filter((n) => n.startsWith('data-')).slice(0, 8),
      textLen: ((el.innerText || '').trim()).length,
    }));
  const bodyKids = Array.from((d.body && d.body.children) || []).slice(0, 8).map((el) => ({
    tag: el.tagName,
    id: el.id || '',
    role: el.getAttribute('role'),
    cls: String(el.className || '').split(/\\s+/).slice(0, 4).join(' '),
    childCount: el.children.length,
  }));
  return {
    visible,
    hasInput: !!input,
    bodyKids,
    interesting,
  };
}`);

async function main() {
  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`)).json()) as CDPTarget[];
  const claude = targets.filter(
    (t) => t.url.includes(CLAUDE_MARKER) && t.webSocketDebuggerUrl,
  );
  console.log(`[probe-claude-transcript] ${claude.length} target(s)`);
  for (const target of claude) {
    const client = new CdpClient();
    try {
      await client.connect(target.webSocketDebuggerUrl!, 6000);
      const shape = await client.evaluate(SHAPE_JS, 8000);
      console.log(`\n--- ${target.id.slice(0, 8)} ${target.url.slice(0, 120)} ---`);
      console.log(JSON.stringify(shape, null, 2));
    } catch (err) {
      console.error(target.id.slice(0, 8), err);
    } finally {
      client.disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
