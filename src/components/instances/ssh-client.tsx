"use client";

import { TerminalView } from "@/components/instances/terminal-view-lazy";
import { Alert, Button, Field, Input, PageSection, Textarea, ToggleGroup } from "@/components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useInterval } from "@/hooks/use-poll";
import type { InstanceRow } from "@/lib/db/schema";
import {
    openCustomSshAction,
    openLocalKvmSshAction,
    openSavedKeySshAction,
    reconnectSshSessionAction,
} from "@/server/actions/ssh";
import { Clock, KeyRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

export interface SavedKeyOption {
  id: string;
  name: string;
  algo: string;
  hasPrivate: boolean;
}

const TTL_OPTIONS = [
  { key: "ttl5m", ms: 5 * 60_000 },
  { key: "ttl15m", ms: 15 * 60_000 },
  { key: "ttl1h", ms: 60 * 60_000 },
  { key: "ttl4h", ms: 4 * 60 * 60_000 },
  { key: "ttl8h", ms: 8 * 60 * 60_000 },
] as const;
const DEFAULT_TTL_MS = 60 * 60_000;

export function SshClient({ instance, savedKeys = [] }: { instance: InstanceRow; savedKeys?: SavedKeyOption[] }) {
  const t = useTranslations("vm.ssh");
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ttlMs, setTtlMs] = useState<number>(DEFAULT_TTL_MS);

  const usableKeys = savedKeys.filter((k) => k.hasPrivate);
  const [savedKeyId, setSavedKeyId] = useState<string>(usableKeys[0]?.id ?? "");
  const [mode, setMode] = useState<"saved" | "paste">(usableKeys.length > 0 ? "saved" : "paste");

  // Custom-SSH form state (for AWS/Azure/GCP).
  const [username, setUsername] = useState(defaultUserFor(instance));
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const isLocal = instance.provider === "local-kvm";

  const openLocal = useCallback(async () => {
    setError(null);
    setLoading(true);
    const r = await openLocalKvmSshAction({
      accountId: instance.accountId,
      providerInstanceId: instance.providerInstanceId,
      ttlMs,
    });
    setLoading(false);
    if (r.ok) {
      setWsUrl(r.wsUrl);
      setSessionId(r.sessionId);
      setExpiresAt(r.expiresAt);
    } else setError(r.error);
  }, [instance.accountId, instance.providerInstanceId, ttlMs]);

  const reconnect = useCallback(async () => {
    if (!sessionId) {
      // Local sessions can be re-opened from scratch (creds are stored).
      if (isLocal) {
        setWsUrl(null);
        return openLocal();
      }
      setWsUrl(null);
      return;
    }
    setError(null);
    setLoading(true);
    const r = await reconnectSshSessionAction({ sessionId });
    setLoading(false);
    if (r.ok) {
      setWsUrl(r.wsUrl);
      setExpiresAt(r.expiresAt);
    } else {
      // Session expired — force credential re-entry.
      setSessionId(null);
      setWsUrl(null);
      setError(r.error);
    }
  }, [sessionId, isLocal, openLocal]);

  async function openCustom() {
    if (mode === "saved") {
      if (!username || !savedKeyId) {
        setError(t("needUsernameAndSavedKey"));
        return;
      }
      setError(null);
      setLoading(true);
      const r = await openSavedKeySshAction({
        accountId: instance.accountId,
        providerInstanceId: instance.providerInstanceId,
        username,
        sshKeyId: savedKeyId,
        ttlMs,
      });
      setLoading(false);
      if (r.ok) {
        setWsUrl(r.wsUrl);
        setSessionId(r.sessionId);
        setExpiresAt(r.expiresAt);
      } else setError(r.error);
      return;
    }
    if (!username || !privateKey) {
      setError(t("needUsernameAndPrivateKey"));
      return;
    }
    setError(null);
    setLoading(true);
    const r = await openCustomSshAction({
      accountId: instance.accountId,
      providerInstanceId: instance.providerInstanceId,
      username,
      privateKey,
      passphrase: passphrase || undefined,
      ttlMs,
    });
    setLoading(false);
    if (r.ok) {
      setWsUrl(r.wsUrl);
      setSessionId(r.sessionId);
      setExpiresAt(r.expiresAt);
    } else setError(r.error);
  }

  useEffect(() => {
    if (isLocal) void openLocal();
  }, [isLocal, openLocal]);

  if (wsUrl) {
    return (
      <div className="space-y-4">
        {expiresAt && <SessionExpiryBar expiresAt={expiresAt} />}
        <TerminalView
          wsUrl={wsUrl}
          label={`${username}@${instance.publicIp ?? instance.publicDns ?? "127.0.0.1"}`}
          onReconnect={reconnect}
        />
      </div>
    );
  }

  if (isLocal) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-sm">
        {loading ? (
          <Button variant="ghost" loading disabled>
            {t("opening")}
          </Button>
        ) : error ? (
          <Alert tone="danger">{error}</Alert>
        ) : null}
      </div>
    );
  }

  const ttlValue = String(ttlMs);
  const canConnect = Boolean(username) && (mode === "saved" ? Boolean(savedKeyId) : Boolean(privateKey));

  return (
    <PageSection title={t("credentialsTitle")} description={t("credentialsDescription")}>
      <div className="grid gap-4">
        <Field label={t("username")}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </Field>

        <div className="space-y-1.5">
          <span id="ssh-ttl-label" className="flex items-center gap-1 text-xs text-muted">
            <Clock className="size-3.5" aria-hidden /> {t("duration")}
          </span>
          <ToggleGroup
            size="sm"
            aria-labelledby="ssh-ttl-label"
            value={ttlValue}
            onValueChange={(v) => setTtlMs(Number(v))}
            options={TTL_OPTIONS.map((o) => ({ value: String(o.ms), label: t(o.key) }))}
          />
          <p className="text-xs leading-snug text-muted">{t("durationHint")}</p>
        </div>

        {usableKeys.length > 0 && (
          <ToggleGroup
            size="sm"
            aria-label={t("keySource")}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "saved", label: t("useSaved") },
              { value: "paste", label: t("pasteKey") },
            ]}
          />
        )}

        {mode === "saved" && usableKeys.length > 0 ? (
          <Field label={t("savedKey")}>
            <Select value={savedKeyId} onValueChange={setSavedKeyId}>
              <SelectTrigger aria-label={t("savedKey")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {usableKeys.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {t("savedKeyOption", { name: k.name, algo: k.algo })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <>
            <Field label={t("privateKey")}>
              <Textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={t("privateKeyPlaceholder")}
                className="bg-bg-muted font-mono text-[11px]"
              />
            </Field>
            <Field label={t("passphrase")}>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}

        <div>
          <Button onClick={openCustom} loading={loading} disabled={!canConnect}>
            <KeyRound className="size-4" aria-hidden /> {t("connect")}
          </Button>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </PageSection>
  );
}

function defaultUserFor(inst: InstanceRow): string {
  if (inst.provider === "aws") return inst.platform === "linux" ? "ec2-user" : "ec2-user";
  if (inst.provider === "azure") return "azureuser";
  if (inst.provider === "gcp") return "ubuntu";
  if (inst.provider === "scaleway") return "m1";
  if (inst.provider === "digitalocean") return "root";
  if (inst.provider === "hetzner") return "root";
  return "ubuntu";
}

function SessionExpiryBar({ expiresAt }: { expiresAt: number }) {
  const t = useTranslations("vm.ssh");
  const format = useFormatter();
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 30_000, { pauseHidden: false });
  const remainingMs = Math.max(0, expiresAt - now);
  if (remainingMs === 0) {
    return <Alert tone="danger" icon={<Clock />} className="text-xs">{t("expired")}</Alert>;
  }
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-1.5 text-xs text-muted">
      <Clock className="size-3.5" aria-hidden /> {t("reconnectWindow", { time: format.relativeTime(expiresAt, now) })}
    </div>
  );
}
