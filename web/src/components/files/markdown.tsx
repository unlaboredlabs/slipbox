import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders a note read-only. The first heading is left out when the page shows it as the title. */
export function MarkdownView({ content, skipTitle }: { content: string; skipTitle?: boolean }) {
  const body = skipTitle ? content.replace(/^\s*# .*\n?/, "") : content;
  return (
    <div className="prose prose-neutral max-w-none text-[14.5px] leading-[1.7] dark:prose-invert prose-headings:font-semibold prose-headings:tracking-[-0.01em] prose-h1:text-2xl prose-h2:mt-9 prose-h2:mb-3 prose-h2:text-[17px] prose-h3:text-[15px] prose-p:my-3 prose-a:text-link prose-a:no-underline hover:prose-a:underline prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.86em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground prose-li:my-1 prose-table:text-[13.5px] prose-th:font-medium prose-hr:my-8">
      <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
    </div>
  );
}
