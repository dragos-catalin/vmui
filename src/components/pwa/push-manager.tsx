"use client";

import { Button } from "@/components/ui/button";
import { haptic } from "@/lib/haptics";
import {
    getVapidPublicKeyAction,
    subscribePushAction,
    testPushAction,
    unsubscribePushAction,
} from "@/server/actions/push";
import { Bell, BellOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const norm = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(norm);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushManager() {
  const t = useTranslations("misc.push");
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [vapid, setVapid] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) return;
    void getVapidPublicKeyAction().then((r) => setVapid(r.key));
    void navigator.serviceWorker.ready.then((reg) =>
      reg.pushManager.getSubscription().then((s) => setEnabled(!!s)),
    );
  }, []);

  const enable = () =>
    start(async () => {
      if (!vapid) {
        toast.error(t("notConfigured"));
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast.error(t("permissionDenied"));
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const key = urlBase64ToUint8Array(vapid);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
      });
      const raw = sub.toJSON();
      const keys = raw.keys ?? {};
      const res = await subscribePushAction({
        endpoint: sub.endpoint,
        p256dh: keys.p256dh ?? "",
        authKey: keys.auth ?? "",
        topics: ["state", "builds", "alerts", "costs", "compliance"],
        userAgent: navigator.userAgent,
      });
      if (res.ok) {
        setEnabled(true);
        haptic("success");
        toast.success(t("enabled"));
      }
    });

  const disable = () =>
    start(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePushAction({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setEnabled(false);
      haptic("tap");
      toast.success(t("disabled"));
    });

  const test = () =>
    start(async () => {
      const r = await testPushAction({ topics: ["state"] });
      if (r.ok && r.sent > 0) toast.success(t("sent", { count: r.sent }));
      else toast.error(t("noSubscriptions"));
    });

  if (!supported) {
    return <p className="text-xs text-fg-muted">{t("unsupported")}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {enabled ? (
        <Button type="button" variant="secondary" size="sm" onClick={disable} loading={pending}>
          <BellOff className="size-4" aria-hidden /> {t("disable")}
        </Button>
      ) : (
        <Button type="button" size="sm" onClick={enable} loading={pending}>
          <Bell className="size-4" aria-hidden /> {t("enable")}
        </Button>
      )}
      {enabled && (
        <Button type="button" variant="outline" size="sm" onClick={test} disabled={pending}>
          {t("sendTest")}
        </Button>
      )}
    </div>
  );
}
