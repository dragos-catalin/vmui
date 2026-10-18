"use client";

import { useAppearance } from "@/components/appearance/appearance-provider";
import { useContextRail } from "@/components/nav/context-rail";
import { InstallButton } from "@/components/pwa/install-prompt";
import { PushManager } from "@/components/pwa/push-manager";
import { SoundEffectsToggle } from "@/components/sound-effects-toggle";
import { Alert, Badge, Button, Field, Kbd, PageHeader, PageSection, PageShell, Stat, StatGrid } from "@/components/ui";
import type { BootScriptRow, WebhookRow } from "@/lib/db/schema";
import type { CodaiSettingsPublic } from "@/lib/codai/settings";
import type { QuietHoursConfig } from "@/lib/quiet-hours";
import type { KnownHostRow } from "@/server/actions/known-hosts";
import type { SettingsSnapshot } from "@/server/queries/settings";
import { Activity, ArrowRight, Cloud, History, House, Key, KeyRound, Palette, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import * as React from "react";
import { BackupCard } from "./backup-card";
import { BootScriptsCard } from "./boot-scripts-card";
import { ChangePasswordCard } from "./change-password-card";
import { CodaiCard } from "./codai-card";
import { KnownHostsCard } from "./known-hosts-card";
import { PasskeysCard } from "./passkeys-card";
import { QuietHoursPanel } from "./quiet-hours-panel";
import { SETTINGS_HUB_SECTIONS } from "./sections";
import { SessionsCard } from "./sessions-card";
import { SettingsNav } from "./settings-nav";
import { TotpCard } from "./totp-card";
import { WebhooksCard } from "./webhooks-card";

export interface SettingsHubProps {
  snapshot: SettingsSnapshot;
  knownHosts: KnownHostRow[];
  webhooks: WebhookRow[];
  bootScripts: BootScriptRow[];
  quietHours: QuietHoursConfig;
  authEnabled: boolean;
  codai: CodaiSettingsPublic;
}

const ENTRANCE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
} as const;

export function SettingsHub(props: SettingsHubProps) {
  const t = useTranslations("settings");
  const [section, setSection] = useQueryState(
    "section",
    parseAsStringLiteral(SETTINGS_HUB_SECTIONS).withDefault("general").withOptions({ shallow: true, history: "replace" }),
  );
  const rail = useContextRail(<RelatedLinks />);

  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} icon={<SettingsIcon />} />
      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,16rem)_minmax(0,1fr)] lg:items-start">
        <SettingsNav value={section} onChange={(s) => void setSection(s)} />
        <AnimatePresence mode="wait" initial={false}>
        <m.div key={section} {...ENTRANCE} className="min-w-0 space-y-4">
          {section === "general" && <GeneralSection snapshot={props.snapshot} />}
          {section === "security" && <SecuritySection authEnabled={props.authEnabled} />}
          {section === "users" && <UsersSection />}
          {section === "access" && <AccessSection knownHosts={props.knownHosts} />}
          {section === "automation" && (
            <AutomationSection webhooks={props.webhooks} bootScripts={props.bootScripts} quietHours={props.quietHours} />
          )}
          {section === "integrations" && <CodaiCard initial={props.codai} />}
          {section === "data" && <BackupCard />}
          <div className="2xl:hidden">
            <RelatedLinks />
          </div>
        </m.div>
        </AnimatePresence>
      </div>
      {rail}
    </PageShell>
  );
}

