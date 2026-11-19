/**
 * The frames on the gateway's local socket, one JSON object per line. A hand-written copy of the published shapes
 * (references/gateway-socket.md); nothing here is imported from the gateway itself.
 */

export type GatewayResultCode = "ok" | "queued" | "unbound" | "invalid" | "too_large" | "unavailable";

export type WorkRow = { readonly id: string; readonly label: string; readonly state: "running" | "done" | "failed" };
export type QuestionOption = { readonly id: string; readonly label: string };
export type ReceiptLine = { readonly label: string; readonly value: string };
export type StatusPhase = "start" | "update" | "stop";

export type SendFrame = { readonly op: "send"; readonly op_id: string } & (
  | { readonly kind: "post"; readonly text: string }
  | { readonly kind: "edit"; readonly target_id: string; readonly text: string }
  | {
      readonly kind: "status";
      readonly status_id: string;
      readonly phase: StatusPhase;
      readonly text: string;
      readonly rows: readonly WorkRow[];
    }
  | { readonly kind: "question"; readonly text: string; readonly options: readonly QuestionOption[] }
  | { readonly kind: "receipt"; readonly title: string; readonly lines: readonly ReceiptLine[] }
);

export type DoriToGatewayFrame =
  | { readonly op: "ping" }
  | SendFrame
  | { readonly op: "subscribe"; readonly session_id: string; readonly session_path: string }
  | { readonly op: "ack"; readonly seq: number };

export type ResultFrame = {
  readonly op: "result";
  readonly re: DoriToGatewayFrame["op"] | "unknown";
  readonly code: GatewayResultCode;
  readonly op_id?: string;
  readonly seq?: number;
  readonly contract_version?: number;
};

type InboundBase = {
  readonly op: "inbound";
  readonly seq: number;
  readonly session_id: string;
  readonly id: string;
  readonly created_at: number;
};
export type InboundFrame = InboundBase &
  (
    | { readonly kind: "message"; readonly text: string }
    | { readonly kind: "answer"; readonly question_id: string; readonly option_id?: string; readonly text?: string }
  );

/** The lead session a subscription announces: its id, and the absolute path of its session file. */
export type AnnouncedSession = { readonly id: string; readonly path: string };

export type GatewayToDoriFrame = ResultFrame | InboundFrame;

const CODES: ReadonlySet<string> = new Set(["ok", "queued", "unbound", "invalid", "too_large", "unavailable"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const seqOf = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** One line from the gateway, or undefined when it is not a frame this client knows. */
export const parseGatewayLine = (line: string): GatewayToDoriFrame | undefined => {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  if (v["op"] === "result") return str(v["re"]) && CODES.has(String(v["code"])) ? (v as ResultFrame) : undefined;
  if (v["op"] !== "inbound" || !seqOf(v["seq"]) || !str(v["session_id"]) || !str(v["id"])) return undefined;
  if (v["kind"] === "message") return str(v["text"]) ? (v as InboundFrame) : undefined;
  if (v["kind"] === "answer" && str(v["question_id"]) && (str(v["option_id"]) || str(v["text"])))
    return v as InboundFrame;
  return undefined;
};
