import { api, usePoll, type Ent } from "../lib";

type Device = { id: string; name: string; kind: string; entity?: string; entities?: string[]; room: string; whiteOnly?: boolean; via: string };
export type Pcs = Record<string, { cpu?: number; ram?: number; gpu?: number; gpuTemp?: number; uptime?: number; focus?: { proc?: string; title?: string }; disks?: Array<{ name: string; pct: number }> }>;
export type DisplayState = {
  rooms: Array<{ id: string; name: string }>;
  devices: Device[];
  entities: Record<string, Ent>;
  inside?: { temp?: Ent | null; hum?: Ent | null } | null;
  home?: { door?: Ent; presence?: Ent; lightsOn?: number; lightsTotal?: number } | null;
  nutrition?: { water: { ml: number; glasses: number; targetMl: number } } | null;
  pcs?: Pcs;
};

/** The house's /api/display/state, shared by Casa and PC (one request, one cache key: DK-31). */
export function useDisplayState(ms: number) {
  const p = usePoll(() => api.vmuiGet<DisplayState>("/api/display/state"), ms, [], "display-state");
  return { ...p, control: (body: Record<string, unknown>) => api.vmuiSend("POST", "/api/display/control", body) };
}