function RelatedLinks() {
  const t = useTranslations("settings.rail");
  const links = [
    { href: "/activity", label: t("activity"), Icon: History },
    { href: "/accounts", label: t("accounts"), Icon: Cloud },
    { href: "/home?tab=settings", label: t("home"), Icon: House },
  ];
  return (
    <section aria-label={t("related")} className="surface p-4">
      <h2 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-muted">{t("related")}</h2>
      <ul className="space-y-1">
        {links.map(({ href, label, Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] px-2 text-sm text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
              </span>
              <ArrowRight className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatBytes(b: number | null): string {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i] ?? "B"}`;
}

function Value({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <p className={mono ? "min-w-0 truncate font-mono text-xs" : "min-w-0 truncate text-sm"} title={typeof children === "string" ? children : undefined}>
      {children}
    </p>
  );
}

function GeneralSection({ snapshot: s }: { snapshot: SettingsSnapshot }) {
  const t = useTranslations("settings.general");
  const format = useFormatter();
  return (
    <>
      <PageSection title={t("environment.title")} description={t("environment.description")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("environment.masterKey")} hint={t.rich("environment.masterKeyHint", { cmd: (chunks) => <code className="font-mono">{chunks}</code> })}>
            <div className="flex flex-wrap items-center gap-2">
              {s.masterKeySet ? (
                <Badge variant="success">
                  <ShieldCheck className="size-3" aria-hidden /> {t("environment.set")}
                </Badge>
              ) : (
                <Badge variant="danger">
                  <ShieldAlert className="size-3" aria-hidden /> {t("environment.missing")}
                </Badge>
              )}
              <span className="font-mono text-xs text-fg-muted">{s.masterKeyFingerprint ?? "—"}</span>
            </div>
          </Field>
          <Field label={t("environment.source")}>
            <Value mono>VMUI_MASTER_KEY · .env</Value>
          </Field>
          <Field label={t("environment.dbPath")}>
            <Value mono>{s.dbPath}</Value>
          </Field>
          <Field label={t("environment.dbResolved")}>
            <Value mono>{s.dbAbsolutePath}</Value>
          </Field>
          <Field label={t("environment.dbSize")}>
            <Value>{formatBytes(s.dbSizeBytes)}</Value>
          </Field>
          <Field label={t("environment.bind")}>
            <Value mono>{`${s.bindAddress}:${s.bindPort}`}</Value>
          </Field>
          <Field label={t("environment.syncInterval")}>
            <Value>{format.number(s.syncIntervalMs / 1000, { style: "unit", unit: "second" })}</Value>
          </Field>
          <Field label={t("environment.mode")}>
            <Value mono>{s.nodeEnv}</Value>
          </Field>
          <Field label={t("environment.appVersion")}>
            <Value mono>{s.appVersion}</Value>
          </Field>
        </div>
      </PageSection>

      <PageSection title={t("telemetry.title")} description={t("telemetry.description")}>
        <StatGrid cols={3} className="grid-cols-3 gap-2 sm:gap-3">
          <Stat compact label={t("telemetry.accounts")} value={format.number(s.counts.accounts)} icon={<Cloud />} />
          <Stat compact label={t("telemetry.instances")} value={format.number(s.counts.instances)} icon={<Activity />} />
          <Stat compact label={t("telemetry.auditEntries")} value={format.number(s.counts.auditEntries)} icon={<History />} />
        </StatGrid>
      </PageSection>

      <AppearanceSummary />

      <PageSection title={t("pwa.title")} description={t("pwa.description")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("pwa.install")}>
            <InstallButton />
          </Field>
          <Field label={t("pwa.sound")}>
            <SoundEffectsToggle />
          </Field>
          <Field
            className="sm:col-span-2"
            label={t("pwa.push")}
            hint={t.rich("pwa.pushHint", {
              code: (chunks) => <code className="my-0.5 inline-block max-w-full break-all align-baseline font-mono leading-normal">{chunks}</code>,
            })}
          >
            <PushManager />
          </Field>
        </div>
      </PageSection>

      <PageSection title={t("providers.title")} description={t("providers.description")}>
        <ul className="divide-y divide-border text-sm">
          {s.providers.map((p) => (
            <li key={p.id} className="flex min-h-10 items-center justify-between gap-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Cloud className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate font-medium" title={p.label}>{p.label}</span>
                <code className="hidden text-2xs text-fg-muted sm:inline">{p.id}</code>
              </div>
              {p.available ? <Badge variant="success">{t("providers.available")}</Badge> : <Badge variant="muted">{t("providers.soon")}</Badge>}
            </li>
          ))}
        </ul>
      </PageSection>

      <Shortcuts />
    </>
  );
}

function AppearanceSummary() {
  const t = useTranslations("settings.general.appearance");
  const ta = useTranslations("appearance");
  const locale = useLocale();
  const { appearance } = useAppearance();
  const motionLabel = appearance.reducedMotion === null ? t("motionSystem") : appearance.reducedMotion ? t("motionReduced") : t("motionFull");
  const localeName = new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  return (
    <PageSection title={t("title")} description={t("description")}>
      <Alert tone="neutral" icon={<Palette />} className="mb-3">
        {t("hint")}
      </Alert>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={t("theme")}>
          <Value>{ta(`theme.${appearance.theme}`)}</Value>
        </Field>
        <Field label={t("accent")}>
          <Value>{appearance.accent === "custom" ? `${ta("accent.custom")} · ${appearance.accentHue}°` : ta(`accent.${appearance.accent}`)}</Value>
        </Field>
        <Field label={t("surface")}>
          <Value>{ta(`surface.${appearance.surface}`)}</Value>
        </Field>
        <Field label={t("density")}>
          <Value>{ta(`density.${appearance.density}`)}</Value>
        </Field>
        <Field label={t("vibe")}>
          <Value>{ta(`vibe.${appearance.vibe}.name`)}</Value>
        </Field>
        <Field label={t("motion")}>
          <Value>{motionLabel}</Value>
        </Field>
        <Field label={t("locale")} hint={t("localeHint")}>
          <Value>{localeName}</Value>
        </Field>
      </div>
    </PageSection>
  );
}

function Shortcuts() {
  const t = useTranslations("settings.general.shortcuts");
  const rows: { keys: string[]; label: string }[] = [
    { keys: ["⌘", "K"], label: t("palette") },
    { keys: ["?"], label: t("help") },
    { keys: ["/"], label: t("search") },
    { keys: ["G", "I"], label: t("goInstances") },
    { keys: ["G", "A"], label: t("goAccounts") },
    { keys: ["G", "L"], label: t("goActivity") },
    { keys: ["G", "S"], label: t("goSettings") },
    { keys: ["N"], label: t("newInstance") },
    { keys: ["R"], label: t("syncAll") },
    { keys: ["T"], label: t("theme") },
    { keys: ["Esc"], label: t("escape") },
  ];
  return (
    <PageSection title={t("title")} description={t("description")}>
      <ul className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <li key={r.label} className="flex min-h-10 items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-bg-muted px-3 py-2">
            <span className="min-w-0 truncate text-fg-muted" title={r.label}>
              {r.label}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {r.keys.map((k, i) => (
                <React.Fragment key={k}>
                  {i > 0 && r.keys[0] === "G" && <span className="text-2xs text-fg-muted">{t("then")}</span>}
                  <Kbd>{k}</Kbd>
                </React.Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </PageSection>
  );
}

function SecuritySection({ authEnabled }: { authEnabled: boolean }) {
  const t = useTranslations("settings");
  if (!authEnabled) {
    return (
      <PageSection title={t("nav.security.title")}>
        <Alert
          tone="info"
          title={t("users.disabledTitle")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/sign-up">{t("users.createFirst")}</Link>
            </Button>
          }
        >
          {t("users.disabledHint")}
        </Alert>
      </PageSection>
    );
  }
  return (
    <>
      <PageSection title={t("security.password.title")} description={t("security.password.description")}>
        <ChangePasswordCard />
      </PageSection>
      <PageSection title={t("security.passkeys.title")} description={t("security.passkeys.description")}>
        <PasskeysCard />
      </PageSection>
      <PageSection title={t("security.totp.title")} description={t("security.totp.description")}>
        <TotpCard />
      </PageSection>
      <PageSection title={t("security.sessions.title")} description={t("security.sessions.description")}>
        <SessionsCard />
      </PageSection>
    </>
  );
}

function UsersSection() {
  const t = useTranslations("settings.users");
  const tr = useTranslations("auth.roles");
  return (
    <>
      <PageSection
        title={t("title")}
        description={t("description")}
        action={
          <Button asChild size="sm">
            <Link href="/settings/users">
              <Users className="size-4" aria-hidden /> {t("manage")}
            </Link>
          </Button>
        }
      >
        <ul className="space-y-2 text-sm">
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge variant="info">{tr("admin")}</Badge>
            <span className="text-fg-muted">{t("legend.admin")}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge>{tr("operator")}</Badge>
            <span className="text-fg-muted">{t("legend.operator")}</span>
          </li>
          <li className="flex flex-wrap items-baseline gap-2">
            <Badge variant="muted">{tr("viewer")}</Badge>
            <span className="text-fg-muted">{t("legend.viewer")}</span>
          </li>
        </ul>
      </PageSection>
      <PageSection
        title={t("familyLink")}
        description={t("hubHint")}
        action={
          <Button asChild size="sm" variant="secondary">
            <Link href="/home?tab=settings&section=family">
              <House className="size-4" aria-hidden /> {t("familyLink")}
            </Link>
          </Button>
        }
      >
        <p className="text-sm text-fg-muted">{t("familyHint")}</p>
      </PageSection>
    </>
  );
}

function AccessSection({ knownHosts }: { knownHosts: KnownHostRow[] }) {
  const t = useTranslations("settings.access");
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <PageSection
          title={t("apiKeys.title")}
          description={t("apiKeys.description")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/settings/api-keys">
                <Key className="size-4" aria-hidden /> {t("apiKeys.manage")}
              </Link>
            </Button>
          }
        >
          <p className="text-sm text-fg-muted">
            {t.rich("apiKeys.usage", { code: (chunks) => <code className="rounded bg-bg-muted px-1 font-mono text-xs">{chunks}</code> })}
          </p>
        </PageSection>
        <PageSection
          title={t("sshKeys.title")}
          description={t("sshKeys.hubDescription")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/settings/ssh-keys">
                <KeyRound className="size-4" aria-hidden /> {t("sshKeys.manage")}
              </Link>
            </Button>
          }
        >
          <p className="text-sm text-fg-muted">{t("sshKeys.description")}</p>
        </PageSection>
      </div>
      <KnownHostsCard initial={knownHosts} />
    </>
  );
}

function AutomationSection({ webhooks, bootScripts, quietHours }: { webhooks: WebhookRow[]; bootScripts: BootScriptRow[]; quietHours: QuietHoursConfig }) {
  const t = useTranslations("settings.automation");
  return (
    <>
      <WebhooksCard initial={webhooks} />
      <BootScriptsCard initial={bootScripts} />
      <PageSection title={t("quietHours.title")} description={t("quietHours.description")}>
        <QuietHoursPanel initial={quietHours} />
      </PageSection>
    </>
  );
}
