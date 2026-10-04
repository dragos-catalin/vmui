import { describe, expect, it, vi } from "vitest";
import { EffectLimiter, type LimiterConfig } from "./effect-limiter";

function fakeClock() {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: t + ms, fn });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    advance(ms: number) {
      t += ms;
      for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.at <= t) timer.fn();
        else timers.push(timer);
      }
    },
    pending: () => timers.length,
  };
}

const config: LimiterConfig = { cooldownMs: { flash: 1_500, scene: 10_000 }, idempotencyTtlMs: 60_000, maxEntries: 50 };

describe("EffectLimiter", () => {
  it("runs the first call and limits the next one inside the cooldown", async () => {
    const clock = fakeClock();
    const lim = new EffectLimiter(config, clock);
    const run = vi.fn(async () => "x");
    expect(await lim.submit("k1", "flash", undefined, run)).toEqual({ status: "ran", result: "x" });
    clock.advance(500);
    expect(await lim.submit("k1", "flash", undefined, run)).toEqual({ status: "limited", retryAfterMs: 1_000, queued: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cooldown is per key and per effect kind", async () => {
    const clock = fakeClock();
    const lim = new EffectLimiter(config, clock);
    const run = async () => 1;
    await lim.submit("k1", "flash", undefined, run);
    expect((await lim.submit("k2", "flash", undefined, run)).status).toBe("ran");
    expect((await lim.submit("k1", "scene", undefined, run)).status).toBe("ran");
    clock.advance(1_500);
    expect((await lim.submit("k1", "flash", undefined, run)).status).toBe("ran");
    clock.advance(1_000);
    expect((await lim.submit("k1", "scene", undefined, run)).status).toBe("limited");
  });

  it("merges a burst into one trailing run where the last call wins", async () => {
    const clock = fakeClock();
    const lim = new EffectLimiter(config, clock);
    const calls: string[] = [];
    const mk = (id: string) => async () => { calls.push(id); };
    await lim.submit("k", "scene", undefined, mk("a"));
    await lim.submit("k", "scene", undefined, mk("b"));
    await lim.submit("k", "scene", undefined, mk("c"));
    await lim.submit("k", "scene", undefined, mk("d"));
    expect(calls).toEqual(["a"]);
    expect(clock.pending()).toBe(1);
    clock.advance(10_000);
    await Promise.resolve();
    expect(calls).toEqual(["a", "d"]);
    // the trailing run starts a new window
    expect((await lim.submit("k", "scene", undefined, mk("e"))).status).toBe("limited");
    clock.advance(10_000);
    await Promise.resolve();
    expect(calls).toEqual(["a", "d", "e"]);
  });

  it("dedupes an idempotencyKey for the TTL and returns the first outcome", async () => {
    const clock = fakeClock();
    const lim = new EffectLimiter(config, clock);
    const run = vi.fn(async () => "gift");
    const first = await lim.submit("k", "flash", "evt-1", run);
    clock.advance(5_000);
    const again = await lim.submit("k", "flash", "evt-1", run);
    expect(again).toEqual({ status: "duplicate", first });
    expect(run).toHaveBeenCalledTimes(1);
    clock.advance(60_000);
    expect((await lim.submit("k", "flash", "evt-1", run)).status).toBe("ran");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("idempotency is per key", async () => {
    const lim = new EffectLimiter(config, fakeClock());
    const run = vi.fn(async () => 0);
    await lim.submit("k1", "flash", "evt", run);
    expect((await lim.submit("k2", "flash", "evt", run)).status).toBe("ran");
  });

  it("stays bounded", async () => {
    const clock = fakeClock();
    const lim = new EffectLimiter({ ...config, maxEntries: 10 }, clock);
    for (let i = 0; i < 100; i++) await lim.submit(`k${i}`, "flash", `e${i}`, async () => 0);
    expect(lim.size().slots).toBeLessThanOrEqual(10);
    expect(lim.size().idempotency).toBeLessThanOrEqual(10);
  });

  it("reports deferred failures instead of throwing", async () => {
    const clock = fakeClock();
    const onErr = vi.fn();
    const lim = new EffectLimiter(config, clock, onErr);
    await lim.submit("k", "flash", undefined, async () => 0);
    await lim.submit("k", "flash", undefined, async () => { throw new Error("ha down"); });
    clock.advance(1_500);
    await new Promise((r) => setTimeout(r, 0));
    expect(onErr).toHaveBeenCalledOnce();
  });
});
