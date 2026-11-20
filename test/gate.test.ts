import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeGate, review } from "../src/gate.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  type Runs = { workflow_runs?: unknown[]; total_count?: number } | { fail: string } | { body: string };
  function gh(w: World, checks: unknown[], runs: Runs = {}) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      if (argv[0] === "api") {
        if ("fail" in runs) return { code: 1, stdout: "", stderr: runs.fail };
        if ("body" in runs) return { code: 0, stdout: runs.body };
        const list = runs.workflow_runs ?? [];
        return {
          code: 0,
          stdout: JSON.stringify({ total_count: runs.total_count ?? list.length, workflow_runs: list }),
        };
      }
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [
      { name: "test", bucket: "fail" },
      { name: "lint", bucket: "pass" },
    ]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [
      { name: "test", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });

  async function clearAt(d: ReturnType<typeof setup>["d"], w: World) {
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await review(d, "o/r#7");
  }

  let nextId = 1;
  type Run = {
    id?: number;
    workflow_id?: number;
    name?: string | null;
    event?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
  };
  const run = (o: Run = {}) => ({
    id: nextId++,
    workflow_id: 10,
    name: "ci",
    event: "pull_request",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    ...o,
  });
  const green = [
    { name: "cla", bucket: "pass" },
    { name: "cubic", bucket: "skipping" },
  ];

  test("an unapproved pull_request run at the exact head refuses although gh pr checks is green", async () => {
    const { w, d } = setup();
    gh(w, green, {
      workflow_runs: [run({ conclusion: "action_required" }), run({ workflow_id: 11, event: "pull_request_target" })],
    });
    await clearAt(d, w);
    const at = head.slice(0, 12);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow(
      `MERGE_REFUSED pull_request workflow run(s) not green at head ${at}: ci=action_required`,
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("ci=action_required");
    const api = w.calls.filter((c) => c.cmd === "gh" && c.argv[0] === "api");
    expect(api.map((c) => c.argv[1])).toEqual([
      `repos/o/r/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
      `repos/o/r/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
    ]);
    expect(w.calls.some((c) => c.argv[1] === "merge")).toBe(false);
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["workflow_pending"]);
  });

  test("queued, running, waiting and completed red runs at the head refuse", async () => {
    for (const state of [
      { status: "queued", conclusion: null },
      { status: "in_progress", conclusion: null },
      { status: "waiting", conclusion: null },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "timed_out" },
      { status: "completed", conclusion: "startup_failure" },
    ]) {
      const { w, d } = setup();
      gh(w, green, { workflow_runs: [run(state)] });
      await clearAt(d, w);
      await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(`ci=${state.conclusion ?? state.status}`);
    }
    const queued = setup();
    gh(queued.w, green, { workflow_runs: [run({ id: 30 }), run({ id: 31, status: "queued", conclusion: null })] });
    await clearAt(queued.d, queued.w);
    await expect(mergeGate(queued.d, "o/r#7", { dryRun: true })).rejects.toThrow("ci=queued");
  });

  test("green runs plus other-head, other-event and superseded runs let the merge through", async () => {
    const { w, d } = setup();
    gh(w, green, {
      workflow_runs: [
        run({ id: 20, conclusion: "cancelled" }),
        run({ id: 21, conclusion: "success" }),
        run({ id: 22, workflow_id: 12, conclusion: "stale" }),
        run({ id: 23, workflow_id: 12, name: null }),
        run({ id: 24, head_sha: "b".repeat(40), conclusion: "action_required" }),
        run({ id: 25, event: "push", status: "queued", conclusion: null }),
        run({ id: 26, workflow_id: 13, event: "pull_request_target", status: "queued", conclusion: null }),
        run({ id: 27, workflow_id: 14, conclusion: "neutral" }),
      ],
    });
    await clearAt(d, w);
    expect(await mergeGate(d, "o/r#7", { dryRun: true })).toBe(`MERGE_OK o/r#7 head=${head} (dry run)`);
    expect(w.usage.filter((e) => e.name === "dori.merge_decided")).toEqual([]);
  });

  test("workflow status that cannot be read fails closed", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pass" }], { fail: "HTTP 403: Resource not accessible by integration" });
    await clearAt(d, w);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow(
      `MERGE_REFUSED workflow runs at ${head.slice(0, 12)} could not be read: HTTP 403`,
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(
      "Actions status unavailable (permission denied or Actions disabled)",
    );
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow(
      "stays refused until the status can be verified",
    );
    gh(w, green, { total_count: 2, workflow_runs: [run({ status: "queued", conclusion: null })] });
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("only 1 of 2 runs returned");
    for (const runs of [
      { body: "warning: this is not json" },
      { total_count: 1, workflow_runs: [{}] },
      {
        total_count: 1,
        workflow_runs: [{ id: 1, workflow_id: 10, event: "pull_request", head_sha: head, status: "completed" }],
      },
      { body: JSON.stringify({ workflow_runs: [run()] }) },
    ]) {
      gh(w, green, runs);
      await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("could not be read");
    }
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["workflow_status_unknown"]);
    gh(w, green, {
      total_count: 1,
      workflow_runs: [{ id: 1, workflow_id: 10, event: "pull_request", head_sha: head, status: "completed" }],
    });
    await expect(mergeGate(d, "o/r#7", { dryRun: true })).rejects.toThrow("has an invalid conclusion");
  });
});
