import { afterEach, expect, test } from "bun:test";

import { EngineLead, unixEngine } from "../src/messenger/engine.ts";
import type { InboundFrame } from "../src/messenger/gateway-frames.ts";
import { type EngineAnswer, startFakeEngine } from "./engine-fakes.ts";

const SESSION_FILE = "/home/dori/.omo/agent/sessions/dori-main.jsonl";
const CWD = "/home/dori/dori";
const message = (seq: number, text: string): InboundFrame => ({
  op: "inbound",
  seq,
  session_id: "durable-main",
  id: `u_${seq}`,
  created_at: 1,
  kind: "message",
  text,
});
const opened: EngineAnswer = {
  success: true,
  data: { sessionId: "handle-1", state: { sessionId: "durable-main", sessionFile: SESSION_FILE } },
};

let engine: Awaited<ReturnType<typeof startFakeEngine>> | null = null;
afterEach(async () => {
  await engine?.close();
  engine = null;
});

test("the lead opens the Dori's main session as a retained session and announces its durable id and file", async () => {
  // Given an engine that opens any session file.
  engine = await startFakeEngine((command) => (command["type"] === "open_session" ? opened : { success: true }));
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), SESSION_FILE, CWD);
  // When the lead is asked which session to announce.
  const announced = await lead.session();
  lead.close();
  // Then it opened that file in the work directory, kept past this connection, and names it by its durable id.
  expect(engine.calls.map((c) => c.command)).toEqual([
    expect.objectContaining({ type: "open_session", sessionPath: SESSION_FILE, cwd: CWD, retain_on_disconnect: true }),
  ]);
  expect(announced).toEqual({ id: "durable-main", path: SESSION_FILE });
});

test("a message is handed as a follow-up that starts a turn when idle, keyed by the room row id, with its whole text", async () => {
  // Given an engine that admits every input.
  engine = await startFakeEngine((command) =>
    command["type"] === "open_session" ? opened : { success: true, data: { disposition: "started" } },
  );
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), SESSION_FILE, CWD);
  const long = "x".repeat(500);
  // When a message reaches the lead.
  await lead.hand(message(7, long));
  lead.close();
  // Then the engine got one follow-up on the opened handle, keyed by the row id so a resend is one message.
  const input = engine.calls.map((c) => c.command).find((c) => c["type"] === "follow_up");
  expect(input).toMatchObject({ sessionId: "handle-1", whenIdle: "start", clientMessageId: "u_7" });
  expect(String(input?.["message"])).toContain(long);
  expect(String(input?.["message"])).toContain("dori send gateway");
});

test("an input the engine refuses is not handed: the lead throws, so the caller does not ack it", async () => {
  // Given an engine that refuses every input.
  engine = await startFakeEngine((command) =>
    command["type"] === "open_session" ? opened : { success: false, error: "model not ready" },
  );
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), SESSION_FILE, CWD);
  // When a message reaches the lead, then the hand-off fails.
  await expect(lead.hand(message(1, "hello"))).rejects.toThrow("engine refused the follow_up");
  lead.close();
});

test("after the engine drops the connection, the next hand-off reconnects and opens the session again", async () => {
  // Given an engine that admits every input, and a first message handed on the first connection.
  engine = await startFakeEngine((command, connection) =>
    command["type"] === "open_session"
      ? { ...opened, data: { ...(opened.data as object), sessionId: `handle-${connection}` } }
      : { success: true, data: { disposition: "queued" } },
  );
  const lead = new EngineLead(unixEngine(engine.socketPath, engine.agentDir), SESSION_FILE, CWD);
  await lead.hand(message(1, "first"));
  // When the engine restarts and a second message comes.
  engine.dropAll();
  await lead.hand(message(2, "second"));
  lead.close();
  // Then the second follow-up went on a fresh connection, on that connection's own handle.
  const inputs = engine.calls.filter((c) => c.command["type"] === "follow_up");
  expect(inputs.map((c) => [c.connection, c.command["sessionId"]])).toEqual([
    [1, "handle-1"],
    [2, "handle-2"],
  ]);
});

test("a host that cannot prove the key is refused before any input is sent", async () => {
  // Given a socket whose host signs with a key the client's agent dir does not hold.
  engine = await startFakeEngine(() => ({ success: true }));
  const other = await startFakeEngine(() => ({ success: true }));
  const lead = new EngineLead(unixEngine(engine.socketPath, other.agentDir), SESSION_FILE, CWD);
  // When a message reaches the lead, then nothing is sent past the handshake.
  await expect(lead.hand(message(1, "hello"))).rejects.toThrow();
  lead.close();
  expect(engine.calls).toEqual([]);
  await other.close();
});
