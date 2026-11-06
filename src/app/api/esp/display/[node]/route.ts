import { espAuthorized } from "@/lib/esp/auth";
import { frameFor, previewView } from "@/lib/esp/gallery";
import { VIEW_ORDER, type ViewId } from "@/lib/esp/views";
import { ambilightStatus } from "@/lib/home/ambilight-status";
import { ha } from "@/lib/home/ha-client";
import { NextResponse, type NextRequest } from "next/server";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// GET /api/esp/display/<node>?k=<ESP_DISPLAY_TOKEN>
// Returns the current 128x64 1-bit BMP for that display. Polled by ESPHome's
// online_image every few seconds; must stay cheap and never throw.
export async function GET(req: NextRequest, { params }: { params: Promise<{ node: string }> }) {
  const { node } = await params;
  if (!espAuthorized(req)) return apiForbidden(req);
  if (!/^[a-z0-9-]{1,32}$/.test(node)) return new NextResponse("bad node", { status: 400 });
  let mode = "--";
  try {
    const s = ambilightStatus(await ha.state("light.hyperhdr"));
    mode = s === "movie" || s === "music" ? s : "off";
  } catch {
    // HA down: views degrade on their own
  }
  // ?fmt=ascii[&view=clock] — text preview for the terminal; does not touch gallery state.
  const sp = req.nextUrl.searchParams;
  if (sp.get("fmt") === "ascii") {
    const view = sp.get("view");
    const fb = view && (VIEW_ORDER as string[]).includes(view) ? await previewView(node, view as ViewId, mode) : await frameFor(node, mode);
    return new NextResponse(fb.toAscii(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const fb = await frameFor(node, mode);
  const bmp = fb.toBmp();
  return new NextResponse(new Uint8Array(bmp), {
    headers: {
      "Content-Type": "image/bmp",
      // ESPHome's online_image allocates from Content-Length; chunked = "Size: 0" = nothing drawn.
      "Content-Length": String(bmp.length),
      "Last-Modified": new Date().toUTCString(),
      "Cache-Control": "no-store",
      // ESPHome caches by ETag/Last-Modified; a changing ETag forces redraw.
      ETag: `"${Date.now()}"`,
    },
  });
}
