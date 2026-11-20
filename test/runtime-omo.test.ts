import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { parseLaunch, shellWords } from "../src/runtime/omo/command.ts";
import { OmoGapError, OmoRuntime } from "../src/runtime/omo/index.ts";
import { formatRef, openSession, parseRef, type SessionRef } from "../src/runtime/types.ts";

type Call = readonly string[];
/** A recorded `omo`: each call is answered by the first handler whose verb matches, as JSON on stdout. */
const fakeOmo = (answers: Record<string, unknown | ((argv: Call) => unknown)>, code = 0) => {
  const calls: { cmd: string; argv: Call }[] = [];
  const exec: Exec = async (cmd, argv): Promise<ExecResult> => {
    calls.push({ cmd, argv });
    const answer = answers[argv[1] ?? ""];
    const value = typeof answer === "function" ? answer(argv) : answer;
    return { code, stdout: JSON.stringify(value ?? { kind: "ok" }), stderr: "" };
  };
  return { exec, calls, argvs: () => calls.map((c) => c.argv) };
};

const ROWS = {
  rows: [
    { device: "dev1", session_id: "s1", title: "lane-a", state: "idle", project: "/w" },
    { device: "dev2", session_id: "s2", title: "lane-b", state: "running", project: "/x" },
    { device: "dev2", session_id: "s3", title: "old", state: "ended", project: "/x" },
  ],
  devices: {},
  incomplete: [],
};
const S1: SessionRef = { runtime: "omo", id: "dev1/s1" };
const S2: SessionRef = { runtime: "omo", id: "dev2/s2" };
const lane = { name: "k", role: "lane", container: "tab", cwd: "/w", env: {}, group: "g" } as const;

describe("refs", () => {
  test("omo:<device>/<session> parses and formats; a bare session id is not an omo ref", () => {
    expect(parseRef("omo:dev1/s-1")).toEqual({ runtime: "omo", id: "dev1/s-1" });
    expect(formatRef({ runtime: "omo", id: "dev1/s-1" })).toBe("omo:dev1/s-1");
    expect(parseRef("omo:s1")).toBeUndefined();
    expect(parseRef("dev1/s1")).toBeUndefined();
  });
});

