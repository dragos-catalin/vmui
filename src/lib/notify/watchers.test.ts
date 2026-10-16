import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/home/access", () => ({ ownerActor: async () => null }));
vi.mock("@/lib/home/credentials", () => ({ haConfig: () => null }));
vi.mock("@/lib/home/ha-client", () => ({ ha: {} }));
vi.mock("@/lib/nutrition/summary", () => ({ nutritionSummary: async () => null }));
vi.mock("./index", () => ({ notify: async () => null, dismissByTag: async () => undefined }));
vi.mock("./settings", () => ({ loadNotifySettings: async () => ({}) }));

import { pcStep, type PcWatch } from "./watchers";

function run(samples: boolean[]) {
  let st: PcWatch = { offN: 0 };
  const edges: Array<string | null> = [];
  for (const s of samples) {
    const r = pcStep(st, s);
    st = r.st;
    edges.push(r.edge);
  }
  return edges;
}

describe("pcStep (PC agent debounce)", () => {
  it("first sample after restart never fires, online or offline", () => {
    expect(run([false])).toEqual([null]);
    expect(run([true])).toEqual([null]);
  });

  it("a single offline sample (sleep/wake flap) does not alert", () => {
    expect(run([true, false, true, false, true])).toEqual([null, null, null, null, null]);
  });

  it("alerts once after 2 consecutive offline samples, then stays quiet", () => {
    expect(run([true, false, false, false, false])).toEqual([null, null, "offline", null, null]);
  });

  it("back online after a confirmed outage dismisses once", () => {
    expect(run([true, false, false, true, true])).toEqual([null, null, "offline", "online", null]);
  });

  it("starting offline then coming online dismisses any stale card", () => {
    expect(run([false, false, true])).toEqual([null, null, "online"]);
  });
});
