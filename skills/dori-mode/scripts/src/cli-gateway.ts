/** dori send gateway and dori inbound gateway: the dori.bot surface over the gateway's local socket. */
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";
import { EngineLead, handToEngine, unixEngine } from "./messenger/engine.ts";
import { Gateway, gatewaySocketPath, unixConnector } from "./messenger/gateway.ts";
import type { InboundFrame, StatusPhase, WorkRow } from "./messenger/gateway-frames.ts";
import { realClock } from "./run.ts";

const PHASES: ReadonlySet<string> = new Set(["start", "update", "stop"]);
const STATES: ReadonlySet<string> = new Set(["running", "done", "failed"]);

const gateway = (cli: Cli): Gateway =>
  new Gateway(unixConnector, realClock, gatewaySocketPath(cli.config.gateway.socket));

/** `--row running:Build the image`; rows are numbered by position, so the same list keeps its ids across updates. */
const rowsOf = (cli: Cli): WorkRow[] =>
  cli.strings("row").map((row, i) => {
    const at = row.indexOf(":");
    const state = row.slice(0, at);
    const label = row.slice(at + 1).trim();
    if (at < 0 || !STATES.has(state) || !label)
      die(`--row must be running|done|failed:<label>, got ${JSON.stringify(row)}`);
    return { id: `r${i + 1}`, label, state: state as WorkRow["state"] };
  });

/** `--line "Total=12,000 KRW"`: one receipt line, split at the first `=`. */
const linesOf = (cli: Cli) =>
  cli.strings("line").map((line) => {
    const at = line.indexOf("=");
    if (at <= 0 || at === line.length - 1) die(`--line must be <label>=<value>, got ${JSON.stringify(line)}`);
    return { label: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  });

export const sendGateway = async (cli: Cli): Promise<void> => {
  const gw = gateway(cli);
  const phase = cli.opt("status");
  const receipt = cli.opt("receipt");
  if (phase !== undefined) {
    if (!PHASES.has(phase)) die("--status must be start, update or stop");
    const id = await gw.status(phase as StatusPhase, cli.need("text"), rowsOf(cli), cli.opt("status-id"));
    console.log(`STATUS ${id}`);
  } else if (cli.values["question"]) {
    const options = cli.strings("option").map((label, i) => ({ id: `o${i + 1}`, label: label.trim() }));
    if (options.length < 2) die("--question needs at least two --option");
    console.log(`QUESTION ${await gw.question(cli.need("text"), options)}`);
  } else if (receipt !== undefined) {
    console.log(`SENT ${await gw.receipt(receipt, linesOf(cli))}`);
  } else {
    const text = cli.need("text");
    const target = cli.values["edit"] === undefined ? undefined : cli.opt("edit") || die("--edit is empty");
    if (target !== undefined) await gw.edit(target, text);
    else console.log(`SENT ${await gw.post(text)}`);
  }
};

/** The shape of the other messengers' lines: `INBOUND <source> <channel> <thread|-> <id> <user|-> <json text>`. */
export const formatGatewayInbound = (sessionId: string, i: InboundFrame): string =>
  i.kind === "message"
    ? `INBOUND gateway ${sessionId} - ${i.id} - ${JSON.stringify(i.text.slice(0, 200))}`
    : `INBOUND gateway:answer ${sessionId} ${i.question_id} ${i.id} - ${JSON.stringify((i.text ?? "").slice(0, 200))}${i.option_id ? ` option=${i.option_id}` : ""}`;

/**
 * `--engine`: no agent session reads stdout, so each inbound goes to the Dori's main session on the engine host
 * (SENPI_RPC_SOCKET, OMO_CODING_AGENT_DIR) and is acked only once the engine has taken it.
 */
const inboundToEngine = async (cli: Cli): Promise<void> => {
  if (cli.opt("session") !== undefined) die("--session is not used with --engine: the engine names the session");
  const socket = process.env["SENPI_RPC_SOCKET"] || die("inbound gateway --engine needs SENPI_RPC_SOCKET");
  const agentDir = process.env["OMO_CODING_AGENT_DIR"] || die("inbound gateway --engine needs OMO_CODING_AGENT_DIR");
  const sessionFile = cli.opt("session-file") || die("inbound gateway --engine needs --session-file");
  if (!sessionFile.startsWith("/")) die("--session-file must be an absolute path");
  const cwd = cli.opt("cwd");
  const lead = new EngineLead(unixEngine(socket, agentDir), {
    sessionFile,
    ...(cwd === undefined ? {} : { cwd }),
    createIfMissing: cli.values["create-session"] === true,
  });
  const session = await lead
    .session()
    .catch((error: unknown) =>
      die(`inbound gateway --engine: ${error instanceof Error ? error.message : "engine unavailable"}`),
    );
  console.log("INBOUND_READY gateway engine");
  const report = (line: string) => (line.startsWith("INBOUND_NOT_HANDED") ? console.error(line) : console.log(line));
  await gateway(cli).subscribe(session, handToEngine(lead, report));
};

export const inboundGateway = async (cli: Cli): Promise<void> => {
  if (cli.values["engine"]) return await inboundToEngine(cli);
  const id =
    cli.opt("session") || process.env["PI_SESSION_ID"] || die("inbound gateway needs --session or PI_SESSION_ID");
  const path =
    cli.opt("session-file") ||
    process.env["PI_SESSION_FILE"] ||
    die("inbound gateway needs --session-file or PI_SESSION_FILE");
  if (!path.startsWith("/")) die("--session-file must be an absolute path");
  console.log("INBOUND_READY gateway");
  await gateway(cli).subscribe({ id, path }, (session, inbound) => console.log(formatGatewayInbound(session, inbound)));
};
