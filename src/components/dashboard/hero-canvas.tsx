"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { useInView, usePageVisible } from "@/hooks/use-poll";
import type { Vibe } from "@/lib/appearance/model";
import { mixRgb, useResolvedTokens, type Rgb } from "@/lib/theme-colors";
import { SCENE_VIBES } from "./hero-scene";
import { Float, Line, Sparkles, Stars } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Per-vibe hero scene. R3F runs purely client-side; the parent component
 * gates render on `mounted` to avoid SSR drift. Each vibe gets a distinct
 * subject; "minimal" + "terminal" return null and let CSS carry the look.
 * Colours come from the resolved `--color-*` tokens so every vibe, light or
 * dark, follows the design system instead of a hard-coded neon set.
 */

type Palette = {
  primary: THREE.Color;
  primaryLight: THREE.Color;
  accent: THREE.Color;
  surface: THREE.Color;
  bg: THREE.Color;
  fgMuted: THREE.Color;
};

type SceneProps = { c: Palette; animate: boolean };

const TOKEN_NAMES = ["primary", "accent", "surface", "bg", "fg-muted"] as const;

function toColor([r, g, b]: Rgb): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255);
}

function CyberpunkScene({ c, animate }: SceneProps) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (!animate || !ref.current) return;
    ref.current.rotation.y += dt * 0.4;
    ref.current.rotation.x += dt * 0.1;
  });
  return (
    <>
      <ambientLight intensity={0.25} />
      <pointLight position={[4, 3, 5]} intensity={2.5} color={c.primary} />
      <pointLight position={[-4, -2, 4]} intensity={2} color={c.accent} />
      <Float speed={animate ? 1.2 : 0} rotationIntensity={0.6} floatIntensity={1.2}>
        <mesh ref={ref}>
          <icosahedronGeometry args={[1.4, 1]} />
          <meshStandardMaterial
            color={c.surface}
            emissive={c.primary}
            emissiveIntensity={0.45}
            wireframe
          />
        </mesh>
      </Float>
      <Sparkles count={120} scale={[8, 4, 4]} size={2.4} speed={animate ? 0.4 : 0} color={c.accent} />
    </>
  );
}

function CockpitScene({ c, animate }: SceneProps) {
  const sweepRef = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (animate && sweepRef.current) sweepRef.current.rotation.z -= dt * 0.6;
  });
  const rings = useMemo(() => [1.0, 1.6, 2.2, 2.8], []);
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[0, 0, 4]} intensity={1.6} color={c.primary} />
      {rings.map((r) => (
        <mesh key={r} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r - 0.012, r, 80]} />
          <meshBasicMaterial color={c.primary} transparent opacity={0.35} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <group ref={sweepRef}>
        <mesh position={[1.4, 0, 0]}>
          <planeGeometry args={[2.8, 0.04]} />
          <meshBasicMaterial color={c.primary} transparent opacity={0.85} />
        </mesh>
        <mesh position={[1.4, 0, 0]}>
          <coneGeometry args={[0.06, 0.4, 8]} />
          <meshStandardMaterial color={c.accent} emissive={c.accent} emissiveIntensity={0.6} />
        </mesh>
      </group>
      <mesh>
        <circleGeometry args={[0.18, 32]} />
        <meshStandardMaterial color={c.primary} emissive={c.primary} emissiveIntensity={0.7} />
      </mesh>
    </>
  );
}

function StrategyScene({ c, animate }: SceneProps) {
  const globeRef = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (animate && globeRef.current) globeRef.current.rotation.y += dt * 0.15;
  });
  // Static arcs between fictional region nodes.
  const arcs = useMemo(() => {
    const pts: THREE.Vector3[][] = [];
    const nodes: [number, number][] = [
      [0.4, 0.6],
      [-0.7, 0.2],
      [0.5, -0.5],
      [-0.3, -0.4],
      [0.0, 0.8],
    ];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const aLat = nodes[i]?.[0] ?? 0;
        const aLon = nodes[i]?.[1] ?? 0;
        const bLat = nodes[j]?.[0] ?? 0;
        const bLon = nodes[j]?.[1] ?? 0;
        const a = new THREE.Vector3().setFromSphericalCoords(1.55, Math.PI / 2 - aLat, aLon);
        const b = new THREE.Vector3().setFromSphericalCoords(1.55, Math.PI / 2 - bLat, bLon);
        const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(2.1);
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        pts.push(curve.getPoints(20));
      }
    }
    return pts;
  }, []);
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[3, 4, 5]} intensity={1.6} color={c.primaryLight} />
      <pointLight position={[-4, -2, 3]} intensity={0.9} color={c.accent} />
      <mesh ref={globeRef}>
        <sphereGeometry args={[1.5, 48, 48]} />
        <meshStandardMaterial
          color={c.surface}
          emissive={c.bg}
          emissiveIntensity={0.8}
          roughness={0.85}
          metalness={0.1}
          wireframe
        />
      </mesh>
      {arcs.map((curve, i) => (
        <Line key={i} points={curve} color={c.primaryLight} lineWidth={1.4} transparent opacity={0.7} />
      ))}
      <Stars radius={20} depth={50} count={1500} factor={4} saturation={0} fade speed={animate ? 0.5 : 0} />
    </>
  );
}

