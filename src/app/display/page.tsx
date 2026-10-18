import { VatraMark } from "@/components/brand/vatra-mark";
import { espAuthorized } from "@/lib/esp/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import "./display.css";
import { Kiosk } from "./kiosk";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Vatra · display" }, robots: { index: false } };

// /display?k=<ESP_DISPLAY_TOKEN> — the page DashCast puts on the Nest Hub.
// The token gate is here rather than in proxy.ts because the Hub cannot hold
// a session; everything the page calls (/api/display/*) re-checks the same token.
export default async function DisplayPage({ searchParams }: { searchParams: Promise<{ k?: string; d?: string }> }) {
  const { k, d } = await searchParams;
  const ok = espAuthorized(new Request(`http://x/?k=${encodeURIComponent(k ?? "")}&d=${encodeURIComponent(d ?? "")}`));
  if (!ok) {
    const t = await getTranslations("nestHub.kiosk");
    return (
      <div className="dk">
        <div className="dk-flat" aria-hidden />
        <div className="dk-forbidden" role="alert">
          <VatraMark size={72} state="error" label="Vatra" />
          <p className="dk-forbidden-title">{t("forbidden")}</p>
          <p className="muted">{t("forbiddenHint")}</p>
        </div>
      </div>
    );
  }
  return <Kiosk token={k ?? ""} deviceToken={d ?? ""} />;
}
