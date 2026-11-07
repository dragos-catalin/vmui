import { listImages } from "@/lib/firmware/store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The firmware images this hub can install and keep updated (P6-03). Public, like the files. */
export async function GET() {
  return NextResponse.json({ images: listImages() }, { headers: { "Cache-Control": "no-store" } });
}
