import type { TopologyEdge, TopologyNode, TopologyNodeKind } from "@/server/queries/topology";
import { mixRgb, type Rgb } from "./theme-colors";

// three-free helpers shared by the 2D view (always loaded) and the 3D scene
// (loaded on demand), so three/@react-three stay out of the base bundle.

export const TOKENS = ["primary", "accent", "success", "warning", "danger", "info", "border", "fg", "fg-muted", "bg", "surface"] as const;
export type Tokens = Record<(typeof TOKENS)[number], Rgb>;

export interface Palette {
  node: Record<TopologyNodeKind, Rgb>;
  edge: Record<TopologyEdge["kind"], Rgb>;
  background: Rgb;
  label: Rgb;
  fallback: Rgb;
}

export function buildPalette(t: Tokens): Palette {
  return {
    node: {
      account: t.primary,
      instance: t.accent,
      volume: t.success,
      snapshot: mixRgb(t.success, t.fg, 0.35),
      "security-group": t.warning,
      vpc: t.info,
      subnet: mixRgb(t.info, t.fg, 0.35),
      bucket: mixRgb(t.primary, t.danger, 0.5),
      "load-balancer": t.danger,
      database: mixRgb(t.warning, t.danger, 0.5),
      dns: mixRgb(t.success, t.accent, 0.5),
    },
    edge: {
      "owned-by": t["fg-muted"],
      attaches: t.success,
      "in-group": t.warning,
      "in-vpc": t.info,
      "in-subnet": mixRgb(t.info, t.fg, 0.35),
    },
    background: t.bg,
    label: t["fg-muted"],
    fallback: t["fg-muted"],
  };
}

export const NODE_KINDS: TopologyNodeKind[] = ["account", "instance", "volume", "snapshot", "security-group", "vpc", "subnet", "bucket", "load-balancer", "database", "dns"];
export const EDGE_KINDS: TopologyEdge["kind"][] = ["owned-by", "attaches", "in-group", "in-vpc", "in-subnet"];

export const KIND_SIZE: Record<TopologyNodeKind, number> = {
  account: 0.6,
  instance: 0.4,
  volume: 0.28,
  snapshot: 0.22,
  "security-group": 0.26,
  vpc: 0.5,
  subnet: 0.32,
  bucket: 0.3,
  "load-balancer": 0.34,
  database: 0.34,
  dns: 0.26,
};

export const LAYOUT_STORAGE_KEY = "vmui:topology:layout";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export function initialLayout(nodes: TopologyNode[]): Map<string, Point3> {
  const accounts = nodes.filter((n) => n.kind === "account");
  const byAcc = new Map<string, TopologyNode[]>();
  for (const n of nodes) {
    if (n.kind === "account") continue;
    const list = byAcc.get(n.accountId) ?? [];
    list.push(n);
    byAcc.set(n.accountId, list);
  }
  const positions = new Map<string, Point3>();
  const accRadius = Math.max(6, accounts.length * 1.6);
  accounts.forEach((acc, i) => {
    const theta = (i / Math.max(1, accounts.length)) * Math.PI * 2;
    const center = { x: Math.cos(theta) * accRadius, y: 0, z: Math.sin(theta) * accRadius };
    positions.set(acc.id, center);
    const children = byAcc.get(acc.accountId) ?? [];
    children.forEach((c, j) => {
      const r = 2 + Math.sqrt(j) * 0.6;
      const phi = j * 2.4;
      const yaw = (j % 7) * 0.4 - 1.2;
      positions.set(c.id, { x: center.x + Math.cos(phi) * r, y: yaw, z: center.z + Math.sin(phi) * r });
    });
  });
  for (const n of nodes) {
    if (!positions.has(n.id)) positions.set(n.id, { x: Math.random() * 2 - 1, y: 0, z: Math.random() * 2 - 1 });
  }
  return positions;
}
