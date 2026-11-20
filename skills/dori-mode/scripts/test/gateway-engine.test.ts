import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EngineLead, handToEngine } from "../src/messenger/engine.ts";
import { unixEngine } from "../src/messenger/engine-link.ts";
import type { InboundFrame } from "../src/messenger/gateway-frames.ts";
import { type EngineAnswer, firedDeadlines, startFakeEngine } from "./engine-fakes.ts";

type Engine = Awaited<ReturnType<typeof startFakeEngine>>;
const message = (seq: number, text: string): InboundFrame => ({
  op: "inbound",
  seq,
  session_id: "durable-main",
  id: `u_${seq}`,
  created_at: 1,
  kind: "message",
  text,
});
const opens =
  (durable = () => "durable-main") =>
  (command: Record<string, unknown>, connection: number): EngineAnswer => ({
    success: true,
    data: {
      sessionId: `handle-${connection}`,
      state: { sessionId: durable(), sessionFile: command["sessionPath"] },
    },
  });

const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
});
const start = async (...args: Parameters<typeof startFakeEngine>) => {
  const engine = await startFakeEngine(...args);
  engines.push(engine);
  return engine;
};
const mainSession = async (engine: Engine) => {
  const file = join(engine.dir, "dori-main.jsonl");
  await writeFile(file, "");
  return file;
};
const followUps = (engine: Engine) => engine.calls.filter((c) => c.command["type"] === "follow_up");

test("the lead opens the Dori's main session as a retained session in its own folder and announces it", async () => {
  // Given an engine and the main session's file.
  const engine = await start(opens());
  const file = await mainSession(engine);
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), { sessionFile: file });
  // When the lead is asked which session to announce.
  const announced = await lead.session();
  lead.close();
  // Then it opened that file, kept past this connection, without naming a folder of its own.
  const [open] = engine.calls.map((c) => c.command);
  expect(open).toMatchObject({ type: "open_session", sessionPath: file, retain_on_disconnect: true });
  expect(open).not.toHaveProperty("cwd");
  expect(announced).toEqual({ id: "durable-main", path: file });
});

test("a session file that does not exist is refused, unless the caller asked to create it", async () => {
  // Given an engine and a session file that is not there.
  const engine = await start(opens());
  const missing = join(engine.dir, "moved-away.jsonl");
  // When the lead opens it without leave to create, then nothing reaches the engine.
  const refusing = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), { sessionFile: missing });
  await expect(refusing.session()).rejects.toThrow("session file missing");
  expect(engine.calls).toEqual([]);
  // When the caller names the file and asks for it to be created, then it is opened in the named folder.
  const creating = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: missing,
    cwd: "/home/dori/dori",
    createIfMissing: true,
  });
  expect(await creating.session()).toEqual({ id: "durable-main", path: missing });
  expect(engine.calls[0]?.command).toMatchObject({ cwd: "/home/dori/dori" });
  creating.close();
});

test("a message goes as a follow-up that starts a turn when idle, keyed by the row id, with its whole text", async () => {
  // Given an engine that admits every input.
  const engine = await start((command, connection) =>
    command["type"] === "open_session"
      ? opens()(command, connection)
      : { success: true, data: { disposition: "started" } },
  );
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  const long = "x".repeat(500);
  // When a message reaches the lead.
  await lead.hand(message(7, long));
  lead.close();
  // Then the engine got one follow-up on the opened handle, keyed by the row id so a resend is the same input.
  const [input] = followUps(engine).map((c) => c.command);
  expect(input).toMatchObject({ sessionId: "handle-1", whenIdle: "start", clientMessageId: "u_7" });
  expect(String(input?.["message"])).toContain(long);
});

test("a refused input is not handed, and the refusal reaches the caller; an id the engine already took counts as handed", async () => {
  // Given an engine that refuses the first input and reports the second as an id it already admitted.
  let inputs = 0;
  const engine = await start((command, connection) => {
    if (command["type"] === "open_session") return opens()(command, connection);
    inputs++;
    return inputs === 1
      ? { success: false, error: "model not ready", errorCode: "model_not_ready" }
      : { success: false, error: "client_message_id_conflict: u_1", errorCode: "client_message_id_conflict" };
  });
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  const reported: string[] = [];
  const port = handToEngine(lead, (line) => reported.push(line));
  // When the CLI's port hands the same row twice.
  await expect(port("durable-main", message(1, "hello"))).rejects.toThrow("model_not_ready");
  await port("durable-main", message(1, "hello"));
  lead.close();
  // Then the refusal was reported by seq and code only, and the second try counted as handed.
  expect(reported).toEqual(["INBOUND_NOT_HANDED gateway 1 model_not_ready", "INBOUND_HANDED gateway 1"]);
});

