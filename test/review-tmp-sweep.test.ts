import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_TMP_PREFIX, REVIEW_TMP_STALE_MS, sweepStaleReviewTmpDirs } from "../src/review-tmp.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeAgedDir(base: string, name: string, ageMs: number, now: number): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.txt"), "payload");
  const t = new Date(now - ageMs);
  utimesSync(dir, t, t);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("sweepStaleReviewTmpDirs", () => {
  test("removes only tool-owned dirs older than 1 hour and preserves fresh, symlink, and unrelated dirs", () => {
    const base = tempDir("dori-sweep-unit-");
    const now = Date.now();
    const stale = makeAgedDir(base, `${REVIEW_TMP_PREFIX}old-1`, REVIEW_TMP_STALE_MS + 60_000, now);
    const fresh = makeAgedDir(base, `${REVIEW_TMP_PREFIX}fresh-1`, REVIEW_TMP_STALE_MS - 60_000, now);
    const compileCache = makeAgedDir(base, "node-compile-cache", REVIEW_TMP_STALE_MS * 5, now);
    const foreign = makeAgedDir(base, "cmis466", REVIEW_TMP_STALE_MS * 5, now);
    const linkTarget = makeAgedDir(base, "real-target", REVIEW_TMP_STALE_MS * 5, now);
    const link = join(base, `${REVIEW_TMP_PREFIX}symlink`);
    symlinkSync(linkTarget, link);

    const removed = sweepStaleReviewTmpDirs({ baseDir: base, now });
    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(compileCache)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(linkTarget)).toBe(true);
  });

  test("skips a stale dir while a process holds an open file inside it, then removes it once closed", () => {
    const base = tempDir("dori-sweep-fd-");
    const now = Date.now();
    const stale = makeAgedDir(base, `${REVIEW_TMP_PREFIX}open-fd`, REVIEW_TMP_STALE_MS + 60_000, now);
    const fd = openSync(join(stale, "file.txt"), "r");
    try {
      expect(sweepStaleReviewTmpDirs({ baseDir: base, now })).toEqual([]);
      expect(existsSync(stale)).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(sweepStaleReviewTmpDirs({ baseDir: base, now })).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });

  test("skips a stale dir while a process has its cwd inside it, then removes it after that process exits", async () => {
    const base = tempDir("dori-sweep-cwd-");
    const now = Date.now();
    const stale = makeAgedDir(base, `${REVIEW_TMP_PREFIX}active-cwd`, REVIEW_TMP_STALE_MS + 60_000, now);
    const sub = join(stale, "repo");
    mkdirSync(sub, { recursive: true });
    const oldTime = new Date(now - (REVIEW_TMP_STALE_MS + 60_000));
    utimesSync(stale, oldTime, oldTime);

    const proc = Bun.spawn([process.execPath, "-e", "console.log('READY'); await new Promise(() => {});"], {
      cwd: sub,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let buf = "";
      while (!buf.includes("READY")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      expect(buf).toContain("READY");

      expect(sweepStaleReviewTmpDirs({ baseDir: base, now })).toEqual([]);
      expect(existsSync(stale)).toBe(true);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }

    expect(sweepStaleReviewTmpDirs({ baseDir: base, now })).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });
});
