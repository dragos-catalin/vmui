import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Download } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { api, toast } from "../lib";
import { usePlatform } from "../platform";

type Meta = { version: string; versionCode: number; sha256: string; size: number; builtAt: string };

/** Mobile only: the Pi hosts the latest APK; offer it when its versionCode is newer than ours. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { mobile, version } = usePlatform();
  const [meta, setMeta] = React.useState<Meta | null>(null);
  const [mine, setMine] = React.useState<number>(0);
  React.useEffect(() => {
    if (!mobile) return;
    void api.appInfo().then((i) => setMine(Number((i as { versionCode?: number }).versionCode ?? 0))).catch(() => undefined);
    void api.vmuiGet<Meta>("/api/desktop/apk?meta=1").then(setMeta).catch(() => undefined);
  }, [mobile]);
  if (!mobile || !meta || !mine || meta.versionCode <= mine) return null;
  const get = async () => {
    try {
      const c = await invoke<{ url: string; token: string } | null>("conn_get");
      if (!c) return;
      // the browser downloads it and Android's package installer verifies the signature
      await openUrl(`${c.url}/api/desktop/apk?d=${encodeURIComponent(c.token)}`);
    } catch (e) {
      toast("error", String(e));
    }
  };
  return (
    <div className="glass mb-4 flex items-center gap-3 border-primary/40 px-3 py-2.5" role="status">
      <Download className="size-5 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t("update.available", { version: meta.version })}</div>
        <div className="text-xs text-muted">{t("update.youHave", { version, mb: (meta.size / 1048576).toFixed(1) })}</div>
      </div>
      <button type="button" className="btn primary sm" onClick={() => void get()}>{t("update.install")}</button>
    </div>
  );
}
