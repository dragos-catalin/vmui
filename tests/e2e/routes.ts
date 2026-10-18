// Every page route under src/app/**/page.tsx (inventory 2026-10-18: 97 pages).
// Dynamic segments get a placeholder that renders the not-found / empty state; they are
// marked `placeholder: true` so the audit report can tell them apart.
// Regenerate the list with: rg --files src/app -g page.tsx

export interface AuditRoute {
  path: string;
  /** Path contains a fake id/token: expect a not-found or empty state, not real data. */
  placeholder?: boolean;
  /** Public page (renders without a session). */
  public?: boolean;
}

const STATIC: string[] = [
  "/",
  "/account-budgets",
  "/account-forecast",
  "/accounts",
  "/accounts/new",
  "/achievements",
  "/action-history",
  "/activity",
  "/activity/archive",
  "/activity/sync",
  "/ai",
  "/alerts",
  "/anomalies",
  "/anomaly-playback",
  "/audit-chain",
  "/auto-park",
  "/auto-tag",
  "/backups",
  "/bill-explainer",
  "/boot-script-diff",
  "/budgets",
  "/builds",
  "/burn-rate",
  "/catalog",
  "/changelog",
  "/cis",
  "/compliance",
  "/compose",
  "/config-backup",
  "/containers",
  "/cost-optimizer",
  "/cost-recos",
  "/costs",
  "/costs/projections",
  "/costs/recommendations",
  "/digest",
  "/dr",
  "/fleet-diff",
  "/forecast",
  "/gitops",
  "/heatmap",
  "/home",
  "/instance-webhooks",
  "/instances/new",
  "/k8s",
  "/key-rotation",
  "/logs",
  "/maintenance",
  "/mesh",
  "/monitoring",
  "/notifications",
  "/offline",
  "/onboarding",
  "/provider-status",
  "/recipes",
  "/recordings",
  "/region-map",
  "/resources",
  "/resources/cleanup",
  "/resources/drift",
  "/restore",
  "/runbooks",
  "/saved-searches",
  "/schedules",
  "/secrets",
  "/settings",
  "/settings/api-keys",
  "/settings/ssh-keys",
  "/settings/users",
  "/spend-heatmap",
  "/status",
  "/tag-drift",
  "/tag-policies",
  "/tags",
  "/teams",
  "/teams/accept",
  "/templates",
  "/terminal",
  "/timeline",
  "/topology",
  "/trash",
  "/webhook-deliveries",
];

const PUBLIC: string[] = ["/sign-in", "/sign-up", "/display"];

const PLACEHOLDER = "e2e-missing";
const DYNAMIC: string[] = [
  `/accounts/${PLACEHOLDER}`,
  `/instances/${PLACEHOLDER}`,
  `/instances/${PLACEHOLDER}/console`,
  `/instances/${PLACEHOLDER}/ssh`,
  `/invite/${PLACEHOLDER}`,
  `/recordings/${PLACEHOLDER}/play`,
];

// The paired kiosk: vm-run.sh exports a throwaway ESP_DISPLAY_TOKEN for the run.
const KIOSK: AuditRoute[] = process.env.ESP_DISPLAY_TOKEN ? [{ path: `/display?k=${process.env.ESP_DISPLAY_TOKEN}`, public: true }] : [];

export const ROUTES: AuditRoute[] = [
  ...STATIC.map((path) => ({ path })),
  ...PUBLIC.map((path) => ({ path, public: true })),
  ...KIOSK,
  ...DYNAMIC.map((path) => ({ path, placeholder: true, public: path.startsWith("/invite/") })),
];

/** SSE / long-poll endpoints: aborted so pages can reach a settled state. */
export const SSE_PATTERN =
  /\/api\/(events|notify\/stream|home\/events)(\?|$)|\/(stream|probe-stream)(\?|$)/;

export function routeSlug(path: string): string {
  if (path === "/") return "root";
  if (path.startsWith("/display?k=")) return "display-paired";
  return path.replace(/^\//, "").replace(/[^a-zA-Z0-9-]+/g, "_");
}
