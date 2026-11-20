import type { Exec } from "../exec.ts";
import { spawnExec, ToolError } from "../exec.ts";
import type {
  AgentStatus,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { parseLaunch } from "./command.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Json = Record<string, unknown>;

/** An operation omo does not expose to another process yet. The message names the missing omo capability. */
export class OmoGapError extends Error {}

export type OmoRuntimeOptions = { readonly env?: Env; readonly log?: (line: string) => void };

const STATUS: Readonly<Record<string, AgentStatus>> = { running: "working", idle: "idle", ended: "gone" };
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * OmO behind the session runtime interface: every step is one `omo remote <verb> --json` call, so a session lives on
 * this device or on any other signed-in device of the account (`DORI_OMO_DEVICE`), reached through the device service
 * and the relay. A ref id is `<device>/<session>`. No herdr, hc or bunshin binary is involved.
 */
export class OmoRuntime implements SessionRuntime {
  readonly kind = "omo";
  private readonly env: Env;
  private readonly log: (line: string) => void;
  private device: string | undefined;

  constructor(
    private readonly exec: Exec = spawnExec,
    options: OmoRuntimeOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((line) => void process.stderr.write(`${line}\n`));
  }

  private get bin(): string {
    return this.env["DORI_OMO_BIN"] || "omo";
  }

  /** One `omo remote` call; a non-zero exit, non-JSON output or an `error` result throws with omo's own reason. */
  private async call(argv: readonly string[]): Promise<Json> {
    const parsed = await this.callAny(argv);
    if (!isJson(parsed)) throw new Error(`omo remote ${argv[0]} --json did not print an object`);
    return parsed;
  }

  private async callAny(argv: readonly string[]): Promise<unknown> {
    const full = ["remote", ...argv, "--json"];
    const result = await this.exec(this.bin, full);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new ToolError(full, { ...result, code: result.code || 1 }, this.bin);
    }
    if (result.code !== 0 || (isJson(parsed) && parsed["kind"] === "error")) {
      const error = isJson(parsed) && isJson(parsed["error"]) ? parsed["error"] : {};
      const why = [str(error["code"]), str(error["message"])].filter(Boolean).join(": ");
      throw new ToolError(full, { ...result, code: result.code || 1, stderr: why || result.stderr }, this.bin);
    }
    return parsed;
  }

  /** `DORI_OMO_DEVICE`, else the device `omo remote devices` marks as this one. */
  private async target(): Promise<string> {
    this.device ??= str(this.env["DORI_OMO_DEVICE"]) ?? (await this.thisDevice());
    return this.device;
  }

  private async thisDevice(): Promise<string> {
    const rows = await this.callAny(["devices"]);
    const own = Array.isArray(rows) ? rows.find((d) => isJson(d) && d["this_device"] === true) : undefined;
    const id = isJson(own) ? str(own["device"]) : undefined;
    if (id === undefined) throw new Error("omo remote devices names no device as this one: sign in with omo login");
    return id;
  }

  /** `DORI_OMO_SELF` (`<device>/<session>`): omo gives a session's own shell no id of its own session yet. */
  self(): SessionRef | undefined {
    const id = str(this.env["DORI_OMO_SELF"]);
    return id === undefined ? undefined : { runtime: "omo", id };
  }

  /** omo sessions carry no label: a group is only the name Dori records beside the ref. */
  async createGroup(label: string, _cwd: string): Promise<string> {
    return label;
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    const keys = Object.keys(spec.env);
    if (keys.length > 0)
      this.log(
        `dori: omo cannot set ${keys.join(", ")} on a session it opens (omo remote open has no --env); ${spec.name} runs without them`,
      );
    const device = await this.target();
    const opened = await this.call(["open", device, "--project", spec.cwd]);
    const thread = isJson(opened["thread"]) ? opened["thread"] : {};
    const session = str(thread["thread_id"]);
    if (session === undefined) throw new Error("omo remote open returned no thread_id");
    return { runtime: "omo", id: `${str(thread["device"]) ?? device}/${session}`, group: spec.group ?? "dori" };
  }

  /** The launch command is applied, not typed: its model is switched to, then its system-prompt text and prompt are sent. */
  async start(ref: SessionRef, command: string): Promise<void> {
    const launch = parseLaunch(command);
    if (launch.model !== undefined) await this.call(["model", ref.id, launch.model]);
    for (const text of [launch.appendSystemPrompt, launch.prompt])
      if (text !== undefined) await this.call(["send", ref.id, text, "--no-wait"]);
  }

  async list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    const rows = (await this.call(["sessions"]))["rows"];
    const out: SessionInfo[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isJson(row)) continue;
      const [device, session] = [str(row["device"]), str(row["session_id"])];
      const status = STATUS[String(row["state"])];
      if (device === undefined || session === undefined || status === "gone") continue;
      const [title, cwd] = [str(row["title"]), str(row["project"])];
      out.push({
        ref: {
          runtime: "omo",
          id: `${device}/${session}`,
          ...(filter?.group === undefined ? {} : { group: filter.group }),
        },
        ...(title === undefined ? {} : { name: title, title }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(status === undefined ? {} : { status }),
        agent: "omo",
      });
    }
    return out;
  }

  async probe(ref: SessionRef): Promise<Probe> {
    const found = (await this.list()).find((s) => s.ref.id === ref.id);
    if (found === undefined) return { status: "gone", shellInFront: false };
    return {
      status: found.status ?? "unknown",
      agent: "omo",
      shellInFront: false,
      ...(found.cwd ? { cwd: found.cwd } : {}),
    };
  }

  async read(_ref: SessionRef, _lines: number): Promise<string> {
    throw new OmoGapError(
      "omo remote has no read verb: a session's transcript cannot be read from another process yet",
    );
  }

  /** `idle` sends only to an idle session; `working` queues behind the running turn (--follow-up); `any` lets omo pick. */
  async deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    const when = opts?.when ?? "idle";
    const { status } = await this.probe(ref);
    if (status === "gone") return { kind: "no-agent" };
    if (when !== "any" && status !== when) return { kind: "not-ready", status };
    const sent = await this.call(["send", ref.id, text, "--no-wait", ...(when === "working" ? ["--follow-up"] : [])]);
    const delivery = isJson(sent["delivery"]) ? sent["delivery"] : {};
    return { kind: "delivered", started: delivery["kind"] === "started" || delivery["kind"] === "steered" };
  }

  /** omo sends whole messages: nothing is ever left typed and waiting for an Enter. */
  async submitTyped(): Promise<SubmitResult> {
    return "changed";
  }

  /** An omo session has no shell to type into. */
  async typeIntoShell(): Promise<boolean> {
    return false;
  }

  /** escape stops the running turn; enter has nothing to submit. */
  async keys(ref: SessionRef, names: readonly Key[]): Promise<void> {
    if (names.includes("escape")) await this.call(["interrupt", ref.id]);
  }

  async close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    await this.call(["close", ref.id]);
  }
}
