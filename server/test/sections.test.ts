// The Markdown splitter: titles, summaries and sections with exact line ranges.
import { describe, expect, test } from "bun:test";
import { snippet } from "../index/search";
import { SECTION_CHARS, parseMarkdown } from "../index/sections";

/** The text of a section's line range, as read(path, "start-end") returns it. */
const linesOf = (content: string, start: number, end: number) => content.split("\n").slice(start - 1, end).join("\n").trim();

describe("splitting notes into sections", () => {
  test("setext headings are headings: the title, the summary and the sections", () => {
    const note = "Legacy exporter\n===============\n\nExports orders as CSV over SFTP every night.\n\nSetup\n-----\n\nThe host key is ssh-rsa.\n";
    const p = parseMarkdown(note);
    expect(p.title).toBe("Legacy exporter");
    expect(p.summary).toBe("Exports orders as CSV over SFTP every night.");
    expect(p.sections.map((s) => [s.heading, s.startLine, s.endLine])).toEqual([
      ["Legacy exporter", 1, 5],
      ["Setup", 6, 9],
    ]);
  });

  test("a rule under a list, a table or front matter is not a heading underline", () => {
    const note = "---\ntitle: Hugo page\n---\n\n# Catalogue\n\nThe data catalogue.\n\n- one item\n---\n\n| a | b |\n|---|---|\n";
    const p = parseMarkdown(note);
    expect(p.title).toBe("Catalogue");
    expect(p.sections.map((s) => s.heading)).toEqual(["", "Catalogue"]);
  });

  test("a long block without blank lines is split between lines, and its heading stays with its text", () => {
    const log = Array.from({ length: 400 }, (_, i) => `2026-11-16T10:00:${String(i % 60).padStart(2, "0")} worker ${i} exited with code 137`);
    const note = `# Incident\n\nThe worker log.\n\n## Log\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`;
    const p = parseMarkdown(note);
    const logSections = p.sections.filter((s) => s.heading === "Log");
    expect(logSections.length).toBeGreaterThan(5);
    for (const s of logSections) expect(s.text.length).toBeLessThanOrEqual(SECTION_CHARS);
    // No section holds only the heading.
    expect(logSections[0].text.startsWith("## Log\n\n```\n2026")).toBe(true);
    // Line ranges are exact and cover every line of the log.
    for (const s of p.sections) expect(linesOf(note, s.startLine, s.endLine)).toBe(s.text);
    expect(logSections.at(-1)!.endLine).toBe(note.split("\n").length - 1);
  });

  test("long sections still break at blank lines first", () => {
    const para = (n: number) => `Paragraph ${n} ` + "words ".repeat(100).trim() + ".";
    const note = `# Long\n\n${[1, 2, 3, 4].map(para).join("\n\n")}\n`;
    const p = parseMarkdown(note);
    expect(p.sections.map((s) => [s.startLine, s.endLine])).toEqual([
      [1, 5],
      [7, 9],
    ]);
  });
});

describe("snippets", () => {
  test("leave out the section's heading, setext ones too", () => {
    expect(snippet("## Setup\n\nThe host key is ssh-rsa.", [])).toBe("The host key is ssh-rsa.");
    expect(snippet("Legacy exporter\n===============\n\nExports orders as CSV.", [])).toBe("Exports orders as CSV.");
  });
});
