import { readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACE_RULES = { gateway: "dori-bot.md" } as const;
export type RulesSurface = keyof typeof SURFACE_RULES;

const RULES_DIR = join(import.meta.dir, "..", "..", "rules");

export class RulesFileError extends Error {}

/** The ids in the front matter's `rules:` list, and the `## <id>` sections of the body, in file order. */
export const parseRules = (text: string): { readonly ids: string[]; readonly sections: string[] } => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front?.[1]) throw new RulesFileError("rules file has no front matter");
  const list = /^rules:\n((?:[ \t]+- .*\n?)*)/m.exec(front[1]);
  const ids = (list?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+- /, "").trim())
    .filter(Boolean);
  const body = text.slice(front[0].length);
  const sections = [...body.matchAll(/^## (\S+)\s*$/gm)].map((m) => m[1] ?? "");
  return { ids, sections };
};

/** The rule ids of a surface. Every id must have exactly one section, and every section must be a listed id. */
export const loadSurfaceRules = (surface: RulesSurface, dir = RULES_DIR): string[] => {
  const { ids, sections } = parseRules(readFileSync(join(dir, SURFACE_RULES[surface]), "utf8"));
  if (!ids.length) throw new RulesFileError(`${SURFACE_RULES[surface]} lists no rules`);
  for (const id of ids)
    if (sections.filter((s) => s === id).length !== 1)
      throw new RulesFileError(`${SURFACE_RULES[surface]}: rule ${id} needs exactly one section`);
  for (const section of sections)
    if (!ids.includes(section))
      throw new RulesFileError(`${SURFACE_RULES[surface]}: section ${section} is not a listed rule`);
  return ids;
};
