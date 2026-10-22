// Renders model text from the parse tree in ../markdown.ts. Only React elements are
// created (never innerHTML), so any HTML in the text is displayed as text.

import { Fragment, type ReactNode } from 'react';
import type { Citation } from '@/src/types';
import { parseMarkdown, safeHref, type Inline } from '../markdown';
import { Timestamp } from './Timestamp';

export function Markdown({ text, citations = [] }: { text: string; citations?: Citation[] }) {
  const renderInline = (nodes: Inline[]): ReactNode[] =>
    nodes.map((node, i) => {
      switch (node.type) {
        case 'text':
          return <Fragment key={i}>{node.text}</Fragment>;
        case 'strong':
          return <strong key={i}>{renderInline(node.children)}</strong>;
        case 'em':
          return <em key={i}>{renderInline(node.children)}</em>;
        case 'code':
          return <code key={i}>{node.text}</code>;
        case 'time':
          return <Timestamp key={i} sec={node.sec} />;
        case 'cite': {
          const c = citations.find((x) => x.index === node.index);
          const href = c ? safeHref(c.uri) : null;
          if (!c || !href) return <Fragment key={i}>[{node.index}]</Fragment>;
          return (
            <a key={i} className="cite" href={href} target="_blank" rel="noopener noreferrer" title={c.title}>
              [{node.index}]
            </a>
          );
        }
      }
    });

  return (
    <div className="md">
      {parseMarkdown(text).map((block, i) => {
        switch (block.type) {
          case 'p':
            return (
              <p key={i}>
                {block.lines.map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(line)}
                  </Fragment>
                ))}
              </p>
            );
          case 'heading':
            return (
              <p key={i} className="md-heading">
                <strong>{renderInline(block.children)}</strong>
              </p>
            );
          case 'ul':
            return (
              <ul key={i}>
                {block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={block.start}>
                {block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
              </ol>
            );
        }
      })}
    </div>
  );
}
