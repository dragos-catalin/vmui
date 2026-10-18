"use client";

import type { TopologyData, TopologyNode, TopologyNodeKind } from "@/server/queries/topology";
import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Vector3 } from "three";
import { rgbToCss, type Rgb } from "./theme-colors";
import { initialLayout, KIND_SIZE, LAYOUT_STORAGE_KEY, NODE_KINDS, type Palette } from "./topology-shared";

// Loaded via next/dynamic only when the 3D view is selected: three +
// @react-three never reach the 2D view or mobile.

interface ControlsLike {
  target: Vector3;
  update: () => void;
}

interface SimNode extends TopologyNode {
  pos: Vector3;
  vel: Vector3;
  fixed: boolean;
}

function toColor(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
}

function loadSavedLayout(): Map<string, [number, number, number]> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, [number, number, number]>;
    return new Map(Object.entries(obj));
  } catch {
    return null;
  }
}

function FitCamera({ nodesRef, fitSignal }: { nodesRef: React.RefObject<SimNode[]>; fitSignal: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as ControlsLike | null;
  useEffect(() => {
    const nodes = nodesRef.current;
    if (!nodes || nodes.length === 0) return;
    const center = new Vector3();
    for (const n of nodes) center.add(n.pos);
    center.divideScalar(nodes.length);
    let radius = 1;
    for (const n of nodes) radius = Math.max(radius, n.pos.distanceTo(center));
    const fov = "fov" in camera && typeof camera.fov === "number" ? camera.fov : 55;
    const distance = (radius * 1.25) / Math.sin((fov * Math.PI) / 360);
    const dir = camera.position.clone().sub(controls?.target ?? new Vector3()).normalize();
    if (dir.lengthSq() === 0) dir.set(0, 0.6, 1).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    camera.lookAt(center);
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
  }, [fitSignal, camera, controls, nodesRef]);
  return null;
}

function ForceScene({
  data,
  palette,
  onHover,
  onSelect,
  saveSignal,
  fitSignal,
}: {
  data: TopologyData;
  palette: Palette;
  onHover: (n: TopologyNode | null) => void;
  onSelect: (n: TopologyNode) => void;
  saveSignal: number;
  fitSignal: number;
}) {
  const nodesRef = useRef<SimNode[]>([]);
  const indexRef = useRef<Map<string, SimNode>>(new Map());

  useMemo(() => {
    const initial = initialLayout(data.nodes);
    const saved = loadSavedLayout();
    const sim: SimNode[] = data.nodes.map((n) => {
      const fromSaved = saved?.get(n.id);
      const p = initial.get(n.id) ?? { x: 0, y: 0, z: 0 };
      const pos = fromSaved ? new Vector3(fromSaved[0], fromSaved[1], fromSaved[2]) : new Vector3(p.x, p.y, p.z);
      return { ...n, pos, vel: new Vector3(), fixed: n.kind === "account" };
    });
    nodesRef.current = sim;
    const idx = new Map<string, SimNode>();
    for (const s of sim) idx.set(s.id, s);
    indexRef.current = idx;
  }, [data]);

  useEffect(() => {
    if (saveSignal === 0) return;
    const out: Record<string, [number, number, number]> = {};
    for (const n of nodesRef.current) out[n.id] = [n.pos.x, n.pos.y, n.pos.z];
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(out));
  }, [saveSignal]);

  const sphereRefs = useRef<Map<string, { position: Vector3 }>>(new Map());
  const linesArrayRef = useRef<Float32Array>(new Float32Array(data.edges.length * 6));
  const lineGeomRef = useRef<BufferGeometry | null>(null);

  useEffect(() => {
    linesArrayRef.current = new Float32Array(data.edges.length * 6);
    const geom = new BufferGeometry();
    const attr = new BufferAttribute(linesArrayRef.current, 3);
    attr.setUsage(DynamicDrawUsage);
    geom.setAttribute("position", attr);
    lineGeomRef.current = geom;
    return () => {
      geom.dispose();
    };
  }, [data]);

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.033);
    const nodes = nodesRef.current;
    const idx = indexRef.current;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const dz = a.pos.z - b.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.01;
        const k = 0.6 / d2;
        a.vel.x += dx * k;
        a.vel.y += dy * k;
        a.vel.z += dz * k;
        b.vel.x -= dx * k;
        b.vel.y -= dy * k;
        b.vel.z -= dz * k;
      }
    }
    for (const e of data.edges) {
      const a = idx.get(e.from);
      const b = idx.get(e.to);
      if (!a || !b) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dz = b.pos.z - a.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const target = e.kind === "owned-by" ? 2.5 : 1.6;
      const f = (d - target) * 0.25;
      const ux = dx / d;
      const uy = dy / d;
      const uz = dz / d;
      a.vel.x += ux * f;
      a.vel.y += uy * f;
      a.vel.z += uz * f;
      b.vel.x -= ux * f;
      b.vel.y -= uy * f;
      b.vel.z -= uz * f;
    }
    for (const a of nodes) {
      a.vel.x += -a.pos.x * 0.01;
      a.vel.y += -a.pos.y * 0.04;
      a.vel.z += -a.pos.z * 0.01;
      if (a.fixed) {
        a.vel.set(0, 0, 0);
        continue;
      }
      a.vel.multiplyScalar(0.85);
      a.pos.x += a.vel.x * step;
      a.pos.y += a.vel.y * step;
      a.pos.z += a.vel.z * step;
      const s = sphereRefs.current.get(a.id);
      if (s) s.position.copy(a.pos);
    }
    const arr = linesArrayRef.current;
    let p = 0;
    for (const e of data.edges) {
      const a = idx.get(e.from);
      const b = idx.get(e.to);
      if (!a || !b) {
        p += 6;
        continue;
      }
      arr[p++] = a.pos.x;
      arr[p++] = a.pos.y;
      arr[p++] = a.pos.z;
      arr[p++] = b.pos.x;
      arr[p++] = b.pos.y;
      arr[p++] = b.pos.z;
    }
    const geom = lineGeomRef.current;
    if (geom) (geom.getAttribute("position") as BufferAttribute).needsUpdate = true;
  });

  const edgeColor = useMemo(() => toColor(palette.edge["owned-by"]), [palette]);
  const nodeColors = useMemo(() => {
    const map = new Map<TopologyNodeKind, Color>();
    for (const k of NODE_KINDS) map.set(k, toColor(palette.node[k]));
    return map;
  }, [palette]);
  const fallbackColor = useMemo(() => toColor(palette.fallback), [palette]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[10, 14, 6]} intensity={0.8} />
      <FitCamera nodesRef={nodesRef} fitSignal={fitSignal} />
      {lineGeomRef.current && (
        <lineSegments geometry={lineGeomRef.current}>
          <lineBasicMaterial color={edgeColor} transparent opacity={0.45} />
        </lineSegments>
      )}
      {nodesRef.current.map((n) => {
        const color = nodeColors.get(n.kind) ?? fallbackColor;
        return (
          <mesh
            key={n.id}
            position={n.pos}
            ref={(mesh) => {
              if (mesh) sphereRefs.current.set(n.id, mesh);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHover(n);
            }}
            onPointerOut={() => onHover(null)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(n);
            }}
          >
            <sphereGeometry args={[KIND_SIZE[n.kind] ?? 0.3, 16, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={n.status === "running" || n.kind === "account" ? 0.45 : 0.1}
              roughness={0.4}
              metalness={0.15}
            />
          </mesh>
        );
      })}
    </>
  );
}

export default function TopologyScene3D({
  data,
  palette,
  hover,
  selected,
  onHover,
  onSelect,
  saveSignal,
  fitSignal,
}: {
  data: TopologyData;
  palette: Palette;
  hover: TopologyNode | null;
  selected: TopologyNode | null;
  onHover: (n: TopologyNode | null) => void;
  onSelect: (n: TopologyNode) => void;
  saveSignal: number;
  fitSignal: number;
}) {
  const t = useTranslations("ops.topology");
  return (
    <Canvas camera={{ position: [0, 12, 18], fov: 55 }}>
      <color attach="background" args={[rgbToCss(palette.background)]} />
      <ForceScene data={data} palette={palette} onHover={onHover} onSelect={onSelect} saveSignal={saveSignal} fitSignal={fitSignal} />
      <OrbitControls makeDefault enableDamping />
      {hover && !selected && (
        <Html position={[0, 0, 0]} center>
          <div className="pointer-events-none surface px-2 py-1 text-2xs shadow-lg">
            <div className="font-semibold">{hover.label}</div>
            <div className="text-muted">
              {t(`kinds.${hover.kind}`)} · {hover.provider}
            </div>
          </div>
        </Html>
      )}
    </Canvas>
  );
}
