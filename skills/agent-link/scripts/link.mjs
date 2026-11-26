#!/usr/bin/env bun
// Lead-side client for one agent-link mailbox pair (Bun or Node >= 22, no dependencies).
//
//   link.mjs health            GET /healthz (no token)
//   link.mjs whoami            GET /api/whoami
//   link.mjs send [--id ID] <text...>
//                              POST /api/send; every line starts "#ID ", text over the limit is
//                              split into "#ID [n/m] ..." lines. Resend only with the same --id.
//   link.mjs poll              print each new outbox line once, advance the cursor
//   link.mjs watch [sec]       poll forever (default 30 s); for a standing monitor
//
// Output lines: "<TAG>_MSG <ts> <text>", "<TAG>_ERR <ts> <error>" (once per distinct error),
// "<TAG>_OK <ts> gateway reachable again", "<TAG>_GAP <ts> ..." (a read hit the gateway's
// 200-line limit, so older lines may be missing), "<TAG>_SENT <ts> #ID" and
// "<TAG>_UNCONFIRMED <ts> #ID ..." (exit 2: the line may or may not have arrived; confirm with
// the receiver before resending). Watch with a filter like ^MBX_.
//
// Environment:
//   MBX_URL or MBX_URL_FILE   gateway origin, e.g. https://mailbox.example.com (file: first line)
//   MBX_APPROVED_ORIGINS      comma-separated origins the token may be sent to; MBX_URL must be one
//                             of them and use https (plain http only for a loopback host)
//   MBX_TOKEN_CMD             command that prints the lead's mirror token (preferred), e.g.
//                             security find-generic-password -s agent-link-NAME -a lead -w
//   MBX_TOKEN                 the token itself, when no secret store is available
//   MBX_NAME                  agent name, used for the cursor file (default "agent")
//   MBX_STATE_DIR             where the cursor lives (default ~/.agent-link)
//   MBX_TAG                   output prefix (default MBX)
// The token is read inside this process and never printed or passed on a command line. Errors
// are reduced to fixed text, so response bodies and token-command output never reach a log.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_TEXT = 4000;
const READ_LIMIT = 200;
const env = process.env;
const tag = env.MBX_TAG || "MBX";
const name = env.MBX_NAME || "agent";
const stateDir = env.MBX_STATE_DIR || path.join(os.homedir(), ".agent-link");
const cursorFile = path.join(stateDir, `${name}.cursor.json`);
const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

// Errors this file raises carry fixed text and are safe to print and persist; anything else is not.
class LinkError extends Error {}
const safe = (e) => (e instanceof LinkError ? e.message : e?.name === "TimeoutError" ? "timeout" : "network error");

// The approved origin the token may go to. Checked before the token is read.
function origin() {
  const raw = (
    env.MBX_URL || (env.MBX_URL_FILE ? fs.readFileSync(env.MBX_URL_FILE, "utf8").split("\n")[0] : "")
  ).trim();
  if (!raw) throw new LinkError("set MBX_URL or MBX_URL_FILE");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new LinkError("MBX_URL is not a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new LinkError("MBX_URL must use https");
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    throw new LinkError("MBX_URL must be an origin only");
  const approved = (env.MBX_APPROVED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, ""));
  if (!approved.includes(u.origin)) throw new LinkError("MBX_URL is not an approved origin (MBX_APPROVED_ORIGINS)");
  return u.origin;
}

function token() {
  let t;
  if (env.MBX_TOKEN_CMD) {
    try {
      t = execFileSync("/bin/sh", ["-c", env.MBX_TOKEN_CMD], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new LinkError("token command failed");
    }
  } else t = env.MBX_TOKEN;
  if (!t?.trim()) throw new LinkError("set MBX_TOKEN_CMD or MBX_TOKEN");
  return t.trim();
}

async function api(p, init = {}, auth = true) {
  const url = origin() + p;
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${token()}`;
  const res = await fetch(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  if (!res.ok) throw new LinkError(`HTTP ${res.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new LinkError("gateway answered with something that is not JSON");
  }
}

// Splits text into lines of at most MAX_TEXT chars, each starting with head (the "#ID " of the
// message) and numbered "[n/m] " when more than one.
export function split(text, head = "") {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if (head.length + flat.length <= MAX_TEXT) return [head + flat];
  const room = MAX_TEXT - head.length - 12;
  const parts = [];
  for (let i = 0; i < flat.length; i += room) parts.push(flat.slice(i, i + room));
  return parts.map((p, i) => `${head}[${i + 1}/${parts.length}] ${p}`);
}

function loadCursor() {
  return fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile, "utf8")) : null;
}

