/**
 * Which Cursor window each Claude webview belongs to.
 *
 * Usage: npx tsx scripts/probe-claude-window-bind.ts
 */
import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

async function main() {
  const config = loadConfig();
  const targets = (await (await fetch(`${config.cdpUrl}/json`)).json()) as Array<Record<string, unknown>>;
  console.log(`[probe] ${targets.length} targets @ ${config.cdpUrl}`);
  const keys = new Set<string>();
  for (const target of targets) {
    for (const key of Object.keys(target)) keys.add(key);
  }
  console.log('keys', [...keys].join(', '));

  for (const target of targets) {
    const url = String(target.url ?? '');
    const type = String(target.type ?? '');
    const interesting = type === 'page' || url.includes('claude-code') || url.includes('workbench');
    if (!interesting) continue;
    const purpose = (() => {
      try { return new URL(url).searchParams.get('purpose') || ''; } catch { return ''; }
    })();
    const id = String(target.id ?? '');
    const parentId = String(target.parentId ?? '');
    const page = targets.find((pageTarget) => {
      const pageId = String(pageTarget.id ?? '');
      return pageTarget.type === 'page' && parentId.startsWith(pageId);
    });
    console.log(JSON.stringify({
      id: id.slice(0, 8),
      idLen: id.length,
      type,
      title: String(target.title ?? '').slice(0, 70),
      purpose,
      parentPrefix: parentId.slice(0, 8),
      parentMatchesPage: page ? String(page.title ?? '').slice(0, 40) : '',
      claude: url.includes('Anthropic.claude-code'),
    }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
