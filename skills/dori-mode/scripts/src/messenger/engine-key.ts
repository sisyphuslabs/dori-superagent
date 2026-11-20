import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import type { EngineLink } from "./engine.ts";
import { MessengerError } from "./http.ts";

const HEX_32 = /^[0-9a-f]{64}$/;
/** The engine names its launch by a UUID; anything else could walk out of the keys directory. */
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 4096;

const refused = (reason: string) => new MessengerError(`engine ${reason}`, 0, "engine_unavailable");
const ownedBy = (stat: Stats, uid: number) => stat.uid === uid;
const ownUid = (): number => process.getuid?.() ?? -1;
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The engine socket must be this user's own and closed to everyone else before a byte goes to it. */
export const checkEngineSocket = async (path: string): Promise<void> => {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isSocket() || !ownedBy(stat, ownUid()) || (stat.mode & 0o002) !== 0)
    throw refused("socket is not this user's own");
};

/**
 * The key of one engine launch, read the way the engine itself reads it: a UUID launch id, a keys directory
 * and a record that belong to this user and no one else can read, no symlink, `version: 1`. The record's text
 * never reaches an error, since a broken record may still hold key material.
 */
const readHostKey = async (agentDir: string, launchId: string): Promise<Buffer> => {
  if (!LAUNCH_ID.test(launchId)) throw refused("announced no usable launch id");
  const dir = join(agentDir, "rpc", "keys");
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory() || !ownedBy(dirStat, ownUid()) || (dirStat.mode & 0o077) !== 0)
    throw refused("key directory is not private");
  const handle = await open(
    join(dir, launchId),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (handle === null) throw refused("key record missing");
  const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !ownedBy(stat, ownUid()) || (stat.mode & 0o077) !== 0)
      throw refused("key record is not private");
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) throw refused("key record unusable");
    let record: unknown;
    try {
      record = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw refused("key record unusable");
    }
    const key = isRecord(record) ? record["key"] : undefined;
    if (!isRecord(record) || record["version"] !== 1 || record["launch_id"] !== launchId)
      throw refused("key record unusable");
    if (typeof key !== "string" || !HEX_32.test(key)) throw refused("key record unusable");
    return Buffer.from(key, "hex");
  } finally {
    bytes.fill(0);
    await handle.close();
  }
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const field = (v: unknown, name: string): unknown => (isRecord(v) ? v[name] : undefined);

/**
 * Proves both sides with the key record the engine wrote for this launch: the host first, so nothing but a nonce
 * goes to a socket that does not hold the key, then this client.
 */
export const authenticate = async (link: EngineLink, agentDir: string): Promise<void> => {
  const clientNonce = randomBytes(32).toString("hex");
  const info = await link.request({ type: "get_protocol_info", auth: { client_nonce: clientNonce } });
  const auth = field(info.data, "auth");
  const launchId = text(field(auth, "launch_id"));
  const serverNonce = text(field(auth, "server_nonce"));
  const serverProof = text(field(auth, "server_proof"));
  if (launchId === undefined || serverNonce === undefined || serverProof === undefined || !HEX_32.test(serverProof))
    throw refused("offered no challenge");
  const key = await readHostKey(agentDir, launchId);
  try {
    const expected = createHmac("sha256", key)
      .update(`senpi-rpc-server\n${launchId}\n${clientNonce}\n${serverNonce}`)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(serverProof, "hex"))) throw refused("proof did not match");
    const clientProof = createHmac("sha256", key)
      .update(`senpi-rpc-client\n${launchId}\n${serverNonce}\n${clientNonce}`)
      .digest("hex");
    const accepted = await link.request({ type: "authenticate", client_proof: clientProof });
    if (!accepted.success) throw refused("refused authentication");
  } finally {
    key.fill(0);
  }
};
