import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Gateway, gatewaySocketPath, unixConnector } from "../src/messenger/gateway.ts";
import { MessengerError, UnsafeMessageError } from "../src/messenger/http.ts";
import { manualDeadline, memoryGateway, ok, recordingClock } from "./gateway-fakes.ts";

const SOCK = "/run/dori-gateway/dori.sock";
const ids = () => {
  let n = 0;
  return () => `op-${++n}`;
};

test("each op writes its documented frame on the socket and returns the row id its op_id names", async () => {
  // Given a gateway that answers every send with ok.
  const gw = memoryGateway((frame, peer) => peer.reply(ok(frame)));
  const answer = manualDeadline();
  const client = new Gateway(gw.connector, recordingClock(), SOCK, ids(), undefined, answer.deadline);
  // When the Dori posts, edits, runs a status row through its three phases, asks and sends a receipt.
  const posted = await client.post("hello");
  await client.edit(posted, "hello again");
  const status = await client.status("start", "Working", [{ id: "r1", label: "Build", state: "running" }]);
  await client.status("update", "Working", [{ id: "r1", label: "Build", state: "done" }], status);
  await client.status("stop", "Done", [], status);
  const question = await client.question("Pay?", [
    { id: "o1", label: "Yes" },
    { id: "o2", label: "No" },
  ]);
  const receipt = await client.receipt("Order", [{ label: "Total", value: "12,000 KRW" }]);
  // Then the frames are exactly the documented shapes, on the configured socket path.
  expect([posted, status, question, receipt]).toEqual(["op-1", "op-3", "op-6", "op-7"]);
  expect(gw.received).toEqual([
    { op: "send", kind: "post", op_id: "op-1", text: "hello" },
    { op: "send", kind: "edit", op_id: "op-2", target_id: "op-1", text: "hello again" },
    {
      op: "send",
      kind: "status",
      op_id: "op-3",
      status_id: "op-3",
      phase: "start",
      text: "Working",
      rows: [{ id: "r1", label: "Build", state: "running" }],
    },
    {
      op: "send",
      kind: "status",
      op_id: "op-4",
      status_id: "op-3",
      phase: "update",
      text: "Working",
      rows: [{ id: "r1", label: "Build", state: "done" }],
    },
    { op: "send", kind: "status", op_id: "op-5", status_id: "op-3", phase: "stop", text: "Done", rows: [] },
    {
      op: "send",
      kind: "question",
      op_id: "op-6",
      text: "Pay?",
      options: [
        { id: "o1", label: "Yes" },
        { id: "o2", label: "No" },
      ],
    },
    { op: "send", kind: "receipt", op_id: "op-7", title: "Order", lines: [{ label: "Total", value: "12,000 KRW" }] },
  ]);
  expect(new Set(gw.paths)).toEqual(new Set([SOCK]));
  // And every answer deadline was cancelled once its answer was in, so none holds the process open.
  expect(answer.counts).toEqual({ armed: 7, cancelled: 7 });
});

test("a retry after a dropped connection, a refused connect or an unavailable answer reuses the same op_id", async () => {
  // Given a gateway that is not listening on the first attempt, drops the second, says unavailable on the third.
  const gw = memoryGateway(
    (frame, peer) => {
      if (peer.connection === 2) peer.drop();
      else if (peer.connection === 3)
        peer.reply({ op: "result", re: "send", code: "unavailable", op_id: frame["op_id"] });
      else peer.reply({ ...ok(frame), code: "queued" });
    },
    (attempt) => attempt === 1,
  );
  const clock = recordingClock();
  // When the Dori posts once.
  const id = await new Gateway(gw.connector, clock, SOCK, ids(), undefined, manualDeadline().deadline).post("hello");
  // Then every attempt carried op-1, the waits came from the injected clock, and the queued answer counts as sent.
  expect(id).toBe("op-1");
  expect(gw.received.map((f) => f["op_id"])).toEqual(["op-1", "op-1", "op-1"]);
  expect(clock.slept).toEqual([1_000, 2_000, 4_000]);
});

