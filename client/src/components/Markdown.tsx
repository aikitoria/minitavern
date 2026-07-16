import { createEffect, createSignal, onCleanup } from 'solid-js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

let hljsPromise: Promise<typeof import('highlight.js/lib/common')> | null = null;

// Segments that must never get quote-wrapping: fenced code (also unclosed,
// mid-stream), inline code, and raw HTML tags.
const PROTECTED_SPLIT = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|<[^>\n]*>)/;
const QUOTE_RE = /"[^"\n]+"|“[^”\n]+”/g;

/**
 * While streaming, close any still-open markers (quotes, *, **, `) at the end
 * of the buffer so emphasis and dialogue color immediately as they stream in,
 * instead of waiting for the closing marker to arrive.
 */
function autoclose(src: string): string {
  // Inside an unclosed code fence marked already renders everything as code.
  if (((src.match(/```/g) ?? []).length) % 2 === 1) return src;
  let out = src;
  let scan = src.replace(/```[\s\S]*?```/g, '');
  if (((scan.match(/`/g) ?? []).length) % 2 === 1) {
    out += '`';
    scan += '`';
  }
  scan = scan.replace(/`[^`\n]*`/g, '');
  const closers: string[] = [];
  if (((scan.match(/"/g) ?? []).length) % 2 === 1) closers.push('"');
  if (((scan.match(/“/g) ?? []).length) > ((scan.match(/”/g) ?? []).length)) closers.push('”');
  const bolds = (scan.match(/\*\*/g) ?? []).length;
  const singles = (scan.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  if (singles % 2 === 1) closers.push('*');
  if (bolds % 2 === 1) closers.push('**');
  return out + closers.join('');
}

/**
 * Wraps "quoted" spans in the markdown SOURCE so the markdown inside them
 * (e.g. "Wow, *she said*") still parses — the span passes through marked as
 * inline raw HTML while its contents keep being processed.
 */
function markQuotes(src: string): string {
  return src
    .split(PROTECTED_SPLIT)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(QUOTE_RE, (m) => `<span class="quoted">${m}</span>`),
    )
    .join('');
}

export default function Markdown(props: { content: string; streaming: boolean }) {
  const [html, setHtml] = createSignal('');
  let container: HTMLDivElement | undefined;
  let raf = 0;

  const render = () => {
    const src = props.streaming ? autoclose(props.content) : props.content;
    setHtml(DOMPurify.sanitize(marked.parse(markQuotes(src), { async: false })));
  };

  const highlight = async () => {
    if (!container?.querySelector('pre code')) return;
    hljsPromise ??= import('highlight.js/lib/common');
    const hljs = (await hljsPromise).default;
    container.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  };

  createEffect(() => {
    void props.content; // track
    if (props.streaming) {
      // Re-parse at most once per frame while tokens stream in.
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          render();
        });
      }
    } else {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      render();
      queueMicrotask(() => void highlight());
    }
  });

  onCleanup(() => cancelAnimationFrame(raf));

  return <div class="md" ref={container} innerHTML={html()} />;
}
