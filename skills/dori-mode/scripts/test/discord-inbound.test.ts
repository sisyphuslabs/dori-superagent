import { describe, expect, test } from "bun:test";
import {
  DiscordInbound,
  formatInbound,
  HELLO_WAIT_MS,
  type ChannelGuild,
  type ChannelHistory,
  type Clock,
  type CursorStore,
  type GatewaySocket,
  type Inbound,
  type InboundCursors,
  type MediaStore,
} from "../src/messenger/discord-inbound.ts";

const inertClock: Clock = { setInterval: () => 1, clearInterval: () => {} };

const silentSocket = (): GatewaySocket => ({ send: () => {}, close: () => {}, onMessage: () => {} });

const cursorStore = (initial: InboundCursors) => {
  const writes: InboundCursors[] = [];
  let current: InboundCursors = initial;
  const store: CursorStore = {
    read: async () => current,
    write: async (next) => {
      writes.push(next);
      current = next;
    },
  };
  return { store, writes, current: () => current };
};

type Row = { id: string; channel_id: string; guild_id?: string; content?: string; author?: { id?: string; username?: string; bot?: boolean }; attachments?: readonly unknown[] };

const row = (id: string, channel: string, authorId = "someone", content = `m${id}`): Row => ({
  id,
  channel_id: channel,
  content,
  author: { id: authorId, username: `user-${authorId}` },
});

const mediaRow = (id: string, channel: string): Row => ({ ...row(id, channel, "someone", ""), attachments: [{ url: `https://cdn/${id}.png`, filename: `${id}.png` }] });

const newestFirst = (...rows: Row[]): readonly unknown[] => rows;

type Harness = {
  inbound: DiscordInbound;
  delivered: Inbound[];
  events: string[];
  calls: { channel: string; after: string }[];
};

const harness = (opts: {
  cursors: CursorStore;
  rowsFor: (channel: string, after: string) => Promise<readonly unknown[]>;
  selfId?: string;
  guild?: ChannelGuild;
  media?: MediaStore | null;
}): Harness => {
  const delivered: Inbound[] = [];
  const events: string[] = [];
  const calls: { channel: string; after: string }[] = [];
  const history: ChannelHistory = async (channel, after) => {
    calls.push({ channel, after });
    return opts.rowsFor(channel, after);
  };
  const inbound = new DiscordInbound(
    silentSocket,
    "token",
    inertClock,
    opts.selfId ?? "self",
    (i) => delivered.push(i),
    (line) => events.push(line),
    opts.media ?? null,
    opts.cursors,
    history,
    opts.guild ?? (async () => "guild-1"),
  );
  return { inbound, delivered, events, calls };
};

describe("DiscordInbound backfill", () => {
  test("delivers the messages after the stored cursor in order and moves the cursor to the newest", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => newestFirst(row("103", "ch1"), row("102", "ch1"), row("101", "ch1")),
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.calls).toEqual([{ channel: "ch1", after: "100" }]);
    expect(h.delivered.map((i) => i.messageId)).toEqual(["101", "102", "103"]);
    expect(h.delivered.map((i) => i.text)).toEqual(["m101", "m102", "m103"]);
    expect(h.delivered.every((i) => i.source === "guild" && i.guild === "guild-1")).toBe(true);
    expect(cursorState.current()).toEqual({ ch1: "103" });
    expect(cursorState.writes.at(-1)).toEqual({ ch1: "103" });
    expect(h.events.some((e) => e.startsWith("backfill fetched 3 message(s) in ch1, delivered 3"))).toBe(true);
  });

  test("a message the bot itself posted is not delivered, but the cursor still passes it", async () => {
    const cursorState = cursorStore({ ch1: "200" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => newestFirst(row("202", "ch1", "self"), row("201", "ch1")),
      selfId: "self",
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.delivered.map((i) => i.messageId)).toEqual(["201"]);
    expect(cursorState.current()).toEqual({ ch1: "202" });
  });

  test("a failing history call stops that channel's backfill and leaves the reason on onEvent", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const h = harness({
      cursors: cursorState.store,
      rowsFor: async () => {
        throw new Error("502 bad gateway");
      },
    });

    h.inbound.start();
    await h.inbound.idle();

    expect(h.calls).toEqual([{ channel: "ch1", after: "100" }]);
    expect(h.delivered).toEqual([]);
    expect(cursorState.writes).toEqual([]);
    expect(h.events).toContain("backfill stopped for ch1: 502 bad gateway");
  });
});

