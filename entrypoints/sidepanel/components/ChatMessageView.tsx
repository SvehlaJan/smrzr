import type { ChatMessage, Citation } from '@/src/types';
import { safeHref } from '../markdown';
import { Markdown } from './Markdown';

/** One chat bubble. Model replies get markdown, citations, sources and Google's search chip. */
export function ChatMessageView(props: {
  role: ChatMessage['role'];
  text: string;
  citations?: Citation[];
  searchEntryPointHtml?: string;
  /** e.g. "#3", shown on user messages that were sent with a focus. */
  focusLabel?: string | null;
  streaming?: boolean;
}) {
  const citations = props.citations ?? [];
  if (props.role === 'user') {
    return (
      <div className="msg msg-user">
        {props.focusLabel && <span className="msg-focus">{props.focusLabel}</span>}
        <p className="msg-plain">{props.text}</p>
      </div>
    );
  }
  return (
    <div className="msg msg-model" aria-live={props.streaming ? 'polite' : undefined} aria-busy={props.streaming || undefined}>
      {props.text ? <Markdown text={props.text} citations={citations} /> : <p className="muted progress">Thinking…</p>}
      {citations.length > 0 && <Sources citations={citations} />}
      {props.searchEntryPointHtml && <SearchSuggestions html={props.searchEntryPointHtml} />}
    </div>
  );
}

function Sources({ citations }: { citations: Citation[] }) {
  return (
    <div className="sources">
      <span className="sources-label">Sources</span>
      <ol>
        {citations.map((c) => {
          const href = safeHref(c.uri);
          return (
            <li key={c.index} value={c.index}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {c.title || href}
                </a>
              ) : (
                c.title
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Google's Search grounding terms require showing the "search suggestions" chip it returns
 * as HTML. We never insert that HTML into our own page: it goes into a sandboxed iframe
 * (no scripts, no access to the extension). `allow-popups` lets its links open in new tabs;
 * the <base target> makes plain links do that instead of navigating the tiny frame.
 */
export function SearchSuggestions({ html }: { html: string }) {
  return (
    <iframe
      className="search-suggestions"
      title="Google Search suggestions"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={`<base target="_blank">${html}`}
    />
  );
}
