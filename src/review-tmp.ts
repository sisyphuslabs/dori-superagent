import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REVIEW_TMP_PREFIX = "dori-review-";
export const REVIEW_TMP_STALE_MS = 60 * 60 * 1000;

const DELETED_SUFFIX = " (deleted)";
const NUMERIC_PID = /^\d+$/;
const SIGNAL_NUMBERS: Readonly<Record<"SIGINT" | "SIGTERM", number>> = {
  SIGINT: 2,
  SIGTERM: 15,
};

export type InUseCheck = (dir: string) => boolean;

export type SweepOptions = {
  readonly baseDir?: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly isInUse?: InUseCheck;
  readonly uid?: number;
};

export function createReviewTmpDir(baseDir: string = tmpdir()): string {
  return mkdtempSync(join(baseDir, REVIEW_TMP_PREFIX));
}

export function removeReviewTmpDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return !existsSync(dir);
  } catch {
    return !existsSync(dir);
  }
}

function stripTrailingSlash(p: string): string {
  return p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p;
}

function dirPrefixes(dir: string): string[] {
  const set = new Set<string>([stripTrailingSlash(dir)]);
  try {
    set.add(stripTrailingSlash(realpathSync(dir)));
  } catch {}
  return [...set];
}

function pathInside(candidate: string, prefixes: readonly string[]): boolean {
  const clean = candidate.endsWith(DELETED_SUFFIX) ? candidate.slice(0, -DELETED_SUFFIX.length) : candidate;
  for (const p of prefixes) {
    if (clean === p || clean.startsWith(`${p}/`)) return true;
  }
  return false;
}

function isDirInUseLinux(prefixes: readonly string[]): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!NUMERIC_PID.test(entry)) continue;
    const procDir = `/proc/${entry}`;
    try {
      if (pathInside(readlinkSync(`${procDir}/cwd`), prefixes)) return true;
    } catch {}
    let fds: string[];
    try {
      fds = readdirSync(`${procDir}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (pathInside(readlinkSync(`${procDir}/fd/${fd}`), prefixes)) return true;
      } catch {}
    }
  }
  return false;
}

export function parseLsofInUse(exitCode: number | null, stdout: string, stderr: string): boolean {
  // On macOS (lsof 4.91), `lsof +D` exits 1 with empty stderr even when matches exist unless every entry in the tree is open.
  if (/^p\d+/m.test(stdout)) return true;
  if (exitCode === 0) return false;
  if (exitCode === 1 && stderr.trim() === "") return false;
  return true;
}

function isDirInUseLsof(target: string): boolean {
  try {
    const res = Bun.spawnSync(["lsof", "-w", "-n", "-P", "-Fp", "+D", target], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stdout = new TextDecoder().decode(res.stdout);
    const stderr = new TextDecoder().decode(res.stderr);
    return parseLsofInUse(res.exitCode, stdout, stderr);
  } catch {
    return true;
  }
}

function isDirInUse(dir: string): boolean {
  const prefixes = dirPrefixes(dir);
  if (process.platform === "linux" && existsSync("/proc")) return isDirInUseLinux(prefixes);
  return isDirInUseLsof(prefixes.at(-1) ?? dir);
}

export function sweepStaleReviewTmpDirs(opts: SweepOptions = {}): string[] {
  const baseDir = opts.baseDir ?? tmpdir();
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? REVIEW_TMP_STALE_MS;
  const checkInUse = opts.isInUse ?? isDirInUse;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);

  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(REVIEW_TMP_PREFIX)) continue;
    const fullPath = join(baseDir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (uid !== undefined && st.uid !== uid) continue;
    if (now - st.mtimeMs <= maxAgeMs) continue;
    if (checkInUse(fullPath)) continue;
    if (removeReviewTmpDir(fullPath)) removed.push(fullPath);
  }
  return removed;
}

export function attachCleanupSignals(cleanup: () => void): () => void {
  let ran = false;
  const runOnce = () => {
    if (ran) return;
    ran = true;
    cleanup();
  };
  const onSigTerm = () => {
    runOnce();
    process.exit(128 + SIGNAL_NUMBERS.SIGTERM);
  };
  const onSigInt = () => {
    runOnce();
    process.exit(128 + SIGNAL_NUMBERS.SIGINT);
  };
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);
  process.on("exit", runOnce);
  return () => {
    process.off("SIGTERM", onSigTerm);
    process.off("SIGINT", onSigInt);
    process.off("exit", runOnce);
  };
}
