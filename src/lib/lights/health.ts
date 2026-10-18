import type { HaState } from "@/lib/home/ha-client";
import "server-only";
import { pcStatusFrom, type PcStatus } from "./control";
import type { LightDevice } from "./model";
import { list, recordHealth } from "./registry";

/**
 * Health from what HA and the PC agent already report: an HA light (or alias) that is
 * `unavailable` is offline; a BLE light takes the PC agent's `ble` report, else the
 * alias, else offline when the PC is gone. Writes only when the value changed.
 */
export function refresh(states: HaState[] | null, pc?: PcStatus): LightDevice[] {
  const pcs = pc ?? pcStatusFrom(states?.find((s) => s.entity_id === "sensor.vmui_pc_agent"));
  const byEntity = new Map((states ?? []).map((s) => [s.entity_id, s]));
  for (const d of list()) {
    let health: LightDevice["health"] = d.health;
    let error: string | null = d.lastError;
    let latencyMs: number | null | undefined;
    const ent = d.transport === "ha" ? d.address : d.haEntity;
    const haOk = ent && states ? byEntity.get(ent)?.state !== "unavailable" && byEntity.has(ent) : null;
    if (d.transport === "ha") {
      if (haOk !== null) health = haOk ? "ok" : "offline";
    } else if (d.transport === "ble") {
      const b = pcs.online ? pcs.ble.find((x) => x.mac.toUpperCase() === d.address.toUpperCase()) : undefined;
      if (b) {
        health = b.connected ? "ok" : b.error ? "degraded" : "ok";
        error = b.error ?? null;
        if (typeof b.latencyMs === "number") latencyMs = Math.round(b.latencyMs);
      } else if (!pcs.online) {
        health = haOk ? "degraded" : states ? "offline" : d.health;
      }
    } else if (d.transport === "hyperhdr") {
      health = pcs.online ? "ok" : "offline";
    }
    if (health !== d.health || error !== d.lastError || (latencyMs !== undefined && latencyMs !== d.lastLatencyMs)) {
      recordHealth(d.id, { health, error, ...(latencyMs !== undefined ? { latencyMs } : {}), seen: health === "ok" });
    }
  }
  return list();
}
