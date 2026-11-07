import { imageFile, loadImage } from "@/lib/firmware/store";
import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Firmware the boards and ESP Web Tools fetch (P6-03). Public on purpose: the firmware is MIT and
// published with every release; nothing here is per-household. Paths the manifest does not name 404.
//   manifest.json  ESP Web Tools manifest (paths relative to it)
//   version        plain text, the board compares it with its own before an http OTA
//   ota.bin        the OTA image          ota.md5  its md5 (ota.http_request md5_url)
//   <bin name>     any bin the manifest lists (factory image for a first install)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  const img = loadImage(id);
  if (!img) return new NextResponse("unknown firmware", { status: 404 });
  const ota = img.manifest.builds[0]?.ota;
  const noStore = { "Cache-Control": "no-store" };
  switch (file) {
    case "manifest.json":
      return NextResponse.json(img.manifest, { headers: noStore });
    case "version":
      return new NextResponse(img.manifest.version, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    case "ota.md5":
      return ota ? new NextResponse(ota.md5, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } }) : new NextResponse("no ota", { status: 404 });
  }
  const name = file === "ota.bin" ? ota?.path : file;
  const f = name ? imageFile(id, name) : null;
  if (!f) return new NextResponse("not found", { status: 404 });
  const body = readFileSync(f.path);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": f.type,
      // ESPHome's http OTA sizes its write from Content-Length
      "Content-Length": String(body.length),
      // file names carry the version, so a bin never changes under its name
      "Cache-Control": file === "ota.bin" ? "no-store" : "public, max-age=31536000, immutable",
    },
  });
}