test("a gateway that takes the connection and never answers ends in gateway_unavailable, not a hang", async () => {
  // Given a gateway that reads every frame and never replies.
  const gw = memoryGateway(() => {});
  const answer = manualDeadline(true);
  // When the Dori posts with every answer deadline already expired; then each attempt gives up, same op_id each time.
  const sent = new Gateway(gw.connector, recordingClock(), SOCK, ids(), undefined, answer.deadline).post("hello");
  await expect(sent).rejects.toThrow("gateway_unavailable");
  expect(gw.received.map((f) => f["op_id"])).toEqual(["op-1", "op-1", "op-1", "op-1", "op-1"]);
  expect(answer.counts).toEqual({ armed: 5, cancelled: 5 });
});

test("with no gateway, a send ends with gateway_unavailable once the backoff is spent", async () => {
  // Given no gateway listening at all.
  const gw = memoryGateway(
    () => {},
    () => true,
  );
  const clock = recordingClock();
  // When the Dori posts; then it fails with the one-line code after the policy's attempts, without a real wait.
  const sent = new Gateway(gw.connector, clock, SOCK, ids()).post("hello");
  await expect(sent).rejects.toThrow(new MessengerError("gateway_unavailable", 0, "gateway_unavailable"));
  expect(gw.attempts()).toBe(5);
  expect(clock.slept).toEqual([1_000, 2_000, 4_000, 8_000]);
});

test("a refusal other than unavailable is not retried and names its code", async () => {
  const gw = memoryGateway((frame, peer) =>
    peer.reply({ op: "result", re: "send", code: "unbound", op_id: frame["op_id"] }),
  );
  const sent = new Gateway(gw.connector, recordingClock(), SOCK, ids()).post("hello");
  await expect(sent).rejects.toThrow("gateway refused the post: unbound");
  expect(gw.attempts()).toBe(1);
});

test("text containing $( is refused before anything is written, in every op", async () => {
  // Given a gateway that would accept anything.
  const gw = memoryGateway((frame, peer) => peer.reply(ok(frame)));
  const client = new Gateway(gw.connector, recordingClock(), SOCK, ids());
  // When each op carries $( in one of its texts; then each is refused as in the other messengers.
  const attempts = [
    client.post("echo $(id)"),
    client.edit("op-1", "$(id)"),
    client.status("start", "ok", [{ id: "r1", label: "$(id)", state: "running" }]),
    client.question("ok?", [{ id: "o1", label: "$(id)" }]),
    client.receipt("ok", [{ label: "Total", value: "$(id)" }]),
  ];
  for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(gw.received).toEqual([]);
});

test("the socket path is DORI_GATEWAY_SOCKET when set, else the configured one", () => {
  expect(gatewaySocketPath(SOCK, {})).toBe(SOCK);
  expect(gatewaySocketPath(SOCK, { DORI_GATEWAY_SOCKET: "/tmp/g.sock" })).toBe("/tmp/g.sock");
});

test("the Unix connector carries one line each way over a real socket", async () => {
  // Given a Unix socket in a temp directory that answers a ping.
  const dir = mkdtempSync(join(tmpdir(), "dori-gw-"));
  const path = join(dir, "dori.sock");
  const server = createServer((socket) =>
    socket.on("data", () =>
      socket.write(`${JSON.stringify({ op: "result", re: "ping", code: "ok", contract_version: 1 })}\n`),
    ),
  );
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    // When the client pings through the real connector; then it reads the contract version back.
    // The answer deadline is held open, so only the socket's own reply can settle the ping.
    const answer = manualDeadline();
    const client = new Gateway(unixConnector, recordingClock(), path, undefined, undefined, answer.deadline);
    expect(await client.ping()).toBe(1);
    expect(answer.counts).toEqual({ armed: 1, cancelled: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
