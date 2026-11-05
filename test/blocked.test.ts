import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedMessage, blockedPath, blockedStateAt, BLOCKED_REPEAT_MS, commitBlockedAlerts, forgetBlocked, formatBlocked, parsePanePrompt,
  planBlockedAlerts, type PanePrompt,
} from "../src/blocked.ts";
import { blockedTick, dutyTick, notifyBlocked } from "../src/harness.ts";
import type { AgentStatus } from "../src/herdr.ts";
import { World } from "./fake.ts";

// The dialog exactly as omo 5.1.60 rendered in a herdr pane on 2026-11-05, before this change was split (issue #113).
const BLOCKED_SCREEN = ` Running PreToolUse hook: matching project rules (1m 57s)

───────────────────────────────────────────────────────────────────────────────────────────────────────────────

 Permission required: eval

 Tool: eval

 Patterns:
   - *

 → Allow once
   Allow always
   Deny
   Deny with feedback

 ↑↓ navigate  enter select  esc/ctrl+c cancel

───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/private/tmp/blocked-alert-probe • CH10.5% • 27K/1M (2.7%) (auto)                     (hive) deepseek-ai/deepseek-v4.1-flash-1017
(😺 OmO Native by Q Kim) fallback: hive/deepseek-ai/deepseek-v4.1-flash-1017 waiting_human · question
`;

const SELECTED_SECOND = BLOCKED_SCREEN.replace(" → Allow once\n   Allow always", "   Allow once\n → Allow always");

const tempDirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-blocked-"));
  tempDirs.push(dir);
  return join(dir, "duty", "blocked.json");
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parsePanePrompt", () => {
  test("reads the measured dialog: heading, four options, and the marked row", () => {
    expect(parsePanePrompt(BLOCKED_SCREEN)).toEqual<PanePrompt>({
      title: "Permission required: eval",
      options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
      selected: 0,
    });
  });

  test("follows the arrow rather than assuming the first row", () => {
    expect(parsePanePrompt(SELECTED_SECOND)?.selected).toBe(1);
  });

  test("the option set is read as shown, so a conditional wider label is just another row", () => {
    const wider = BLOCKED_SCREEN.replace("   Allow always\n", "   Allow always\n   Allow for this workspace\n");
    expect(parsePanePrompt(wider)?.options).toEqual(["Allow once", "Allow always", "Allow for this workspace", "Deny", "Deny with feedback"]);
  });

  test("an idle omo screen with an unrelated hint line is not a dialog", () => {
    const idle = `──────────────────────────────\n❯\n──────────────────────────────\n/home • CH10% • 27K/1M\n`;
    expect(parsePanePrompt(idle)).toBeNull();
  });

  test("a hint line with no arrow above it is not a dialog", () => {
    expect(parsePanePrompt(" something happened\n more text\n ↑↓ navigate  enter select  esc to cancel\n")).toBeNull();
  });

  test("two arrows is a layout this does not understand, so it refuses", () => {
    expect(parsePanePrompt(BLOCKED_SCREEN.replace("   Deny\n", " → Deny\n"))).toBeNull();
  });

  test("an answer list cut off by prose is not parsed", () => {
    expect(parsePanePrompt(" → a\n   " + "x".repeat(80) + "\n ↑↓ navigate  enter select\n")).toBeNull();
  });
});

