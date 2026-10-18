"use client";

import { Alert, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { addLocalKvmAccount, type LocalKvmAccountFormState } from "@/server/actions/accounts";
import { Apple, HousePlug, MonitorCog, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeBlock, ConnectField, ConnectPanel, RICH, SubmitButton } from "./connect-shared";

const initial: LocalKvmAccountFormState = {};

type Kind = "mac" | "win" | "ubuntu" | "hyperv-win" | "hyperv-haos";

interface KindPreset {
  vmDir: string;
  vncPort: number;
  qmpPort: number;
  sshPort: number;
  wsPort: number;
  ramMb: number;
  cores: number;
  threads: number;
  bootScript: string;
  setupScript: string;
}

// Keep these in sync with KIND_DEFAULTS in src/lib/providers/local-kvm.ts.
const PRESETS: Record<Kind, KindPreset> = {
  mac: {
    vmDir: "/home/dragos/OSX-KVM",
    vncPort: 5900,
    qmpPort: 4444,
    sshPort: 10022,
    wsPort: 6080,
    ramMb: 16384,
    cores: 4,
    threads: 8,
    bootScript: "boot-mac.sh",
    setupScript: "scripts/setup-osx-kvm.sh",
  },
  win: {
    vmDir: "/home/dragos/vmui-vms/win",
    vncPort: 6900,
    qmpPort: 4445,
    sshPort: 10023,
    wsPort: 6090,
    ramMb: 8192,
    cores: 4,
    threads: 8,
    bootScript: "boot-win.sh",
    setupScript: "scripts/setup-win-vm.sh",
  },
  ubuntu: {
    vmDir: "/home/dragos/vmui-vms/ubuntu",
    vncPort: 7900,
    qmpPort: 4446,
    sshPort: 10024,
    wsPort: 6100,
    ramMb: 4096,
    cores: 2,
    threads: 4,
    bootScript: "boot-ubuntu.sh",
    setupScript: "scripts/setup-ubuntu-vm.sh",
  },
  "hyperv-win": {
    vmDir: "",
    vncPort: 0,
    qmpPort: 0,
    sshPort: 13389,
    wsPort: 0,
    ramMb: 8192,
    cores: 4,
    threads: 8,
    bootScript: "setup-win-hyperv.ps1",
    setupScript: "scripts/setup-win-hyperv.ps1",
  },
  "hyperv-haos": {
    vmDir: "",
    vncPort: 0,
    qmpPort: 0,
    sshPort: 22222,
    wsPort: 0,
    ramMb: 6144,
    cores: 4,
    threads: 4,
    bootScript: "homeassistant.ps1",
    setupScript: "scripts/homeassistant.ps1 -Build",
  },
};

const KIND_ICON: Record<Kind, React.ComponentType<{ className?: string }>> = {
  mac: Apple,
  win: MonitorCog,
  ubuntu: Terminal,
  "hyperv-win": MonitorCog,
  "hyperv-haos": HousePlug,
};

const KINDS = Object.keys(PRESETS) as Kind[];

export function LocalKvmAccountConnect() {
  const t = useTranslations("cloud.connect.localKvm");
  const tp = useTranslations("cloud.shared.provider");
  const [state, action, pending] = useActionState(addLocalKvmAccount, initial);
  const [kind, setKind] = useState<Kind>("mac");
  const router = useRouter();
  const preset = useMemo(() => PRESETS[kind], [kind]);

  useEffect(() => {
    if (state.ok && state.accountId) {
      if (state.generatedCreds) {
        // The plaintext password cannot be recovered later, so stay on the page.
        toast.success(t("generated.toast", { username: state.generatedCreds.username, password: state.generatedCreds.password }), { duration: 30_000 });
      } else {
        toast.success(t("connected"));
        router.push("/");
      }
      router.refresh();
    } else if (state.error && !state.fieldErrors) {
      toast.error(state.error);
    }
  }, [state, router, t]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ConnectPanel icon={<MonitorCog />} title={t("title")} description={t("description")}>
        {/* Re-keying on `kind` refreshes every defaultValue when the guest kind changes. */}
        <form key={kind} action={action} className="grid gap-4">
          <input type="hidden" name="kind" value={kind} />

          <fieldset className="grid gap-1.5">
            <legend className="text-xs text-muted">{t("guestKind")}</legend>
            <div role="radiogroup" aria-label={t("guestKind")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                const active = k === kind;
                return (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setKind(k)}
                    role="radio"
                    aria-checked={active}
                    className={cn(
                      "flex min-h-16 flex-col items-start gap-1 rounded-[var(--radius-md)] border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      active
                        ? "border-primary bg-[color-mix(in_oklch,var(--color-primary)_10%,transparent)]"
                        : "border-border hover:bg-surface-muted",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className="size-4" aria-hidden />
                      <span className="text-sm font-semibold">{t(`kinds.${k}.label`)}</span>
                    </span>
                    <span className="text-[11px] text-muted">{t(`kinds.${k}.sub`)}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <ConnectField name="name" label={t("fields.name")} placeholder={t("namePlaceholder", { kind: t(`kinds.${kind}.label`) })} error={state.fieldErrors?.name} required />
          <ConnectField
            name="hostLabel"
            label={t("fields.hostLabel")}
            placeholder={t("fields.hostLabelPlaceholder")}
            hint={t("fields.hostLabelHint")}
            error={state.fieldErrors?.hostLabel}
            required
            defaultValue={t(`kinds.${kind}.hostLabel`)}
          />
          <ConnectField
            name="distro"
            label={t("fields.distro")}
            placeholder={t("fields.distroPlaceholder")}
            hint={t("fields.distroHint")}
            error={state.fieldErrors?.distro}
            required
            defaultValue="Ubuntu-24.04"
          />
          <ConnectField
            name="vmDir"
            label={t("fields.vmDir")}
            placeholder={preset.vmDir}
            hint={t("fields.vmDirHint", { script: preset.bootScript })}
            error={state.fieldErrors?.vmDir}
            required
            defaultValue={preset.vmDir}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ConnectField name="vncPort" label={t("fields.vncPort")} type="number" defaultValue={String(preset.vncPort)} error={state.fieldErrors?.vncPort} />
            <ConnectField name="qmpPort" label={t("fields.qmpPort")} type="number" defaultValue={String(preset.qmpPort)} error={state.fieldErrors?.qmpPort} />
            <ConnectField name="sshPort" label={t("fields.sshPort")} type="number" defaultValue={String(preset.sshPort)} error={state.fieldErrors?.sshPort} />
            <ConnectField name="wsPort" label={t("fields.wsPort")} type="number" defaultValue={String(preset.wsPort)} error={state.fieldErrors?.wsPort} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ConnectField name="cores" label={t("fields.cores")} type="number" defaultValue={String(preset.cores)} error={state.fieldErrors?.cores} />
            <ConnectField name="threads" label={t("fields.threads")} type="number" defaultValue={String(preset.threads)} error={state.fieldErrors?.threads} />
            <ConnectField name="ramMb" label={t("fields.ramMb")} type="number" defaultValue={String(preset.ramMb)} error={state.fieldErrors?.ramMb} />
          </div>
          {kind !== "mac" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <ConnectField name="osUsername" label={t("fields.osUsername")} placeholder={t("fields.osUsernamePlaceholder")} hint={t("fields.osUsernameHint")} error={state.fieldErrors?.osUsername} />
              <ConnectField
                name="osPassword"
                label={t("fields.osPassword")}
                type="password"
                autoComplete="off"
                placeholder={t("fields.osPasswordPlaceholder")}
                hint={t("fields.osPasswordHint")}
                error={state.fieldErrors?.osPassword}
              />
            </div>
          )}
          <SubmitButton pending={pending} provider={tp("local-kvm")} />
          {state.generatedCreds && <GeneratedCreds creds={state.generatedCreds} />}
        </form>
      </ConnectPanel>

      <ConnectPanel icon={<Terminal />} title={t("checklist.title", { kind: t(`kinds.${kind}.label`) })} description={t("checklist.description")}>
        <div className="space-y-4 text-sm">
          <Check title={t("checklist.kvm.title")}>
            <CodeBlock code="wsl -- bash -lc 'ls -la /dev/kvm'" />
            <p>{t.rich("checklist.kvm.body", RICH)}</p>
          </Check>
          <Check title={t("checklist.qemu.title")}>
            <CodeBlock code="wsl -- bash -lc 'qemu-system-x86_64 --version'" />
            <p>{t.rich("checklist.qemu.body", { ...RICH, script: () => <code className="font-mono">{preset.setupScript}</code> })}</p>
            <p>{t(`kinds.${kind}.setupHint`)}</p>
          </Check>
          <Check title={t("checklist.setup.title", { script: preset.setupScript })}>
            <CodeBlock code={`wsl -- bash /mnt/e/gh/vmui/${preset.setupScript}`} />
            <p>{t("checklist.setup.body", { dir: preset.vmDir })}</p>
          </Check>
          {kind === "mac" && (
            <Check title={t("checklist.mac.title")}>
              <p>{t.rich("checklist.mac.body", RICH)}</p>
            </Check>
          )}
          {kind === "win" && (
            <Check title={t("checklist.win.title")}>
              <p>{t.rich("checklist.win.body", RICH)}</p>
            </Check>
          )}
          {kind === "ubuntu" && (
            <Check title={t("checklist.ubuntu.title")}>
              <p>{t.rich("checklist.ubuntu.body", RICH)}</p>
            </Check>
          )}
          <Check title={t("checklist.msrs.title")}>
            <CodeBlock code="wsl -- bash -lc 'echo 1 | sudo tee /sys/module/kvm/parameters/ignore_msrs'" />
          </Check>
        </div>
      </ConnectPanel>
    </div>
  );
}

function GeneratedCreds({ creds }: { creds: { username: string; password: string } }) {
  const t = useTranslations("cloud.connect.localKvm.generated");
  return (
    <Alert tone="warning" title={t("title")}>
      <div className="space-y-2">
        <p>{t("body")}</p>
        <pre className="select-all rounded-[var(--radius-sm)] bg-surface-muted p-2 font-mono text-[11px]">
          {`username: ${creds.username}\npassword: ${creds.password}`}
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(`${creds.username}:${creds.password}`);
            toast.success(t("copied"));
          }}
        >
          {t("copy")}
        </Button>
      </div>
    </Alert>
  );
}

function Check({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-1 space-y-1 text-xs text-muted">{children}</div>
    </div>
  );
}
