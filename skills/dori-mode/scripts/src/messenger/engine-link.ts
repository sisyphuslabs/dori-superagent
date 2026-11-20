import { connect, type Socket } from "node:net";

import { authenticate, checkEngineSocket } from "./engine-key.ts";
import { type AnswerDeadline, timeoutDeadline } from "./gateway.ts";
import { type Fields, field, text } from "./fields.ts";
import { MessengerError } from "./http.ts";

/** The engine's answer; `lost` when there was none: the connection closed, or the deadline passed first. */
export type EngineReply = {
  readonly success: boolean;
  readonly data?: unknown;
  readonly errorCode?: string;
  readonly lost?: "closed" | "timeout";
};

/** One authenticated connection to the engine's RPC socket: one answer per command, events skipped. */
export type EngineLink = {
  readonly request: (command: Fields) => Promise<EngineReply>;
  readonly closed: Promise<void>;
  readonly close: () => void;
};
export type EngineConnector = () => Promise<EngineLink>;

/** A line longer than this from the engine ends the connection instead of growing the buffer. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** How long the engine has to answer one command; past it the connection is dropped and the input not handed. */
export const ENGINE_DEADLINE_MS = 30_000;

const lineLink = (socket: Socket, deadline: AnswerDeadline): EngineLink => {
  const pending = new Map<string, (reply: EngineReply) => void>();
  let buffer = "";
  let ended = false;
  let next = 0;
  const closed = new Promise<void>((resolve) =>
    socket.on("close", () => {
      ended = true;
      for (const settle of pending.values()) settle({ success: false, lost: "closed" });
      pending.clear();
      resolve();
    }),
  );
  socket.on("error", () => socket.destroy());
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS && !buffer.includes("\n")) return void socket.destroy();
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      // Session events stream on this connection too; only an answer to one of ours settles anything.
      const id = text(field(record, "id"));
      const settle = id === undefined ? undefined : pending.get(id);
      if (id === undefined || settle === undefined) continue;
      pending.delete(id);
      const errorCode = text(field(record, "errorCode"));
      settle({
        success: field(record, "success") === true,
        data: field(record, "data"),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  });
  return {
    request: (command) => {
      if (ended) return Promise.resolve({ success: false, lost: "closed" });
      const id = `dori-inbound-${++next}`;
      const due = deadline();
      const answered = new Promise<EngineReply>((resolve) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ ...command, id })}\n`);
      });
      const timedOut = due.expired.then((): EngineReply => {
        // An engine that let one command go unanswered is not trusted with the next.
        pending.delete(id);
        socket.destroy();
        return { success: false, lost: "timeout" };
      });
      return Promise.race([answered, timedOut]).finally(due.cancel);
    },
    closed,
    close: () => socket.end(),
  };
};

/** The engine on its Unix socket (SENPI_RPC_SOCKET), proven with the agent dir's key records (OMO_CODING_AGENT_DIR). */
export const unixEngine =
  (
    socketPath: string,
    agentDir: string,
    deadline: AnswerDeadline = timeoutDeadline(ENGINE_DEADLINE_MS),
  ): EngineConnector =>
  async () => {
    await checkEngineSocket(socketPath);
    const socket = connect(socketPath);
    const due = deadline();
    const reached = await Promise.race([
      new Promise<boolean>((resolve) => {
        socket.once("connect", () => resolve(true));
        socket.once("error", () => resolve(false));
      }),
      due.expired.then(() => false),
    ]).finally(due.cancel);
    if (!reached) {
      socket.destroy();
      throw new MessengerError("engine socket refused", 0, "engine_unavailable");
    }
    const link = lineLink(socket, deadline);
    try {
      await authenticate(link, agentDir);
      return link;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
