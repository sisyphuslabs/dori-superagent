import { stat } from "node:fs/promises";

import type { EngineConnector, EngineLink } from "./engine-link.ts";
import { field, text } from "./fields.ts";
import type { LeadPort } from "./gateway.ts";
import type { AnnouncedSession, InboundFrame } from "./gateway-frames.ts";
import { MessengerError } from "./http.ts";

/** What the Dori's session is given for one message or answer from the dori.bot chat: a function of the row alone. */
export const promptOf = (inbound: InboundFrame): string => {
  const said =
    inbound.kind === "message"
      ? `The owner wrote in the dori.bot chat:\n\n${inbound.text}`
      : `The owner answered your question ${inbound.question_id} in the dori.bot chat` +
        `${inbound.option_id === undefined ? "" : ` with option ${inbound.option_id}`}` +
        `${inbound.text === undefined ? "." : `:\n\n${inbound.text}`}`;
  return `${said}\n\n(Reply with \`dori send gateway\`; the dori.bot rules are in the dori-mode skill's rules/dori-bot.md.)`;
};

export type MainSession = {
  readonly sessionFile: string;
  /** The folder a newly created session works in; an existing session keeps its own. */
  readonly cwd?: string;
  /** Only the caller that owns the file's path may let a missing file become a new, empty session. */
  readonly createIfMissing?: boolean;
};
type Opened = { readonly link: EngineLink; readonly handle: string; readonly session: AnnouncedSession };
const failed = (code: string) => new MessengerError(`engine refused the follow_up: ${code}`, 0, code);

/**
 * The Dori's main session on the engine host, reached over one long-lived connection: a message is handed as a
 * follow-up that starts a turn when the session is idle and joins the running one otherwise, keyed by the room row id
 * so a resend after a lost ack is the same input to the engine. Every (re)open must find the same session it first
 * announced, or nothing is handed.
 */
export class EngineLead {
  private opened: Promise<Opened> | null = null;
  private announced: AnnouncedSession | null = null;

  constructor(
    private readonly connect: EngineConnector,
    private readonly main: MainSession,
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
      // The engine already admitted this row under its id: a resend after a lost ack.
      if (reply.success || reply.errorCode === "client_message_id_conflict") return;
      if (this.opened === opening) this.opened = null;
      link.close();
      if (reply.lost !== "closed" || attempt > 0)
        throw failed(reply.errorCode ?? (reply.lost === "timeout" ? "engine_timeout" : "engine_refused"));
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
    const { sessionFile, cwd, createIfMissing = false } = this.main;
    if (!createIfMissing && (await stat(sessionFile).catch(() => null)) === null)
      throw new MessengerError("engine session file missing", 0, "engine_session_missing");
    const link = await this.connect();
    const reply = await link.request({
      type: "open_session",
      sessionPath: sessionFile,
      retain_on_disconnect: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const handle = text(field(reply.data, "sessionId"));
    const state = field(reply.data, "state");
    const durable = text(field(state, "sessionId"));
    const file = text(field(state, "sessionFile"));
    const changed = this.announced !== null && durable !== this.announced.id;
    if (!reply.success || handle === undefined || durable === undefined || file !== sessionFile || changed) {
      link.close();
      throw new MessengerError(
        changed ? "engine session changed behind the file" : "engine refused the session",
        0,
        "engine_session",
      );
    }
    this.announced ??= { id: durable, path: sessionFile };
    return { link, handle, session: this.announced };
  }
}

/**
 * The lead port `inbound gateway --engine` subscribes with: a row is handed or the error goes back to the
 * subscription (which acks nothing and tries again). `report` gets one line per attempt, by seq and code only.
 */
export const handToEngine =
  (lead: EngineLead, report: (line: string) => void): LeadPort =>
  async (_, inbound) => {
    try {
      await lead.hand(inbound);
    } catch (error) {
      const code = error instanceof MessengerError && error.code !== undefined ? error.code : "failed";
      report(`INBOUND_NOT_HANDED gateway ${inbound.seq} ${code}`);
      throw error;
    }
    report(`INBOUND_HANDED gateway ${inbound.seq}`);
  };
