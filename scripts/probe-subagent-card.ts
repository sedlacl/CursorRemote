import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function main() {
  const config = loadConfig();
  const targets = await (await fetch(`${config.cdpUrl}/json`)).json() as CDPTarget[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page?.webSocketDebuggerUrl) {
    console.error('No workbench');
    process.exit(2);
  }
  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(page.webSocketDebuggerUrl);

  const report = await client.evaluate(`
    (() => {
      const card = document.querySelector('[data-subagent-task-card="true"]');
      if (!card) return { found: false };
      const walk = (el, depth = 0) => {
        if (!el || depth > 5) return null;
        const kids = Array.from(el.children || []).map((c) => walk(c, depth + 1));
        return {
          tag: el.tagName,
          role: el.getAttribute('role'),
          attrs: Array.from(el.attributes || [])
            .filter((a) => a.name.startsWith('data-') || a.name === 'title' || a.name === 'aria-label' || a.name === 'class')
            .map((a) => a.name + '=' + String(a.value).slice(0, 100)),
          textOwn: Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 3),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          children: kids,
        };
      };
      const header = card.querySelector('[data-subagent-task-card-header="true"]');
      const model = card.querySelector('[data-subagent-task-model="true"]');
      const stop = card.querySelector('[data-subagent-task-action="stop"]');
      const shimmer = card.querySelector('[data-shimmer="true"]');
      // Heuristic: title-like spans inside header excluding model/stop/status
      const titleCandidates = [];
      if (header) {
        for (const el of Array.from(header.querySelectorAll('span, div, p'))) {
          if (el.closest('[data-subagent-task-model], [data-subagent-task-action], .ui-subagent-status-indicator')) continue;
          const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!t || t.length > 160) continue;
          if (el.children.length > 2) continue;
          titleCandidates.push({
            tag: el.tagName,
            className: String(el.className || '').slice(0, 100),
            text: t,
            childCount: el.children.length,
          });
        }
      }
      return {
        found: true,
        modelText: (model?.textContent || '').replace(/\\s+/g, ' ').trim(),
        stopText: (stop?.textContent || '').replace(/\\s+/g, ' ').trim(),
        shimmerText: (shimmer?.textContent || '').replace(/\\s+/g, ' ').trim(),
        titleCandidates: titleCandidates.slice(0, 20),
        tree: walk(card),
        outer: (card.outerHTML || '').slice(0, 4000),
      };
    })()
  `);
  console.log(JSON.stringify(report, null, 2));
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
