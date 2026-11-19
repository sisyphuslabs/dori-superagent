import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { done, ready, report, startLane } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import type { Lane } from "../src/store-types.ts";
import { href, type World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const REPLY = ["bun", "reply", "{thread}", "--text", "{text}"];
const DONE_POST = ["bun", "done-post", "{thread}", "--text", "{text}"];
const THREAD = "slack:C1/1234.5678";

const config = (d: Deps, hooks: Record<string, readonly string[]>) =>
  writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ hooks }));

const posts = (w: World) => w.calls.filter((c) => c.cmd === "bun").map((c) => c.argv);
const threadLog = (d: Deps, key: string) => (d.store.lane(key)?.log ?? []).filter((e) => e.kind === "thread");

describe("a lane with a thread posts into it", () => {
  test("READY posts the lead's exact message, addressed to the lane's thread", async () => {
    const { w, d, brief } = setup();
    config(d, { threadReply: REPLY });
    const lane = await startLane(d, "threaded", brief, { group: "w1", thread: THREAD });
    expect(w.panes.get(lane.paneId)!.ran[0]).toContain(`Report milestones into thread ${THREAD}`);

    await ready(d, "threaded", "fix landed", ["https://github.com/o/r/pull/1"]);
    expect(posts(w)).toEqual([
      ["reply", THREAD, "--text", "[READY threaded] fix landed\nevidence: https://github.com/o/r/pull/1"],
    ]);
    expect(threadLog(d, "threaded").map((e) => e.text)).toEqual([`thread post sent to ${THREAD}`]);
  });

  test("report, ready and done each post their own text into the same thread", async () => {
    const { w, d, brief } = setup();
    config(d, { threadReply: REPLY, threadDone: DONE_POST });
    await startLane(d, "threaded", brief, { group: "w1", thread: THREAD });

    await report(d, "threaded", "half way");
    await ready(d, "threaded", "done", ["https://example.test/1"]);
    await done(d, "threaded");
    expect(posts(w)).toEqual([
      ["reply", THREAD, "--text", "[REPORT threaded] half way"],
      ["reply", THREAD, "--text", "[READY threaded] done\nevidence: https://example.test/1"],
      ["done-post", THREAD, "--text", "done"],
    ]);
  });

  test("a closed lane uses threadDone, never threadReply, when only threadDone is configured", async () => {
    const { w, d, brief } = setup();
    config(d, { threadDone: DONE_POST });
    await startLane(d, "threaded", brief, { group: "w1", thread: THREAD });
    await report(d, "threaded", "half way");
    await ready(d, "threaded", "done", ["https://example.test/1"]);
    expect(posts(w)).toEqual([]);
    expect(threadLog(d, "threaded").map((e) => e.text)).toEqual([
      `thread post skipped: no threadReply hook configured for ${THREAD}`,
      `thread post skipped: no threadReply hook configured for ${THREAD}`,
    ]);

    await done(d, "threaded");
    expect(posts(w)).toEqual([["done-post", THREAD, "--text", "done"]]);
  });

  test("a failing post is recorded and told to the lead; the lane keeps its state", async () => {
    const { w, d, lead, brief } = setup();
    config(d, { threadReply: REPLY });
    w.reviewer = () => ({ code: 1, stdout: "", stderr: "channel_not_found" });
    await startLane(d, "threaded", brief, { group: "w1", thread: THREAD });

    await ready(d, "threaded", "fix landed", ["https://example.test/1"]);
    expect(d.store.lane("threaded")!.status).toBe("ready");
    expect(threadLog(d, "threaded")[0]!.text).toBe(`thread post to ${THREAD} failed (exit 1): channel_not_found`);
    expect(lead.received.at(-1)).toBe(
      "[THREAD threaded] the thread post failed (exit 1); lane is still ready and the text reached the lead anyway: [READY threaded] fix landed\nevidence: https://example.test/1",
    );
  });
});

describe("a lane without a thread", () => {
  test("posts nothing, logs a skip, and never writes a thread into the record", async () => {
    const { w, d, lead, brief } = setup();
    config(d, { threadReply: REPLY, threadDone: DONE_POST });
    await startLane(d, "plain", brief, { group: "w1" });
    await report(d, "plain", "half way");
    await ready(d, "plain", "done", ["https://example.test/1"]);

    expect(posts(w)).toEqual([]);
    expect(w.panes.get(d.store.lane("plain")!.paneId)!.ran[0]).not.toContain("thread");
    expect(threadLog(d, "plain").map((e) => e.text)).toEqual([
      "thread post skipped: this lane has no thread to post to",
      "thread post skipped: this lane has no thread to post to",
    ]);
    expect(JSON.stringify(d.store.lane("plain"))).not.toContain("undefined");
    expect(d.store.lane("plain")!.thread).toBeUndefined();
    expect(lead.received.at(-1)).toBe("[READY plain] done\nevidence: https://example.test/1");
  });

  test("a lane record written before threads existed still closes without a post", async () => {
    const { w, d } = setup();
    config(d, { threadReply: REPLY, threadDone: DONE_POST });
    w.addPane("w1:p9", "shell");
    const old: Lane = {
      key: "legacy",
      sessionRef: href("w1:p9"),
      paneId: "w1:p9",
      tabId: "w1:t9",
      brief: join(d.store.root, "legacy.md"),
      cwd: d.store.root,
      status: "ready",
      createdAt: w.clock,
      lastActivityAt: w.clock,
      nudges: 0,
      final: { text: "closed long ago", evidence: ["https://example.test/1"], at: w.clock },
      log: [{ at: w.clock, kind: "ready", text: "done" }],
    };
    d.store.saveLane(old);

    await done(d, "legacy");
    expect(posts(w)).toEqual([]);
    expect(d.store.lane("legacy")!.status).toBe("done");
    expect(threadLog(d, "legacy").map((e) => e.text)).toEqual([
      "thread post skipped: this lane has no thread to post to",
    ]);
  });
});

describe("the --thread flag", () => {
  test("start refuses a ref that cannot address one thread, before it opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const thread of ["none", "C1/1.1", "mattermost:C1/1", "slack:C1/", "slack:C1/not-a-ts", ""]) {
      await expect(startLane(d, "bad", brief, { group: "w1", thread })).rejects.toThrow(Refusal);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.lane("bad")).toBeUndefined();
  });

  test("dori start --thread records the ref and tells the lane where to report", async () => {
    const { w, d, brief } = setup();
    expect(await main(["start", "threaded", "--brief", brief, "--thread", "slack:C7/9.9"], d)).toBe(0);
    const lane = d.store.lane("threaded")!;
    expect(lane.thread).toBe("slack:C7/9.9");
    expect(w.panes.get(lane.paneId)!.ran[0]).toContain("Report milestones into thread slack:C7/9.9");
  });
});
