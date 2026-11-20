import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

export function tempDir(prefix: string, base = tmpdir()): string {
  const root = mkdtempSync(join(base, prefix));
  roots.push(root);
  return root;
}
