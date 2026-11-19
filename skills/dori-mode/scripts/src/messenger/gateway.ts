import { connect } from "node:net";

import type { Clock } from "../run.ts";
import {
  type DoriToGatewayFrame,
  type InboundFrame,
  parseGatewayLine,
  type QuestionOption,
  type ReceiptLine,
  type ResultFrame,
  type SendFrame,
  type StatusPhase,
  type WorkRow,
} from "./gateway-frames.ts";
import { DEFAULT_RETRY, guardText, MessengerError, type RetryPolicy } from "./http.ts";

/** DORI_GATEWAY_SOCKET when set, else the configured path (config `gateway.socket`). */
export const gatewaySocketPath = (
  configured: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env["DORI_GATEWAY_SOCKET"] || configured;

/** One connection to the socket: whole lines out, whole lines in, `undefined` once it has closed. */
export type GatewayConnection = {
  readonly write: (line: string) => void;
  readonly next: () => Promise<string | undefined>;
  readonly close: () => void;
};
export type SocketConnector = (path: string) => Promise<GatewayConnection>;

export const unixConnector: SocketConnector = (path) =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    const lines: string[] = [];
    const waiting: ((line: string | undefined) => void)[] = [];
    let buffer = "";
    let closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const reader = waiting.shift();
        if (reader) reader(line);
        else lines.push(line);
      }
    });
    socket.on("close", () => {
      closed = true;
      for (const reader of waiting.splice(0)) reader(undefined);
    });
    socket.on("error", (e) => (closed ? undefined : reject(e)));
    socket.on("connect", () =>
      resolve({
        write: (line) => void socket.write(`${line}\n`),
        next: () =>
          lines.length || closed ? Promise.resolve(lines.shift()) : new Promise((answer) => waiting.push(answer)),
        close: () => socket.destroy(),
      }),
    );
  });

export const GATEWAY_UNAVAILABLE = "gateway_unavailable";

/** How long one request waits for its answer. Cancelled once the answer is in, so it never holds the process. */
export type AnswerDeadline = () => { readonly expired: Promise<void>; readonly cancel: () => void };

export const timeoutDeadline =
  (ms: number): AnswerDeadline =>
  () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return { expired, cancel: () => clearTimeout(timer) };
  };

/** Hands one user message or answer to the lead session the subscription announced. */
export type LeadPort = (sessionId: string, inbound: InboundFrame) => Promise<void> | void;

/**
 * The dori.bot surface: a client of the gateway's local socket, with the verbs of the other messengers. Each send
 * carries an `op_id` chosen once, so a retry after a dropped connection is the same send and is stored once.
 */
export class Gateway {
  constructor(
    private readonly connect: SocketConnector,
    private readonly clock: Clock,
    private readonly socketPath: string,
    private readonly newOpId: () => string = () => crypto.randomUUID(),
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
    private readonly deadline: AnswerDeadline = timeoutDeadline(10_000),
  ) {}

  async post(text: string): Promise<string> {
    return (await this.send({ op: "send", kind: "post", op_id: this.newOpId(), text: guardText(text) })).id;
  }

  async edit(messageId: string, text: string): Promise<void> {
    await this.send({ op: "send", kind: "edit", op_id: this.newOpId(), target_id: messageId, text: guardText(text) });
  }

  /** `start` creates the status row and returns its id; `update` and `stop` change that row in place. */
  async status(phase: StatusPhase, text: string, rows: readonly WorkRow[], statusId?: string): Promise<string> {
    const opId = this.newOpId();
    const target = statusId ?? (phase === "start" ? opId : undefined);
    if (target === undefined) throw new MessengerError(`a status ${phase} needs the id its start returned`, 0);
    const checked = rows.map((row) => ({ ...row, label: guardText(row.label) }));
    await this.send({
      op: "send",
      kind: "status",
      op_id: opId,
      status_id: target,
      phase,
      text: guardText(text),
      rows: checked,
    });
    return target;
  }

