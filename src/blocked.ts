// Blocked panes: an omo pane whose agent is waiting on a permission dialog reports `agent_status: "blocked"`, and
// nothing in dori used to notice. This module reads that dialog off the visible screen (the only place the question
// text exists for a TUI session) so the duty loop can report it. It never sends keys: answering a dialog is a policy
// question, not a feature (see issue #113).
//
// Measured on omo 5.1.60 (2026-11-05), a blocked TUI pane shows:
//
//   Permission required: eval
//
//   Tool: eval
//
//   Patterns:
//     - *
//
//   → Allow once
//     Allow always
//     Deny
//     Deny with feedback
//
//   ↑↓ navigate  enter select  esc/ctrl+c cancel
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PanePrompt = {
  readonly title: string;
  readonly options: readonly string[];
  readonly selected: number;
};

export type BlockedPane = { readonly pane: string; readonly key?: string; readonly prompt: PanePrompt | null };

const MAX_OPTION_LABEL = 60;
const MAX_OPTIONS = 9;
const HEADING_LOOKUP_LINES = 12;

const SELECTED = /^\s*(?:→|›|>)\s+(\S.*?)\s*$/;
const PLAIN_OPTION = /^\s{0,3}(\S.*?)\s*$/;
const FOOTER = /navigate/i;
const PERMISSION_HEADING = /^.*\bPermission required:\s*(.+?)\s*$/;

const stripped = (line: string): string => Bun.stripANSI(line).trimEnd();

/**
 * The dialog a blocked pane is showing, or null when the visible screen does not positively show one. A question
 * that is not a permission prompt parses as null too; the pane is still reported as blocked, just without its text.
 */
export const parsePanePrompt = (screen: string): PanePrompt | null => {
  const lines = Bun.stripANSI(screen).split("\n").map(stripped);
  // The hint line closes the dialog; a screen without it in view is not a dialog we can read.
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i]!) && lines.length - i <= 15) {
      footer = i;
      break;
    }
  }
  if (footer < 1) return null;
  let end = footer - 1;
  while (end >= 0 && lines[end]!.trim() === "") end--;
  if (end < 0) return null;
  let start = end;
  for (let i = end; i >= 0; i--) {
    if (lines[i]!.trim() === "") break;
    start = i;
  }
  const labels: string[] = [];
  const marked: number[] = [];
  for (let i = start; i <= end; i++) {
    const line = lines[i]!;
    const arrow = SELECTED.exec(line);
    const label = (arrow ? arrow[1]! : PLAIN_OPTION.exec(line)?.[1] ?? "").trim();
    if (!label || label.length > MAX_OPTION_LABEL) return null;
    if (arrow) marked.push(labels.length);
    labels.push(label);
  }
  if (labels.length < 2 || labels.length > MAX_OPTIONS) return null;
  // Exactly one arrow is what makes this a choice list rather than a paragraph that happens to sit above a hint.
  if (marked.length !== 1) return null;
  let heading = "";
  for (let i = start - 1, seen = 0; i >= 0 && seen < HEADING_LOOKUP_LINES; i--, seen++) {
    const line = lines[i]!;
    if (PERMISSION_HEADING.test(line)) {
      heading = line.trim();
      break;
    }
    if (!heading && line.trim() !== "") heading = line.trim();
  }
  return { title: heading.slice(0, 160), options: labels, selected: marked[0]! };
};

/** The screen's clock ticks while a dialog waits, so a repeat alert keys on what the dialog asks, not its pixels. */
export const promptFingerprint = (p: PanePrompt | null): string => (p ? `${p.title}\u0000${p.options.join("\u0000")}` : "unparsed");

type BlockedState = Record<string, { readonly fingerprint: string; readonly at: number }>;

const readState = (path: string): BlockedState => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BlockedState = {};
    for (const [pane, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { fingerprint?: unknown; at?: unknown };
      if (typeof v?.fingerprint === "string" && typeof v?.at === "number") out[pane] = { fingerprint: v.fingerprint, at: v.at };
    }
    return out;
  } catch {
    return {};
  }
};

const writeState = (path: string, state: BlockedState): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

/** A pane still blocked on the same question is reported again only after this long. */
export const BLOCKED_REPEAT_MS = 15 * 60_000;

type Plan = { readonly state: Readonly<Record<string, { readonly fingerprint: string; readonly at: number }>> };

/**
 * Plans which blocked panes need a report, without touching disk. State is keyed by pane and remembers the last
 * reported question, so a pane is reported once, again when it asks something new, and again when the same question
 * has gone unanswered for the repeat window. A pane that is no longer blocked is forgotten, so its next block is new.
 */
export const planBlockedAlerts = (path: string, blocked: readonly BlockedPane[], now: number, repeatMs = BLOCKED_REPEAT_MS): {
  readonly fresh: readonly BlockedPane[];
  readonly state: Plan["state"];
} => {
  const previous = readState(path);
  const state: Record<string, { readonly fingerprint: string; readonly at: number }> = {};
  const fresh: BlockedPane[] = [];
  for (const entry of blocked) {
    const fingerprint = promptFingerprint(entry.prompt);
    const seen = previous[entry.pane];
    const isFresh = !seen || seen.fingerprint !== fingerprint || now - seen.at >= repeatMs;
    if (isFresh) fresh.push(entry);
    state[entry.pane] = isFresh ? { fingerprint, at: now } : seen;
  }
  return { fresh, state };
};

/**
 * Saves the plan once the reports went out. A fresh pane whose report did not reach anyone keeps no record, so the
 * next sweep reports it again instead of waiting out the repeat window for an alert nobody saw.
 */
export const commitBlockedAlerts = (path: string, plan: Plan, delivered: ReadonlySet<string>): void => {
  const previous = readState(path);
  const next: BlockedState = {};
  for (const [pane, value] of Object.entries(plan.state)) {
    const unchanged = previous[pane] && previous[pane]!.fingerprint === value.fingerprint && previous[pane]!.at === value.at;
    if (unchanged || delivered.has(pane)) next[pane] = value;
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) writeState(path, next);
};

export const blockedPath = (stateDir: string): string => `${stateDir}/duty/blocked.json`;

/** Target is the lane key when there is one, else the pane id. */
export const blockedMessage = (entry: BlockedPane): string => {
  const target = entry.key ?? entry.pane;
  const question = entry.prompt ? ` ${entry.prompt.title}.` : " (the dialog text is not readable on screen; look at the pane).";
  const options = entry.prompt ? ` options: ${entry.prompt.options.join(" | ")}.` : "";
  return `[BLOCKED ${target}] ${entry.pane} is waiting for input:${question}${options} Answer it in that pane, or check dori blocked.`;
};

export const formatBlocked = (entry: BlockedPane, at?: number): string =>
  `${entry.pane.padEnd(8)} ${(entry.key ?? "-").padEnd(24)} ${entry.prompt ? entry.prompt.title : "blocked (no readable dialog)"}${
    at === undefined ? "" : `  first seen ${new Date(at).toISOString().slice(11, 19)}Z`
  }`;

export const blockedStateAt = (path: string, pane: string): number | undefined => (existsSync(path) ? readState(path)[pane]?.at : undefined);

export const forgetBlocked = (path: string, pane: string): void => {
  const state = readState(path);
  if (!(pane in state)) return;
  delete state[pane];
  writeState(path, state);
};
