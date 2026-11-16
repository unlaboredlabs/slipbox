// Splits a Markdown file into a title, a summary and searchable sections.
import { createHash } from "node:crypto";

export interface Section {
  heading: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
  text: string;
  textHash: string;
}

export interface Parsed {
  title: string;
  summary: string;
  sections: Section[];
}

/** Sections longer than this are split further at paragraph boundaries. */
export const SECTION_CHARS = 1500;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** A setext underline: `===` makes the line above a level 1 heading, `---` a level 2 one. */
const SETEXT = /^ {0,3}(=+|-{2,})\s*$/;
/** Lines that start a block of their own, so a `---` under them is a rule, not a heading underline. */
const BLOCK_START = /^\s*([-*+>|]|\d+[.)]\s|#{1,6}\s)/;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseMarkdown(content: string): Parsed {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const headings = findHeadings(lines);
  const titleHeading = headings.find((h) => h.level === 1);
  const title = titleHeading?.text ?? "";
  const headingLines = new Set(headings.flatMap((h) => (h.end > h.line ? [h.line, h.end] : [h.line])));
  const summary = firstParagraph(lines, titleHeading ? titleHeading.end + 1 : 0, headingLines);

  // One block per heading, plus any text before the first heading.
  const blocks: { heading: string; start: number; headingEnd: number; end: number }[] = [];
  const starts = headings.map((h) => h.line);
  if (starts[0] !== 0 && lines.length) blocks.push({ heading: "", start: 0, headingEnd: -1, end: (starts[0] ?? lines.length) - 1 });
  headings.forEach((h, i) =>
    blocks.push({ heading: h.text, start: h.line, headingEnd: h.end, end: (starts[i + 1] ?? lines.length) - 1 }),
  );

  const sections: Section[] = [];
  for (const b of blocks) {
    for (const [start, end] of splitLong(lines, b.start, b.end, b.headingEnd)) {
      const text = lines.slice(start, end + 1).join("\n").trim();
      if (!text) continue;
      sections.push({ heading: b.heading, startLine: start + 1, endLine: end + 1, text, textHash: hashText(text) });
    }
  }
  return { title, summary, sections };
}

interface Heading {
  line: number; // the heading's first line (its text)
  end: number; // its last line: the underline of a setext heading, else the same line
  level: number;
  text: string;
}

/** Headings outside code fences and front matter: ATX (`# Title`) and setext (a line underlined with `===` or `---`). */
function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  let from = 0;
  // YAML front matter: a `---` first line, up to the next `---`.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (close > 0) from = close + 1;
  }
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(l);
    if (m) {
      headings.push({ line: i, end: i, level: m[1].length, text: m[2] });
      continue;
    }
    // The line above must be plain text: not blank, a list item, a quote, a table row, a fence or another underline.
    const prev = lines[i - 1];
    const u = SETEXT.exec(l);
    if (u && i > from && prev.trim() && !BLOCK_START.test(prev) && !FENCE.test(prev) && !SETEXT.test(prev)) {
      headings.push({ line: i - 1, end: i, level: u[1][0] === "=" ? 1 : 2, text: prev.trim() });
    }
  }
  return headings;
}

function firstParagraph(lines: string[], from: number, headingLines: Set<number>): string {
  const para: string[] = [];
  let inFence = false;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) {
      inFence = !inFence;
      if (para.length) break;
      continue;
    }
    if (inFence) continue;
    if (headingLines.has(i)) {
      if (para.length) break;
      continue;
    }
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  const text = para.join(" ");
  return text.length > 300 ? text.slice(0, 297).trimEnd() + "..." : text;
}

/**
 * Splits lines [start, end] into ranges of about SECTION_CHARS, breaking at
 * blank lines, or between lines when a long run has none (a log, a big code
 * block), so no section grows past what the model reads. A heading (lines
 * start..headingEnd) always stays with text that follows it.
 */
function splitLong(lines: string[], start: number, end: number, headingEnd: number): [number, number][] {
  const ranges: [number, number][] = [];
  let from = start;
  let size = 0;
  let lastBreak = -1; // last blank line seen in the current range after some body text
  let body = false; // whether the current range has text other than its heading
  for (let i = start; i <= end; i++) {
    const blank = !lines[i].trim();
    if (size + lines[i].length + 1 > SECTION_CHARS && body) {
      // Break at the last blank line, else just before this line.
      const cut = lastBreak > from ? lastBreak : i;
      ranges.push([from, cut - 1]);
      from = cut === lastBreak ? cut + 1 : cut;
      size = lines.slice(from, i).reduce((s, l) => s + l.length + 1, 0);
      body = lines.slice(from, i).some((l) => l.trim());
      lastBreak = -1;
    }
    size += lines[i].length + 1;
    if (blank && body && i > from) lastBreak = i;
    if (!blank && i > headingEnd) body = true;
  }
  if (from <= end) ranges.push([from, end]);
  return ranges;
}