describe("create / start", () => {
  test("create opens a session on DORI_OMO_DEVICE in the spec's cwd, every call through omo remote --json", async () => {
    const fake = fakeOmo({ open: { kind: "ok", thread: { device: "dev2", thread_id: "t9" } } });
    const rt = new OmoRuntime(fake.exec, { env: { DORI_OMO_DEVICE: "dev2" } });
    expect(await rt.create(lane)).toEqual({ runtime: "omo", id: "dev2/t9", group: "g" });
    expect(fake.calls).toEqual([{ cmd: "omo", argv: ["remote", "open", "dev2", "--project", "/w", "--json"] }]);
  });

  test("without DORI_OMO_DEVICE the session opens on the device omo marks as this one; DORI_OMO_BIN names the binary", async () => {
    const fake = fakeOmo({
      devices: [
        { device: "peer", this_device: false },
        { device: "me", this_device: true },
      ],
      open: { kind: "ok", thread: { thread_id: "t1" } },
    });
    const rt = new OmoRuntime(fake.exec, { env: { DORI_OMO_BIN: "/opt/omob" } });
    expect((await rt.create(lane)).id).toBe("me/t1");
    expect(fake.calls.map((c) => c.cmd)).toEqual(["/opt/omob", "/opt/omob"]);
    expect(fake.argvs()[1]).toEqual(["remote", "open", "me", "--project", "/w", "--json"]);
  });

  test("env the session cannot carry is named in one log line, never dropped silently", async () => {
    const lines: string[] = [];
    const fake = fakeOmo({ open: { kind: "ok", thread: { device: "d", thread_id: "t" } } });
    const rt = new OmoRuntime(fake.exec, { env: { DORI_OMO_DEVICE: "d" }, log: (l) => lines.push(l) });
    await rt.create({ ...lane, env: { DORI_LANE: "k", DORI_HOME: "/h" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DORI_LANE, DORI_HOME");
  });

  test("start applies the launch command: model switch, then system-prompt text, then the prompt", async () => {
    const fake = fakeOmo({});
    const rt = new OmoRuntime(fake.exec, { env: {} });
    await rt.start(S2, "omo --model 'p/m' --append-system-prompt 'be duty' 'it'\\''s the brief'");
    expect(fake.argvs()).toEqual([
      ["remote", "model", "dev2/s2", "p/m", "--json"],
      ["remote", "send", "dev2/s2", "be duty", "--no-wait", "--json"],
      ["remote", "send", "dev2/s2", "it's the brief", "--no-wait", "--json"],
    ]);
  });

  test("openSession closes the session when start is refused", async () => {
    const fake = fakeOmo({ open: { kind: "ok", thread: { device: "d", thread_id: "t" } } });
    const rt = new OmoRuntime(fake.exec, { env: { DORI_OMO_DEVICE: "d" } });
    await expect(openSession(rt, lane, "bash -lc x")).rejects.toThrow("only starts omo sessions");
    expect(fake.argvs().at(-1)).toEqual(["remote", "close", "d/t", "--json"]);
  });
});

describe("list / probe", () => {
  test("list maps omo's rows to sessions and leaves ended ones out", async () => {
    const rt = new OmoRuntime(fakeOmo({ sessions: ROWS }).exec, { env: {} });
    expect(await rt.list({ group: "g" })).toEqual([
      {
        ref: { runtime: "omo", id: "dev1/s1", group: "g" },
        name: "lane-a",
        title: "lane-a",
        cwd: "/w",
        status: "idle",
        agent: "omo",
      },
      {
        ref: { runtime: "omo", id: "dev2/s2", group: "g" },
        name: "lane-b",
        title: "lane-b",
        cwd: "/x",
        status: "working",
        agent: "omo",
      },
    ]);
  });

  test("probe reads the session's state; a session omo no longer lists is gone", async () => {
    const rt = new OmoRuntime(fakeOmo({ sessions: ROWS }).exec, { env: {} });
    expect(await rt.probe(S2)).toEqual({ status: "working", agent: "omo", shellInFront: false, cwd: "/x" });
    expect((await rt.probe({ runtime: "omo", id: "dev2/s3" })).status).toBe("gone");
  });
});

describe("deliver / keys / close", () => {
  test("idle delivery sends only to an idle session and reports a started turn", async () => {
    const fake = fakeOmo({ sessions: ROWS, send: { kind: "ok", delivery: { kind: "started", turn_id: "u" } } });
    const rt = new OmoRuntime(fake.exec, { env: {} });
    expect(await rt.deliver(S1, "hi")).toEqual({ kind: "delivered", started: true });
    expect(fake.argvs().at(-1)).toEqual(["remote", "send", "dev1/s1", "hi", "--no-wait", "--json"]);
    expect(await rt.deliver(S2, "hi")).toEqual({ kind: "not-ready", status: "working" });
  });

  test("working delivery queues behind the running turn; a gone session has no agent", async () => {
    const fake = fakeOmo({ sessions: ROWS, send: { kind: "ok", delivery: { kind: "queued", queue_position: 1 } } });
    const rt = new OmoRuntime(fake.exec, { env: {} });
    expect(await rt.deliver(S2, "next", { when: "working" })).toEqual({ kind: "delivered", started: false });
    expect(fake.argvs().at(-1)).toEqual(["remote", "send", "dev2/s2", "next", "--no-wait", "--follow-up", "--json"]);
    expect(await rt.deliver({ runtime: "omo", id: "dev9/x" }, "x", { when: "any" })).toEqual({ kind: "no-agent" });
  });

  test("escape interrupts, enter sends nothing, close ends the session", async () => {
    const fake = fakeOmo({});
    const rt = new OmoRuntime(fake.exec, { env: {} });
    await rt.keys(S1, ["enter"]);
    await rt.keys(S1, ["escape"]);
    await rt.close(S1);
    expect(fake.argvs()).toEqual([
      ["remote", "interrupt", "dev1/s1", "--json"],
      ["remote", "close", "dev1/s1", "--json"],
    ]);
  });

  test("an omo error result throws with omo's own code and message", async () => {
    const fake = fakeOmo({ close: { kind: "error", error: { code: "not_found", message: "no such session" } } }, 1);
    await expect(new OmoRuntime(fake.exec, { env: {} }).close(S1)).rejects.toThrow("not_found: no such session");
  });

  test("operations omo does not expose are a typed gap, not a silent no-op", async () => {
    const rt = new OmoRuntime(fakeOmo({}).exec, { env: { DORI_OMO_SELF: "dev1/s1" } });
    await expect(rt.read(S1, 10)).rejects.toBeInstanceOf(OmoGapError);
    expect(await rt.typeIntoShell()).toBe(false);
    expect(rt.self()).toEqual(S1);
  });
});

describe("launch command parsing", () => {
  test("shell words: single quotes, double quotes, backslashes", () => {
    expect(shellWords(`omo 'a b' "c \\"d\\"" e\\ f`)).toEqual(["omo", "a b", 'c "d"', "e f"]);
  });

  test("a flag the remote session cannot take is refused rather than dropped", () => {
    expect(() => parseLaunch("omo --session /x")).toThrow("--session");
    expect(parseLaunch("/usr/local/bin/omo 'go'")).toEqual({ prompt: "go" });
  });
});
