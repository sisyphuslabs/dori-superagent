import { expect, test } from "bun:test";

import { formatGatewayInbound } from "../src/cli-gateway.ts";
import { Gateway } from "../src/messenger/gateway.ts";
import type { InboundFrame } from "../src/messenger/gateway-frames.ts";
import { memoryGateway, recordingClock } from "./gateway-fakes.ts";

const SESSION = "0b8f3c1e-session";
const SESSION_FILE = "/sessions/lead.jsonl";
const ANNOUNCED = { id: SESSION, path: SESSION_FILE };
const message = (seq: number, text: string) => ({
  op: "inbound",
  seq,
  session_id: SESSION,
  id: `m${seq}`,
  created_at: 1,
  kind: "message",
  text,
});

test("inbound announces the lead session, hands each message to the lead, and acks it only after the hand-off", async () => {
  // Given a gateway that, once subscribed, pushes a message and an answer, then refuses every later connection.
  const order: string[] = [];
  const gw = memoryGateway(
    (frame, peer) => {
      order.push(`gateway got ${frame["op"]}${frame["seq"] ? ` ${frame["seq"]}` : ""}`);
      if (frame["op"] !== "subscribe") return;
      peer.reply({ op: "result", re: "subscribe", code: "ok" });
      peer.reply(message(1, "hello"));
      peer.reply({ ...message(2, "x"), kind: "answer", question_id: "op-6", option_id: "o1", text: undefined });
      peer.drop();
    },
    (attempt) => attempt > 1,
  );
  const handed: [string, InboundFrame][] = [];
  const lead = (session: string, inbound: InboundFrame) => {
    order.push(`lead got ${inbound.seq}`);
    handed.push([session, inbound]);
  };
  // When the Dori subscribes as its lead session, until the gateway is gone.
  const done = new Gateway(gw.connector, recordingClock(), "/run/dori-gateway/dori.sock").subscribe(ANNOUNCED, lead);
  await expect(done).rejects.toThrow("gateway_unavailable");
  // Then the subscription named the session, both inbound frames reached the lead with that id, each acked after it.
  expect(gw.received[0]).toEqual({ op: "subscribe", session_id: SESSION, session_path: SESSION_FILE });
  expect(handed.map(([session, i]) => [session, i.kind, i.seq])).toEqual([
    [SESSION, "message", 1],
    [SESSION, "answer", 2],
  ]);
  expect(order).toEqual([
    "gateway got subscribe",
    "lead got 1",
    "gateway got ack 1",
    "lead got 2",
    "gateway got ack 2",
  ]);
});

test("after a dropped connection the session is announced again and a resent seq is acked without a second hand-off", async () => {
  // Given a gateway that resends seq 1 on every connection and adds seq 2 on the second one before dropping.
  const gw = memoryGateway(
    (frame, peer) => {
      if (frame["op"] !== "subscribe") return;
      peer.reply({ op: "result", re: "subscribe", code: "ok" });
      peer.reply(message(1, "hello"));
      if (peer.connection === 2) peer.reply(message(2, "again"));
      peer.drop();
    },
    (attempt) => attempt > 2,
  );
  const handed: number[] = [];
  const clock = recordingClock();
  const done = new Gateway(gw.connector, clock, "/sock").subscribe(ANNOUNCED, (_, i) => void handed.push(i.seq));
  await expect(done).rejects.toThrow("gateway_unavailable");
  // Then seq 1 reached the lead once, was acked on both connections, and the reconnects waited on the injected clock.
  expect(handed).toEqual([1, 2]);
  expect(gw.received.filter((f) => f["op"] === "subscribe")).toHaveLength(2);
  expect(gw.received.filter((f) => f["op"] === "ack").map((f) => f["seq"])).toEqual([1, 1, 2]);
  expect(clock.slept.length).toBeGreaterThan(0);
});

test("an inbound line keeps the other messengers' field order", () => {
  const answer = { ...message(2, "x"), kind: "answer", question_id: "op-6", option_id: "o1" } as InboundFrame;
  expect(formatGatewayInbound(SESSION, message(1, "hi there") as InboundFrame)).toBe(
    `INBOUND gateway ${SESSION} - m1 - "hi there"`,
  );
  expect(formatGatewayInbound(SESSION, answer)).toBe(`INBOUND gateway:answer ${SESSION} op-6 m2 - "x" option=o1`);
});
