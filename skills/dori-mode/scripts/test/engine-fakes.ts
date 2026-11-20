import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnswerDeadline } from "../src/messenger/gateway.ts";

type Command = Record<string, unknown>;
export type EngineAnswer = {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly errorCode?: string;
};
export type FakeEngineOptions = {
  /** The launch id the host announces; another value than its record's makes the client look elsewhere. */
  readonly announcedLaunchId?: (real: string) => string;
  /** Signs the host proof with another key than the one in its record, as an impostor would. */
  readonly proveWithOtherKey?: boolean;
};

/**
 * A real Unix socket that speaks the engine's RPC handshake (the host proves itself with the key record under
 * `<agentDir>/rpc/keys/<launch_id>`, then the client does) and answers every later command through `answer`;
 * `null` leaves a command unanswered. Every command after the handshake is recorded with its connection.
 */
export const startFakeEngine = async (
  answer: (command: Command, connection: number) => EngineAnswer | null,
  options: FakeEngineOptions = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-engine-"));
  const agentDir = join(dir, "agent");
  const socketPath = join(dir, "rpc.sock");
  const launchId = crypto.randomUUID();
  const key = randomBytes(32);
  await mkdir(join(agentDir, "rpc", "keys"), { recursive: true, mode: 0o700 });
  await chmod(join(agentDir, "rpc", "keys"), 0o700);
  const recordPath = join(agentDir, "rpc", "keys", launchId);
  await writeFile(recordPath, JSON.stringify({ version: 1, launch_id: launchId, key: key.toString("hex") }), {
    mode: 0o600,
  });
  const calls: { readonly command: Command; readonly connection: number }[] = [];
  const waiting: { readonly type: string; readonly resolve: () => void }[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  /** An impostor proves itself under the launch id it announces, with a record it planted wherever that leads. */
  const announced = options.announcedLaunchId?.(launchId) ?? launchId;
  const server: Server = createServer((socket) => {
    const connection = ++connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let serverNonce = "";
    let clientNonce = "";
    let authenticated = false;
    const reply = (id: unknown, command: unknown, body: EngineAnswer) =>
      socket.write(`${JSON.stringify({ id, type: "response", command, ...body })}\n`);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const command = JSON.parse(buffer.slice(0, end)) as Command;
        buffer = buffer.slice(end + 1);
        const { id, type } = command;
        if (type === "get_protocol_info") {
          clientNonce = String((command["auth"] as Command)["client_nonce"]);
          serverNonce = randomBytes(32).toString("hex");
          const signer = options.proveWithOtherKey === true ? randomBytes(32) : key;
          const proof = createHmac("sha256", signer)
            .update(`senpi-rpc-server\n${announced}\n${clientNonce}\n${serverNonce}`)
            .digest("hex");
          reply(id, type, {
            success: true,
            data: { auth: { launch_id: announced, server_nonce: serverNonce, server_proof: proof } },
          });
          // An event the client must skip while it waits for an answer.
          socket.write(`${JSON.stringify({ type: "agent_start" })}\n`);
        } else if (type === "authenticate") {
          const expected = createHmac("sha256", key)
            .update(`senpi-rpc-client\n${announced}\n${serverNonce}\n${clientNonce}`)
            .digest("hex");
          authenticated = command["client_proof"] === expected;
          reply(id, type, authenticated ? { success: true } : { success: false, error: "unauthenticated" });
        } else if (!authenticated) {
          reply(id, type, { success: false, error: "unauthenticated" });
        } else {
          calls.push({ command, connection });
          for (const waiter of waiting.filter((w) => w.type === type)) waiter.resolve();
          const answered = answer(command, connection);
          if (answered !== null) reply(id, type, answered);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o660);
  return {
    dir,
    socketPath,
    agentDir,
    recordPath,
    keyHex: key.toString("hex"),
    calls,
    /** Resolves when the next command of that type reaches the engine. */
    received: (type: string) => new Promise<void>((resolve) => waiting.push({ type, resolve })),
    /** Drops every open connection, as an engine restart would. */
    dropAll: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/** Answer deadlines the test fires one by one, newest last; none expires by itself. */
export const firedDeadlines = () => {
  const fire: (() => void)[] = [];
  const deadline: AnswerDeadline = () => {
    let expire = () => {};
    const expired = new Promise<void>((resolve) => (expire = resolve));
    fire.push(expire);
    return { expired, cancel: () => {} };
  };
  return { deadline, fireLatest: () => fire.at(-1)?.() };
};