test("an engine that never answers times out instead of holding the chat, and the input is not handed", async () => {
  // Given an engine that takes the follow-up and never answers it.
  const engine = await start((command, connection) =>
    command["type"] === "open_session" ? opens()(command, connection) : null,
  );
  const deadlines = firedDeadlines();
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir, deadlines.deadline), {
    sessionFile: await mainSession(engine),
  });
  await lead.session();
  // When the follow-up's deadline passes.
  const arrived = engine.received("follow_up");
  const handing = lead.hand(message(1, "anyone?"));
  await arrived;
  deadlines.fireLatest();
  // Then the hand-off fails with the timeout as its reason.
  await expect(handing).rejects.toThrow("engine_timeout");
  lead.close();
});

test("after an engine restart the lead reopens, and a different session behind the file is refused", async () => {
  // Given an engine whose session behind the file changes when it restarts.
  let durable = "durable-main";
  const engine = await start((command, connection) =>
    command["type"] === "open_session"
      ? opens(() => durable)(command, connection)
      : { success: true, data: { disposition: "queued" } },
  );
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  await lead.hand(message(1, "first"));
  // When the engine restarts with the same session, then the next message goes on the new connection.
  engine.dropAll();
  await lead.hand(message(2, "second"));
  expect(followUps(engine).map((c) => [c.connection, c.command["sessionId"]])).toEqual([
    [1, "handle-1"],
    [2, "handle-2"],
  ]);
  // When it restarts with another session behind that file, then nothing is handed to it.
  durable = "durable-other";
  engine.dropAll();
  await expect(lead.hand(message(3, "third"))).rejects.toThrow("session changed");
  expect(followUps(engine)).toHaveLength(2);
  lead.close();
});

test.each([
  ["a host proof made with another key", { proveWithOtherKey: true }],
  ["a launch id that leaves the keys directory to a planted record", { announcedLaunchId: () => "../../planted" }],
])("%s is refused before anything is sent", async (_name, options) => {
  // Given a host that cannot prove it holds the key record's key, or one that planted a private record outside the keys.
  const engine = await start(() => ({ success: true }), options);
  const planted = { version: 1, launch_id: "../../planted", key: engine.keyHex };
  await writeFile(join(engine.agentDir, "planted"), JSON.stringify(planted), { mode: 0o600 });
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  // When the lead connects, then the handshake fails and no command follows it.
  await expect(lead.session()).rejects.toThrow("engine");
  expect(engine.calls).toEqual([]);
  lead.close();
});

test.each([
  ["a key record others can read", async (engine: Engine) => chmod(engine.recordPath, 0o644)],
  ["a socket anyone may write to", async (engine: Engine) => chmod(engine.socketPath, 0o666)],
])("%s is refused before anything is sent", async (_name, loosen) => {
  // Given an engine whose key record or socket is not private to its owner.
  const engine = await start(() => ({ success: true }));
  await loosen(engine);
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  // When the lead connects, then nothing is sent past the handshake.
  await expect(lead.session()).rejects.toThrow("engine");
  expect(engine.calls).toEqual([]);
  lead.close();
});

test("a key record that is not JSON is refused with a fixed reason that carries none of its bytes", async () => {
  // Given a key record replaced by text that happens to be key material.
  const engine = await start(() => ({ success: true }));
  await writeFile(engine.recordPath, "deadbeefcafe0123", { mode: 0o600 });
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), {
    sessionFile: await mainSession(engine),
  });
  // When the lead connects, then the error names the record and not its content.
  const failure = await lead.session().catch((error: unknown) => (error instanceof Error ? error.message : ""));
  expect(failure).toContain("engine key record");
  expect(failure).not.toContain("deadbeef");
  lead.close();
});
