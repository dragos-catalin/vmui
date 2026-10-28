import { meHealth } from "@/lib/health/me";

export const dynamic = "force-dynamic";

// GET /api/v1/me/health   Authorization: Bearer vmd_<device token>
// The owner's health readings and nutrition totals for the Vitals apps
// (desktop, iPhone, Android). Owner's paired devices only; never cached.
export async function GET(req: Request) {
  const r = await meHealth(req);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return Response.json(r.body, { headers: { "Cache-Control": "no-store" } });
}
