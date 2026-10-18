import { describe, expect, it } from "vitest";
import {
  appendSegment,
  applyBrightness,
  applyCalibration,
  bisectNext,
  composeCalibration,
  downgrade,
  withSegmentStarts,
  type Capabilities,
  type Segment,
} from "./model";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  onoff: true,
  brightness: true,
  rgb: true,
  kelvin: [2000, 6500],
  effects: ["Rainbow"],
  addressable: false,
  segments: false,
  ledCountConfig: false,
  whiteOnly: false,
  ...over,
});

const seg = (id: string, ord: number, ledCount: number): Omit<Segment, "ledStart"> => ({
  id, deviceId: "d", ord, name: id, ledCount, reverse: false, calibration: {},
});

describe("composeCalibration", () => {
  it("returns an empty calibration when nothing is set", () => {
    expect(composeCalibration({})).toEqual({});
  });
  it("lets the segment override gamma and colour order", () => {
    const c = composeCalibration({ gamma: 2.2, colorOrder: "RGB" }, { gamma: 1.8, colorOrder: "GRB" });
    expect(c.gamma).toBe(1.8);
    expect(c.colorOrder).toBe("GRB");
  });
  it("keeps device gamma when the segment has none", () => {
    expect(composeCalibration({ gamma: 2.2 }, {}).gamma).toBe(2.2);
  });
  it("multiplies gains across device, segment and profile", () => {
    const c = composeCalibration({ gains: [1, 0.5, 1] }, { gains: [0.5, 1, 1] }, { gains: [1, 1, 0.8] });
    expect(c.gains).toEqual([0.5, 0.5, 0.8]);
  });
  it("takes the lowest briCap and the highest briMin", () => {
    const c = composeCalibration({ briCap: 0.9, briMin: 0.05 }, { briCap: 0.7 }, { briMin: 0.1, briCap: 0.8 });
    expect(c.briCap).toBe(0.7);
    expect(c.briMin).toBe(0.1);
  });
  it("sums kelvin offsets", () => {
    expect(composeCalibration({ kelvinOffset: 100 }, { kelvinOffset: -50 }, { kelvinOffset: 200 }).kelvinOffset).toBe(250);
  });
  it("ignores the profile for gamma and colour order", () => {
    const c = composeCalibration({}, null, { gamma: 3, colorOrder: "BGR" });
    expect(c.gamma).toBeUndefined();
    expect(c.colorOrder).toBeUndefined();
  });
});

describe("applyCalibration", () => {
  it("is the identity with gamma 1 and no gains", () => {
    expect(applyCalibration([12, 128, 250], { gamma: 1 })).toEqual([12, 128, 250]);
    expect(applyCalibration([12, 128, 250], {})).toEqual([12, 128, 250]);
  });
  it("applies gains per channel", () => {
    expect(applyCalibration([200, 200, 200], { gains: [1, 0.5, 0] })).toEqual([200, 100, 0]);
  });
  it("applies gamma as (v/255)^gamma*255", () => {
    const [r] = applyCalibration([128, 0, 255], { gamma: 2 });
    expect(r).toBe(Math.round((128 / 255) ** 2 * 255));
    expect(applyCalibration([0, 255, 0], { gamma: 2.2 })).toEqual([0, 255, 0]);
  });
  it("reorders into GRB wire order", () => {
    expect(applyCalibration([10, 20, 30], { colorOrder: "GRB" })).toEqual([20, 10, 30]);
  });
  it("reorders into BGR wire order", () => {
    expect(applyCalibration([10, 20, 30], { colorOrder: "BGR" })).toEqual([30, 20, 10]);
  });
  it("clamps gains above 1 to 255", () => {
    expect(applyCalibration([200, 10, 10], { gains: [2, 1, 1] })).toEqual([255, 10, 10]);
  });
});

describe("applyBrightness", () => {
  it("keeps 0 as 0 even with a briMin", () => {
    expect(applyBrightness(0, { briMin: 0.2 })).toBe(0);
  });
  it("raises low values to briMin", () => {
    expect(applyBrightness(5, { briMin: 0.2 })).toBe(20);
  });
  it("caps high values at briCap", () => {
    expect(applyBrightness(100, { briCap: 0.6 })).toBe(60);
  });
  it("passes through values inside the range", () => {
    expect(applyBrightness(42, { briMin: 0.1, briCap: 0.9 })).toBe(42);
  });
  it("never exceeds 100 without a calibration", () => {
    expect(applyBrightness(150, {})).toBe(100);
  });
});