function saveCursor(c) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(`${cursorFile}.tmp`, JSON.stringify(c));
  fs.renameSync(`${cursorFile}.tmp`, cursorFile);
}

// Picks the lines after the cursor. The gateway's since= is strictly newer and ts has 1 s
// resolution, so the caller asks from one second before cursor.ts and this skips the cursor.n
// lines already printed at cursor.ts. Returns the new lines and the advanced cursor.
export function advance(cursor, msgs) {
  let { ts, n } = cursor;
  let skip = n;
  const fresh = [];
  for (const m of msgs) {
    if (m.ts < ts) continue;
    if (m.ts === ts && skip > 0) {
      skip--;
      continue;
    }
    fresh.push(m);
    if (m.ts === ts) n++;
    else {
      // A newer second: the skip budget belonged to the old cursor second only.
      ts = m.ts;
      n = 1;
      skip = 0;
    }
  }
  return { fresh, cursor: { ts, n } };
}

async function poll() {
  const cur = loadCursor();
  const since = cur?.ts ? isoSeconds(new Date(Date.parse(cur.ts) - 1000)) : "";
  let msgs;
  try {
    ({ messages: msgs } = await api(
      `/api/messages?limit=${READ_LIMIT}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
    ));
  } catch (e) {
    const err = safe(e);
    if (cur?.err !== err) console.log(`${tag}_ERR ${isoSeconds(new Date())} ${err}`);
    // Without a successful read there is no evidence of where the outbox ends: keep no position.
    saveCursor({ ...cur, err });
    return false;
  }
  if (!cur?.ts) {
    // The first successful read starts at the gateway's newest line and prints nothing; an empty
    // box starts at the epoch, so its first line is printed.
    const last = msgs.at(-1);
    if (cur?.err) console.log(`${tag}_OK ${isoSeconds(new Date())} gateway reachable again`);
    saveCursor(
      last ? { ts: last.ts, n: msgs.filter((m) => m.ts === last.ts).length } : { ts: isoSeconds(new Date(0)), n: 0 },
    );
    return true;
  }
  if (cur.err) console.log(`${tag}_OK ${isoSeconds(new Date())} gateway reachable again`);
  const { fresh, cursor } = advance(cur, msgs);
  // The gateway returns only the newest READ_LIMIT matches, so a full read may have dropped older ones.
  const gap = msgs.length >= READ_LIMIT;
  if (gap) {
    console.log(
      `${tag}_GAP ${isoSeconds(new Date())} read hit the ${READ_LIMIT}-line limit; lines after ${since} and before ${msgs[0].ts} may be missing: read them from the box log on the gateway host`,
    );
  }
  for (const m of fresh) console.log(`${tag}_MSG ${m.ts} ${m.text.replace(/\p{Cc}/gu, " ")}`);
  saveCursor(cursor);
  return !gap;
}

// Sends one message under one id. Any failure leaves the outcome unknown (the gateway may have
// written the line before it failed), so it is reported as unconfirmed, never retried here.
async function send(rest) {
  let id = crypto.randomBytes(4).toString("hex");
  if (rest[0] === "--id") {
    id = rest[1] ?? "";
    rest = rest.slice(2);
  }
  if (!/^[\w-]{1,32}$/.test(id)) throw new LinkError("--id takes letters, digits, - or _");
  const text = rest.join(" ").trim();
  if (!text) throw new LinkError("usage: link.mjs send [--id ID] <text>");
  const lines = split(text, `#${id} `);
  for (const [i, line] of lines.entries()) {
    try {
      await api("/api/send", { method: "POST", body: JSON.stringify({ text: line }) });
    } catch (e) {
      console.log(
        `${tag}_UNCONFIRMED ${isoSeconds(new Date())} #${id} line ${i + 1}/${lines.length}: ${safe(e)}; ask the receiver whether #${id} arrived before resending with --id ${id}`,
      );
      process.exitCode = 2;
      return;
    }
  }
  console.log(`${tag}_SENT ${isoSeconds(new Date())} #${id}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "health") return console.log(JSON.stringify(await api("/healthz", {}, false)));
  if (cmd === "whoami") return console.log(JSON.stringify(await api("/api/whoami")));
  if (cmd === "send") return send(rest);
  if (cmd === "poll") {
    if (!(await poll())) process.exitCode = 1;
    return;
  }
  if (cmd === "watch") {
    const sec = Number(rest[0] || 30);
    for (;;) {
      await poll();
      await new Promise((r) => setTimeout(r, sec * 1000));
    }
  }
  throw new LinkError("usage: link.mjs health | whoami | send [--id ID] <text> | poll | watch [sec]");
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`link: ${safe(e)}`);
    process.exit(1);
  });
}
