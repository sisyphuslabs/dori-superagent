import { existsSync } from "node:fs";

import type { Gateway } from "./messenger/gateway.ts";
import { loadSurfaceRules } from "./surface-rules.ts";

/** null when no gateway socket is present (not a Dori VM); boot then skips the surface, as Slack with no token. */
export type GatewayCheck = () => Promise<{ readonly contractVersion: number | undefined } | null>;

export const gatewayCheck =
  (gateway: Pick<Gateway, "ping">, socketPath: string, exists: (path: string) => boolean = existsSync): GatewayCheck =>
  async () =>
    exists(socketPath) ? { contractVersion: await gateway.ping() } : null;

/** The boot lines for the gateway surface; a socket that does not answer within the deadline is a failed check. */
export const gatewayBootLines = async (
  check: GatewayCheck,
  deadlineMs: number,
): Promise<{ readonly failed: boolean; readonly lines: readonly string[] }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      check(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
      }),
    ]);
    if (result === "timeout") return { failed: true, lines: [`GATEWAY ping timed out after ${deadlineMs} ms`] };
    if (result === null) return { failed: false, lines: ["GATEWAY skipped (no gateway socket)"] };
    const reachable = `GATEWAY reachable contract=${result.contractVersion ?? "-"}`;
    try {
      return {
        failed: false,
        lines: [reachable, `GATEWAY rules rules/dori-bot.md: ${loadSurfaceRules("gateway").join(" ")}`],
      };
    } catch {
      return { failed: true, lines: [reachable, "GATEWAY rules unreadable rules/dori-bot.md"] };
    }
  } catch {
    return { failed: true, lines: ["GATEWAY unavailable"] };
  } finally {
    clearTimeout(timer);
  }
};
