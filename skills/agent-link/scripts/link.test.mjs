import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advance, split } from "./link.mjs";

const LINK = path.join(import.meta.dir, "link.mjs");

describe("advance", () => {
  test("skips lines already printed at the cursor second and prints the rest in order", () => {
    // The caller re-reads from one second before the cursor, so the cursor second comes back.
    const msgs = [
      { ts: "2026-01-01T00:00:09Z", text: "old" },
      { ts: "2026-01-01T00:00:10Z", text: "seen" },
      { ts: "2026-01-01T00:00:10Z", text: "same second, new" },
      { ts: "2026-01-01T00:00:11Z", text: "next" },
    ];
    const { fresh, cursor } = advance({ ts: "2026-01-01T00:00:10Z", n: 1 }, msgs);
    expect(fresh.map((m) => m.text)).toEqual(["same second, new", "next"]);
    expect(cursor).toEqual({ ts: "2026-01-01T00:00:11Z", n: 1 });
  });

  test("counts several new lines in one second so the next poll skips all of them", () => {
    const msgs = [
      { ts: "2026-01-01T00:00:20Z", text: "[1/2] a" },
      { ts: "2026-01-01T00:00:20Z", text: "[2/2] b" },
    ];
    const first = advance({ ts: "2026-01-01T00:00:10Z", n: 1 }, msgs);
    expect(first.cursor).toEqual({ ts: "2026-01-01T00:00:20Z", n: 2 });
    expect(advance(first.cursor, msgs).fresh).toEqual([]);
  });
});

