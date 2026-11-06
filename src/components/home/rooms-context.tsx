"use client";

import { useTranslations } from "next-intl";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { HomeRoom } from "@/lib/home/catalog";

// Rooms are data (lib/home/house.ts, server-only). The server page that renders a
// home surface reads them once and provides them here, so client components
// (floor plan, room grants, family card, invite form) never import a static list.
const RoomsContext = createContext<HomeRoom[]>([]);

export function RoomsProvider({ rooms, children }: { rooms: HomeRoom[]; children: ReactNode }) {
  return <RoomsContext value={rooms}>{children}</RoomsContext>;
}

export const useRooms = (): HomeRoom[] => useContext(RoomsContext);

/** Label for a room: seed rooms (bedroom, kitchen…) keep their translation; user rooms show their own name. */
export function useRoomLabel(ns: "home.rooms" | "homeCards.floorPlan.rooms" = "home.rooms"): (id: string) => string {
  const rooms = useRooms();
  const t = useTranslations(ns) as unknown as { (k: string): string; has(k: string): boolean };
  return useCallback((id: string) => (t.has(id) ? t(id) : rooms.find((r) => r.id === id)?.name ?? id), [rooms, t]);
}
