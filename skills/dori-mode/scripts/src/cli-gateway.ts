/** dori send gateway and dori inbound gateway: the dori.bot surface over the gateway's local socket. */
import type { Cli } from "./cli-context.ts";
import { die } from "./cli-context.ts";
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

export const inboundGateway = async (cli: Cli): Promise<void> => {
  const sessionId =
    cli.opt("session") || process.env["PI_SESSION_ID"] || die("inbound gateway needs --session or PI_SESSION_ID");
  console.log("INBOUND_READY gateway");
  await gateway(cli).subscribe(sessionId, (session, inbound) => console.log(formatGatewayInbound(session, inbound)));
};
