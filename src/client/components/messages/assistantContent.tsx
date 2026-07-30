import React, { useMemo, useState } from 'react';
import type { CodeBlockItem } from '../../../server/types.js';
import { CodeBlockBody, NativeCodeBlock, isRenderableCodeBlockItem } from './codeBlocks.js';
import type { AssistantContentSegment } from '../../utils/assistantContent.js';

function AssistantHtmlSegment({ html }: { html: string }) {
  return <div className="assistant-html-segment" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AssistantInlineCodeBlock({ item }: { item: CodeBlockItem }) {
  const [fullscreenBlock, setFullscreenBlock] = useState<CodeBlockItem | null>(null);
  return (
    <>
      <NativeCodeBlock item={item} onFullscreen={() => setFullscreenBlock(item)} />
      {fullscreenBlock && (
        <div className="code-block-fs-overlay" role="dialog" aria-modal="true" aria-label={fullscreenBlock.filename || 'Code'}>
          <div className="code-block-fs-backdrop" onClick={() => setFullscreenBlock(null)} />
          <div className="code-block-fs-panel">
            <div className="code-block-fs-panel-header">
              <span className="code-block-fs-title">{fullscreenBlock.filename || fullscreenBlock.language || 'Code'}</span>
              <button type="button" className="code-block-fs-close" aria-label="Close" onClick={() => setFullscreenBlock(null)}>x</button>
            </div>
            <div className="code-block-fs-scroll">
              <CodeBlockBody item={fullscreenBlock} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function AssistantMessageContent({
  segments,
}: {
  segments: AssistantContentSegment[];
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'html') {
          return <AssistantHtmlSegment key={`html-${index}`} html={segment.html} />;
        }
        if (!isRenderableCodeBlockItem(segment.item)) return null;
        return <AssistantInlineCodeBlock key={`code-${segment.index}:${index}`} item={segment.item} />;
      })}
    </>
  );
}
