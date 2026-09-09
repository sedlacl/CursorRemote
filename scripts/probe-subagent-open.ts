import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { CdpClient } from '../src/server/cdp-client.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface JobProbe {
  title: string;
  hasClickable: boolean;
  clickableClass: string;
}

interface WindowProbe {
  documentTitle: string;
  composerId: string;
  jobs: JobProbe[];
}

async function inspect(client: CdpClient): Promise<WindowProbe> {
  return await client.evaluate(`
    (() => {
      const visibleComposer = Array.from(document.querySelectorAll('.composer-bar.editor[data-composer-id]'))
        .find(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 8 && rect.height > 8;
        });
      const root = visibleComposer || document;
      const jobs = Array.from(root.querySelectorAll('.composer-toolbar-background-job-item')).map(job => {
        const clickable = job.querySelector('.composer-toolbar-background-job-item-clickable')
          || job.closest('.composer-toolbar-background-job-item-clickable');
        const title = (job.querySelector('.composer-toolbar-background-job-item-text')?.textContent || '')
          .replace(/\\s+/g, ' ').trim();
        return {
          title,
          hasClickable: clickable instanceof HTMLElement,
          clickableClass: clickable instanceof HTMLElement ? clickable.className : '',
        };
      });
      return {
        documentTitle: document.title,
        composerId: visibleComposer?.getAttribute('data-composer-id') || '',
        jobs,
      };
    })()
  `) as WindowProbe;
}

async function main(): Promise<void> {
  const click = process.argv.includes('--click');
  const config = loadConfig();
  const targets = await (await fetch(`${config.cdpUrl}/json`)).json() as CDPTarget[];
  const pages = targets.filter(target =>
    target.type === 'page' && target.url.includes('workbench') && target.webSocketDebuggerUrl,
  );

  for (const page of pages) {
    const client = new CdpClient();
    await client.connect(page.webSocketDebuggerUrl!);
    const before = await inspect(client);
    if (before.jobs.length === 0) {
      console.log(JSON.stringify({ target: page.title, before }, null, 2));
      client.disconnect();
      continue;
    }

    let clicked = false;
    if (click) {
      clicked = await client.evaluate(`
        (() => {
          const visibleComposer = Array.from(document.querySelectorAll('.composer-bar.editor[data-composer-id]'))
            .find(el => {
              const rect = el.getBoundingClientRect();
              return rect.width > 8 && rect.height > 8;
            });
          const job = visibleComposer?.querySelector('.composer-toolbar-background-job-item');
          const clickable = job?.querySelector('.composer-toolbar-background-job-item-clickable')
            || job?.closest('.composer-toolbar-background-job-item-clickable');
          if (!(clickable instanceof HTMLElement)) return false;
          clickable.click();
          return true;
        })()
      `) as boolean;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const after = await inspect(client);
    console.log(JSON.stringify({ target: page.title, clicked, before, after }, null, 2));
    client.disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