function AuroraScene({ c, animate }: SceneProps) {
  const ribbonRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!animate || !ribbonRef.current) return;
    ribbonRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.3) * 0.15;
    const mat = ribbonRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.35 + Math.sin(state.clock.elapsedTime * 0.5) * 0.15;
  });
  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[4, 4, 4]} intensity={1.6} color={c.primary} />
      <pointLight position={[-4, -2, 3]} intensity={1.3} color={c.accent} />
      <Float speed={animate ? 0.8 : 0} rotationIntensity={0.3} floatIntensity={0.6}>
        <mesh ref={ribbonRef}>
          <torusKnotGeometry args={[1.1, 0.32, 200, 24, 2, 5]} />
          <meshStandardMaterial
            color={c.surface}
            emissive={c.primary}
            emissiveIntensity={0.4}
            roughness={0.25}
            metalness={0.7}
          />
        </mesh>
      </Float>
      <Sparkles count={80} scale={[8, 5, 4]} size={1.8} speed={animate ? 0.25 : 0} color={c.accent} />
    </>
  );
}

function SynthwaveScene({ c, animate }: SceneProps) {
  const sunRef = useRef<THREE.Mesh>(null);
  const gridRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!animate) return;
    if (sunRef.current) sunRef.current.position.y = -0.3 + Math.sin(state.clock.elapsedTime * 0.4) * 0.05;
    if (gridRef.current) {
      gridRef.current.position.z = (state.clock.elapsedTime * 0.3) % 1;
    }
  });
  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[0, 1, 4]} intensity={2.2} color={c.primary} />
      <mesh ref={sunRef} position={[0, -0.3, -0.5]}>
        <circleGeometry args={[1.6, 64]} />
        <meshBasicMaterial color={c.primary} />
      </mesh>
      <mesh ref={gridRef} rotation={[-Math.PI / 2.2, 0, 0]} position={[0, -1.6, 0]}>
        <planeGeometry args={[16, 12, 24, 24]} />
        <meshBasicMaterial color={c.primary} wireframe transparent opacity={0.6} />
      </mesh>
    </>
  );
}

function SceneFor({ vibe, c, animate }: { vibe: Vibe } & SceneProps) {
  switch (vibe) {
    case "cyberpunk":
      return <CyberpunkScene c={c} animate={animate} />;
    case "cockpit":
      return <CockpitScene c={c} animate={animate} />;
    case "strategy":
      return <StrategyScene c={c} animate={animate} />;
    case "aurora":
      return <AuroraScene c={c} animate={animate} />;
    case "synthwave":
      return <SynthwaveScene c={c} animate={animate} />;
    default:
      return null;
  }
}

/** Explicit appearance flag wins; `null` ("system") falls back to the OS media query. */
function useReducedMotion(pref: boolean | null): boolean {
  const [system, setSystem] = useState(false);
  useEffect(() => {
    if (pref !== null) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setSystem(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [pref]);
  return pref ?? system;
}

export default function HeroCanvas() {
  const { appearance, ready } = useAppearance();
  const { vibe } = appearance;
  const reduced = useReducedMotion(appearance.reducedMotion);
  const [viewRef, inView] = useInView<HTMLDivElement>("0px");
  const visible = usePageVisible();
  const tokens = useResolvedTokens(TOKEN_NAMES);
  const palette = useMemo<Palette | null>(() => {
    if (!tokens) return null;
    return {
      primary: toColor(tokens.primary),
      primaryLight: toColor(mixRgb(tokens.primary, tokens["fg-muted"], 0.3)),
      accent: toColor(tokens.accent),
      surface: toColor(tokens.surface),
      bg: toColor(tokens.bg),
      fgMuted: toColor(tokens["fg-muted"]),
    };
  }, [tokens]);

  if (!ready) return null;
  if (!SCENE_VIBES.has(vibe)) return null;
  if (!palette) return null;
  const animate = !reduced && inView && visible;

  return (
    <div ref={viewRef} className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-xl)]">
      <Canvas
        dpr={[1, 1.5]}
        frameloop={animate ? "always" : "demand"}
        camera={{ position: [0, 0, 5], fov: 45 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ background: "transparent" }}
      >
        <Suspense fallback={null}>
          <SceneFor vibe={vibe} c={palette} animate={animate} />
        </Suspense>
      </Canvas>
    </div>
  );
}