describe("split", () => {
  test("keeps a short message as one line with newlines flattened", () => {
    expect(split("done\n  found 3 seats")).toEqual(["done found 3 seats"]);
  });

  test("numbers long messages and keeps every part, with its id, within the gateway limit", () => {
    const parts = split("x".repeat(9000), "#0a1b2c3d ");
    expect(parts.length).toBe(3);
    expect(parts[0]?.startsWith("#0a1b2c3d [1/3] ")).toBe(true);
    expect(parts[2]?.startsWith("#0a1b2c3d [3/3] ")).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
    expect(parts.map((p) => p.replace(/^#0a1b2c3d \[\d+\/3\] /, "")).join("")).toBe("x".repeat(9000));
  });
});

// A stand-in for the pinned reference gateway's REST surface: the token picks the box it reads,
// since= is strictly newer, and a read returns only the newest min(limit, 200) matches.
function gateway() {
  const g = { boxes: { "outbox-a": [], "inbox-a": [] }, fail: null, seen: [], sent: [] };
  const reads = { "lead-token": "outbox-a", "agent-token": "inbox-a" };
  g.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      g.seen.push({ path: u.pathname, auth: req.headers.get("authorization") });
      if (g.fail) return new Response(g.fail.body, { status: g.fail.status, headers: g.fail.headers });
      if (u.pathname === "/healthz") return Response.json({ ok: true });
      const box = reads[(req.headers.get("authorization") ?? "").replace(/^Bearer /, "")];
      if (!box) return Response.json({ error: "invalid_token" }, { status: 401 });
      if (u.pathname === "/api/whoami") return Response.json({ agent: box });
      if (u.pathname === "/api/messages") {
        const since = u.searchParams.get("since");
        const limit = Number(u.searchParams.get("limit") || 50);
        const out = g.boxes[box].filter((m) => !since || m.ts > since);
        return Response.json({ messages: out.slice(-Math.min(Math.max(1, limit | 0), 200)) });
      }
      if (u.pathname === "/api/send") {
        const { text } = await req.json();
        g.sent.push(text);
        return Response.json({ sent: text });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  g.origin = `http://127.0.0.1:${g.server.port}`;
  return g;
}

const at = (s, text = "") => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString().replace(".000", ""), text });

let dir;
let g;
const env = (extra = {}) => ({
  MBX_URL: g.origin,
  MBX_APPROVED_ORIGINS: g.origin,
  MBX_TOKEN: "lead-token",
  MBX_STATE_DIR: dir,
  ...extra,
});
const cursorFile = () => path.join(dir, "agent.cursor.json");
const readCursor = () => (fs.existsSync(cursorFile()) ? JSON.parse(fs.readFileSync(cursorFile(), "utf8")) : null);
const writeCursor = (ts, n) => fs.writeFileSync(cursorFile(), JSON.stringify({ ts, n }));
const msgLines = (out) => out.split("\n").filter((l) => l.startsWith("MBX_MSG "));

async function link(args, vars) {
  const p = Bun.spawn([process.execPath, LINK, ...args], {
    env: { PATH: process.env.PATH, HOME: dir, ...vars },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-"));
  g = gateway();
});
afterEach(() => {
  g.server.stop(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("credentials stay with the approved destination", () => {
  const marker = () => path.join(dir, "token-read");
  const tokenCmd = () => `touch '${marker()}'; echo lead-token`;

  test("refuses plain http to a non-loopback host before reading the token", async () => {
    const url = "http://mailbox.invalid";
    const r = await link(["whoami"], env({ MBX_URL: url, MBX_APPROVED_ORIGINS: url, MBX_TOKEN_CMD: tokenCmd() }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("https");
    expect(fs.existsSync(marker())).toBe(false);
  });

  test("refuses a URL that is not an approved origin before reading the token", async () => {
    const r = await link(
      ["whoami"],
      env({
        MBX_URL: "https://moved.invalid",
        MBX_APPROVED_ORIGINS: "https://mailbox.invalid",
        MBX_TOKEN_CMD: tokenCmd(),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("not an approved origin");
    expect(fs.existsSync(marker())).toBe(false);
  });

  test("does not follow a redirect to another origin", async () => {
    const other = gateway();
    try {
      g.fail = { status: 307, body: "", headers: { location: `${other.origin}/api/whoami` } };
      const r = await link(["whoami"], env());
      expect(r.code).toBe(1);
      expect(other.seen).toEqual([]);
    } finally {
      other.server.stop(true);
    }
  });

  test("sends the token to an approved loopback origin", async () => {
    const r = await link(["whoami"], env());
    expect(r.code).toBe(0);
    expect(g.seen.at(-1)?.auth).toBe("Bearer lead-token");
  });

  test("keeps an upstream error body out of the output and the state file", async () => {
    writeCursor(at(0).ts, 0);
    g.fail = { status: 500, body: "upstream detail SECRET-BODY" };
    const r = await link(["poll"], env());
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 500");
    expect(r.out + r.err + fs.readFileSync(cursorFile(), "utf8")).not.toContain("SECRET-BODY");
  });

  test("keeps credential-provider diagnostics out of the output and the state file", async () => {
    writeCursor(at(0).ts, 0);
    const r = await link(["poll"], env({ MBX_TOKEN_CMD: "echo TOKEN-DIAG; echo TOKEN-DIAG >&2; exit 3" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("token command failed");
    expect(r.out + r.err + fs.readFileSync(cursorFile(), "utf8")).not.toContain("TOKEN-DIAG");
  });
});

describe("send never reports an unconfirmed delivery as sent", () => {
  test("a gateway write failure is reported as unconfirmed with the id to resend under", async () => {
    g.fail = { status: 400, body: '{"error":"mailbox write failed"}' };
    const r = await link(["send", "book the table"], env());
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^MBX_UNCONFIRMED \S+ #[0-9a-f]{8} /m);
    expect(r.out).not.toContain("MBX_SENT");
  });

  test("an unreachable gateway is reported as unconfirmed", async () => {
    g.server.stop(true);
    const r = await link(["send", "book the table"], env());
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^MBX_UNCONFIRMED /m);
  });

  test("a resend keeps the original id so the receiver can skip it", async () => {
    const r = await link(["send", "--id", "0a1b2c3d", "book the table"], env());
    expect(r.code).toBe(0);
    expect(g.sent).toEqual(["#0a1b2c3d book the table"]);
    expect(r.out).toMatch(/^MBX_SENT \S+ #0a1b2c3d$/m);
  });
});

for (const [side, token, box] of [
  ["lead reading the outbox", "lead-token", "outbox-a"],
  ["agent reading the inbox", "agent-token", "inbox-a"],
]) {
  describe(`no silent loss or duplication, ${side}`, () => {
    test("a read that fills the 200-line limit is reported as a gap", async () => {
      g.boxes[box].push(at(0, "seen"));
      for (let i = 1; i <= 250; i++) g.boxes[box].push(at(i, `m${i}`));
      writeCursor(at(0).ts, 1);
      const r = await link(["poll"], env({ MBX_TOKEN: token }));
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^MBX_GAP /m);
      expect(msgLines(r.out).at(-1)).toEndWith(" m250");
      expect(readCursor().ts).toBe(at(250).ts);
    });

    test("an outage neither loses nor repeats lines", async () => {
      g.boxes[box].push(at(0, "seen"));
      writeCursor(at(0).ts, 1);
      g.fail = { status: 503, body: "" };
      expect((await link(["poll"], env({ MBX_TOKEN: token }))).code).toBe(1);
      expect(readCursor().ts).toBe(at(0).ts);
      g.boxes[box].push(at(0, "same second"), at(1, "one"), at(2, "two"));
      g.fail = null;
      const back = await link(["poll"], env({ MBX_TOKEN: token }));
      expect(back.out).toMatch(/^MBX_OK /m);
      expect(msgLines(back.out).map((l) => l.split(" ").slice(2).join(" "))).toEqual(["same second", "one", "two"]);
      expect(msgLines((await link(["poll"], env({ MBX_TOKEN: token }))).out)).toEqual([]);
    });

    test("a failed first read sets no cursor; the first good read sets it from the gateway", async () => {
      g.boxes[box].push(at(0, "old"), at(1, "older"));
      g.fail = { status: 503, body: "" };
      expect((await link(["poll"], env({ MBX_TOKEN: token }))).code).toBe(1);
      expect(readCursor()?.ts).toBeUndefined();
      g.fail = null;
      expect(msgLines((await link(["poll"], env({ MBX_TOKEN: token }))).out)).toEqual([]);
      g.boxes[box].push(at(2, "new"));
      expect(msgLines((await link(["poll"], env({ MBX_TOKEN: token }))).out)).toEqual([`MBX_MSG ${at(2).ts} new`]);
    });

    test("a line written in the cursor's second is printed exactly once", async () => {
      g.boxes[box].push(at(5, "first"));
      writeCursor(at(5).ts, 1);
      g.boxes[box].push(at(5, "same second"));
      const r = await link(["poll"], env({ MBX_TOKEN: token }));
      expect(msgLines(r.out)).toEqual([`MBX_MSG ${at(5).ts} same second`]);
      expect(msgLines((await link(["poll"], env({ MBX_TOKEN: token }))).out)).toEqual([]);
    });
  });
}
