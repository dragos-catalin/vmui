"use client";

import { useInterval } from "@/hooks/use-poll";
import * as React from "react";
import { useAnyLightOn } from "./use-home-states";

/** Evening window for the warm tint when no light state says otherwise. */
const isEvening = (d = new Date()) => d.getHours() >= 19 || d.getHours() < 7;

/**
 * MO-08: with appearance `ambient` on (`html[data-ambient="auto"]`), warms the
 * theme while a room light is on or after sunset by setting
 * `html[data-ambient-warm="1"]`. The CSS for the attribute lives in the theme.
 * Mount once in the root layout; renders nothing.
 */
export function AmbientWarmth() {
  const lightOn = useAnyLightOn();
  const [evening, setEvening] = React.useState(false);
  const [ambient, setAmbient] = React.useState(false);

  React.useEffect(() => {
    const html = document.documentElement;
    const read = () => setAmbient(html.dataset.ambient === "auto");
    read();
    setEvening(isEvening());
    const mo = new MutationObserver(read);
    mo.observe(html, { attributes: true, attributeFilter: ["data-ambient"] });
    return () => mo.disconnect();
  }, []);

  useInterval(() => setEvening(isEvening()), 60_000);

  React.useEffect(() => {
    const html = document.documentElement;
    if (ambient && (lightOn || evening)) html.dataset.ambientWarm = "1";
    else delete html.dataset.ambientWarm;
  }, [ambient, lightOn, evening]);

  React.useEffect(() => () => void delete document.documentElement.dataset.ambientWarm, []);

  return null;
}
