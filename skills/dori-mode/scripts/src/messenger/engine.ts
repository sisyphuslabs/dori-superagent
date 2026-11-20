import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

import type { AnnouncedSession, InboundFrame } from "./gateway-frames.ts";
import { MessengerError } from "./http.ts";

type Fields = Readonly<Record<string, unknown>>;
type Reply = { readonly success: boolean; readonly data?: unknown };

/** One authenticated connection to the engine's RPC socket: one answer per command, events skipped. */
export type EngineLink = {
  readonly request: (command: Fields) => Promise<Reply>;
  readonly closed: Promise<void>;
  readonly close: () => void;
};
export type EngineConnector = () => Promise<EngineLink>;

const isRecord = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const field = (v: unknown, name: string): unknown => (isRecord(v) ? v[name] : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const HEX_32 = /^[0-9a-f]{64}$/;
/** A line longer than this from the engine ends the connection instead of growing the buffer. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

const lineLink = (socket: Socket): EngineLink => {
  const pending = new Map<string, (reply: Reply) => void>();
  let buffer = "";
  let ended = false;
  let next = 0;
  const closed = new Promise<void>((resolve) =>
    socket.on("close", () => {
      ended = true;
      for (const settle of pending.values()) settle({ success: false, data: "closed" });
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
      settle({ success: field(record, "success") === true, data: field(record, "data") });
    }
  });
  return {
    request: (command) => {
      if (ended) return Promise.resolve({ success: false, data: "closed" });
      const id = `dori-inbound-${++next}`;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ ...command, id })}\n`);
      });
    },
    closed,
    close: () => socket.end(),
  };
};

const hostKey = async (agentDir: string, launchId: string): Promise<Buffer> => {
  const record: unknown = JSON.parse(await readFile(join(agentDir, "rpc", "keys", launchId), "utf8"));
  const key = text(field(record, "key"));
  if (field(record, "launch_id") !== launchId || key === undefined || !HEX_32.test(key))
    throw new MessengerError("engine key record unusable", 0, "engine_unavailable");
  return Buffer.from(key, "hex");
};

/**
 * Proves both sides with the key record the engine wrote under `<agentDir>/rpc/keys/<launch_id>`: the host first,
 * so nothing is sent to a socket that does not hold the key, then this client.
 */
const authenticate = async (link: EngineLink, agentDir: string): Promise<void> => {
  const clientNonce = randomBytes(32).toString("hex");
  const info = await link.request({ type: "get_protocol_info", auth: { client_nonce: clientNonce } });
  const auth = field(info.data, "auth");
  const launchId = text(field(auth, "launch_id"));
  const serverNonce = text(field(auth, "server_nonce"));
  const serverProof = text(field(auth, "server_proof"));
  if (launchId === undefined || serverNonce === undefined || serverProof === undefined || !HEX_32.test(serverProof))
    throw new MessengerError("engine offered no challenge", 0, "engine_unavailable");
  const key = await hostKey(agentDir, launchId);
  try {
    const expected = createHmac("sha256", key)
      .update(`senpi-rpc-server\n${launchId}\n${clientNonce}\n${serverNonce}`)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(serverProof, "hex")))
      throw new MessengerError("engine proof did not match", 0, "engine_unavailable");
    const clientProof = createHmac("sha256", key)
      .update(`senpi-rpc-client\n${launchId}\n${serverNonce}\n${clientNonce}`)
      .digest("hex");
    const accepted = await link.request({ type: "authenticate", client_proof: clientProof });
    if (!accepted.success) throw new MessengerError("engine refused authentication", 0, "engine_unavailable");
  } finally {
    key.fill(0);
  }
};

/** The engine on its Unix socket (SENPI_RPC_SOCKET), proven with the agent dir's key records (OMO_CODING_AGENT_DIR). */
export const unixEngine =
  (socketPath: string, agentDir: string): EngineConnector =>
  async () => {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", () => reject(new MessengerError("engine socket refused", 0, "engine_unavailable")));
    });
    const link = lineLink(socket);
    try {
      await authenticate(link, agentDir);
      return link;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };

/** What the Dori's session is given for one message or answer from the dori.bot chat. */
export const promptOf = (inbound: InboundFrame): string => {
  const said =
    inbound.kind === "message"
      ? `The owner wrote in the dori.bot chat:\n\n${inbound.text}`
      : `The owner answered your question ${inbound.question_id} in the dori.bot chat` +
        `${inbound.option_id === undefined ? "" : ` with option ${inbound.option_id}`}` +
        `${inbound.text === undefined ? "." : `:\n\n${inbound.text}`}`;
  return `${said}\n\n(Reply with \`dori send gateway\`; the dori.bot rules are in the dori-mode skill's rules/dori-bot.md.)`;
};

type Opened = { readonly link: EngineLink; readonly handle: string; readonly session: AnnouncedSession };

/**
 * The Dori's main session on the engine host, reached over one long-lived connection: a message is handed as a
 * follow-up that starts a turn when the session is idle and joins the running one otherwise, keyed by the room row id
 * so a resend after a lost ack is the same input to the engine.
 */
export class EngineLead {
  private opened: Promise<Opened> | null = null;

  constructor(
    private readonly connect: EngineConnector,
    private readonly sessionFile: string,
    private readonly cwd: string,
  ) {}

  async session(): Promise<AnnouncedSession> {
    return (await this.open()).session;
  }

  async hand(inbound: InboundFrame): Promise<void> {
    // A connection the engine dropped since the last message costs one fresh connection, not a lost message.
    for (let attempt = 0; ; attempt++) {
      const opening = this.open();
      const { link, handle } = await opening;
      const reply = await link.request({
        type: "follow_up",
        sessionId: handle,
        message: promptOf(inbound),
        whenIdle: "start",
        clientMessageId: inbound.id,
      });
      if (reply.success) return;
      const lost = reply.data === "closed";
      if (this.opened === opening) this.opened = null;
      link.close();
      if (!lost || attempt > 0) throw new MessengerError("engine refused the follow_up", 0, "engine_refused");
    }
  }

  close(): void {
    void this.opened?.then(
      ({ link }) => link.close(),
      () => undefined,
    );
    this.opened = null;
  }

  private open(): Promise<Opened> {
    if (this.opened !== null) return this.opened;
    const opening = this.openNow();
    this.opened = opening;
    const release = () => {
      if (this.opened === opening) this.opened = null;
    };
    opening.then(({ link }) => void link.closed.then(release), release);
    return opening;
  }

  private async openNow(): Promise<Opened> {
    const link = await this.connect();
    const reply = await link.request({
      type: "open_session",
      sessionPath: this.sessionFile,
      cwd: this.cwd,
      retain_on_disconnect: true,
    });
    const handle = text(field(reply.data, "sessionId"));
    const durable = text(field(field(reply.data, "state"), "sessionId"));
    if (!reply.success || handle === undefined || durable === undefined) {
      link.close();
      throw new MessengerError("engine refused the session", 0, "engine_unavailable");
    }
    return { link, handle, session: { id: durable, path: this.sessionFile } };
  }
}
