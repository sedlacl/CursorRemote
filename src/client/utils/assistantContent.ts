import type { CodeBlockItem } from '../../server/types.js';
import { isRenderableCodeBlockItem } from '../components/messages/codeBlocks.js';
import { sanitizeHtml } from './sanitizeHtml.js';

const ELEMENT_NODE = 1;
const COMPOSER_CODE_BLOCK_SELECTOR = '.composer-message-codeblock, .composer-code-block-container';
const NATIVE_CODE_BLOCK_SLOT_CLASS = 'native-code-block-slot';

export type AssistantContentSegment =
  | { kind: 'html'; html: string }
  | { kind: 'codeBlock'; index: number; item: CodeBlockItem };

/** Sanitize assistant markdown HTML and replace composer native blocks with slot anchors. */
export function sanitizeAssistantHtml(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined') return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script, iframe, object, embed, form').forEach((node) => node.remove());

  let cbSlot = 0;
  tmp.querySelectorAll(COMPOSER_CODE_BLOCK_SELECTOR).forEach((el) => {
    const slot = document.createElement('div');
    slot.className = NATIVE_CODE_BLOCK_SLOT_CLASS;
    slot.dataset.cbIndex = String(cbSlot++);
    el.replaceWith(slot);
  });
  tmp.querySelectorAll('.ui-code-block').forEach((el) => el.remove());

  tmp.querySelectorAll<HTMLElement>('*').forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'src') {
        try {
          const url = new URL(attr.value, window.location.href);
          const allowed = name === 'src'
            ? url.protocol === 'data:' || ['http:', 'https:'].includes(url.protocol)
            : ['http:', 'https:', 'mailto:'].includes(url.protocol);
          if (!allowed) node.removeAttribute(attr.name);
        } catch {
          node.removeAttribute(attr.name);
        }
      }
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  return tmp.innerHTML;
}

function elementContainsSlot(element: Element): boolean {
  return !!element.querySelector(`.${NATIVE_CODE_BLOCK_SLOT_CLASS}`);
}

function flushHtmlBuffer(buffer: HTMLElement, segments: AssistantContentSegment[]): void {
  const html = buffer.innerHTML.trim();
  if (html) segments.push({ kind: 'html', html });
  buffer.innerHTML = '';
}

function consumeAssistantNodes(
  nodes: Iterable<Node>,
  buffer: HTMLElement,
  segments: AssistantContentSegment[],
  codeBlocks: CodeBlockItem[],
  used: Set<number>,
): void {
  for (const node of nodes) {
    if (node.nodeType === ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.classList.contains(NATIVE_CODE_BLOCK_SLOT_CLASS)) {
        flushHtmlBuffer(buffer, segments);
        const index = parseInt(element.dataset.cbIndex || '-1', 10);
        const item = Number.isFinite(index) && index >= 0 ? codeBlocks[index] : undefined;
        if (isRenderableCodeBlockItem(item)) {
          used.add(index);
          segments.push({ kind: 'codeBlock', index, item: item! });
        }
        continue;
      }
      if (elementContainsSlot(element)) {
        consumeAssistantNodes(element.childNodes, buffer, segments, codeBlocks, used);
        continue;
      }
    }
    buffer.appendChild(node.cloneNode(true));
  }
}

/** Split sanitized assistant HTML into ordered prose/code segments for React rendering. */
export function buildAssistantContentSegments(
  rawHtml: string,
  codeBlocks: CodeBlockItem[] = [],
): AssistantContentSegment[] {
  if (!rawHtml.trim()) {
    return codeBlocks
      .map((item, index) => ({ kind: 'codeBlock' as const, index, item }))
      .filter((segment) => isRenderableCodeBlockItem(segment.item));
  }

  if (typeof document === 'undefined') {
    return [{ kind: 'html', html: sanitizeHtml(rawHtml) }];
  }

  const sanitized = sanitizeAssistantHtml(rawHtml);
  const container = document.createElement('div');
  container.innerHTML = sanitized;

  const segments: AssistantContentSegment[] = [];
  const used = new Set<number>();
  const buffer = document.createElement('div');
  consumeAssistantNodes(container.childNodes, buffer, segments, codeBlocks, used);
  flushHtmlBuffer(buffer, segments);

  for (let index = 0; index < codeBlocks.length; index++) {
    if (used.has(index) || !isRenderableCodeBlockItem(codeBlocks[index])) continue;
    segments.push({ kind: 'codeBlock', index, item: codeBlocks[index]! });
  }

  return segments;
}
