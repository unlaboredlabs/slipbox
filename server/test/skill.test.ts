// The agent skill in skills/: what `npx skills add` and Claude Code need to find and load it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SKILL = new URL("../../skills/slipbox/SKILL.md", import.meta.url);

test("skills/slipbox/SKILL.md has valid name and description frontmatter", () => {
  const text = readFileSync(SKILL, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(front).not.toBeNull();
  const meta = Bun.YAML.parse(front![1]) as Record<string, unknown>;

  // The Agent Skills rules: name is the folder's name, lowercase words joined by single hyphens, at most 64 characters.
  expect(meta.name).toBe("slipbox");
  expect(meta.name as string).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  expect((meta.name as string).length).toBeLessThanOrEqual(64);

  // The description is what an agent decides to load the skill by: at most 1024 characters.
  expect(typeof meta.description).toBe("string");
  const description = (meta.description as string).trim();
  expect(description.length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);

  // Short enough to load whole at the start of work.
  expect(text.split("\n").length).toBeLessThan(150);
});