describe("DiscordInbound delivery guarantee", () => {
  test("a media message's cursor moves only after its line is out", async () => {
    const cursorState = cursorStore({ ch1: "300" });
    let releaseSave = () => {};
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => (saveStarted = resolve));
    const media: MediaStore = {
      save: async (messageId) => {
        saveStarted();
        await new Promise<void>((resolve) => (releaseSave = resolve));
        return [`/state/${messageId}.png`];
      },
    };
    const h = harness({ cursors: cursorState.store, rowsFor: async () => newestFirst(mediaRow("301", "ch1")), media });

    h.inbound.start();
    await started;
    // The download is in flight: nothing has printed and the cursor must still be behind.
    expect(h.delivered).toEqual([]);
    expect(cursorState.writes).toEqual([]);

    releaseSave();
    await h.inbound.idle();

    expect(h.delivered.map((i) => i.media)).toEqual([["/state/301.png"]]);
    expect(cursorState.current()).toEqual({ ch1: "301" });
  });

  test("a text line waits for an earlier message's download instead of overtaking it", async () => {
    const cursorState = cursorStore({ ch1: "500" });
    let releaseSave = () => {};
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => (saveStarted = resolve));
    const order: string[] = [];
    const media: MediaStore = {
      save: async (messageId) => {
        saveStarted();
        await new Promise<void>((resolve) => (releaseSave = resolve));
        return [`/state/${messageId}.png`];
      },
    };
    const inbound = new DiscordInbound(
      silentSocket,
      "token",
      inertClock,
      "self",
      (i) => order.push(`LINE ${i.messageId}`),
      () => {},
      media,
      cursorState.store,
      async () => newestFirst(row("502", "ch1"), mediaRow("501", "ch1")),
      async () => "guild-1",
    );

    inbound.start();
    await started;
    expect(order).toEqual([]);

    releaseSave();
    await inbound.idle();

    expect(order).toEqual(["LINE 501", "LINE 502"]);
    expect(cursorState.current()).toEqual({ ch1: "502" });
  });

  test("a line that never came out leaves the cursor behind, so a restart prints the message again", async () => {
    const cursorState = cursorStore({ ch1: "400" });
    const attempts: string[] = [];
    const events: string[] = [];
    const inbound = new DiscordInbound(
      silentSocket,
      "token",
      inertClock,
      "self",
      () => {
        attempts.push("line");
        throw new Error("stdout closed");
      },
      (line) => events.push(line),
      null,
      cursorState.store,
      async () => newestFirst(row("401", "ch1")),
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();

    expect(attempts).toEqual(["line"]);
    expect(cursorState.writes).toEqual([]);
    expect(events.some((e) => e.startsWith("delivery failed: stdout closed"))).toBe(true);
  });

  test("the line carries the whole text, so a long message is distinguishable from a short one", () => {
    const text = "x".repeat(4000);
    const line = formatInbound({
      source: "guild",
      channel: "c1",
      guild: "g1",
      messageId: "9",
      author: "someone",
      authorIsBot: false,
      text,
    });

    expect(line).toContain(JSON.stringify(text));
    expect(line.split("\n")).toHaveLength(1);
  });
});
type Timer = { cb: () => void; ms: number };

/** Keeps every timer the class arms, even after clearInterval, so a test can fire a callback the
 * clock had already queued and prove it cannot touch the socket that replaced it. */
