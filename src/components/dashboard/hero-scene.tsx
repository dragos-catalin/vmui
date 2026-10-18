"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import type { Vibe } from "@/lib/appearance/model";
import dynamic from "next/dynamic";

/** Vibes that render a 3D scene; the rest return null and let CSS carry the look. */
export const SCENE_VIBES: ReadonlySet<Vibe> = new Set<Vibe>(["cyberpunk", "cockpit", "strategy", "aurora", "synthwave"]);

// three + R3F + drei only load for vibes that actually render a scene.
const HeroCanvas = dynamic(() => import("./hero-canvas"), { ssr: false, loading: () => null });

export function HeroScene() {
  const { appearance, ready } = useAppearance();
  if (!ready || !SCENE_VIBES.has(appearance.vibe)) return null;
  return <HeroCanvas />;
}