import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { adoptLane, LaunchError } from "../src/launch.ts";
import { hcTerm } from "./hc-runner.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: ReturnType<typeof newWorld>;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const briefWithDone = (name = "brief.md"): string => {
  const path = join(state.dir, name);
  writeFileSync(path, "# task\n- Done = closed acme/app#3. The lane closes only when every signal reads back live.\n");
  return path;
};

test("adopt refuses a pane no herdr pane backs and registers nothing", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const err = await adoptLane(deps, {
    key: "demo",
    title: "t",
    brief: briefWithDone(),
    done: "closed acme/app#3",
    pane: "w:p2",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LaunchError);
  expect((err as Error).message).toContain("does not own");
  expect(await deps.registry.read("demo")).toBeNull();
});

test("adopt refuses a missing brief and a brief without a Done line", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  world.panes.push({ pane_id: "w:p2", workspace_id: "w" });
  await expect(
    adoptLane(deps, {
      key: "demo",
      title: "t",
      brief: join(state.dir, "gone.md"),
      done: "closed acme/app#3",
      pane: "w:p2",
    }),
  ).rejects.toThrow("brief not found");
  const plain = join(state.dir, "plain.md");
  writeFileSync(plain, "# task\nno done line here\n");
  await expect(
    adoptLane(deps, { key: "demo", title: "t", brief: plain, done: "closed acme/app#3", pane: "w:p2" }),
  ).rejects.toThrow("no Done line");
  expect(await deps.registry.read("demo")).toBeNull();
});

test("adopt takes over a pane that belongs to dori's own panes and registers it", async () => {
  world.panes.push({ pane_id: "w:p2", workspace_id: "w" });
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const lane = await adoptLane(deps, {
    key: "demo",
    title: "t",
    brief: briefWithDone(),
    done: "closed acme/app#3",
    pane: "w:p2",
  });
  expect(lane.pane).toBe("w:p2");
  expect((await deps.registry.read("demo"))?.pane).toBe("w:p2");
});

test("on hc, adopt only takes a terminal labelled into the lane group", async () => {
  world.terminals = {
    t7: hcTerm({ labels: { "dori.group": "lanes" } }),
    t9: hcTerm({ title: "swarm worker" }),
  };
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", laneWorkspace: "lanes" });
  const lane = await adoptLane(deps, {
    key: "demo",
    title: "t",
    brief: briefWithDone(),
    done: "closed acme/app#3",
    pane: "hc:t7",
  });
  expect(lane.pane).toBe("t7");
  await expect(
    adoptLane(deps, {
      key: "other",
      title: "t",
      brief: briefWithDone("brief2.md"),
      done: "closed acme/app#3",
      pane: "hc:t9",
    }),
  ).rejects.toThrow("does not own");
});
