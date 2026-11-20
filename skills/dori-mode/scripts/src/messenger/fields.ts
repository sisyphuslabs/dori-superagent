/** Reading untyped JSON from the engine: a record, one of its fields, and a non-empty string. */
export type Fields = Readonly<Record<string, unknown>>;
export const isRecord = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
export const field = (v: unknown, name: string): unknown => (isRecord(v) ? v[name] : undefined);
export const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