const manualClock = () => {
  const live: Timer[] = [];
  const all: Timer[] = [];
  const cleared: unknown[] = [];
  const clock: Clock = {
    setInterval: (cb, ms) => {
      const t = { cb, ms };
      all.push(t);
      live.push(t);
      return t;
    },
    clearInterval: (h) => {
      cleared.push(h);
      const i = live.indexOf(h as Timer);
      if (i >= 0) live.splice(i, 1);
    },
    setTimeout: (cb, ms) => {
      const t = { cb, ms };
      all.push(t);
      live.push(t);
      return t;
    },
    clearTimeout: (h) => {
      cleared.push(h);
      const i = live.indexOf(h as Timer);
      if (i >= 0) live.splice(i, 1);
    },
  };
  return { clock, live, all, cleared };
};

const fakeSocket = () => {
  const sent: Record<string, unknown>[] = [];
  let handler: (data: string) => void = () => {};
  let closer: (code: number, reason: string) => void = () => {};
  const s = {
    sent,
    closes: 0,
    send: (data: string) => void sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => void s.closes++,
    onMessage: (cb: (data: string) => void) => {
      handler = cb;
    },
    onClose: (cb: (code: number, reason: string) => void) => {
      closer = cb;
    },
    deliver: (payload: unknown) => handler(JSON.stringify(payload)),
    /** HELLO is always the first frame Discord sends, on every connection. */
    hello: (interval = 1000) => s.deliver({ op: 10, d: { heartbeat_interval: interval } }),
    closeWith: (code: number, reason = "") => closer(code, reason),
  };
  return s;
};

const gateway = (clock: Clock) => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const open = () => {
    const s = fakeSocket();
    sockets.push(s);
    return s;
  };
  const events: string[] = [];
  const inbound = new DiscordInbound(open, "token", clock, "self", () => {}, (line) => events.push(line));
  return { sockets, events, inbound };
};

describe("DiscordInbound HELLO wait", () => {
  test("a socket that connects but never sends HELLO is closed, reconnected once, and the reason is reported", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    expect(g.sockets).toHaveLength(1);
    const wait = clock.all.filter((t) => t.ms === HELLO_WAIT_MS);
    expect(wait).toHaveLength(1);

    wait[0]!.cb();

    expect(g.sockets[0]!.closes).toBe(1);
    expect(g.sockets).toHaveLength(1);
    const delay = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toHaveLength(1);
    delay[0]!.cb();
    expect(g.sockets).toHaveLength(2);
    expect(g.events).toEqual([`gateway sent no HELLO within ${HELLO_WAIT_MS / 1000}s; reconnecting`]);
    // The replacement socket is watched by its own HELLO timer, and the fired one is gone.
    expect(clock.all.filter((t) => t.ms === HELLO_WAIT_MS)).toHaveLength(2);
    expect(clock.live.filter((t) => t.ms === HELLO_WAIT_MS)).toHaveLength(1);
  });

  test("HELLO clears the wait timer, and the callback the clock had already queued cannot close the healthy socket", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    const wait = clock.all.find((t) => t.ms === HELLO_WAIT_MS)!;

    g.sockets[0]!.hello(30_000);

    expect(clock.cleared).toContain(wait);
    expect(clock.live).not.toContain(wait);
    expect(clock.live.filter((t) => t.ms === 30_000)).toHaveLength(1);

    wait.cb();

    expect(g.sockets).toHaveLength(1);
    expect(g.sockets[0]!.closes).toBe(0);
    expect(g.events.filter((e) => e.includes("HELLO"))).toEqual([]);
  });

  test("after stop() the HELLO wait is cleared, and a queued callback or a late HELLO reconnects nothing", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    const wait = clock.all.find((t) => t.ms === HELLO_WAIT_MS)!;

    g.inbound.stop();
    expect(clock.live).toEqual([]);

    wait.cb();
    g.sockets[0]!.hello();

    expect(g.sockets).toHaveLength(1);
    expect(g.events).toEqual([]);
  });
});


