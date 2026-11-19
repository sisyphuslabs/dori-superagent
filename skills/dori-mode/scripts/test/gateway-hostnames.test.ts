import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..");
// Every file of the dori.bot surface. The other messengers name their own public API hosts and are not part of it.
const SURFACE = [
  "scripts/src/messenger/gateway.ts",
  "scripts/src/messenger/gateway-frames.ts",
  "scripts/src/cli-gateway.ts",
  "scripts/src/boot-gateway.ts",
  "scripts/src/surface-rules.ts",
  "rules/dori-bot.md",
  "references/gateway-socket.md",
];
const HOSTNAME =
  /\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|bot|co|gg|cloud|sh|me|xyz|kr|jp|local|internal|lan|run|tech|so))\b/gi;

const hostnamesIn = (text: string): string[] => [...text.matchAll(HOSTNAME)].map((m) => m[0].toLowerCase());

test("the scan finds hostnames, addresses and localhost", () => {
  expect(hostnamesIn("see https://api.example.com/x, 10.0.0.1, localhost:8080 and dori.bot")).toEqual([
    "api.example.com",
    "10.0.0.1",
    "localhost",
    "dori.bot",
  ]);
});

test("the gateway surface names no hostname other than dori.bot", () => {
  const found = SURFACE.flatMap((file) =>
    hostnamesIn(readFileSync(join(SKILL, file), "utf8"))
      .filter((host) => host !== "dori.bot")
      .map((host) => `${file}: ${host}`),
  );
  expect(found).toEqual([]);
});
