"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Subsection } from "@/components/ui/settings-panel";
import type { EspFound } from "@/lib/firmware/adopt";
import type { FirmwareImage } from "@/lib/firmware/store";
import { adoptEspAction, scanEspAction } from "@/server/actions/esp-devices";
import { Cpu, Download, Radar, Usb } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "esp-web-install-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { manifest?: string };
    }
  }
}

type Image = FirmwareImage;
const BOARDS = ["vatra-display-oled", "vatra-display-s3", "vatra-button-atom", "vatra-button-c3"] as const;
type Board = (typeof BOARDS)[number];
const isBoard = (id: string): id is Board => (BOARDS as readonly string[]).includes(id);
const ERRORS = ["unreachable", "not_vatra", "already_adopted", "refused", "bad_host", "forbidden", "failed"] as const;
type AdoptError = (typeof ERRORS)[number];
const asError = (e: string): AdoptError => ((ERRORS as readonly string[]).includes(e) ? (e as AdoptError) : "failed");

/** Devices → Add (P6-04): flash a Vatra board from the browser (ESP Web Tools, Web Serial) with the
 *  firmware this hub serves, then adopt it: scoped token + hub address written to the board, and the
 *  board offered to Home Assistant. Owner-only (the settings tab is). */
export function AddDeviceCard() {
  const t = useTranslations("devices.add");
  const [images, setImages] = React.useState<Image[] | null>(null);
  const [image, setImage] = React.useState<string>("");
  const [found, setFound] = React.useState<EspFound[] | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [host, setHost] = React.useState("");
  const [serial, setSerial] = React.useState<"ok" | "insecure" | "unsupported" | null>(null);
  const [secureUrl, setSecureUrl] = React.useState<string | null>(null);

  const scan = React.useCallback(async () => {
    setScanning(true);
    const r = await scanEspAction();
    setScanning(false);
    if (!r.ok) return void toast.error(t(`error.${asError(r.error)}`));
    setFound(r.data.found);
    setImages(r.data.images);
    setSecureUrl(r.data.secureUrl);
    setImage((cur) => cur || r.data.images[0]?.id || "");
  }, [t]);

  React.useEffect(() => {
    void scan();
    setSerial(!window.isSecureContext ? "insecure" : "serial" in navigator ? "ok" : "unsupported");
    void import("esp-web-tools/dist/install-button.js");
  }, [scan]);

  const adopt = async (target: string, name?: string) => {
    setBusy(target);
    const r = await adoptEspAction({ host: target, ...(name ? { name } : {}) });
    setBusy(null);
    if (!r.ok) return void toast.error(t(`error.${asError(r.error)}`));
    toast.success(t("adopted", { image: r.data.image }), { description: t(`ha.${r.data.ha}`) });
    void scan();
  };

  const selected = images?.find((i) => i.id === image) ?? null;

  return (
    <Panel id="add-device" title={t("title")} description={t("intro")}>
      <div className="space-y-6">
        <Subsection title={t("flash.title")} hint={t("flash.hint")}>
          {images && images.length === 0 ? (
            <p className="text-sm text-muted">{t("flash.noFirmware")}</p>
          ) : (
            <div className="space-y-3">
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="sr-only">{t("flash.board")}</legend>
                {(images ?? []).map((i) => (
                  <label key={i.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm has-[:checked]:border-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
                    <input type="radio" name="vatra-image" value={i.id} checked={image === i.id} onChange={() => setImage(i.id)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="block font-medium">{isBoard(i.id) ? t(`board.${i.id}`) : i.name}</span>
                      <span className="block text-xs text-muted">{i.chipFamily} · {i.version}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {selected && (
                <div className="flex flex-wrap items-center gap-3">
                  {serial === "ok" ? (
                    <esp-web-install-button key={selected.id} manifest={`/api/firmware/${selected.id}/manifest.json`} className="block max-w-full">
                      <Button slot="activate" type="button" className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left">
                        <Usb className="size-4" aria-hidden /> {t("flash.install", { name: isBoard(selected.id) ? t(`board.${selected.id}`) : selected.name })}
                      </Button>
                    </esp-web-install-button>
                  ) : (
                    <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                      {serial === "insecure" ? t("flash.insecure") : t("flash.unsupported")}
                      {serial === "insecure" && secureUrl && (
                        <>
                          {" "}
                          <a className="font-medium underline underline-offset-2" href={`${secureUrl.replace(/\/$/, "")}/home?tab=settings&section=addDevice`}>
                            {t("flash.openSecure")}
                          </a>
                        </>
                      )}
                    </p>
                  )}
                  <a className="inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2" href={`/api/firmware/${selected.id}/manifest.json`} download>
                    <Download className="size-4" aria-hidden /> {t("flash.manifest")}
                  </a>
                </div>
              )}
            </div>
          )}
        </Subsection>

        <Subsection
          title={t("adopt.title")}
          hint={t("adopt.hint")}
          action={
            <Button variant="outline" size="sm" onClick={scan} loading={scanning}>
              <Radar className="size-4" aria-hidden /> {t("adopt.scan")}
            </Button>
          }
        >
          <div className="space-y-3">
            {found === null ? null : found.length === 0 ? (
              <p className="text-sm text-muted">{t("adopt.none")}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border" aria-label={t("adopt.found")}>
                {found.map((d) => (
                  <li key={d.name} className="flex flex-wrap items-center gap-3 p-3">
                    <Cpu className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{d.friendlyName ?? d.name}</span>
                      <span className="block truncate text-xs text-muted">{[d.ip ?? d.host, d.project, d.version].filter(Boolean).join(" · ")}</span>
                    </span>
                    {d.vatra ? <Badge variant="info">{t("adopt.vatra")}</Badge> : <Badge variant="muted">{t("adopt.esphome")}</Badge>}
                    {d.vatra && (
                      <Button size="sm" onClick={() => adopt(d.ip ?? d.host, d.friendlyName ?? undefined)} loading={busy === (d.ip ?? d.host)}>
                        {t("adopt.action")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (host.trim()) void adopt(host.trim().toLowerCase());
              }}
            >
              <label className="grid min-w-0 flex-1 gap-1 text-sm">
                <span>{t("adopt.manual")}</span>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" inputMode="url" autoComplete="off" maxLength={80} />
              </label>
              <Button type="submit" variant="outline" loading={busy === host.trim().toLowerCase() && !!host}>
                {t("adopt.action")}
              </Button>
            </form>
            <p className="text-xs text-muted">{t("adopt.forget")}</p>
          </div>
        </Subsection>
      </div>
    </Panel>
  );
}