describe("DiscordInbound cursor safety (#87 review)", () => {
  const ready = (s: { deliver: (p: unknown) => void }) => s.deliver({ op: 0, t: "READY", d: { session_id: "s1" } });

  test("a live message does not move a channel's cursor while that channel's catch-up is still running", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    let releaseHistory = () => {};
    let historyStarted = () => {};
    const started = new Promise<void>((resolve) => (historyStarted = resolve));
    const clock = manualClock();
    const g = gateway(clock.clock);
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async () => {
        historyStarted();
        await new Promise<void>((resolve) => (releaseHistory = resolve));
        return newestFirst(row("101", "ch1"));
      },
      async () => "guild-1",
    );

    inbound.start();
    await started;

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("150", "ch1") });
    expect(cursorState.current()).toEqual({ ch1: "100" });

    releaseHistory();
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "101" });

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("151", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "151" });
  });
  test("a catch-up that stopped early leaves the cursor behind, and the next live message cannot overtake the gap", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const clock = manualClock();
    const g = gateway(clock.clock);
    let fail = true;
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async () => {
        if (fail) throw new Error("502 bad gateway");
        return [];
      },
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();
    expect(g.events).toContain("backfill stopped for ch1: 502 bad gateway");

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("150", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "100" });

    fail = false;
    ready(g.sockets[0]!);
    await inbound.idle();

    g.sockets[0]!.deliver({ op: 0, t: "MESSAGE_CREATE", d: row("151", "ch1") });
    await inbound.idle();
    expect(cursorState.current()).toEqual({ ch1: "151" });
  });

  test("a fresh identify after op 9 runs catch-up again, so the outage window is replayed", async () => {
    const cursorState = cursorStore({ ch1: "100" });
    const clock = manualClock();
    const g = gateway(clock.clock);
    const calls: { channel: string; after: string }[] = [];
    const inbound = new DiscordInbound(
      () => {
        const s = fakeSocket();
        g.sockets.push(s);
        return s;
      },
      "token",
      clock.clock,
      "self",
      () => {},
      (line) => g.events.push(line),
      null,
      cursorState.store,
      async (channel, after) => {
        calls.push({ channel, after });
        return [];
      },
      async () => "guild-1",
    );

    inbound.start();
    await inbound.idle();
    expect(calls).toHaveLength(1);

    g.sockets[0]!.deliver({ op: 9, d: false });
    const delay = clock.live.find((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toBeDefined();
    delay!.cb();

    ready(g.sockets.at(-1)!);
    await inbound.idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ channel: "ch1", after: "100" });
  });
});

describe("DiscordInbound reconnect safety (#87 review)", () => {
  test("op 9 waits a random 1-5 s before identifying again instead of reconnecting at once", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();
    expect(g.sockets).toHaveLength(1);

    g.sockets[0]!.deliver({ op: 9, d: false });

    expect(g.sockets).toHaveLength(1);
    const delays = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delays).toHaveLength(1);
    delays[0]!.cb();
    expect(g.sockets).toHaveLength(2);
  });

  test("repeated op 9 frames back off, so a storm cannot open a socket per frame", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.deliver({ op: 9, d: false });
    const first = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    first[0]!.cb();
    g.sockets[1]!.deliver({ op: 9, d: false });
    const second = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 60_000 && !first.includes(t));
    expect(second).toHaveLength(1);
    expect(second[0]!.ms).toBeGreaterThan(first[0]!.ms);
    expect(g.sockets).toHaveLength(2);
  });

  test("a fatal close code stops the loop instead of identifying forever", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.closeWith(4004, "Authentication failed");

    expect(g.sockets).toHaveLength(1);
    expect(clock.live.filter((t) => t.ms >= 1000 && t.ms <= 60_000)).toHaveLength(0);
    expect(g.events.some((e) => e.includes("4004"))).toBe(true);
  });

  test("a non-fatal close code reconnects after a delay", () => {
    const clock = manualClock();
    const g = gateway(clock.clock);
    g.inbound.start();

    g.sockets[0]!.closeWith(1006, "");

    const delay = clock.live.filter((t) => t.ms >= 1000 && t.ms <= 5000);
    expect(delay).toHaveLength(1);
    delay[0]!.cb();
    expect(g.sockets).toHaveLength(2);
  });
});
