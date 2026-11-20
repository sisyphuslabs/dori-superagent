import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Command = Record<string, unknown>;
export type EngineAnswer = { readonly success: boolean; readonly data?: unknown; readonly error?: string };

/**
 * A real Unix socket that speaks the engine's RPC handshake (the host proves itself with the key record under
 * `<agentDir>/rpc/keys/<launch_id>`, then the client does) and answers every later command through `answer`.
 * Every command after the handshake is recorded, with the connection it came on.
 */
export const startFakeEngine = async (answer: (command: Command, connection: number) => EngineAnswer) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-engine-"));
  const agentDir = join(dir, "agent");
  const socketPath = join(dir, "rpc.sock");
  const launchId = crypto.randomUUID();
  const key = randomBytes(32);
  await mkdir(join(agentDir, "rpc", "keys"), { recursive: true });
  await writeFile(
    join(agentDir, "rpc", "keys", launchId),
    JSON.stringify({ version: 1, launch_id: launchId, key: key.toString("hex") }),
    { mode: 0o600 },
  );
  const calls: { readonly command: Command; readonly connection: number }[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
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
          const proof = createHmac("sha256", key)
            .update(`senpi-rpc-server\n${launchId}\n${clientNonce}\n${serverNonce}`)
            .digest("hex");
          reply(id, type, {
            success: true,
            data: { auth: { launch_id: launchId, server_nonce: serverNonce, server_proof: proof } },
          });
          // An event the client must skip while it waits for an answer.
          socket.write(`${JSON.stringify({ type: "agent_start" })}\n`);
        } else if (type === "authenticate") {
          const expected = createHmac("sha256", key)
            .update(`senpi-rpc-client\n${launchId}\n${serverNonce}\n${clientNonce}`)
            .digest("hex");
          authenticated = command["client_proof"] === expected;
          reply(id, type, authenticated ? { success: true } : { success: false, error: "unauthenticated" });
        } else if (!authenticated) {
          reply(id, type, { success: false, error: "unauthenticated" });
        } else {
          calls.push({ command, connection });
          reply(id, type, answer(command, connection));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    agentDir,
    calls,
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
