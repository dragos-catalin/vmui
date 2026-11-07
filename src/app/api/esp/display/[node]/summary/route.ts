import { apiForbidden } from "@/lib/api-error";
import { espAuthorized } from "@/lib/esp/auth";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { ha } from "@/lib/home/ha-client";
import { houseEntities } from "@/lib/home/house";
import { household } from "@/lib/household";
import { nutritionSummary } from "@/lib/nutrition/summary";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const STATUS = {
  en: { haDown: "Home Assistant offline", ok: "" },
  ro: { haDown: "Home Assistant indisponibil", ok: "" },
} as const;

// GET /api/esp/display/<node>/summary — the colour touch display (vatra-display-s3) draws its own
// LVGL widgets from this small JSON every 10 s. Same auth as the OLED frame route (esp32 profile).
// Field names are a firmware contract (firmware/images/vatra-display-s3.yaml): keep them.
export async function GET(req: NextRequest, { params }: { params: Promise<{ node: string }> }) {
  const { node } = await params;
  if (!espAuthorized(req)) return apiForbidden(req);
  if (!/^[a-z0-9-]{1,48}$/.test(node)) return new NextResponse("bad node", { status: 400 });
  const h = household();
  const text = STATUS[h.locale] ?? STATUS.en;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: h.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [states, nutrition] = await Promise.all([ha.states().catch(() => null), nutritionSummary().catch(() => null)]);
  const lights = houseEntities();
  const lightsOn = states ? states.filter((s) => s.entity_id.startsWith("light.") && lights.has(s.entity_id) && s.state === "on").length : null;
  const hyper = states?.find((s) => s.entity_id === "light.hyperhdr");
  const mode = states ? ambilightStatus(hyper ?? null) : null;
  const ambilight = mode === "movie" || mode === "music" ? mode : mode ? "off" : "--";
  return NextResponse.json(
    {
      time,
      lightsOn,
      water: nutrition ? { ml: nutrition.water.ml, target: nutrition.water.targetMl } : null,
      ambilight,
      status: states ? text.ok : text.haDown,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