  async question(text: string, options: readonly QuestionOption[]): Promise<string> {
    const checked = options.map((option) => ({ ...option, label: guardText(option.label) }));
    return (
      await this.send({ op: "send", kind: "question", op_id: this.newOpId(), text: guardText(text), options: checked })
    ).id;
  }

  async receipt(title: string, lines: readonly ReceiptLine[]): Promise<string> {
    const checked = lines.map((line) => ({ label: guardText(line.label), value: guardText(line.value) }));
    return (
      await this.send({ op: "send", kind: "receipt", op_id: this.newOpId(), title: guardText(title), lines: checked })
    ).id;
  }

  /** One attempt, no retry: the socket answers with its contract version, or this throws. */
  async ping(): Promise<number | undefined> {
    const answer = await this.request({ op: "ping" });
    if (answer?.code !== "ok") throw new MessengerError(GATEWAY_UNAVAILABLE, 0, GATEWAY_UNAVAILABLE);
    return answer.contract_version;
  }

  /**
   * The long-lived inbound stream: announce the lead session, hand each message or answer to the lead, then ack it.
   * A dropped connection is reopened with backoff and the session announced again; the gateway resends what was not
   * acked, and a `seq` already handed over is acked again without a second hand-off (`seq` is the row's position in
   * the conversation's stored log, so it only grows, also across a gateway restart). Ends with gateway_unavailable
   * after `policy.attempts` failed connections in a row.
   */
  async subscribe(sessionId: string, lead: LeadPort): Promise<never> {
    let handed = 0;
    for (let failures = 0; ; ) {
      const conn = await this.connect(this.socketPath).catch(() => undefined);
      if (conn) {
        try {
          conn.write(JSON.stringify({ op: "subscribe", session_id: sessionId } satisfies DoriToGatewayFrame));
          for (let line = await conn.next(); line !== undefined; line = await conn.next()) {
            const frame = parseGatewayLine(line);
            if (frame?.op === "result" && frame.re === "subscribe")
              if (frame.code === "ok") failures = 0;
              else throw new MessengerError(`gateway refused the subscription: ${frame.code}`, 0, frame.code);
            if (frame?.op !== "inbound") continue;
            if (frame.seq > handed) {
              await lead(sessionId, frame);
              handed = frame.seq;
            }
            conn.write(JSON.stringify({ op: "ack", seq: frame.seq } satisfies DoriToGatewayFrame));
          }
        } finally {
          conn.close();
        }
      }
      failures++;
      if (failures >= this.policy.attempts) throw new MessengerError(GATEWAY_UNAVAILABLE, 0, GATEWAY_UNAVAILABLE);
      await this.clock.sleep(this.backoffMs(failures - 1));
    }
  }

  private async send(frame: SendFrame): Promise<{ readonly id: string }> {
    for (let attempt = 0; ; attempt++) {
      const answer = await this.request(frame).catch(() => undefined);
      if (answer?.code === "ok" || answer?.code === "queued") return { id: frame.op_id };
      if (answer && answer.code !== "unavailable")
        throw new MessengerError(`gateway refused the ${frame.kind}: ${answer.code}`, 0, answer.code);
      if (attempt >= this.policy.attempts - 1) throw new MessengerError(GATEWAY_UNAVAILABLE, 0, GATEWAY_UNAVAILABLE);
      await this.clock.sleep(this.backoffMs(attempt));
    }
  }

  /** One connection, one frame, the result that answers it; `undefined` when the connection closed first. */
  private async request(frame: DoriToGatewayFrame): Promise<ResultFrame | undefined> {
    const conn = await this.connect(this.socketPath);
    // A gateway that takes the connection and never answers must not hang the send: the read gives up at the deadline.
    const deadline = this.deadline();
    try {
      conn.write(JSON.stringify(frame));
      const timedOut = deadline.expired.then(() => undefined);
      const next = () => Promise.race([conn.next(), timedOut]);
      for (let line = await next(); line !== undefined; line = await next()) {
        const answer = parseGatewayLine(line);
        if (answer?.op === "result" && (answer.re === frame.op || answer.re === "unknown")) return answer;
      }
      return undefined;
    } finally {
      deadline.cancel();
      conn.close();
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** attempt);
  }
}
