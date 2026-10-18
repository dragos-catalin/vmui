import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { FolderOpen, Languages } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, type Lang } from "../i18n";
import { api, toast } from "../lib";
import { usePlatform } from "../platform";
import { Card, Row, Seg, Switch } from "../ui";
import { DevicesCard } from "./Devices";

/** Desktop settings: language (shared with the tray), autostart, paired phones, paths, version. */
export function Setari() {
  const { t, i18n } = useTranslation();
  const { root, version } = usePlatform();
  const [auto, setAuto] = React.useState<boolean | null>(null);
  React.useEffect(() => void isEnabled().then(setAuto).catch(() => setAuto(null)), []);
  const lang: Lang = i18n.language === "en" ? "en" : "ro";

  const changeLang = (l: Lang) => setLanguage(l).then(() => toast("ok", t("setari.langSaved"))).catch((e) => toast("error", String(e)));
  const toggleAuto = (v: boolean) =>
    void (v ? enable() : disable()).then(() => { setAuto(v); toast("ok", v ? t("setari.autostartOn") : t("setari.autostartOff")); }).catch((e) => toast("error", String(e)));

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("nav.setari")}</h1>
        <p className="text-sm text-muted mt-1">{t("setari.sub")}</p>
      </div>
      <Card title={t("setari.app")}>
        <Row label={t("setari.language")} hint={t("setari.languageHint")}>
          <Languages className="size-4 text-muted" aria-hidden />
          <Seg value={lang} onChange={(l) => void changeLang(l)} options={[{ id: "ro", label: "Română" }, { id: "en", label: "English" }]} />
        </Row>
        <Row label={t("setari.autostart")} hint={t("setari.autostartHint")}>
          {auto == null ? <span className="text-xs text-dim">n/a</span> : <Switch checked={auto} onChange={toggleAuto} label={t("setari.autostart")} />}
        </Row>
        <Row label={t("setari.repo")} hint={root}><button type="button" className="btn ghost sm" onClick={() => void api.openPath("root")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>
        <Row label="ambilight/settings.json"><button type="button" className="btn ghost sm" onClick={() => void api.openPath("settings")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>
        <Row label={t("setari.logs")}><button type="button" className="btn ghost sm" onClick={() => void api.openPath("logs")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>
        <Row label={t("setari.version")}><span className="text-xs text-muted tabular-nums">{version || "—"}</span></Row>
      </Card>
      <DevicesCard />
    </div>
  );
}
