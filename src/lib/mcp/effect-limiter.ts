/**
 * Guards physical light effects driven by agents and TikSee chat/gift events:
 *
 * - per key, per effect kind cooldown (flash >= 1.5 s, scene >= 10 s by default);
 * - burst merging: calls arriving inside the window are coalesced into ONE trailing
 *   run at the end of the window, and the last call wins;
 * - idempotencyKey dedupe for 60 s, so a client retry never fires twice.
 *
 * In-memory and bounded: a restart forgets cooldowns, which is harmless.
 */

export type EffectKind = "flash" | "scene";

export type LimiterConfig = {
  cooldownMs: Record<EffectKind, number>;
  idempotencyTtlMs: number;
  /** Upper bound on tracked (key, effect) slots and on idempotency entries. */
  maxEntries: number;
};

export const DEFAULT_LIMITER_CONFIG: LimiterConfig = {
  cooldownMs: { flash: 1_500, scene: 10_000 },
  idempotencyTtlMs: 60_000,
  maxEntries: 1_000,
};

export type SubmitResult<T> =
  | { status: "ran"; result: T }
  | { status: "limited"; retryAfterMs: number; queued: true }
  | { status: "duplicate"; first: SubmitResult<T> };

type Slot = {
  lastRunAt: number;
  pending?: () => Promise<unknown>;
  scheduled?: boolean;
};

type Clock = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
};

export class EffectLimiter {
  private readonly slots = new Map<string, Slot>();
  private readonly seen = new Map<string, { at: number; outcome: Promise<SubmitResult<unknown>> }>();

  constructor(
    private readonly config: LimiterConfig = DEFAULT_LIMITER_CONFIG,
    private readonly clock: Clock = realClock,
    private readonly onDeferredError: (e: unknown) => void = () => {},
  ) {}

  async submit<T>(keyId: string, effect: EffectKind, idempotencyKey: string | undefined, run: () => Promise<T>): Promise<SubmitResult<T>> {
    const now = this.clock.now();
    if (idempotencyKey) {
      this.pruneSeen(now);
      const id = `${keyId}\u0000${idempotencyKey}`;
      const prior = this.seen.get(id);
      if (prior && now - prior.at < this.config.idempotencyTtlMs) {
        return { status: "duplicate", first: (await prior.outcome) as SubmitResult<T> };
      }
      const outcome = this.admit(keyId, effect, run, now);
      this.seen.delete(id);
      this.seen.set(id, { at: now, outcome });
      this.capMap(this.seen);
      return outcome;
    }
    return this.admit(keyId, effect, run, now);
  }

  /** Visible for tests and diagnostics. */
  size(): { slots: number; idempotency: number } {
    return { slots: this.slots.size, idempotency: this.seen.size };
  }

  private async admit<T>(keyId: string, effect: EffectKind, run: () => Promise<T>, now: number): Promise<SubmitResult<T>> {
    const slotId = `${keyId}\u0000${effect}`;
    const cooldown = this.config.cooldownMs[effect];
    const slot = this.slots.get(slotId);
    if (!slot || (!slot.scheduled && now - slot.lastRunAt >= cooldown)) {
      this.touch(slotId, { lastRunAt: now });
      return { status: "ran", result: await run() };
    }
    slot.pending = run;
    const retryAfterMs = Math.max(0, slot.lastRunAt + cooldown - now);
    if (!slot.scheduled) {
      slot.scheduled = true;
      this.clock.setTimer(() => this.flush(slotId), retryAfterMs);
    }
    this.touch(slotId, slot);
    return { status: "limited", retryAfterMs, queued: true };
  }

  private flush(slotId: string) {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    const run = slot.pending;
    slot.pending = undefined;
    slot.scheduled = false;
    if (!run) return;
    slot.lastRunAt = this.clock.now();
    run().catch(this.onDeferredError);
  }

  private touch(slotId: string, slot: Slot) {
    this.slots.delete(slotId);
    this.slots.set(slotId, slot);
    if (this.slots.size <= this.config.maxEntries) return;
    for (const [id, s] of this.slots) {
      if (this.slots.size <= this.config.maxEntries) break;
      if (!s.scheduled) this.slots.delete(id);
    }
  }

  private pruneSeen(now: number) {
    for (const [id, v] of this.seen) {
      if (now - v.at < this.config.idempotencyTtlMs) break;
      this.seen.delete(id);
    }
  }

  private capMap(map: Map<string, unknown>) {
    for (const id of map.keys()) {
      if (map.size <= this.config.maxEntries) break;
      map.delete(id);
    }
  }
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const GLOBAL_KEY = "__vmuiEffectLimiter__" as const;
type GlobalWithLimiter = typeof globalThis & { [GLOBAL_KEY]?: EffectLimiter };

/** Process-wide limiter; cooldowns overridable with VMUI_EFFECT_COOLDOWN_{FLASH,SCENE}_MS. */
export function effectLimiter(): EffectLimiter {
  const g = globalThis as GlobalWithLimiter;
  g[GLOBAL_KEY] ??= new EffectLimiter(
    {
      ...DEFAULT_LIMITER_CONFIG,
      cooldownMs: {
        flash: envMs("VMUI_EFFECT_COOLDOWN_FLASH_MS", DEFAULT_LIMITER_CONFIG.cooldownMs.flash),
        scene: envMs("VMUI_EFFECT_COOLDOWN_SCENE_MS", DEFAULT_LIMITER_CONFIG.cooldownMs.scene),
      },
    },
    realClock,
    (e) => console.error("[mcp] deferred effect failed:", e instanceof Error ? e.message : e),
  );
  return g[GLOBAL_KEY];
}
