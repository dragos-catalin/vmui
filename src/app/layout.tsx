import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { ThemedToaster } from "@/components/appearance/themed-toaster";
import { SPLASH_BOOT_SCRIPT, Splash } from "@/components/brand/splash";
import { AmbientWarmth } from "@/components/home/ambient-warmth";
import { IncidentBanner } from "@/components/incident-banner";
import { ContextRailHost, ContextRailProvider } from "@/components/nav/context-rail";
import { GlobalOverlays } from "@/components/nav/global-overlays";
import { MobileNav } from "@/components/nav/mobile-nav";
import { NavProgress } from "@/components/nav/nav-progress";
import { Sidebar } from "@/components/nav/sidebar";
import { SkipLink } from "@/components/nav/skip-link";
import { Topbar } from "@/components/nav/topbar";
import { UserMenu } from "@/components/nav/user-menu";
import { PullToRefresh } from "@/components/pwa/pull-to-refresh";
import { QueryProvider } from "@/components/query-provider";
import { RealtimeListener } from "@/components/realtime-listener";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VoiceCommander } from "@/components/voice-commander";
import { ensureAlertSchedulerRunning } from "@/lib/alert-engine";
import { accentHueOf, appearanceAttributes } from "@/lib/appearance/model";
import { resolveAppearance } from "@/lib/appearance/server";
import { ensureAuditRetention } from "@/lib/audit-retention";
import { getCurrentUser } from "@/lib/auth";
import { ensureBackupSchedulerRunning } from "@/lib/backups";
import { ensureComplianceScanRunning } from "@/lib/compliance-scheduler";
import { ensureGitopsSchedulerRunning } from "@/lib/gitops";
import { currentHomeActor } from "@/lib/home/access";
import { ensureSchedulerRunning } from "@/lib/scheduler";
import { startWebhookDispatcher } from "@/lib/webhook-dispatcher";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter-tight/wght.css";
import "./globals.css";

// Module-load side effects run in every `next build` page-data worker too
// (~30 of them, each opening the SQLite file and starting timers). Only the
// real server should.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  ensureSchedulerRunning();
  ensureAuditRetention();
  startWebhookDispatcher();
  ensureComplianceScanRunning();
  ensureAlertSchedulerRunning();
  ensureGitopsSchedulerRunning();
  ensureBackupSchedulerRunning();
}

export const metadata: Metadata = {
  title: { default: "Vatra", template: "%s · Vatra" },
  description: "Vatra — home & machines. One calm place for the house and the machines.",
  manifest: "/manifest.webmanifest",
  applicationName: "Vatra",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Vatra",
  },
  openGraph: { title: "Vatra", description: "home & machines · casă și mașini", type: "website" },
};

export const viewport: Viewport = {
  // Brand bg tokens (vatra-theme.css bg) as hex: browser chrome cannot read CSS variables.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdf9f6" },
    { media: "(prefers-color-scheme: dark)", color: "#110b07" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // /display (Nest Hub kiosk) gets a bare document: no sidebar (which prefetches
  // ~30 routes), no palette / voice / SW / realtime — the Hub has 4 slow cores.
  const locale = await getLocale();
  if ((await headers()).get("x-vmui-kiosk") === "1") {
    return (
      <html lang={locale} className="display-root" suppressHydrationWarning>
        <body>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </body>
      </html>
    );
  }
  // Family members (adult/child/guest) get the home surface only: no VM navigation, no incident banner.
  // Redirecting here (not in page.tsx) runs before the shell streams, so it is a real 307 instead of a
  // client-side replace racing the dashboard's Suspense fallback.
  const familyOnly = await currentHomeActor().then((a) => !!a && a.role !== "owner").catch(() => false);
  if (familyOnly) {
    const path = (await headers()).get("x-vmui-path") ?? "";
    if (path && !path.startsWith("/home") && !path.startsWith("/sign-") && !path.startsWith("/invite")) redirect("/home");
  }
  // Auth-ish pages (sign-in, invitation acceptance) have no shell: nothing to navigate to yet.
  const path = (await headers()).get("x-vmui-path") ?? "";
  const bare = path.startsWith("/invite/") || path.startsWith("/sign-in") || path.startsWith("/sign-up");
  const appearance = await resolveAppearance();
  const { style: _accentStyle, ...htmlAttrs } = appearanceAttributes(appearance);
  const railCookie = (await cookies()).get("vmui_sidebar")?.value;
  const initialCollapsed = railCookie === "1" ? true : railCookie === "0" ? false : undefined;
  const tShell = await getTranslations("shell");
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      {...htmlAttrs}
      {...(initialCollapsed === undefined ? {} : { "data-sidebar": initialCollapsed ? "rail" : "full" })}
      style={{ ["--accent-h" as string]: String(accentHueOf(appearance)) }}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: SPLASH_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <SkipLink />
        <NextIntlClientProvider>
          <AppearanceProvider initial={appearance}>
            <QueryProvider>
              <TooltipProvider delayDuration={300}>
                <ConfirmProvider>
                  <NavProgress />
                  {!bare && <Splash label={tShell("splash")} />}
                  <PullToRefresh>
                    {bare ? (
                      <main className="grid min-h-dvh place-items-center overflow-x-clip px-4 py-10">{children}</main>
                    ) : (
                    <ContextRailProvider>
                      <div className="flex min-h-dvh">
                        <Sidebar compact={familyOnly} initialCollapsed={initialCollapsed} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <Topbar user={<UserMenuSlot />} compact={familyOnly} />
                          <div className="flex min-w-0 flex-1">
                            <main id="main" className="min-w-0 flex-1 px-4 pb-24 pt-4 sm:px-6 md:pb-12 lg:px-10">
                              {!familyOnly && <IncidentBanner />}
                              {children}
                            </main>
                            <ContextRailHost compact={familyOnly} />
                          </div>
                        </div>
                      </div>
                    </ContextRailProvider>
                    )}
                  </PullToRefresh>
                  <MobileNav compact={familyOnly || bare} />
                  <ThemedToaster />
                  <GlobalOverlays />
                  <ServiceWorkerRegister />
                  <VoiceCommander />
                  <RealtimeListener />
                  <AmbientWarmth />
                </ConfirmProvider>
              </TooltipProvider>
            </QueryProvider>
          </AppearanceProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

async function UserMenuSlot() {
  try {
    const user = await getCurrentUser();
    if (!user) return null;
    return <UserMenu user={{ email: user.email, displayName: user.displayName, role: user.role }} />;
  } catch {
    return null;
  }
}
