import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSurfaceRules, parseRules, RulesFileError } from "../src/surface-rules.ts";

const RULES_FILE = join(import.meta.dir, "..", "..", "rules", "dori-bot.md");

test("the gateway surface's rules include the surface rules and the ask guide, each with its own section", () => {
  // Given the dori.bot rules file; when its surface rules are loaded.
  const ids = loadSurfaceRules("gateway");
  // Then the required ids are there, and the body has exactly one section per id and none besides.
  for (const id of [
    "ask.money-leaves",
    "ask.sent-to-another-person",
    "ask.cannot-be-undone",
    "surface.one-conversation",
    "surface.only-sent-is-shown",
    "surface.no-internal-plumbing",
    "surface.answer-within-a-minute",
  ])
    expect(ids).toContain(id);
  const { sections } = parseRules(readFileSync(RULES_FILE, "utf8"));
  expect([...sections].sort()).toEqual([...ids].sort());
});

test("a rules file whose ids and sections disagree is refused", () => {
  // Given a rules file with an id that has no section, then one with a section no id lists.
  const dir = mkdtempSync(join(tmpdir(), "dori-rules-"));
  try {
    const write = (body: string) => writeFileSync(join(dir, "dori-bot.md"), body);
    write("---\nrules:\n  - a.one\n  - a.two\n---\n\n## a.one\n\ntext\n");
    expect(() => loadSurfaceRules("gateway", dir)).toThrow(RulesFileError);
    write("---\nrules:\n  - a.one\n---\n\n## a.one\n\ntext\n\n## a.extra\n\ntext\n");
    expect(() => loadSurfaceRules("gateway", dir)).toThrow(RulesFileError);
    write("---\nrules:\n  - a.one\n---\n\n## a.one\n\ntext\n");
    expect(loadSurfaceRules("gateway", dir)).toEqual(["a.one"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
