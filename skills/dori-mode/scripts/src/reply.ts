import type { Clock } from "./run.ts";
import { Discord } from "./messenger/discord.ts";
import type { Http } from "./messenger/http.ts";
import { Slack, type SlackAuth } from "./messenger/slack.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { Telegram } from "./messenger/telegram.ts";
import { type Platform, parseThreadRef, RefError } from "./thread-ref.ts";

export type Delivery = {
  readonly platform: Platform;
  readonly channel: string;
  readonly threadTs?: string;
  readonly text: string;
  readonly editTs?: string;
};

export type DeliveryEnv = {
  readonly http: Http;
  readonly clock: Clock;
  readonly slackAuth: () => SlackAuth;
  readonly telegramToken: () => string;
  readonly discordToken: () => string;
  readonly ledgerFile: string;
  readonly slackBase?: string;
};

const PLATFORMS: readonly string[] = ["slack", "telegram", "discord"];

export const planFromArgv = (argv: readonly string[]): Delivery => {
  const [command = "", ...args] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) throw new RefError(`${command}: ${arg} needs a value`);
    flags.set(arg.slice(2), value);
    i++;
  }
  const text = flags.get("text");
  if (text === undefined) throw new RefError(`${command} needs --text`);
  const editTs = flags.get("edit");
  const target = positionals[0] ?? "";
  if (command === "reply") {
    const ref = parseThreadRef(target);
    return {
      platform: ref.platform,
      channel: ref.channel,
      ...(ref.threadId ? { threadTs: ref.threadId } : {}),
      text,
      ...(editTs ? { editTs } : {}),
    };
  }
  if (command === "send") {
    if (!PLATFORMS.includes(target))
      throw new RefError(`send needs slack, telegram or discord, not ${target || "nothing"}`);
    const to = flags.get("to");
    if (to === undefined) throw new RefError("send needs --to");
    const thread = flags.get("thread");
    return {
      platform: target as Platform,
      channel: to,
      ...(thread ? { threadTs: thread } : {}),
      text,
      ...(editTs ? { editTs } : {}),
    };
  }
  throw new RefError(`${command} does not take a message (send and reply do)`);
};

export const post = async (delivery: Delivery, env: DeliveryEnv): Promise<string> => {
  const { platform, channel, threadTs, text, editTs } = delivery;
  if (platform === "slack") {
    const slack = new Slack(env.http, env.clock, env.slackAuth(), env.slackBase, new ThreadLedger(env.ledgerFile));
    if (editTs) {
      await slack.edit(channel, editTs, text);
      return `EDITED ${editTs}`;
    }
    return `SENT ${(await slack.post(channel, text, threadTs)).ts}`;
  }
  if (platform === "telegram") {
    const tg = new Telegram(env.http, env.clock, env.telegramToken());
    const target = { chatId: channel, ...(threadTs ? { threadId: Number(threadTs) } : {}) };
    if (editTs) {
      await tg.edit(target, Number(editTs), text);
      return `EDITED ${editTs}`;
    }
    return `SENT ${await tg.send(target, text)}`;
  }
  const dc = new Discord(env.http, env.clock, env.discordToken());
  if (editTs) {
    await dc.edit(channel, editTs, text);
    return `EDITED ${editTs}`;
  }
  return `SENT ${await dc.send(threadTs ?? channel, text)}`;
};
