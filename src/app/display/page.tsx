import { VatraMark } from "@/components/brand/vatra-mark";
import { espAuthorized } from "@/lib/esp/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import "./display.css";
import { Kiosk } from "./kiosk";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Vatra · display" }, robots: { index: false } };

// /display — the page DashCast puts on the Nest Hub. The Hub arrives through
// /api/display/session?code=… (one-time code -> httpOnly kiosk cookie), so neither this URL nor the
// kiosk's fetches carry a token. ?k= / ?d= still work during the P0-06 deprecation window.
// The gate is here rather than in proxy.ts; every /api/display/* call re-checks the cookie.
export default async function DisplayPage({ searchParams }: { searchParams: Promise<{ k?: string; d?: string }> }) {
  const { k, d } = await searchParams;
  const h = await headers();
  const q = new URLSearchParams();
  if (k) q.set("k", k);
  if (d) q.set("d", d);
  const ok = espAuthorized(new Request(`http://x/display${q.size ? `?${q}` : ""}`, { headers: { cookie: h.get("cookie") ?? "" } }));
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
