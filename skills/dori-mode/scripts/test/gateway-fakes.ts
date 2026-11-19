import type { AnswerDeadline, GatewayConnection, SocketConnector } from "../src/messenger/gateway.ts";
import type { Clock } from "../src/run.ts";

type Frame = Record<string, unknown>;
export type Peer = { readonly reply: (frame: unknown) => void; readonly drop: () => void; readonly connection: number };

/**
 * An in-memory socket pair: the client's lines reach `respond` as parsed frames, in order, and the frames it replies
 * with come back as lines. `refuse` makes a connection attempt fail, as when no gateway is listening.
 */
export const memoryGateway = (
  respond: (frame: Frame, peer: Peer) => void,
  refuse: (attempt: number) => boolean = () => false,
) => {
  const received: Frame[] = [];
  const paths: string[] = [];
  let attempts = 0;
  const connector: SocketConnector = async (path) => {
    paths.push(path);
    const connection = ++attempts;
    if (refuse(connection)) throw new Error("connect ENOENT");
    const lines: (string | undefined)[] = [];
    const waiting: ((line: string | undefined) => void)[] = [];
    let closed = false;
    const deliver = (line: string | undefined) => {
      const reader = waiting.shift();
      if (reader) reader(line);
      else lines.push(line);
    };
    const peer: Peer = {
      reply: (frame) => (closed ? undefined : deliver(JSON.stringify(frame))),
      drop: () => {
        if (!closed) deliver(undefined);
        closed = true;
      },
      connection,
    };
    const conn: GatewayConnection = {
      write: (line) => {
        const frame = JSON.parse(line) as Frame;
        received.push(frame);
        respond(frame, peer);
      },
      next: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiting.push(r))),
      close: () => peer.drop(),
    };
    return conn;
  };
  return { connector, received, paths, attempts: () => attempts };
};

/** A clock whose sleeps return at once and are recorded, so backoff is checked without waiting. */
export const recordingClock = (): Clock & { readonly slept: number[] } => {
  const slept: number[] = [];
  let at = 0;
  return {
    slept,
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  };
};

/** An answer deadline the test controls: it expires only through `expire`, and counts what was armed and cancelled. */
export const manualDeadline = (expireAtOnce = false) => {
  let fire = () => {};
  const expired = expireAtOnce ? Promise.resolve() : new Promise<void>((resolve) => (fire = resolve));
  const counts = { armed: 0, cancelled: 0 };
  const deadline: AnswerDeadline = () => {
    counts.armed++;
    return { expired, cancel: () => void counts.cancelled++ };
  };
  return { deadline, counts, expire: () => fire() };
};

export const ok = (frame: Frame) => ({ op: "result", re: frame["op"], code: "ok", op_id: frame["op_id"] });
