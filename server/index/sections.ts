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

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseMarkdown(content: string): Parsed {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  // Find headings outside code fences.
  const headings: { line: number; level: number; text: string }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (FENCE.test(l)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING.exec(l);
      if (m) headings.push({ line: i, level: m[1].length, text: m[2] });
    }
  });

  const titleHeading = headings.find((h) => h.level === 1);
  const title = titleHeading?.text ?? "";
  const summary = firstParagraph(lines, titleHeading ? titleHeading.line + 1 : 0);

  // One block per heading, plus any text before the first heading.
  const blocks: { heading: string; start: number; end: number }[] = [];
  const starts = headings.map((h) => h.line);
  if (starts[0] !== 0 && lines.length) blocks.push({ heading: "", start: 0, end: (starts[0] ?? lines.length) - 1 });
  headings.forEach((h, i) => blocks.push({ heading: h.text, start: h.line, end: (starts[i + 1] ?? lines.length) - 1 }));

  const sections: Section[] = [];
  for (const b of blocks) {
    for (const [start, end] of splitLong(lines, b.start, b.end)) {
      const text = lines.slice(start, end + 1).join("\n").trim();
      if (!text) continue;
      sections.push({ heading: b.heading, startLine: start + 1, endLine: end + 1, text, textHash: hashText(text) });
    }
  }
  return { title, summary, sections };
}

function firstParagraph(lines: string[], from: number): string {
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
    if (HEADING.test(l)) {
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

/** Splits lines [start, end] into ranges of about SECTION_CHARS, breaking at blank lines. */
function splitLong(lines: string[], start: number, end: number): [number, number][] {
  const ranges: [number, number][] = [];
  let from = start;
  let size = 0;
  let lastBreak = -1; // last blank line seen in the current range
  for (let i = start; i <= end; i++) {
    size += lines[i].length + 1;
    if (!lines[i].trim() && i > from) lastBreak = i;
    if (size > SECTION_CHARS && lastBreak > from) {
      ranges.push([from, lastBreak - 1]);
      from = lastBreak + 1;
      size = lines.slice(from, i + 1).reduce((s, l) => s + l.length + 1, 0);
      lastBreak = -1;
    }
  }
  if (from <= end) ranges.push([from, end]);
  return ranges;
}
