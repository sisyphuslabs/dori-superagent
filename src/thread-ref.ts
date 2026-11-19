export type ThreadRef = { readonly platform: Platform; readonly channel: string; readonly threadId?: string };

type Platform = "slack" | "telegram" | "discord";

export class RefError extends Error {}

const PLATFORMS: readonly Platform[] = ["slack", "telegram", "discord"];
const SLACK_TS = /^\d+(\.\d+)?$/;
const INT_ID = /^\d+$/;

/**
 * Reads a `platform:channel/thread` ref, the form `dori start --thread` takes. A lane's thread is posted to by an argv
 * hook, so a ref that cannot address one thread is refused here, before a lane opens and long before a post is tried.
 */
export const parseThreadRef = (ref: string): ThreadRef => {
  const text = ref.trim();
  if (!text) throw new RefError("thread ref is empty");
  if (text === "none") throw new RefError("thread ref is none: this lane has no thread to post to");
  const colon = text.indexOf(":");
  if (colon < 0) throw new RefError(`thread ref ${ref} has no platform (expected platform:channel/thread)`);
  const platform = text.slice(0, colon).trim();
  if (!PLATFORMS.includes(platform as Platform))
    throw new RefError(`thread ref ${ref} names an unknown platform ${platform}`);
  const rest = text.slice(colon + 1);
  const slash = rest.lastIndexOf("/");
  const channel = (slash < 0 ? rest : rest.slice(0, slash)).trim();
  const threadId = slash < 0 ? undefined : rest.slice(slash + 1).trim();
  if (!channel) throw new RefError(`thread ref ${ref} has no channel`);
  if (/\s/.test(channel)) throw new RefError(`thread ref ${ref} has whitespace in its channel`);
  if (threadId !== undefined) {
    if (!threadId) throw new RefError(`thread ref ${ref} ends with "/" and no thread id`);
    const numeric = platform === "slack" ? SLACK_TS.test(threadId) : INT_ID.test(threadId);
    if (!numeric) throw new RefError(`thread ref ${ref} has a non-numeric thread id ${threadId}`);
  }
  return { platform: platform as Platform, channel, ...(threadId ? { threadId } : {}) };
};
