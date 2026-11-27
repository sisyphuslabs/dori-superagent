import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../src/gate.ts";
import { setup } from "./harness-setup.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const HEAD = "a".repeat(40);
const STALE_MS = 2 * 60 * 60 * 1000;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setupGh(w: ReturnType<typeof setup>["w"]) {
  w.gh = (argv) =>
    argv[1] === "view" ? { code: 0, stdout: JSON.stringify({ headRefOid: HEAD }) } : { code: 1, stdout: "" };
}

function writeFakeGh(binDir: string): void {
  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh\nif [ "$2" = "view" ]; then printf '{"headRefOid":"%s"}\\n' "${HEAD}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(ghPath, 0o755);
}

describe("dori review temp dir lifecycle", () => {
  test("creates a per-review temp dir, passes it to the reviewer, and deletes it on success", async () => {
    const { w, d } = setup();
    setupGh(w);
    let seenDir = "";
    const exec = d.exec;
    const deps = {
      ...d,
      exec: async (
        cmd: string,
        argv: readonly string[],
        options?: { env?: Readonly<Record<string, string | undefined>> },
      ) => {
        if (cmd === "gh") return exec(cmd, argv);
        const dir = options?.env?.["DORI_REVIEW_TMPDIR"] ?? "";
        seenDir = dir;
        expect(dir).not.toBe("");
        expect(options?.env?.["TMPDIR"]).toBe(dir);
        expect(argv.at(-1)).toContain(dir);
        mkdirSync(join(dir, "repo"), { recursive: true });
        writeFileSync(join(dir, "repo", "keys.json"), "{}");
        return { code: 0, stdout: "no findings\nVERDICT: CLEAR", stderr: "" };
      },
    };
    const res = await review(deps, "o/r#101");
    expect(res.verdict).toBe("CLEAR");
    expect(seenDir).not.toBe("");
    expect(existsSync(seenDir)).toBe(false);
  });

  test("deletes the per-review temp dir when the reviewer fails or throws", async () => {
    const { w, d } = setup();
    setupGh(w);
    const seen: string[] = [];
    let mode: "nonzero" | "noverdict" | "throw" = "nonzero";
    const exec = d.exec;
    const deps = {
      ...d,
      exec: async (
        cmd: string,
        argv: readonly string[],
        options?: { env?: Readonly<Record<string, string | undefined>> },
      ) => {
        if (cmd === "gh") return exec(cmd, argv);
        const dir = options?.env?.["DORI_REVIEW_TMPDIR"] ?? "";
        seen.push(dir);
        expect(dir).not.toBe("");
        mkdirSync(join(dir, "base"), { recursive: true });
        writeFileSync(join(dir, "base", "diff.txt"), "data");
        if (mode === "throw") throw new Error("spawn failed");
        if (mode === "nonzero") return { code: 2, stdout: "", stderr: "boom" };
        return { code: 0, stdout: "no verdict line", stderr: "" };
      },
    };
    await expect(review(deps, "o/r#102")).rejects.toThrow("reviewer exited 2");
    mode = "noverdict";
    await expect(review(deps, "o/r#102")).rejects.toThrow("no VERDICT");
    mode = "throw";
    await expect(review(deps, "o/r#102")).rejects.toThrow("spawn failed");
    expect(seen).toHaveLength(3);
    for (const dir of seen) expect(existsSync(dir)).toBe(false);
  });

  test("cleans up the temp dir and exits 143 when dori review receives SIGTERM", async () => {
    const root = tempDir("dori-sigterm-test-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const tmpBase = join(root, "tmp");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(tmpBase, { recursive: true });
    writeFakeGh(bin);

    const reviewerScript = join(bin, "fake-reviewer.ts");
    writeFileSync(
      reviewerScript,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
const dir = process.env["DORI_REVIEW_TMPDIR"] ?? "";
if (dir) {
  mkdirSync(join(dir, "repo"), { recursive: true });
  writeFileSync(join(dir, "repo", "keys.json"), "{}");
}
const sock = createConnection({ host: "127.0.0.1", port: Number(process.env["READY_PORT"]) }, () => {
  sock.end(dir + "\\n");
});
await new Promise(() => {});
`,
    );
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ hooks: { reviewCommand: [process.execPath, reviewerScript, "{tmpDir}"] } }),
    );

    let onReady!: (dir: string) => void;
    const ready = new Promise<string>((resolve) => {
      onReady = resolve;
    });
    const server = createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buf += chunk;
      });
      socket.on("end", () => onReady(buf.trim()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const proc = Bun.spawn([process.execPath, CLI, "review", "o/r#103"], {
      env: {
        ...process.env,
        DORI_HOME: home,
        TMPDIR: tmpBase,
        READY_PORT: String(port),
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reviewDir = await ready;
      expect(reviewDir).not.toBe("");
      expect(realpathSync(reviewDir).startsWith(realpathSync(tmpBase))).toBe(true);
      expect(existsSync(join(reviewDir, "repo", "keys.json"))).toBe(true);
      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(143);
      expect(existsSync(reviewDir)).toBe(false);
    } finally {
      server.close();
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  });

  test("startup sweep removes stale unused dori-review-* dirs and preserves unrelated dirs like node-compile-cache", async () => {
    const { w, d } = setup();
    setupGh(w);
    const tmpBase = tempDir("dori-sweep-base-");
    const stale = join(tmpBase, "dori-review-stale-1");
    const compileCache = join(tmpBase, "node-compile-cache");
    mkdirSync(stale, { recursive: true });
    mkdirSync(compileCache, { recursive: true });
    const oldTime = new Date(Date.now() - STALE_MS);
    utimesSync(stale, oldTime, oldTime);
    utimesSync(compileCache, oldTime, oldTime);

    const prevTmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = tmpBase;
    try {
      w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
      await review(d, "o/r#104");
    } finally {
      if (prevTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = prevTmp;
    }
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(compileCache)).toBe(true);
  });
});
