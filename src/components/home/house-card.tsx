"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsPanel, Subsection } from "@/components/ui/settings-panel";
import type { CatalogDevice } from "@/lib/home/catalog";
import { deleteDeviceAction, deleteRoomAction, importFromHaAction, saveDeviceAction, saveRoomAction } from "@/server/actions/house";
import { Building2, DownloadCloud, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { KIND_ICON } from "./device-icon";
import { useRoomLabel, useRooms } from "./rooms-context";
import { useHomeAction } from "./use-home-action";

const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

/** Owner-only editor of the house: rooms, which room each device sits in, import from HA. */
export function HouseCard({ devices, haConnected, defaultOpen = false }: { devices: CatalogDevice[]; haConnected: boolean; defaultOpen?: boolean }) {
  const t = useTranslations("setup.house");
  const rooms = useRooms();
  const roomLabel = useRoomLabel();
  const reduce = useReducedMotion();
  const [newRoom, setNewRoom] = React.useState("");
  const [preview, setPreview] = React.useState<{ rooms: number; devices: number } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const opts = { error: t("failed"), refresh: true } as const;
  const saveRoom = useHomeAction(saveRoomAction, opts);
  const delRoom = useHomeAction(deleteRoomAction, opts);
  const saveDev = useHomeAction(saveDeviceAction, opts);
  const delDev = useHomeAction(deleteDeviceAction, opts);
  const router = useRouter();

  const addRoom = async () => {
    const name = newRoom.trim();
    if (!name) return;
    let id = slugify(name) || "room";
    for (let i = 2; rooms.some((r) => r.id === id); i++) id = `${slugify(name)}_${i}`;
    const k = rooms.length;
    setBusy("room");
    const r = await saveRoom.run({ id, name, x: (k % 2) * 50 + 2, y: Math.floor(k / 2) * 34 + 2, w: 46, h: 30, sort: k });
    setBusy(null);
    if (r.ok) setNewRoom("");
  };
  const removeRoom = async (id: string) => {
    if (devices.some((d) => d.room === id)) return void toast.error(t("roomNotEmpty"));
    await delRoom.run(id);
  };
  const move = (d: CatalogDevice, room: string) => saveDev.run({ id: d.id, name: d.name, kind: d.kind, room, entity: d.entity, entities: d.entities, x: d.x, y: d.y, via: d.via, whiteOnly: d.whiteOnly, notes: d.notes });
  const runPreview = async () => {
    setBusy("preview");
    // useHomeAction drops payloads: the preview needs the counts
    const r = await importFromHaAction(true);
    setBusy(null);
    if (r.ok) setPreview({ rooms: r.data.rooms.length, devices: r.data.devices.length });
    else toast.error(t("failed"));
  };
  const runImport = async () => {
    setBusy("import");
    const r = await importFromHaAction(false);
    setBusy(null);
    if (!r.ok) return void toast.error(t("failed"));
    setPreview(null);
    toast.success(t("imported"));
    router.refresh();
  };

  return (
    <SettingsPanel id="house" icon={<Building2 className="size-4" aria-hidden />} title={t("title")} summary={t("summary", { rooms: rooms.length, devices: devices.length })} defaultOpen={defaultOpen}>
      <div className="space-y-4">
        <Subsection title={t("import")} hint={haConnected ? t("importHint") : t("noHa")}>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={runPreview} loading={busy === "preview"} disabled={!haConnected}>
              <DownloadCloud className="size-4" aria-hidden /> {t("preview")}
            </Button>
            {preview && (
              <>
                <span role="status" className="text-sm text-muted">{t("previewResult", preview)}</span>
                <Button onClick={runImport} loading={busy === "import"} disabled={preview.rooms + preview.devices === 0}>{t("apply")}</Button>
              </>
            )}
          </div>
        </Subsection>

        <Subsection title={t("rooms")} hint={t("roomsHint")}>
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {rooms.map((r) => {
                const list = devices.filter((d) => d.room === r.id);
                return (
                  <m.li key={r.id} layout={!reduce} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, height: 0 }} className="min-w-0 rounded-lg border border-border p-3">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{roomLabel(r.id)}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="muted">{list.length}</Badge>
                        <Button variant="ghost" size="icon" aria-label={`${t("deleteRoom")}: ${roomLabel(r.id)}`} onClick={() => removeRoom(r.id)}>
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </span>
                    </div>
                    {list.length === 0 ? (
                      <p className="mt-1 text-xs text-muted">{t("unassigned")}</p>
                    ) : (
                      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {list.map((d) => {
                          const Icon = KIND_ICON[d.kind];
                          return (
                            <li key={d.id} className="flex min-w-0 items-center gap-2 rounded-md bg-bg-muted px-2 py-1.5 text-sm">
                              <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                              <span className="min-w-0 flex-1 truncate" title={d.entity ?? d.name}>{d.name}</span>
                              <select aria-label={`${t("moveTo")}: ${d.name}`} value={d.room} onChange={(e) => void move(d, e.target.value)} className="h-7 max-w-[8rem] shrink-0 rounded border border-border bg-surface px-1 text-xs">
                                {rooms.map((x) => <option key={x.id} value={x.id}>{roomLabel(x.id)}</option>)}
                              </select>
                              <Button variant="ghost" size="icon" aria-label={`${t("deleteDevice")}: ${d.name}`} onClick={() => void delDev.run(d.id)}>
                                <Trash2 className="size-3.5" aria-hidden />
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </m.li>
                );
              })}
            </AnimatePresence>
          </ul>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void addRoom(); }}>
            <Input value={newRoom} onChange={(e) => setNewRoom(e.target.value)} placeholder={t("roomName")} aria-label={t("roomName")} maxLength={60} />
            <Button type="submit" variant="outline" loading={busy === "room"} disabled={!newRoom.trim()}>
              <Plus className="size-4" aria-hidden /> {t("addRoom")}
            </Button>
          </form>
        </Subsection>
      </div>
    </SettingsPanel>
  );
}