describe("planBlockedAlerts", () => {
  const entry = { pane: "w1:p9", key: "fix-x", prompt: parsePanePrompt(BLOCKED_SCREEN) };
  const other = { pane: "w1:p8", key: "fix-y", prompt: { title: "Permission required: bash", options: ["Allow", "Deny"], selected: 0 } };
  const record = (path: string, blocked: readonly { pane: string; key?: string; prompt: PanePrompt | null }[], now: number): readonly typeof blocked[number][] => {
    const plan = planBlockedAlerts(path, blocked, now);
    commitBlockedAlerts(path, plan, new Set(blocked.map((e) => e.pane)));
    return plan.fresh;
  };

  test("a question is reported once and remembered across calls", () => {
    const path = tempFile();
    expect(record(path, [entry], 1_000)).toEqual([entry]);
    expect(record(path, [entry], 2_000)).toEqual([]);
  });

  test("a new question in the same pane is reported again", () => {
    const path = tempFile();
    record(path, [entry], 1_000);
    expect(record(path, [other], 2_000)).toEqual([other]);
  });

  test("an unanswered question is reported again after the repeat window", () => {
    const path = tempFile();
    record(path, [entry], 1_000);
    expect(record(path, [entry], 1_000 + BLOCKED_REPEAT_MS - 1)).toEqual([]);
    expect(record(path, [entry], 1_000 + BLOCKED_REPEAT_MS)).toEqual([entry]);
  });

  test("a pane that stopped being blocked is forgotten, so its next block is new", () => {
    const path = tempFile();
    record(path, [entry], 1_000);
    expect(record(path, [], 2_000)).toEqual([]);
    expect(record(path, [entry], 3_000)).toEqual([entry]);
    expect(blockedStateAt(path, "w1:p9")).toBe(3_000);
  });

  test("a report that reached nobody is not recorded, so the next sweep sends it again", () => {
    const path = tempFile();
    const plan = planBlockedAlerts(path, [entry], 1_000);
    expect(plan.fresh).toEqual([entry]);
    commitBlockedAlerts(path, plan, new Set());
    expect(blockedStateAt(path, "w1:p9")).toBeUndefined();
    expect(planBlockedAlerts(path, [entry], 2_000).fresh).toEqual([entry]);
  });

  test("a failure on one pane never un-records another one already sent", () => {
    const path = tempFile();
    const plan = planBlockedAlerts(path, [entry, other], 1_000);
    commitBlockedAlerts(path, plan, new Set(["w1:p8"]));
    expect(blockedStateAt(path, "w1:p8")).toBe(1_000);
    expect(blockedStateAt(path, "w1:p9")).toBeUndefined();
    expect(planBlockedAlerts(path, [entry, other], 2_000).fresh).toEqual([entry]);
  });

  test("forgetting one pane keeps the others", () => {
    const path = tempFile();
    record(path, [entry, other], 1_000);
    forgetBlocked(path, "w1:p9");
    expect(blockedStateAt(path, "w1:p9")).toBeUndefined();
    expect(blockedStateAt(path, "w1:p8")).toBe(1_000);
    expect(record(path, [entry, other], 2_000)).toEqual([entry]);
  });

  test("a corrupt state file is treated as empty instead of crashing the sweep", () => {
    const path = tempFile();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{");
    expect(record(path, [entry], 1_000)).toEqual([entry]);
    writeFileSync(path, JSON.stringify({ "w1:p9": { fingerprint: 7 } }));
    expect(record(path, [entry], 2_000)).toEqual([entry]);
  });
});

describe("blockedMessage", () => {
  test("names the lane, its pane, the question and the options, and sends the answer to a person", () => {
    const message = blockedMessage({ pane: "w1:p9", key: "fix-x", prompt: parsePanePrompt(BLOCKED_SCREEN) });
    expect(message).toStartWith("[BLOCKED fix-x] w1:p9 is waiting for input: Permission required: eval.");
    expect(message).toContain("Allow once | Allow always | Deny | Deny with feedback");
    expect(message).toContain("Answer it in that pane");
    expect(message).not.toContain("dori approve");
  });

  test("a pane with no lane and no readable dialog still points at the pane", () => {
    const message = blockedMessage({ pane: "w1:p9", prompt: null });
    expect(message).toContain("[BLOCKED w1:p9]");
    expect(message).toContain("look at the pane");
  });

  test("the row names the pane, the lane and when it was first seen", () => {
    expect(formatBlocked({ pane: "w1:p9", key: "fix-x", prompt: null }, 0)).toBe("w1:p9    fix-x                    blocked (no readable dialog)  first seen 00:00:00Z");
  });
});

describe("notifyBlocked", () => {
  const entry = { pane: "w1:p9", key: "fix-x", prompt: null };
  const recorder = (dir: string): string => {
    const path = join(dir, "hook.sh");
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\n`, { mode: 0o755 });
    return path;
  };

  test("an argv template gets the placeholders filled with data, never through a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-notify-"));
    tempDirs.push(dir);
    const hook = recorder(dir);
    const accepted = await notifyBlocked([entry], `${hook} --text {text} --key {key} {pane}`);
    expect(accepted.has("w1:p9")).toBe(true);
    const args = (await Bun.file(join(dir, "args.txt")).text()).trim().split("\n");
    expect(args.slice(0, 2)).toEqual(["--text", blockedMessage(entry)]);
    expect(args.slice(2)).toEqual(["--key", "fix-x", "w1:p9"]);
  });

  test("no hook means nothing was asked to send, so every pane counts as accepted", async () => {
    expect((await notifyBlocked([entry], "")).has("w1:p9")).toBe(true);
  });

  test("a hook that exits non-zero is a failure, not an acceptance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-notify-"));
    tempDirs.push(dir);
    const hook = join(dir, "fail.sh");
    writeFileSync(hook, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    expect((await notifyBlocked([entry], hook)).size).toBe(0);
  });

  test("a hook that cannot start is a failure, never a crash", async () => {
    expect((await notifyBlocked([entry], "/nonexistent/hook")).size).toBe(0);
  });
});

describe("blockedTick", () => {
  test("a lane pane that turns blocked is reported to the lead exactly once", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "idle");
    d.store.setRole("lead", "w1:p1");
    const brief = join(d.store.root, "brief.md");
    writeFileSync(brief, "x");
    d.store.saveLane({
      key: "fix-x", paneId: "w1:p9", tabId: "w1:t9", brief, cwd: "/w", status: "working",
      createdAt: 1, lastActivityAt: 1, nudges: 0, log: [],
    });
    w.addPane("w1:p9", "blocked").screen = BLOCKED_SCREEN;
    lead.received.length = 0;

    const first = await blockedTick(d);
    expect(first).toContainEqual({ pane: "w1:p9", lane: "fix-x", action: "blocked", detail: "Permission required: eval" });
    expect(lead.received.at(-1)).toContain("[BLOCKED fix-x] w1:p9 is waiting for input");
    expect(lead.received.at(-1)).toContain("Allow once | Allow always | Deny | Deny with feedback");

    const second = await blockedTick(d);
    expect(second).toEqual([]);
    expect(lead.received.length).toBe(1);
    expect(d.store.lane("fix-x")!.status).toBe("working");
  });

  test("reporting a blocked pane never sends keys to it", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p1", "idle");
    d.store.setRole("lead", "w1:p1");
    const blocked = w.addPane("w1:p9", "blocked");
    blocked.screen = BLOCKED_SCREEN;
    await blockedTick(d);
    expect(blocked.pressed).toEqual([]);
    expect(w.calls.filter((c) => c.argv[2] === "send-keys")).toEqual([]);
  });

  test("the lead's own blocked pane is never queued to itself", async () => {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "blocked");
    lead.screen = BLOCKED_SCREEN;
    d.store.setRole("lead", "w1:p1");
    const events = await blockedTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "blocked-lead", detail: "Permission required: eval" });
    expect(lead.received).toEqual([]);
  });

  test("a stopped duty loop reports nothing", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p9", "blocked").screen = BLOCKED_SCREEN;
    d.store.setStop(1, "maintenance", "duty");
    const events = await dutyTick(d);
    expect(events).toContainEqual({ action: "stopped", detail: "maintenance" });
    expect(events.some((e) => e.action === "blocked")).toBe(false);
  });
});
