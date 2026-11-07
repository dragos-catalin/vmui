import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, FolderOpen, Languages, Monitor, Moon, Sun, Trash2, Unplug } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { DevicesCard } from "../components/paired-devices";
import { setLanguage, type Lang } from "../i18n";
import { api, toast } from "../lib";
import { usePlatform } from "../platform";
import { useThemePref, type ThemePref } from "../theme";
import { Card, confirmDialog, Dialog, PageHeader, Row, Seg, Switch } from "../ui";

const MAX_PASSWORD = 200;
const HUB_PAGES = [
  { path: "/privacy", key: "setari.linkPrivacy" },
  { path: "/legal", key: "setari.linkLegal" },
  { path: "/licenses", key: "setari.linkLicenses" },
  { path: "/account/delete", key: "setari.linkAccountDelete" },
] as const;

/** Desktop settings: language (shared with the tray), autostart, paired phones, paths, version. */
export function Setari() {
  const { t, i18n } = useTranslation();
  const { root, version, dev, paired, vmui } = usePlatform();
  const disconnect = async () => {
    if (!(await confirmDialog({ title: t("setari.disconnectConfirm"), confirm: t("setari.disconnect") }))) return;
    await api.connClear().then(() => { toast("ok", t("setari.disconnected")); location.reload(); }).catch((e) => toast("error", String(e)));
  };
  const [auto, setAuto] = React.useState<boolean | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => void isEnabled().then(setAuto).catch(() => setAuto(null)), []);
  const lang: Lang = i18n.language === "en" ? "en" : "ro";
  const [theme, setTheme] = useThemePref();
  const openHub = (path: string) => void openUrl(`${vmui.replace(/\/+$/, "")}${path}`).catch((e) => toast("error", String(e)));

  const changeLang = (l: Lang) => setLanguage(l).then(() => toast("ok", t("setari.langSaved"))).catch((e) => toast("error", String(e)));
  const toggleAuto = (v: boolean) =>
    void (v ? enable() : disable()).then(() => { setAuto(v); toast("ok", v ? t("setari.autostartOn") : t("setari.autostartOff")); }).catch((e) => toast("error", String(e)));

  return (
    <div className="grid gap-5">
      <PageHeader title={t("nav.setari")} sub={t("setari.sub")} />
      <Card title={t("setari.app")}>
        <Row label={t("setari.language")} hint={t("setari.languageHint")}>
          <Languages className="size-4 shrink-0 text-muted" aria-hidden />
          <Seg value={lang} onChange={(l) => void changeLang(l)} options={[{ id: "ro", label: "Română" }, { id: "en", label: "English" }]} />
        </Row>
        <Row label={t("setari.theme")} hint={t("setari.themeHint")}>
          <Seg<ThemePref> value={theme} onChange={setTheme} options={[
            { id: "system", label: t("setari.themeSystem"), icon: <Monitor className="size-3.5" aria-hidden /> },
            { id: "dark", label: t("setari.themeDark"), icon: <Moon className="size-3.5" aria-hidden /> },
            { id: "light", label: t("setari.themeLight"), icon: <Sun className="size-3.5" aria-hidden /> },
          ]} />
        </Row>
        <Row label={t("setari.autostart")} hint={t("setari.autostartHint")}>
          {auto == null ? <span className="text-xs text-muted">{t("setari.unavailable")}</span> : <Switch checked={auto} onChange={toggleAuto} label={t("setari.autostart")} />}
        </Row>
        <Row label={t("setari.hub")} hint={vmui || t("setari.hubNone")}>
          {paired && <button type="button" className="btn ghost sm" onClick={() => void disconnect()}><Unplug className="size-3.5" />{t("setari.disconnect")}</button>}
        </Row>
        {vmui && (
          <Row label={t("setari.hubPages")} hint={t("setari.hubPagesHint")}>
            <div className="flex flex-wrap justify-end gap-1.5">
              {HUB_PAGES.map((p) => (
                <button key={p.path} type="button" className="btn ghost sm" onClick={() => openHub(p.path)}><ExternalLink className="size-3.5" aria-hidden />{t(p.key)}</button>
              ))}
            </div>
          </Row>
        )}
        {paired && (
          <Row label={t("setari.deleteAccount")} hint={t("setari.deleteAccountHint")}>
            <button type="button" className="btn danger sm" onClick={() => setDeleting(true)}><Trash2 className="size-3.5" aria-hidden />{t("setari.deleteAccount")}</button>
          </Row>
        )}
        {dev && <Row label={t("setari.repo")} hint={root}><button type="button" className="btn ghost sm" onClick={() => void api.openPath("root")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>}
        {dev && <Row label={t("setari.ambilightFile")} hint="ambilight/settings.json"><button type="button" className="btn ghost sm" onClick={() => void api.openPath("settings")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>}
        <Row label={t("setari.logs")}><button type="button" className="btn ghost sm" onClick={() => void api.openPath("logs")}><FolderOpen className="size-3.5" />{t("common.open")}</button></Row>
        <Row label={t("setari.version")}><span className="text-xs text-muted tabular-nums">{version || "—"}</span></Row>
      </Card>
      <DevicesCard />
      {deleting && <DeleteAccountDialog lang={lang} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** Password + warning, then POST /api/v1/app/account/delete via Rust; success forgets the pairing like Disconnect. */
function DeleteAccountDialog({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const errorId = React.useId();
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!password || password.length > MAX_PASSWORD || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.accountDelete(password, lang);
      toast("ok", t("setari.deleteAccountDone"));
      location.reload();
    } catch (e) {
      const msg = String(e);
      setError(msg === "invalid_password" ? t("setari.deleteAccountInvalid") : msg === "not_bound" ? t("setari.deleteAccountNotBound") : msg);
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("setari.deleteAccountTitle")} onClose={() => !busy && onClose()} width={440} initialFocus={inputRef}>
      <form onSubmit={(ev) => void submit(ev)}>
        <p className="mt-2 text-sm text-muted">{t("setari.deleteAccountWarning")}</p>
        <label className="field mt-4"><span>{t("setari.deleteAccountPassword")}</span>
          <input ref={inputRef} className="input" type="password" autoComplete="current-password" maxLength={MAX_PASSWORD} value={password}
            onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} disabled={busy} />
        </label>
        {error && <p id={errorId} role="alert" className="mt-2 text-sm text-down">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="submit" className="btn danger solid" disabled={busy || !password}>{busy ? t("setari.deleteAccountBusy") : t("setari.deleteAccountConfirm")}</button>
        </div>
      </form>
    </Dialog>
  );
}
