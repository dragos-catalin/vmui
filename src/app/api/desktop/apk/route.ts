import { espAuthorized } from "@/lib/esp/auth";
import { NextResponse, type NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// The Android build lives next to vmui on the Pi (pi-deploy copies it to
// public-apk/vmui.apk + vmui.apk.json {version, versionCode, sha256, size}).
// The app compares versionCode on launch and offers the download; the phone's
// package installer verifies the signature (same release keystore).
const DIR = path.join(process.cwd(), "public-apk");

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const meta = path.join(DIR, "vmui.apk.json");
  const apk = path.join(DIR, "vmui.apk");
  if (!existsSync(meta) || !existsSync(apk)) return NextResponse.json({ error: "no apk published" }, { status: 404 });
  if (req.nextUrl.searchParams.get("meta") === "1") {
    return new NextResponse(await readFile(meta), { headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
  }
  const size = statSync(apk).size;
  return new NextResponse(Readable.toWeb(createReadStream(apk)) as ReadableStream, {
    headers: { "content-type": "application/vnd.android.package-archive", "content-length": String(size), "content-disposition": 'attachment; filename="vmui.apk"', "Cache-Control": "no-store" },
  });
}
