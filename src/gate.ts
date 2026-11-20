import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prompt, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { loadHooks, substitute } from "./hooks.ts";
import type { MergeOutcome } from "./telemetry.ts";

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

type Verdict = "CLEAR" | "BLOCK";
type VerdictScan = { kind: "none" } | { kind: "verdict"; verdict: Verdict } | { kind: "ambiguous"; values: Verdict[] };

/** The original contract: a column-zero line, trailing rationale allowed (`VERDICT: CLEAR — 4 LOW findings`). */
const PLAIN_VERDICT = /^VERDICT:\s*(CLEAR|BLOCK)(?![A-Za-z0-9])(?![_-][A-Za-z0-9])/;

/** The incident's shape: nothing but the verdict once markdown emphasis and backticks are removed. */
const EMPHASISED_VERDICT = /^VERDICT\s*:\s*(CLEAR|BLOCK)$/;

/** A bullet, list, or blockquote marker never introduces a verdict, even when its mark could pass as emphasis. */
const MARKER = /^\s*(?:[-+]|\*|\d+[.)]|>)\s/;

/**
 * Two compatible shapes: the original column-zero `VERDICT: CLEAR|BLOCK` line (trailing rationale included), and a
 * whole line that is only that verdict wrapped in markdown emphasis or backticks. Indented lines, bullets, blockquotes
 * and fenced examples never count. Plain lines keep legacy last-match; plain and emphasised lines that disagree are
 * ambiguous and write no receipt.
 */
function scanVerdicts(stdout: string): VerdictScan {
  const plain: Verdict[] = [];
  const emphasised: Verdict[] = [];
  let fence: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (mark) {
      // A fence closes only on the same marker character with at least the opening run's length.
      if (fence === undefined) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined || MARKER.test(raw) || /^\s/.test(raw)) continue;
    const p = PLAIN_VERDICT.exec(raw);
    if (p) {
      plain.push(p[1] as Verdict);
      continue;
    }
    const e = EMPHASISED_VERDICT.exec(raw.replace(/[`*_]/g, "").trim());
    if (e && /[`*_]/.test(raw)) emphasised.push(e[1] as Verdict);
  }
  if (plain.length === 0 && emphasised.length === 0) return { kind: "none" };
  if (emphasised.length === 0) return { kind: "verdict", verdict: plain.at(-1)! };
  if (plain.length === 0) {
    const values = [...new Set(emphasised)];
    return values.length === 1 ? { kind: "verdict", verdict: values[0]! } : { kind: "ambiguous", values };
  }
  const values = [...new Set([...plain, ...emphasised])];
  return values.length === 1 ? { kind: "verdict", verdict: values[0]! } : { kind: "ambiguous", values };
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(
  d: Deps,
  prId: string,
  model?: string,
): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  // hooks.reviewCommand replaces the built-in reviewer; it must print a VERDICT line like the built-in one.
  const hook = loadHooks(d.store.root).reviewCommand;
  const sha = await headSha(d, pr);
  const vars = { pr: pr.id, repo: pr.repo, number: String(pr.number), sha };
  const text = prompt("review.md", vars);
  const [cmd, ...argv] = hook
    ? substitute(hook, { ...vars, text })
    : [d.agentCmd, "-p", "--no-session", ...(model ? ["--model", model] : []), text];
  const res = await d.exec(cmd ?? d.agentCmd, argv);
  const scan = scanVerdicts(res.stdout);
  if (res.code !== 0 || scan.kind !== "verdict") {
    const name = `${pr.id.replaceAll("/", "__").replace("#", "_")}@${sha}-${randomUUID()}.noverdict.txt`;
    const diagnostic = join(d.store.root, "receipts", name);
    writeFileSync(diagnostic, res.stdout.split(/\r?\n/).slice(-200).join("\n"), { flag: "wx", mode: 0o600 });
    const reason =
      res.code !== 0
        ? `reviewer exited ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`
        : scan.kind === "ambiguous"
          ? `reviewer printed conflicting verdicts (${scan.values.join(" and ")})`
          : "reviewer printed no VERDICT line";
    throw new Error(`${reason}; no receipt written; reviewer output saved to ${diagnostic}`);
  }
  const verdict = scan.verdict;
  d.store.saveReceipt({
    pr: pr.id,
    sha,
    verdict,
    model: hook ? "hook" : (model ?? "default"),
    at: d.now(),
    summary: res.stdout.trim().slice(-4000),
  });
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}
