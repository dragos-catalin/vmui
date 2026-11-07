import { invoke } from "@tauri-apps/api/core";
import { KeyRound, RadioTower, RefreshCw, Smartphone } from "lucide-react";
import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import { cn, toast, type Health } from "../lib";
import { usePlatform } from "../platform";

type Found = { url: string; host: string; via: string };
type Ticket = { id: string; token: string; code: string; status: string };
type Step = { kind: "scan" } | { kind: "pick"; found: Found[] } | { kind: "wait"; url: string; t: Ticket } | { kind: "login"; url: string } | { kind: "redeem"; url: string };
export type Invite = { hub: string; invite: string };

/** First run (phone, or an installed desktop copy). Finds the hub by itself (mDNS on the LAN,
 *  well-known names), then either asks for approval — the code shows here and in the web /
 *  desktop / other phones — or signs in with the Vatra account. A `vatra://pair` invite
 *  (QR / link from the hub's Add device page) is redeemed straight away. */
export function Setup({ onDone, canCancel, onCancel, invite }: { onDone: () => void; canCancel: boolean; onCancel: () => void; invite?: Invite | null }) {
  const { t } = useTranslation();
  const { mobile } = usePlatform();
  const [step, setStep] = React.useState<Step>(invite ? { kind: "redeem", url: invite.hub } : { kind: "scan" });
  const [manual, setManual] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const scan = React.useCallback(async () => {
    setStep({ kind: "scan" });
    const found = await invoke<Found[]>("discover").catch(() => [] as Found[]);
    setStep({ kind: "pick", found });
  }, []);
  React.useEffect(() => {
    if (!invite) { void scan(); return; }
    setStep({ kind: "redeem", url: invite.hub });
    void invoke<Health>("pair_redeem", { url: invite.hub, invite: invite.invite })
      .then((h) => { toast("ok", t("setup.connected", { detail: h.detail })); onDone(); })
      .catch((e) => {
        const code = String(e).replace(/^Error:\s*/, "");
        toast("error", code === "invite_invalid" ? t("setup.inviteInvalid") : code);
        setStep({ kind: "pick", found: [{ url: invite.hub, host: "", via: "manual" }] });
      });
    // one redemption per invite; onDone/t are stable enough for this screen's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, scan]);

  const request = async (url: string) => {
    setBusy(true);
    try {
      const ticket = await invoke<Ticket>("pair_request", { url });
      setStep({ kind: "wait", url, t: ticket });
      const h = await invoke<Health>("pair_wait", { url, id: ticket.id, token: ticket.token });
      toast("ok", t("setup.approved", { detail: h.detail }));
      onDone();
    } catch (e) {
      const code = String(e).replace(/^Error:\s*/, "");
      toast("error", code === "rejected" ? t("setup.rejected") : code === "expired" ? t("setup.timedOut") : code);
      setStep({ kind: "pick", found: [{ url, host: "", via: "manual" }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-scene h-full grid place-items-center p-5" style={{ paddingTop: "max(env(safe-area-inset-top), 20px)" }}>
      <div className="glass w-full max-w-sm p-6 grid gap-5">
        <div className="flex items-center gap-3">
          <Smartphone className="size-7 shrink-0 text-primary-text" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold">{t("setup.title")}</h1>
            <p className="text-xs text-muted">{t(mobile ? "setup.sub" : "setup.subDesktop")}</p>
          </div>
        </div>

        {step.kind === "redeem" && (
          <div className="flex items-center gap-3 text-sm text-muted py-6 justify-center" role="status"><RadioTower className="size-5 motion-safe:animate-pulse text-primary-text" aria-hidden />{t("setup.redeeming", { url: step.url })}</div>
        )}

        {step.kind === "scan" && (
          <div className="flex items-center gap-3 text-sm text-muted py-6 justify-center"><RadioTower className="size-5 motion-safe:animate-pulse text-primary-text" aria-hidden />{t("setup.scanning")}</div>
        )}

        {step.kind === "pick" && (
          <div className="grid gap-3">
            {step.found.length === 0 && <p className="text-sm text-warning-text">{t("setup.notFound")}</p>}
            {step.found.map((f) => (
              <button key={f.url} type="button" className="tile on text-left" disabled={busy} onClick={() => void request(f.url)}>
                <RadioTower className="size-5 text-ok" />
                <div className="min-w-0"><div className="font-medium">{f.host || "vmui"}</div><div className="text-xs text-muted truncate">{f.url} · {f.via === "mdns" ? t("setup.viaLan") : f.via === "dns" ? t("setup.viaDns") : t("setup.viaManual")}</div></div>
              </button>
            ))}
            <div className="flex gap-2">
              <input className="input flex-1" inputMode="url" autoCapitalize="off" aria-label={t("setup.manualLabel")} placeholder={t("setup.manualPlaceholder")} value={manual} onChange={(e) => setManual(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !/^https?:\/\//.test(manual)} onClick={() => void request(manual.trim().replace(/\/$/, ""))}>{t("common.ok")}</button>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <button type="button" className="btn ghost sm" onClick={() => void scan()}><RefreshCw className="size-3.5" />{t("setup.rescan")}</button>
              <button type="button" className="btn ghost sm" disabled={step.found.length === 0 && !manual} onClick={() => setStep({ kind: "login", url: step.found[0]?.url ?? manual })}><KeyRound className="size-3.5" />{t("setup.haveAccount")}</button>
            </div>
          </div>
        )}

        {step.kind === "wait" && (
          <div className="grid gap-4 text-center py-2">
            <p className="text-sm text-muted"><Trans i18nKey={mobile ? "setup.waitText" : "setup.waitTextDesktop"} components={{ b: <b /> }} /></p>
            <div className="font-mono text-5xl tabular-nums tracking-[0.35em] text-primary-text">{step.t.code}</div>
            <p className="text-xs text-muted">{step.url} · {t("setup.expires")}</p>
            <button type="button" className="btn ghost sm justify-self-center" onClick={() => setStep({ kind: "login", url: step.url })}><KeyRound className="size-3.5" />{t("setup.orLogin")}</button>
          </div>
        )}

        {step.kind === "login" && <Login url={step.url} onBack={() => void scan()} onDone={onDone} />}

        {canCancel && step.kind !== "wait" && step.kind !== "redeem" && <button type="button" className="btn ghost sm justify-self-end" onClick={onCancel}>{t("common.back")}</button>}
      </div>
    </div>
  );
}

function Login({ url, onBack, onDone }: { url: string; onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const h = await invoke<Health>("pair_login", { url, email, password });
      toast("ok", t("setup.connected", { detail: h.detail }));
      onDone();
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <p className="text-xs text-muted">{t("setup.loginSub", { url })}</p>
      <label className="field"><span>{t("setup.email")}</span><input className="input" type="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="field"><span>{t("setup.password")}</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <div className="flex justify-between gap-2 pt-1">
        <button type="button" className="btn ghost" onClick={onBack}>{t("common.back")}</button>
        <button type="submit" className={cn("btn primary")} disabled={busy || !email || !password}>{busy ? t("setup.checking") : t("setup.connect")}</button>
      </div>
    </form>
  );
}