describe("withSegmentStarts", () => {
  it("computes ledStart as a prefix sum", () => {
    const s = withSegmentStarts([seg("a", 0, 10), seg("b", 1, 5), seg("c", 2, 7)]);
    expect(s.map((x) => x.ledStart)).toEqual([0, 10, 15]);
  });
  it("sorts by ord before summing (after a reorder)", () => {
    const s = withSegmentStarts([seg("c", 2, 7), seg("a", 1, 10), seg("b", 0, 5)]);
    expect(s.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(s.map((x) => x.ledStart)).toEqual([0, 5, 15]);
  });
  it("returns an empty list for no segments", () => {
    expect(withSegmentStarts([])).toEqual([]);
  });
});

describe("appendSegment", () => {
  it("gives the first segment ord 0 and start 0", () => {
    const s = appendSegment([], { name: "Bandă", ledCount: 1, deviceId: "melk" });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ ord: 0, ledStart: 0, deviceId: "melk", name: "Bandă" });
  });
  it("uses ord = max + 1 even with gaps", () => {
    const s = appendSegment([seg("a", 0, 10), seg("b", 4, 5)], { name: "new", ledCount: 3 });
    const last = s[s.length - 1];
    expect(last?.ord).toBe(5);
    expect(last?.ledStart).toBe(15);
    expect(last?.deviceId).toBe("d");
  });
  it("does not mutate the input", () => {
    const input = [seg("a", 0, 10)];
    appendSegment(input, { name: "x", ledCount: 1 });
    expect(input).toHaveLength(1);
  });
});

describe("downgrade", () => {
  it("reduces off to just on:false", () => {
    expect(downgrade({ on: false, rgb: [1, 2, 3], brightnessPct: 40 }, caps())).toEqual({ on: false });
  });
  it("keeps a full state on a capable light", () => {
    expect(downgrade({ on: true, rgb: [1, 2, 3], brightnessPct: 40, effect: "Rainbow" }, caps())).toEqual({ on: true, rgb: [1, 2, 3], brightnessPct: 40, effect: "Rainbow" });
  });
  it("never yields rgb on a whiteOnly light and falls back to 3000 K", () => {
    const out = downgrade({ on: true, rgb: [255, 0, 0] }, caps({ whiteOnly: true, rgb: true }));
    expect(out.rgb).toBeUndefined();
    expect(out.kelvin).toBe(3000);
  });
  it("keeps an explicit kelvin on a whiteOnly light", () => {
    const out = downgrade({ on: true, rgb: [255, 0, 0], kelvin: 4000 }, caps({ whiteOnly: true }));
    expect(out).toEqual({ on: true, kelvin: 4000 });
  });
  it("never yields rgb on whiteOnly for any colour", () => {
    for (let i = 0; i < 20; i++) {
      const out = downgrade({ on: true, rgb: [i * 12, 255 - i * 12, i] }, caps({ whiteOnly: true, kelvin: null }));
      expect(out.rgb).toBeUndefined();
    }
  });
  it("drops rgb when the light has no colour", () => {
    expect(downgrade({ on: true, rgb: [1, 2, 3] }, caps({ rgb: false })).rgb).toBeUndefined();
  });
  it("drops brightness when the light cannot dim", () => {
    expect(downgrade({ on: true, brightnessPct: 50 }, caps({ brightness: false })).brightnessPct).toBeUndefined();
  });
  it("clamps kelvin into the supported range and drops unknown effects", () => {
    const out = downgrade({ on: true, kelvin: 9000, effect: "Nope" }, caps());
    expect(out.kelvin).toBe(6500);
    expect(out.effect).toBeUndefined();
  });
});

describe("bisectNext", () => {
  it("returns the first probe without an answer", () => {
    expect(bisectNext({ lo: 0, hi: 60 })).toEqual({ lo: 0, hi: 60, probe: 30, done: false });
  });
  it("moves hi down when the probe reaches the end", () => {
    expect(bisectNext({ lo: 0, hi: 60, answer: true })).toMatchObject({ lo: 0, hi: 30, probe: 15 });
  });
  it("moves lo up when the probe falls short", () => {
    expect(bisectNext({ lo: 0, hi: 60, answer: "short" })).toMatchObject({ lo: 30, hi: 60, probe: 45 });
  });
  it("is done immediately when hi - lo is 1", () => {
    expect(bisectNext({ lo: 4, hi: 5 })).toEqual({ lo: 4, hi: 5, probe: 5, done: true });
  });
  it("converges to N for every N in 1..60 within ceil(log2(60)) steps", () => {
    const max = Math.ceil(Math.log2(60));
    for (let n = 1; n <= 60; n++) {
      let step = bisectNext({ lo: 0, hi: 60 });
      let steps = 0;
      while (!step.done) {
        step = bisectNext({ lo: step.lo, hi: step.hi, answer: step.probe >= n });
        steps++;
        expect(steps).toBeLessThanOrEqual(max);
      }
      expect(step.hi).toBe(n);
      expect(step.probe).toBe(n);
    }
  });
});
