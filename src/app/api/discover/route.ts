import { API_VERSION, MIN_CLIENT } from "@/lib/api-version";
import { userCount } from "@/lib/auth";
import { NextResponse } from "next/server";
import { hostname } from "node:os";

export const dynamic = "force-dynamic";

/** Unauthenticated identity card for autodiscovery (mDNS _vatra._tcp / _vmui._tcp → this).
 *  Nothing sensitive: `claimed` only tells a fresh app to show the setup-code screen. */
export async function GET() {
  const claimed = (await userCount().catch(() => 1)) > 0;
  return NextResponse.json(
    { app: "vmui", product: "vatra", host: hostname(), version: process.env.npm_package_version ?? "", apiVersion: API_VERSION, minClient: MIN_CLIENT, claimed, pair: "/api/devices/pair" },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}
