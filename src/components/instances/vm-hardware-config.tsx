"use client";

import { Alert, Button, PageSection, SkeletonText } from "@/components/ui";
import { useAction } from "@/hooks/use-action";
import { err, ok } from "@/lib/action-result";
import {
    getHostCapabilitiesAction,
    getVmHardwareAction,
    updateVmHardwareAction,
    type HostCapabilities,
} from "@/server/actions/local-kvm";
import { Cpu, MemoryStick, Save } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

const RAM_PRESETS_MB = [4096, 8192, 12288, 16384, 24576, 32768];
const CORES_OPTIONS = [1, 2, 4, 6, 8];
const THREAD_FACTORS = [1, 2]; // SMT 1× or 2×

interface Hardware {
  cores: number;
  threads: number;
  ramMb: number;
}

export function VmHardwareConfig({
  accountId,
  vmRunning,
}: {
  accountId: string;
  vmRunning: boolean;
}) {
  const t = useTranslations("vm.hardware");
  const tc = useTranslations("common");
  const [caps, setCaps] = useState<HostCapabilities | null>(null);
  const [initial, setInitial] = useState<Hardware | null>(null);
  const [draft, setDraft] = useState<Hardware | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedNextBoot, setSavedNextBoot] = useState(false);

  const { run: runSave, pending } = useAction(
    async (hw: Hardware) => {
      const r = await updateVmHardwareAction(accountId, hw);
      if (!r.ok) return err(r.error, undefined, r.fieldErrors);
      return ok(r.appliedNextBoot);
    },
    {
      success: (nextBoot) => (nextBoot ? t("savedNextBoot") : t("saved")),
      refresh: false,
    },
  );

  // Load current config + host caps in parallel
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [hwR, capsR] = await Promise.all([
        getVmHardwareAction(accountId),
        getHostCapabilitiesAction(accountId),
      ]);
      if (cancelled) return;
      if (hwR.ok) {
        const hw = { cores: hwR.cores, threads: hwR.threads, ramMb: hwR.ramMb };
        setInitial(hw);
        setDraft(hw);
      } else {
        setError(hwR.error);
      }
      if (capsR.ok) setCaps(capsR.caps);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (error) {
    return (
      <PageSection title={t("title")} description={t("description")}>
        <Alert tone="danger">{error}</Alert>
      </PageSection>
    );
  }

  if (!draft || !initial) {
    return (
      <PageSection title={t("title")} description={t("probing")}>
        <SkeletonText lines={3} />
      </PageSection>
    );
  }

  const dirty =
    draft.cores !== initial.cores ||
    draft.threads !== initial.threads ||
    draft.ramMb !== initial.ramMb;

  const maxRamMb = caps ? Math.max(1024, caps.hostMemMb - 1536) : 65536;
  const maxCores = caps ? caps.hostCores : 32;

  function setCores(c: number) {
    setDraft((d) =>
      d ? { ...d, cores: c, threads: Math.max(d.threads, c) } : d,
    );
  }
  function setThreads(t: number) {
    setDraft((d) => (d ? { ...d, threads: t } : d));
  }
  function setRam(r: number) {
    setDraft((d) => (d ? { ...d, ramMb: r } : d));
  }

  function reset() {
    setDraft(initial);
    setFieldErrors({});
  }

  async function save() {
    if (!draft) return;
    setFieldErrors({});
    const r = await runSave(draft);
    if (r.ok) {
      setInitial(draft);
      setSavedNextBoot(Boolean(r.data));
    } else if (r.fieldErrors) {
      setFieldErrors(r.fieldErrors);
    }
  }

  const smtFactor = (draft.threads / draft.cores).toFixed(0);

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        caps && (
          <span className="text-[11px] text-muted">
            {t("host", { threads: caps.hostCores, gib: (caps.hostMemMb / 1024).toFixed(1) })}
          </span>
        )
      }
    >
      <div className="space-y-4">
        <HardwareField
          icon={Cpu}
          label={t("cores")}
          value={String(draft.cores)}
          right={t("coresValue", { count: draft.cores })}
        >
          <Pills
            value={draft.cores}
            options={CORES_OPTIONS.filter((c) => c <= maxCores)}
            onChange={setCores}
          />
        </HardwareField>

        <HardwareField
          icon={Cpu}
          label={t("threads")}
          value={t("threadsSmt", { count: draft.threads, factor: smtFactor })}
          right={t("threadsValue", { count: draft.threads })}
          error={fieldErrors.threads}
        >
          <Pills
            value={draft.threads}
            options={THREAD_FACTORS.map((f) => draft.cores * f).filter(
              (t) => t <= maxCores,
            )}
            onChange={setThreads}
            renderLabel={(n) => t("threadOption", { count: n, factor: (n / draft.cores).toFixed(0) })}
          />
        </HardwareField>

        <HardwareField
          icon={MemoryStick}
          label={t("ram")}
          value={t("ramGib", { gib: (draft.ramMb / 1024).toFixed(draft.ramMb % 1024 === 0 ? 0 : 1) })}
          right={t("ramMib", { mib: draft.ramMb })}
          error={fieldErrors.ramMb}
        >
          <Pills
            value={draft.ramMb}
            options={RAM_PRESETS_MB.filter((r) => r <= maxRamMb)}
            onChange={setRam}
            renderLabel={(r) => `${r / 1024}G`}
          />
          <input
            type="range"
            min={1024}
            max={maxRamMb}
            step={1024}
            value={draft.ramMb}
            onChange={(e) => setRam(Number(e.target.value))}
            className="vmui-range mt-2 w-full"
            aria-label={t("ramAria")}
          />
        </HardwareField>

        <AnimatePresence>
          {vmRunning && (dirty || savedNextBoot) && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <Alert tone="warning" className="text-xs">
                {t("runningWarning")}
              </Alert>
            </m.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty || pending}>
            {t("reset")}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty} loading={pending}>
            <Save className="h-3.5 w-3.5" aria-hidden />
            {tc("save")}
          </Button>
        </div>
      </div>
    </PageSection>
  );
}

function HardwareField({
  icon: Icon,
  label,
  value,
  right,
  children,
  error,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  right?: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted">
          <Icon className="h-3 w-3" aria-hidden />
          {label}
        </div>
        <div className="font-mono text-sm tabular-nums">{value}</div>
      </div>
      {children}
      <div className="flex items-center justify-between text-[11px]">
        <span className={error ? "text-danger" : "text-muted"} role={error ? "alert" : undefined}>
          {error ?? "\u00a0"}
        </span>
        <span className="text-muted">{right}</span>
      </div>
    </div>
  );
}

function Pills<T extends number>({
  value,
  options,
  onChange,
  renderLabel,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  renderLabel?: (v: T) => string;
}) {
  // Stable id-per-mount so each Pills group has its own layout animation
  const groupId = useId();
  return (
    <div className="flex flex-wrap gap-1.5" role="group">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <m.button
            key={opt}
            type="button"
            layout
            whileTap={{ scale: 0.96 }}
            onClick={() => onChange(opt)}
            aria-pressed={active}
            className={
              "relative min-h-8 rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
              (active
                ? "border-primary text-primary"
                : "border-border text-muted hover:text-fg")
            }
          >
            {active && (
              <m.span
                layoutId={`pill-bg-${groupId}`}
                className="absolute inset-0 -z-10 rounded-full bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)]"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            )}
            {renderLabel ? renderLabel(opt) : opt}
          </m.button>
        );
      })}
    </div>
  );
}
