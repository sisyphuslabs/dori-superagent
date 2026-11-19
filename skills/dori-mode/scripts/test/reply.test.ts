import { expect, test } from "bun:test";
import { join } from "node:path";

import { fill } from "../src/config.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { type DeliveryEnv, planFromArgv, post } from "../src/reply.ts";
import { RefError } from "../src/thread-ref.ts";
import { fakeClock, withState } from "./fakes.ts";

const fakeHttp = (
  script: (req: HttpRequest, n: number) => HttpResponse = () => ok({ ok: true, channel: "C1", ts: "111.222" }),
) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: JSON.stringify(body),
});

const envFor = (http: Http, dir: string): DeliveryEnv => ({
  http,
  clock: fakeClock(0),
  slackAuth: () => ({ token: "t" }),
  telegramToken: () => "b",
  discordToken: () => "b",
  ledgerFile: join(dir, "slack-threads.json"),
});

const deliver = async (argv: readonly string[], script?: (req: HttpRequest, n: number) => HttpResponse) => {
  const { http, seen } = fakeHttp(script);
  const state = withState();
  try {
    const printed = await post(planFromArgv(argv), envFor(http, state.dir));
    return { printed, seen, body: (i: number) => JSON.parse(String(seen[i]?.body)) };
  } finally {
    state.done();
  }
};

test("reply to slack:channel/thread posts into that channel with the thread as thread_ts", async () => {
  const { printed, seen, body } = await deliver(["reply", "slack:C123/1234.5678", "--text", "deploy finished"]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://slack.com/api/chat.postMessage");
  expect(body(0)).toEqual({ channel: "C123", text: "deploy finished", thread_ts: "1234.5678" });
  expect(printed).toBe("SENT 111.222");
});

test("reply to a bare slack channel stays a channel post with no thread_ts", async () => {
  const { body } = await deliver(["reply", "slack:C123", "--text", "hi"]);
  expect(body(0)).toEqual({ channel: "C123", text: "hi" });
});

test("reply to telegram:chat/topic carries chat_id and message_thread_id", async () => {
  const { seen, body } = await deliver(["reply", "telegram:42/7", "--text", "deploy finished"], () =>
    ok({ ok: true, result: { message_id: 5 } }),
  );
  expect(seen[0]?.url).toBe("https://api.telegram.org/botb/sendMessage");
  expect(body(0)).toEqual({ chat_id: "42", message_thread_id: 7, text: "deploy finished" });
});

test("reply to discord:channel/thread posts into the thread channel", async () => {
  const { seen, body } = await deliver(["reply", "discord:111/222", "--text", "deploy finished"], () =>
    ok({ id: "333" }),
  );
  expect(seen[0]?.url).toBe("https://discord.com/api/v10/channels/222/messages");
  expect(body(0)).toEqual({ content: "deploy finished", allowed_mentions: { parse: [] } });
});

test("reply --edit ID updates that message instead of posting a new one", async () => {
  const { seen, body } = await deliver(["reply", "slack:C123/1234.5678", "--text", "fixed", "--edit", "111.222"], () =>
    ok({ ok: true }),
  );
  expect(seen[0]?.url).toBe("https://slack.com/api/chat.update");
  expect(body(0)).toEqual({ channel: "C123", ts: "111.222", text: "fixed" });
});

test("the old wiring, which passed the whole platform:channel/ts ref as --to, posts to a channel of that literal name with no thread", async () => {
  const { body } = await deliver(["send", "slack", "--to", "slack:C123/1234.5678", "--text", "deploy finished"]);
  expect(body(0)).toEqual({ channel: "slack:C123/1234.5678", text: "deploy finished" });
});

test("a ref with no thread to post to is refused before any request goes out", async () => {
  for (const ref of ["none", "C123/1.1", "mattermost:C1/1", "slack:C1/not-a-ts", "slack:/1.1", "slack:C1/"]) {
    const { http, seen } = fakeHttp();
    expect(() => planFromArgv(["reply", ref, "--text", "x"])).toThrow(RefError);
    expect(seen).toHaveLength(0);
    void http;
  }
});

test("reply needs text, and text carrying a $( substitution is refused before any request goes out", async () => {
  expect(() => planFromArgv(["reply", "slack:C1/1.1"])).toThrow(RefError);
  const { http, seen } = fakeHttp();
  const state = withState();
  try {
    await expect(
      post(planFromArgv(["reply", "slack:C1/1.1", "--text", "$(whoami)"]), envFor(http, state.dir)),
    ).rejects.toThrow("$(");
  } finally {
    state.done();
  }
  expect(seen).toHaveLength(0);
});

const exampleHooks = async (): Promise<Record<string, string[]>> => {
  const config = (await Bun.file(join(import.meta.dir, "../../references/config.example.json")).json()) as {
    hooks?: Record<string, string[]>;
  };
  return config.hooks ?? {};
};

const subcommandAt = (argv: readonly string[]): number => {
  const at = argv.findIndex((a) => a === "reply" || a === "send");
  if (at < 0) throw new Error(`hook argv names no send or reply subcommand: ${argv.join(" ")}`);
  return at;
};

test("the shipped example config wires both thread hooks to a reply that lands in the lane's channel and thread", async () => {
  const example = await exampleHooks();
  for (const hook of ["threadReply", "threadDone"]) {
    const argv = example[hook];
    if (!argv) throw new Error(`the example config has no hooks.${hook}`);
    const filled = fill(argv, { thread: "slack:C123/1234.5678", text: "deploy finished", key: "demo-lane" });
    const { body } = await deliver(filled.slice(subcommandAt(filled)));
    expect(body(0)).toEqual({ channel: "C123", text: "deploy finished", thread_ts: "1234.5678" });
  }
});
