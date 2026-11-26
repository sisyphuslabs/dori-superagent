import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GUARD = path.join(import.meta.dir, "box-guard.sh");

let dir;
let boxes;

// A stand-in mailbox program: it only has to be a live process named like the real box.
function startBox(name) {
  const p = Bun.spawn(["bash", path.join(dir, "mailbox", "box.sh"), name], { stdin: "pipe" });
  boxes.push(p);
}

// A stand-in terminal host. "records" appends the line the way a mailbox box logs it;
// "drops" accepts the text and records nothing, as a plain shell in the box's place would.
function fakeHost(mode) {
  const file = path.join(dir, `hc-${mode}`);
  const record = mode === "records" ? `printf '%s %s\\n' 2026-01-01T00:00:00Z "$3" >> "$MAILBOX_DIR/$2.log"` : ":";
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = send ] || exit 9\ntouch "$MAILBOX_DIR/host-called"\n${record}\n`, {
    mode: 0o755,
  });
  return file;
}

async function guard(host, box, text) {
  const p = Bun.spawn(["bash", GUARD, "send", box, text], {
    env: { PATH: process.env.PATH, MAILBOX_DIR: path.join(dir, "mailbox"), BOX_GUARD_HC: host, BOX_GUARD_TRIES: "2" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exited;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-guard-"));
  fs.mkdirSync(path.join(dir, "mailbox"));
  fs.writeFileSync(path.join(dir, "mailbox", "box.sh"), "while read -r line; do :; done\n");
  boxes = [];
});
afterEach(async () => {
  for (const p of boxes) p.kill();
  await Promise.all(boxes.map((p) => p.exited));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to deliver when the target box is not running the mailbox program", async () => {
  startBox("outbox-a");
  expect(await guard(fakeHost("records"), "inbox-a", "ping 1")).not.toBe(0);
  expect(fs.existsSync(path.join(dir, "mailbox", "host-called"))).toBe(false);
});

test("succeeds only once the line is in the box log", async () => {
  startBox("inbox-a");
  expect(await guard(fakeHost("records"), "inbox-a", "ping 2")).toBe(0);
});

test("fails when the text was accepted but never recorded", async () => {
  startBox("inbox-a");
  expect(await guard(fakeHost("drops"), "inbox-a", "ping 3")).not.toBe(0);
  expect(fs.existsSync(path.join(dir, "mailbox", "host-called"))).toBe(true);
});
