import type { Locale } from "@/i18n/config";
import { espAuthorized } from "@/lib/esp/auth";
import { ha, type HaState } from "@/lib/home/ha-client";
import { applyScene, captureScene, identify, knownState, listDiscovered, pcStatus, setLedCount, setLight, storeDiscovered, testPattern, undo } from "@/lib/lights/control";
import { refresh } from "@/lib/lights/health";
import { errorText, lightsLocale, localizeName, roomName } from "@/lib/lights/i18n";
import type { LightDevice } from "@/lib/lights/model";
import * as registry from "@/lib/lights/registry";
import { calibrationSchema, devicePatchSchema, deviceInputSchema, discoveredItemSchema, lightStateSchema, segmentPatchSchema, targetSchema } from "@/lib/lights/schema";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(120);

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), target: targetSchema, state: lightStateSchema }),
  z.object({ op: z.literal("undo") }),
  z.object({ op: z.literal("identify"), id }),
  z.object({ op: z.literal("scene_save"), name: z.string().min(1).max(80), targets: z.array(targetSchema).min(1).max(100) }),
  z.object({ op: z.literal("scene_apply"), id }),
  z.object({ op: z.literal("scene_delete"), id }),
  z.object({ op: z.literal("device_update"), id, patch: devicePatchSchema }),
  z.object({ op: z.literal("device_add"), device: deviceInputSchema }),
  z.object({ op: z.literal("device_delete"), id }),
  z.object({ op: z.literal("segment_add"), deviceId: id, name: z.string().min(1).max(60), ledCount: z.number().int().min(1).max(5000) }),
  z.object({ op: z.literal("segment_update"), id, patch: segmentPatchSchema }),
  z.object({ op: z.literal("segment_delete"), id }),
  z.object({ op: z.literal("segment_reorder"), deviceId: id, order: z.array(id).min(1).max(200) }),
  z.object({ op: z.literal("group_save"), id: id.optional(), name: z.string().min(1).max(80), members: z.array(targetSchema).max(200) }),
  z.object({ op: z.literal("group_delete"), id }),
  z.object({ op: z.literal("profile_activate"), id }),
  z.object({ op: z.literal("profile_update"), id, calibration: calibrationSchema }),
  z.object({ op: z.literal("seed_ha") }),
  z.object({ op: z.literal("import"), json: z.union([z.string().max(2_000_000), z.record(z.string(), z.unknown())]) }),
  z.object({ op: z.literal("led_count"), deviceId: id, count: z.number().int().min(1).max(5000) }),
  z.object({ op: z.literal("test_pattern"), deviceId: id, segmentId: id.optional(), step: z.number().int().min(1).max(5000) }),
  z.object({ op: z.literal("discovered"), items: z.array(discoveredItemSchema).max(200) }),
]);
type Body = z.infer<typeof body>;

const actorOf = (req: NextRequest) => {
  const a = req.headers.get("x-vmui-actor");
  return a && /^[\w.:@-]{1,60}$/.test(a) ? a : req.headers.get("authorization")?.startsWith("Bearer vmd_") ? "device" : "token";
};

function present(d: LightDevice, states: HaState[] | null, locale: Locale): LightDevice {
  return {
    ...d,
    segments: d.segments.map((s) => ({ ...s, name: localizeName(s.name, locale) })),
    state: knownState(d, states),
  };
}

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  const locale = lightsLocale(req);
  const url = new URL(req.url);
  if (url.searchParams.get("export") === "1") {
    return NextResponse.json(registry.exportJson(), { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="vmui-lights.json"' } });
  }
  const states = await ha.states().catch(() => null);
  if (registry.isEmpty()) {
    try {
      if (states) await registry.seedFromHa(states);
      else registry.upsertDevice(registry.MELK_OA10);
    } catch {
      /* HA down or partial seed: serve what exists */
    }
  }
  const pc = await pcStatus(states);
  const devices = refresh(states, pc).map((d) => present(d, states, locale));
  const rooms = [...new Set(devices.map((d) => d.room))].map((r) => ({ id: r, name: roomName(r, locale) }));
  return NextResponse.json(
    {
      devices,
      groups: registry.listGroups().map((g) => ({ ...g, name: localizeName(g.name, locale) })),
      scenes: registry.listScenes().map((s) => ({ ...s, name: localizeName(s.name, locale) })),
      profiles: registry.listProfiles().map((p) => ({ ...p, name: localizeName(p.name, locale) })),
      rooms,
      pcOnline: pc.online,
      haOnline: states !== null,
      discovered: listDiscovered(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function handle(b: Body, actor: string): Promise<Record<string, unknown>> {
  switch (b.op) {
    case "set":
      return { ...(await setLight(b.target, b.state, actor)) };
    case "undo":
      return { ...(await undo(actor)) };
    case "identify":
      return { ...(await identify(b.id, actor)) };
    case "scene_save":
      return { ok: true, scene: await captureScene(b.name, b.targets) };
    case "scene_apply":
      return { ...(await applyScene(b.id, actor)) };
    case "scene_delete":
      registry.deleteScene(b.id);
      return { ok: true };
    case "device_update":
      return { ok: true, device: registry.updateDevice(b.id, b.patch) };
    case "device_add":
      return { ok: true, device: registry.upsertDevice(b.device) };
    case "device_delete":
      registry.deleteDevice(b.id);
      return { ok: true };
    case "segment_add":
      return { ok: true, segment: registry.addSegment(b.deviceId, { name: b.name, ledCount: b.ledCount }) };
    case "segment_update":
      return { ok: true, segment: registry.updateSegment(b.id, b.patch) };
    case "segment_delete":
      registry.deleteSegment(b.id);
      return { ok: true };
    case "segment_reorder":
      return { ok: true, segments: registry.reorder(b.deviceId, b.order) };
    case "group_save":
      return { ok: true, group: registry.saveGroup(b) };
    case "group_delete":
      registry.deleteGroup(b.id);
      return { ok: true };
    case "profile_activate":
      return { ok: true, profile: registry.activateProfile(b.id) };
    case "profile_update":
      return { ok: true, profile: registry.updateProfile(b.id, b.calibration) };
    case "seed_ha":
      return { ok: true, ...(await registry.seedFromHa()) };
    case "import":
      return { ok: true, imported: registry.importJson(b.json) };
    case "led_count":
      return { ...(await setLedCount(b.deviceId, b.count, actor)) };
    case "test_pattern":
      return { ...(await testPattern(b.deviceId, b.segmentId, b.step, actor)) };
    case "discovered":
      return { ok: true, stored: storeDiscovered(b.items) };
  }
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  const locale = lightsLocale(req);
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) {
    const issue = p.error.issues[0];
    return NextResponse.json({ ok: false, error: `${errorText(new Error(issue?.message ?? "invalid"), locale)}${issue?.path.length ? ` (${issue.path.join(".")})` : ""}` }, { status: 400 });
  }
  try {
    return NextResponse.json(await handle(p.data, actorOf(req)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: errorText(e, locale) }, { status: 400 });
  }
}
