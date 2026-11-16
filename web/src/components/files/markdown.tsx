import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon } from "lucide-react";

type Node = { type: string; tagName?: string; position?: { start: { line: number }; end: { line: number } }; properties?: Record<string, unknown> };

/**
 * Marks each top-level block with its lines, so a line range can be found. Drops the first
 * h1 when the page shows it as the title (the server's title rule: the first `# ` heading).
 */
const blocks = (skipTitle: boolean) => () => (tree: { children: Node[] }) => {
  if (skipTitle) {
    const title = tree.children.findIndex((n) => n.tagName === "h1");
    if (title >= 0) tree.children.splice(title, 1);
  }
  for (const n of tree.children) {
    if (n.type === "element" && n.position) Object.assign((n.properties ??= {}), { dataLine: n.position.start.line, dataEnd: n.position.end.line });
  }
};

/**
 * Where a link in the note at `from` points inside the data folder, or null for anything else.
 * "./" and "../" are relative to the note; other paths with a folder are from the root, as the
 * agents' tools write them; a bare file name is a neighbour.
 */
export function notePath(href: string | undefined, from: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) return null;
  let target = href.split(/[?#]/)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (!target.endsWith(".md")) return null;
  const folder = from.split("/").slice(0, -1);
  const start = /^\.\.?\//.test(target) || !target.includes("/") ? folder : [];
  const parts = [...start];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** A note is written by an agent: a remote image would tell its site that the note was read. Only inline (data:) images show. */
function NoteImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  if (typeof src === "string" && src.startsWith("data:")) return <img src={src} alt={alt} />;
  const href = typeof src === "string" ? src : undefined;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={href} className="inline-flex items-center gap-1.5 align-baseline">
      <ImageIcon className="size-3.5 shrink-0 self-center" />
      {alt || "Image"}
    </a>
  );
}

const PROSE =
  "prose prose-neutral max-w-none text-[14.5px] leading-[1.7] [overflow-wrap:anywhere] dark:prose-invert prose-headings:font-semibold prose-headings:tracking-[-0.01em] prose-h1:text-2xl prose-h2:mt-9 prose-h2:mb-3 prose-h2:text-[17px] prose-h3:text-[15px] prose-p:my-3 prose-a:text-link prose-a:no-underline hover:prose-a:underline prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.86em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground prose-li:my-1 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 prose-table:text-[13.5px] prose-th:font-medium prose-hr:my-8";

/** Renders a note read-only, scrolled to `lines` ("12-30") when given. */
export function MarkdownView({ content, path, skipTitle, lines }: { content: string; path: string; skipTitle?: boolean; lines?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = lines?.match(/^(\d+)(?:-(\d+))?$/);
    if (!m || !ref.current) return;
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    const hits = [...ref.current.querySelectorAll<HTMLElement>("[data-line]")].filter((el) => Number(el.dataset.line) <= to && Number(el.dataset.end) >= from);
    hits[0]?.scrollIntoView({ block: "start" });
    for (const el of hits) {
      el.classList.remove("line-hit");
      void el.offsetWidth; // restart the animation when the same lines are opened again
      el.classList.add("line-hit");
    }
  }, [lines, content]);

  const components: Components = {
    a: ({ node: _node, href, children, ...rest }) => {
      const target = notePath(href, path);
      if (target) return <Link to="/files" search={{ path: target }}>{children}</Link>;
      const external = href && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href);
      return (
        <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...rest}>
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => <NoteImage src={src} alt={alt} />,
  };

  return (
    <div ref={ref} className={PROSE}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[blocks(Boolean(skipTitle))]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
