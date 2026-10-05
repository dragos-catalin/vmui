import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const cloudAccounts = sqliteTable("cloud_accounts", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["aws", "azure", "gcp", "scaleway", "digitalocean", "hetzner", "local-kvm"] }).notNull(),
  name: text("name").notNull(),
  /** Default region used when the provider needs one. */
  defaultRegion: text("default_region"),
  /** JSON array of additional regions to sync. null = only defaultRegion. */
  regions: text("regions"),
  /** JSON map (string→string) of tags auto-applied to every new instance. */
  defaultTags: text("default_tags"),
  /** Keep at most N snapshots per instance (matched by name fragment). 0 / null disables retention. */
  snapshotRetentionCount: integer("snapshot_retention_count"),
  /** Hard monthly USD cap; createInstance refuses to launch when projected monthly burn would exceed it. */
  monthlyBudgetUsd: real("monthly_budget_usd"),
  /** JSON array of tag keys that every instance in this account must carry; compliance flags violations. */
  requiredTags: text("required_tags"),
  /** Hard vCPU cap (sum across running instances). createInstance refuses to launch when exceeding it. */
  vcpuQuota: integer("vcpu_quota"),
  /** When true, terminateInstance auto-creates a snapshot first if no recent one exists. */
  safeTerminate: integer("safe_terminate", { mode: "boolean" }).notNull().default(false),
  /**
   * JSON array of `{ pattern: string; tags: Record<string,string> }` rules.
   * On instance sync each rule whose regex matches the instance name applies
   * the listed tags locally (in instanceTags), without touching the provider.
   */
  autoTagRules: text("auto_tag_rules"),
  /** Encrypted JSON blob of provider credentials (AES-256-GCM, base64). */
  credentialsEnc: text("credentials_enc").notNull(),
  /** Cached display info (account id, email, etc.) — encrypted JSON. */
  metadataEnc: text("metadata_enc"),
  /**
   * Encrypted JSON of `{ privateKey: string; passphrase?: string; defaultUser?: string }`
   * used as the agent SSH key for live-stats probes & cloud-init log streaming
   * across every instance in this account. Upload once, reuse everywhere.
   */
  probeKeyEnc: text("probe_key_enc"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const instances = sqliteTable("instances", {
  /** Synthetic id: `${accountId}:${region}:${providerInstanceId}` */
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  name: text("name"),
  /** User-edited display name. Preserved across syncs; falls back to provider name. */
  displayName: text("display_name"),
  /** User-pinned to the top. */
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  /** Manual sort order (lower = earlier). null when not manually ordered. */
  sortOrder: integer("sort_order"),
  /** Free-form user notes. */
  notes: text("notes"),
  /** When true, terminate is refused and surfaced in the UI as a lock icon. */
  terminationLocked: integer("termination_locked", { mode: "boolean" }).notNull().default(false),
  /** Live-stats probe interval in seconds (5..600). null = inherits global default. */
  probeIntervalSec: integer("probe_interval_sec"),
  /** Normalized state: pending | running | stopping | stopped | terminated | unknown */
  state: text("state").notNull().default("unknown"),
  /** "windows" | "macos" | "linux" */
  platform: text("platform").notNull().default("linux"),
  instanceType: text("instance_type"),
  publicIp: text("public_ip"),
  publicDns: text("public_dns"),
  privateIp: text("private_ip"),
  keyName: text("key_name"),
  rawJson: text("raw_json"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  /**
   * Updated every time the normalized state changes during a sync. Used by
   * idle-detection to flag long-running instances that nobody has touched.
   */
  lastStateChangeAt: integer("last_state_change_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: text("account_id"),
  action: text("action").notNull(),
  target: text("target"),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Cached on-demand hourly prices keyed by provider+region+type+platform.
 * Source can be "static", "aws-pricing-api", "scaleway-catalog", etc.
 */
export const pricingCache = sqliteTable("pricing_cache", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  instanceType: text("instance_type").notNull(),
  platform: text("platform").notNull(),
  usdPerHour: real("usd_per_hour").notNull(),
  source: text("source").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type CloudAccountRow = typeof cloudAccounts.$inferSelect;
export type InstanceRow = typeof instances.$inferSelect;
export type PricingCacheRow = typeof pricingCache.$inferSelect;

/**
 * Cached cloud resources beyond compute instances — volumes, snapshots,
 * security groups, keypairs, networks, buckets, etc. One row per (account,
 * region, kind, externalId).
 */
export const cachedResources = sqliteTable("cached_resources", {
  /** Synthetic: `${accountId}:${region}:${kind}:${externalId}`. */
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  /** Resource kind: volume, snapshot, security-group, keypair, vpc, subnet, bucket, ... */
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name"),
  /** Provider-specific status (available, in-use, completed, ...). */
  status: text("status"),
  /** Free-form size in bytes (volumes, snapshots, buckets). */
  sizeBytes: integer("size_bytes"),
  /** Reference to an instance row id when this resource is attached. */
  attachedToInstanceId: text("attached_to_instance_id"),
  /** Estimated USD/month (null when unknown / free). */
  monthlyUsd: real("monthly_usd"),
  rawJson: text("raw_json"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type CachedResourceRow = typeof cachedResources.$inferSelect;

/**
 * Locally-managed SSH key pairs. The private key is encrypted with the master
 * key (AES-256-GCM); public keys are stored in cleartext. vmui uses these to
 * inject ssh keys at create-time (Azure / GCP / Scaleway) and to authenticate
 * the browser SSH bridge. AWS keypairs live server-side and are referenced by
 * name only — vmui does not store them here.
 */
export const sshKeys = sqliteTable("ssh_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** "rsa" | "ed25519" | "imported". Lowercase. */
  algo: text("algo").notNull(),
  /** OpenSSH-format public key (ssh-rsa AAAA… / ssh-ed25519 AAAA…). */
  publicKey: text("public_key").notNull(),
  /** Encrypted PEM/OpenSSH private key. May be null if user only stored the public half. */
  privateKeyEnc: text("private_key_enc"),
  /** Optional passphrase encrypted alongside the private key. */
  passphraseEnc: text("passphrase_enc"),
  /** Optional fingerprint for de-dup / display. */
  fingerprint: text("fingerprint"),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SshKeyRow = typeof sshKeys.$inferSelect;

/**
 * Time-series snapshots captured at the end of every successful sync.
 * Used for sparklines on the dashboard and per-account history.
 */
export const snapshotHistory = sqliteTable("snapshot_history", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  totalInstances: integer("total_instances").notNull(),
  runningInstances: integer("running_instances").notNull(),
  hourlyUsd: real("hourly_usd").notNull(),
});

export type SnapshotHistoryRow = typeof snapshotHistory.$inferSelect;

/**
 * Schedules: per-instance cron-driven actions (auto-shutdown, scheduled
 * reboot, etc.). The cron expression is evaluated in the server's local TZ.
 */
export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id")
    .notNull()
    .references(() => instances.id, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  action: text("action", { enum: ["start", "stop", "reboot", "snapshot"] }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastRunStatus: text("last_run_status"),
});

export type ScheduleRow = typeof schedules.$inferSelect;

/**
 * Local tags. Lives parallel to provider-native tags so it works on every
 * provider including local-kvm and Scaleway. `(instanceId, key)` is unique
 * per instance — re-tagging overwrites the value. Empty `value` means a
 * label-style tag.
 */
export const instanceTags = sqliteTable("instance_tags", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id")
    .notNull()
    .references(() => instances.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull().default(""),
  /** "local" | "synced" — when synced, this row mirrors a provider tag. */
  source: text("source", { enum: ["local", "synced"] }).notNull().default("local"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type InstanceTagRow = typeof instanceTags.$inferSelect;

/**
 * Pinned SSH host keys. The first time the SSH bridge connects to a (host,
 * port) pair we record the server's public-key fingerprint; subsequent
 * connections refuse to proceed if the fingerprint changes (same model as
 * OpenSSH's known_hosts). Removing a row resets to "trust on next use".
 */
export const sshHostKeys = sqliteTable("ssh_host_keys", {
  id: text("id").primaryKey(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  /** Algorithm reported by the server, e.g. "ssh-ed25519" or "ssh-rsa". */
  algorithm: text("algorithm").notNull(),
  /** Hex-encoded SHA-256 of the server's host key. */
  fingerprintSha256: text("fingerprint_sha256").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  /** Optional note shown in the UI ("home lab", "prod box"). */
  note: text("note"),
});

export type SshHostKeyRow = typeof sshHostKeys.$inferSelect;

/**
 * Per-tag-key cost budgets. Tracks a single tag key (e.g. "team", "env")
 * and a monthly USD threshold. Every cost sync evaluates current monthly
 * burn for each tag value under that key; crossings get audit-logged and
 * the next dashboard load shows a banner.
 */
export const tagBudgets = sqliteTable("tag_budgets", {
  id: text("id").primaryKey(),
  /** Tag key to slice costs by. */
  tagKey: text("tag_key").notNull(),
  /** Optional tag value to scope the budget; null = all values under tagKey. */
  tagValue: text("tag_value"),
  /** Monthly USD budget. */
  monthlyUsd: real("monthly_usd").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  /** Last time this budget was evaluated. */
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  /** Most recent observed monthly USD (snapshot at lastCheckedAt). */
  lastObservedUsd: real("last_observed_usd"),
  /** 0/1 — set to 1 once the budget is first exceeded; cleared on reset. */
  exceeded: integer("exceeded").notNull().default(0),
});

export type TagBudgetRow = typeof tagBudgets.$inferSelect;

/**
 * Outgoing webhook destinations. Each row matches a Slack/Discord/Generic
 * URL plus a JSON-array channel filter. The dispatcher subscribes once at
 * boot and POSTs a compact JSON body to each subscriber whose channels
 * include the fired event. Failures are audit-logged but never thrown.
 */
export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  /** "slack" | "discord" | "teams" | "generic" — controls body shape. */
  kind: text("kind", { enum: ["slack", "discord", "teams", "generic"] }).notNull(),
  /** JSON array of subscribed event channels. */
  channels: text("channels").notNull(),
  enabled: integer("enabled").notNull().default(1),
  /** Minimum seconds between successive deliveries; 0/null = no cooldown. */
  cooldownSec: integer("cooldown_sec"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastFiredAt: integer("last_fired_at", { mode: "timestamp" }),
  lastStatus: text("last_status"),
});

export type WebhookRow = typeof webhooks.$inferSelect;

/**
 * Per-region sync events with diff counters. Lets users review what changed
 * over time, debug missing syncs, and audit drift. We store a compact JSON
 * blob with the list of impacted instance ids so the explorer can show
 * per-row detail without re-querying the provider.
 */
export const syncHistory = sqliteTable("sync_history", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  durationMs: integer("duration_ms").notNull().default(0),
  total: integer("total").notNull().default(0),
  added: integer("added").notNull().default(0),
  removed: integer("removed").notNull().default(0),
  stateChanged: integer("state_changed").notNull().default(0),
  /** Optional JSON: { added: string[]; removed: string[]; stateChanged: Array<{id, from, to}> } */
  detailsJson: text("details_json"),
});

export type SyncHistoryRow = typeof syncHistory.$inferSelect;

/**
 * Reusable boot scripts (cloud-init or shell). When a VM is created with a
 * `bootScriptId` set, the script body is passed as user-data to the
 * provider create call. Scripts are stored verbatim and never executed by
 * vmui itself — only by the guest OS.
 */
export const bootScripts = sqliteTable("boot_scripts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** "cloud-init" | "bash" | "powershell" — advisory only; passed verbatim. */
  kind: text("kind", { enum: ["cloud-init", "bash", "powershell"] }).notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BootScriptRow = typeof bootScripts.$inferSelect;

/**
 * docker-compose recipes that can be applied to any reachable Linux instance
 * via SSH. Versions are tracked separately so users can roll back or audit
 * what was applied to which host.
 */
export const composeRecipes = sqliteTable("compose_recipes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** Current YAML body (also written to compose_recipe_versions on save). */
  body: text("body").notNull(),
  /** "local" (build images on vmui host) or "remote" (build on target VM). */
  buildLocation: text("build_location", { enum: ["local", "remote"] }).notNull().default("remote"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type ComposeRecipeRow = typeof composeRecipes.$inferSelect;

export const composeRecipeVersions = sqliteTable("compose_recipe_versions", {
  id: text("id").primaryKey(),
  recipeId: text("recipe_id")
    .notNull()
    .references(() => composeRecipes.id, { onDelete: "cascade" }),
  /** Monotonic version number within a recipe (1, 2, 3…). */
  version: integer("version").notNull(),
  body: text("body").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type ComposeRecipeVersionRow = typeof composeRecipeVersions.$inferSelect;

/**
 * Container registry credentials. Secrets are AES-256-GCM encrypted JSON
 * stored as a single blob in `credentials`.
 */
export const registryCredentials = sqliteTable("registry_credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** ecr | gcr | acr | dockerhub | ghcr */
  type: text("type", { enum: ["ecr", "gcr", "acr", "dockerhub", "ghcr"] }).notNull(),
  /** e.g. 123.dkr.ecr.us-east-1.amazonaws.com or ghcr.io */
  registryUrl: text("registry_url").notNull(),
  /** Encrypted JSON: {username?,password?,token?,accessKeyId?,secretAccessKey?,region?,serviceAccountJson?} */
  credentials: text("credentials").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type RegistryCredentialRow = typeof registryCredentials.$inferSelect;

/**
 * Image build + push history. Tracks every `docker build && docker push`
 * job kicked off through vmui, regardless of where the build ran.
 */
export const imageBuilds = sqliteTable("image_builds", {
  id: text("id").primaryKey(),
  registryId: text("registry_id")
    .notNull()
    .references(() => registryCredentials.id, { onDelete: "cascade" }),
  /** Full image ref, e.g. ghcr.io/foo/bar:1.2.3 */
  imageRef: text("image_ref").notNull(),
  /** "local" (run on vmui host) or "remote" (run over SSH on an instance). */
  buildLocation: text("build_location", { enum: ["local", "remote"] }).notNull(),
  /** Set when buildLocation === "remote". */
  instanceId: text("instance_id"),
  /** Inline Dockerfile body OR path on remote. */
  dockerfile: text("dockerfile"),
  /** Optional context dir (defaults to the dockerfile's parent). */
  contextPath: text("context_path"),
  status: text("status", { enum: ["pending", "running", "success", "failed"] })
    .notNull()
    .default("pending"),
  logOutput: text("log_output"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export type ImageBuildRow = typeof imageBuilds.$inferSelect;

/**
 * Web Push subscriptions. One row per device/browser that opted in. The
 * endpoint URL is unique per subscription and serves as the foreign key.
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  authKey: text("auth_key").notNull(),
  /** Comma-separated topic flags: state,builds,alerts,costs,compliance */
  topics: text("topics").notNull().default("state,builds,alerts,costs,compliance"),
  userAgent: text("user_agent"),
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * GitOps source. A row represents a git repository that is periodically
 * cloned (or fetched) and scanned for docker-compose files; every change is
 * automatically applied to a target instance.
 */
export const gitSources = sqliteTable("git_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  branch: text("branch").notNull().default("main"),
  /** none | token | ssh */
  authType: text("auth_type", { enum: ["none", "token", "ssh"] }).notNull().default("none"),
  /** Encrypted JSON: { token?, sshKey?, username? } */
  authBlob: text("auth_blob"),
  /** Glob inside the repo, e.g. "stacks/**\/docker-compose.yml" */
  composeGlob: text("compose_glob").notNull().default("**/docker-compose.y*ml"),
  /** Instance to deploy to (optional — if null, applies to all reachable VMs with the matching tag). */
  targetInstanceId: text("target_instance_id"),
  /** Cron-ish interval in seconds. */
  pollSeconds: integer("poll_seconds").notNull().default(60),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastCommit: text("last_commit"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type GitSourceRow = typeof gitSources.$inferSelect;

export const gitApplyHistory = sqliteTable("git_apply_history", {
  id: text("id").primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => gitSources.id, { onDelete: "cascade" }),
  commit: text("commit").notNull(),
  /** compose file path within the repo */
  path: text("path").notNull(),
  status: text("status", { enum: ["success", "failed", "skipped"] }).notNull(),
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type GitApplyHistoryRow = typeof gitApplyHistory.$inferSelect;


/**
 * Append-only history of `cached_resources.rawJson` changes. A row is
 * inserted whenever a sync detects that the upstream provider JSON for an
 * already-known resource differs from what we have cached. Allows users to
 * see infrastructure drift over time.
 */
export const resourceHistory = sqliteTable("resource_history", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  prevJson: text("prev_json"),
  nextJson: text("next_json").notNull(),
});

export type ResourceHistoryRow = typeof resourceHistory.$inferSelect;

/**
 * Optional local user accounts for multi-user deployments. When the table is
 * empty vmui runs in single-user mode (no auth). Once a user exists the
 * sign-in screen and role checks become mandatory.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operator", "viewer"] }).notNull().default("viewer"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  /** Encrypted base32 TOTP secret (AES-256-GCM). Null when not enrolled. */
  totpSecretEnc: text("totp_secret_enc"),
  /** When the user successfully verified the first code; null = pending. */
  totpVerifiedAt: integer("totp_verified_at", { mode: "timestamp" }),
  /** Encrypted JSON array of single-use backup codes. */
  totpBackupCodesEnc: text("totp_backup_codes_enc"),
    /** Appearance + locale preferences (lib/appearance/model.ts); JSON, mirrored to the `vmui_appearance` cookie. */
    preferences: text("preferences"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type UserRole = UserRow["role"];

/**
 * API keys for the public /api/v1 surface. Stored as scrypt hashes; the
 * plaintext key is shown exactly once at creation time. Rate limit is enforced
 * per-key in memory by `src/lib/api-auth.ts`.
 */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hash: text("hash").notNull(),
  role: text("role", { enum: ["operator", "viewer"] }).notNull().default("viewer"),
  rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
  /** JSON `ApiKeyScopes` (src/lib/api-key-scopes.ts); null = unrestricted. */
  scopes: text("scopes"),
  /** `apiKeyLookupId(plaintext)` (src/lib/api-auth.ts); null on keys minted before it existed until first use. */
  lookupId: text("lookup_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * In-app notification center. Persisted, append-only inbox of human-relevant
 * events: failed actions, schedule misses, budget breaches, compliance
 * findings, drift, etc. Audit log is the source of truth for everything;
 * notifications are the curated, dismissible subset surfaced in the topbar
 * bell. `seenAt` tracks first view; `dismissedAt` hides from default views.
 */
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  /** Category for grouping/filtering: "auth" | "cost" | "compliance" | "schedule" | "sync" | "instance" | "system" */
  category: text("category").notNull(),
  /** "info" | "success" | "warning" | "error" */
  severity: text("severity", { enum: ["info", "success", "warning", "error"] }).notNull().default("info"),
  title: text("title").notNull(),
  body: text("body"),
  /** Optional deep-link path inside the app (e.g. "/instances/abc"). */
  href: text("href"),
  /** Optional related accountId for filtering. */
  accountId: text("account_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  seenAt: integer("seen_at", { mode: "timestamp" }),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
});

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * Registered WebAuthn / Passkey credentials. One row per credential per
 * user. `publicKey` and `credentialId` are stored base64url-encoded so we
 * can survive process restarts. `counter` is updated on every successful
 * assertion to detect cloned authenticators.
 */
export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** base64url-encoded credential ID. */
  credentialId: text("credential_id").notNull().unique(),
  /** base64url-encoded COSE public key. */
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  /** Comma-separated transports hint (e.g. "internal,hybrid"). */
  transports: text("transports"),
  /** Human-friendly label set by the user at registration time. */
  label: text("label").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

export type PasskeyRow = typeof passkeys.$inferSelect;

/**
 * Cached cost optimisation recommendations. One row per (account, instance,
 * kind). Refreshed on demand and on a 12h scheduler tick. Cleared when the
 * underlying instance disappears.
 */
export const costRecommendations = sqliteTable("cost_recommendations", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => cloudAccounts.id, { onDelete: "cascade" }),
  instanceId: text("instance_id")
    .notNull()
    .references(() => instances.id, { onDelete: "cascade" }),
  /** "rightsize" | "idle" | "stop-after-hours" | "spot-eligible" */
  kind: text("kind").notNull(),
  /** Severity-style confidence indicator: "low" | "medium" | "high". */
  confidence: text("confidence").notNull().default("medium"),
  /** Free-form one-line summary shown in the UI. */
  summary: text("summary").notNull(),
  /** Optional suggested instance type (rightsize). */
  suggestedInstanceType: text("suggested_instance_type"),
  /** Observed p95 CPU over the lookback window, percent. */
  observedCpuP95: real("observed_cpu_p95"),
  /** Hours of CPU sample data analysed. */
  lookbackHours: integer("lookback_hours"),
  /** Estimated monthly savings if applied (positive number). */
  estMonthlySavingsUsd: real("est_monthly_savings_usd"),
  /** Optional payload (e.g. CW datapoint counts). */
  detailsJson: text("details_json"),
  computedAt: integer("computed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type CostRecommendationRow = typeof costRecommendations.$inferSelect;

export const alertRules = sqliteTable("alert_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Filter scope: null = all instances; JSON `{accountIds?: string[]; tagKey?: string; tagValue?: string}` */
  scopeJson: text("scope_json"),
  /**
   * Rule expression as JSON:
   * { metric: "cpu"|"mem"|"disk"|"net_in"|"net_out"|"load1"|"uptime";
   *   op: ">"|"<"|">="|"<="|"=="|"!=";
   *   threshold: number;
   *   windowSec: number;   // sustained for this many seconds
   *   cooldownSec?: number; // suppress refires for this many seconds (default 600)
   * }
   */
  expressionJson: text("expression_json").notNull(),
  /** JSON array of channel ids referenced from alertChannels. */
  channelsJson: text("channels_json").notNull(),
  /** ISO message template; supports {{instance}}, {{metric}}, {{value}}, {{threshold}}. */
  messageTemplate: text("message_template"),
  /** "info" | "warning" | "critical" */
  severity: text("severity").notNull().default("warning"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type AlertRuleRow = typeof alertRules.$inferSelect;

export const alertChannels = sqliteTable("alert_channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** "toast" | "discord" | "slack" | "ntfy" | "webhook" | "smtp" */
  kind: text("kind").notNull(),
  /** Encrypted JSON config (webhook URL, SMTP creds, etc.). */
  configEnc: text("config_enc").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type AlertChannelRow = typeof alertChannels.$inferSelect;

export const alertFirings = sqliteTable("alert_firings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: text("rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  instanceId: text("instance_id"),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  threshold: real("threshold").notNull(),
  status: text("status", { enum: ["firing", "resolved"] }).notNull().default("firing"),
  message: text("message"),
  /** JSON array of `{channel, status, error?}` results. */
  deliveryJson: text("delivery_json"),
  firedAt: integer("fired_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
});

export type AlertFiringRow = typeof alertFirings.$inferSelect;

export const probeSamples = sqliteTable("probe_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  instanceId: text("instance_id")
    .notNull()
    .references(() => instances.id, { onDelete: "cascade" }),
  /** Composite metric JSON: { cpu, mem, disk, net_in, net_out, load1, uptime, cores: number[], iops? } */
  metricsJson: text("metrics_json").notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type ProbeSampleRow = typeof probeSamples.$inferSelect;

/**
 * Backup policy. Defines a recurring backup job for one instance.
 *
 * kind:
 *  - cloud-snapshot: provider.createSnapshot() of the boot disk
 *  - s3-dump:        tar over ssh, piped to `aws s3 cp -` (destination in destConfig)
 *  - local-copy:     tar over ssh to a path on the VM (destination in destConfig)
 *  - cross-region:   cloud-snapshot then provider-specific copy to another region
 */
export const backupPolicies = sqliteTable("backup_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["cloud-snapshot", "s3-dump", "local-copy", "cross-region"] })
    .notNull()
    .default("cloud-snapshot"),
  instanceId: text("instance_id")
    .notNull()
    .references(() => instances.id, { onDelete: "cascade" }),
  /** Standard 5-field cron expression. */
  cronExpr: text("cron_expr").notNull().default("0 3 * * *"),
  /** JSON { keepDaily, keepWeekly, keepMonthly } */
  retentionJson: text("retention_json").notNull().default('{"keepDaily":7,"keepWeekly":4,"keepMonthly":6}'),
  /** Encrypted JSON. Shape depends on kind. */
  destConfigEnc: text("dest_config_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastStatus: text("last_status", { enum: ["ok", "error", "running"] }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type BackupPolicyRow = typeof backupPolicies.$inferSelect;

export const backupJobs = sqliteTable("backup_jobs", {
  id: text("id").primaryKey(),
  policyId: text("policy_id")
    .notNull()
    .references(() => backupPolicies.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["queued", "running", "ok", "error"] }).notNull().default("queued"),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  /** Reference: snapshot id, s3 key, local path, etc. */
  artifactRef: text("artifact_ref"),
  /** Size in bytes (best-effort) */
  sizeBytes: integer("size_bytes"),
  message: text("message"),
});

export type BackupJobRow = typeof backupJobs.$inferSelect;

/**
 * Encrypted secret blob. Used for DB credentials, API keys, generic
 * passwords. Reveal events go in `secretReveals`.
 */
export const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["db", "api-key", "password", "generic"] }).notNull().default("generic"),
  /** Encrypted JSON: { value: string, meta?: Record<string,string> } */
  valueEnc: text("value_enc").notNull(),
  /** If set, reminder shows in UI after this many days since lastRotatedAt. */
  rotationDays: integer("rotation_days"),
  lastRotatedAt: integer("last_rotated_at", { mode: "timestamp" }),
  /** When true, value can only be revealed with an admin re-auth. */
  sealed: integer("sealed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SecretRow = typeof secrets.$inferSelect;

export const secretReveals = sqliteTable("secret_reveals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  secretId: text("secret_id")
    .notNull()
    .references(() => secrets.id, { onDelete: "cascade" }),
  userId: text("user_id"),
  ip: text("ip"),
  at: integer("at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type SecretRevealRow = typeof secretReveals.$inferSelect;

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type TeamRow = typeof teams.$inferSelect;

export const teamMembers = sqliteTable("team_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "operator", "viewer", "member"] }).notNull().default("member"),
  joinedAt: integer("joined_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type TeamMemberRow = typeof teamMembers.$inferSelect;

export const teamInvitations = sqliteTable("team_invitations", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  role: text("role", { enum: ["admin", "operator", "viewer", "member"] }).notNull().default("member"),
  invitedBy: text("invited_by"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type TeamInvitationRow = typeof teamInvitations.$inferSelect;

/**
 * Terminal session recordings (asciinema cast v2).
 * Files are written under `data/recordings/<id>.cast`. We store metadata only.
 */
export const terminalRecordings = sqliteTable("terminal_recordings", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  instanceLabel: text("instance_label"),
  userId: text("user_id"),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  durationMs: integer("duration_ms").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  path: text("path").notNull(),
  cols: integer("cols").notNull().default(80),
  rows: integer("rows").notNull().default(24),
});

export type TerminalRecordingRow = typeof terminalRecordings.$inferSelect;

/**
 * Per-instance markdown runbooks. Tracked centrally so they survive VM
 * recreation; matched by `accountId + providerInstanceId`.
 */
export const runbooks = sqliteTable("runbooks", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  providerInstanceId: text("provider_instance_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type RunbookRow = typeof runbooks.$inferSelect;

/**
 * Tag-based monthly budgets — alert threshold lives in code, not schema.
 * (Original schema kept at line 283.)
 */
export const idleParkPolicies = sqliteTable("idle_park_policies", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  cpuPct: integer("cpu_pct").notNull().default(5),
  netKbps: integer("net_kbps").notNull().default(50),
  windowMin: integer("window_min").notNull().default(30),
  enabled: integer("enabled").notNull().default(1),
  lastParkedAt: integer("last_parked_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type IdleParkPolicyRow = typeof idleParkPolicies.$inferSelect;

/** Sticky notes attached to a VM (matched by accountId + providerInstanceId). */
export const stickyNotes = sqliteTable("sticky_notes", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  body: text("body").notNull(),
  color: text("color").notNull().default("amber"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type StickyNoteRow = typeof stickyNotes.$inferSelect;

/** Auto-tag rules: regex on name → key/value tag applied at sync time. */
export const autoTagRules = sqliteTable("auto_tag_rules", {
  id: text("id").primaryKey(),
  /** JS regex source, no flags */
  namePattern: text("name_pattern").notNull(),
  tagKey: text("tag_key").notNull(),
  tagValue: text("tag_value").notNull(),
  enabled: integer("enabled").notNull().default(1),
  priority: integer("priority").notNull().default(100),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type AutoTagRuleRow = typeof autoTagRules.$inferSelect;

/** Daily snapshot of fleet membership for diffing day-over-day. */
export const fleetSnapshots = sqliteTable("fleet_snapshots", {
  id: text("id").primaryKey(),
  capturedAt: integer("captured_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  /** JSON array of {accountId, providerInstanceId, name, region, state, instanceType} */
  membersJson: text("members_json").notNull(),
});
export type FleetSnapshotRow = typeof fleetSnapshots.$inferSelect;

/** Generic key/value app settings (single-row config). */
export const settings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type SettingRow = typeof settings.$inferSelect;

/** Saved launch templates — re-launchable VM configurations. */
export const launchTemplates = sqliteTable("launch_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  accountId: text("account_id").notNull(),
  region: text("region").notNull(),
  instanceType: text("instance_type").notNull(),
  platform: text("platform").notNull(),
  /** JSON CreateInstanceInput-shaped payload */
  configJson: text("config_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type LaunchTemplateRow = typeof launchTemplates.$inferSelect;

/** Per-cloud-account monthly budget cap. */
export const accountBudgets = sqliteTable("account_budgets", {
  accountId: text("account_id").primaryKey(),
  monthlyUsd: real("monthly_usd").notNull(),
  alertedAt: integer("alerted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type AccountBudgetRow = typeof accountBudgets.$inferSelect;

/** Saved search filters for the instances list. */
export const savedSearches = sqliteTable("saved_searches", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type SavedSearchRow = typeof savedSearches.$inferSelect;

/** Markdown runbook attached to an instance (per providerInstanceId). */
export const instanceRunbooks = sqliteTable("instance_runbooks", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type InstanceRunbookRow = typeof instanceRunbooks.$inferSelect;

/** Webhook fired on instance state transitions. */
export const instanceWebhooks = sqliteTable("instance_webhooks", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  providerInstanceId: text("provider_instance_id"),
  url: text("url").notNull(),
  secret: text("secret"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastFiredAt: integer("last_fired_at", { mode: "timestamp" }),
  lastStatus: text("last_status"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type InstanceWebhookRow = typeof instanceWebhooks.$inferSelect;

/** Rolling baseline of CPU/mem averages for drift alarms. */
export const probeBaselines = sqliteTable("probe_baselines", {
  instanceId: text("instance_id").primaryKey(),
  cpuMean: real("cpu_mean").notNull(),
  cpuStd: real("cpu_std").notNull(),
  memMean: real("mem_mean").notNull(),
  memStd: real("mem_std").notNull(),
  samples: integer("samples").notNull(),
  computedAt: integer("computed_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type ProbeBaselineRow = typeof probeBaselines.$inferSelect;

/** Hash chain over auditLog rows; computed in batches by scheduler. */
export const auditChain = sqliteTable("audit_chain", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromAuditId: integer("from_audit_id").notNull(),
  toAuditId: integer("to_audit_id").notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  hmac: text("hmac").notNull(),
  computedAt: integer("computed_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type AuditChainRow = typeof auditChain.$inferSelect;

/** Per-instance encrypted secrets vault (KV). */
export const instanceSecrets = sqliteTable("instance_secrets", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  key: text("key").notNull(),
  /** AES-256-GCM encrypted value (base64). */
  valueEnc: text("value_enc").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type InstanceSecretRow = typeof instanceSecrets.$inferSelect;

/** Tag policy DSL rules. Each rule has a condition and required keys. */
export const tagPolicies = sqliteTable("tag_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Free-form DSL: e.g. "provider=aws AND region~^eu" */
  condition: text("condition").notNull(),
  /** JSON array of required tag keys. */
  requireKeysJson: text("require_keys_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type TagPolicyRow = typeof tagPolicies.$inferSelect;

/** Trash bin: keeps metadata of terminated instances for restore-as-data. */
export const instanceTrash = sqliteTable("instance_trash", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  region: text("region").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  name: text("name"),
  provider: text("provider").notNull(),
  instanceType: text("instance_type"),
  rawJson: text("raw_json"),
  terminatedAt: integer("terminated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  terminatedBy: text("terminated_by"),
  /** Snapshot taken by safe-terminate, so restore does not depend on archived audit rows. */
  safeSnapshotId: text("safe_snapshot_id"),
});
export type InstanceTrashRow = typeof instanceTrash.$inferSelect;

/** Maintenance windows: actions are blocked or warned about during them. */
export const maintenanceWindows = sqliteTable("maintenance_windows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** ISO timestamp of window start. */
  startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
  /** ISO timestamp of window end. */
  endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
  /** "block" refuses mutations; "warn" only logs. */
  mode: text("mode", { enum: ["block", "warn"] }).notNull().default("warn"),
  /** Optional account scope; null = global. */
  accountId: text("account_id"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdBy: text("created_by"),
});
export type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;

/** Outbound webhook delivery queue with retry/backoff. */
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  url: text("url").notNull(),
  payloadJson: text("payload_json").notNull(),
  signature: text("signature"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  /** queued | delivering | ok | failed */
  status: text("status", { enum: ["queued", "delivering", "ok", "failed"] }).notNull().default("queued"),
  lastErrorMessage: text("last_error"),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  deliveredAt: integer("delivered_at", { mode: "timestamp" }),
});
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** CIS-Linux benchmark check results per instance. */
export const cisCheckResults = sqliteTable("cis_check_results", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerInstanceId: text("provider_instance_id").notNull(),
  checkId: text("check_id").notNull(),
  title: text("title").notNull(),
  /** pass | fail | skip | error */
  result: text("result", { enum: ["pass", "fail", "skip", "error"] }).notNull(),
  evidence: text("evidence"),
  ranAt: integer("ran_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type CisCheckRow = typeof cisCheckResults.$inferSelect;

/** Where each smart-home device sits on the floor plan (percent of room box). */
export const homeLayout = sqliteTable("home_layout", {
  deviceId: text("device_id").primaryKey(),
  room: text("room").notNull(),
  x: real("x").notNull(),
  y: real("y").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type HomeLayoutRow = typeof homeLayout.$inferSelect;

/** Food log. One row per meal; `items` is the JSON component breakdown from the
 *  analysis. Source of truth for the nutrition view, HA sensors and the coach;
 *  Health Connect only mirrors it so Samsung Health shows the meal. */
export const meals = sqliteTable("meals", {
  id: text("id").primaryKey(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  /** YYYY-MM-DD in Europe/Bucharest, precomputed so daily sums are one indexed query. */
  day: text("day").notNull(),
  name: text("name").notNull(),
  mealType: text("meal_type", { enum: ["breakfast", "lunch", "dinner", "snack"] }).notNull(),
  calories: real("calories").notNull(),
  protein: real("protein").notNull().default(0),
  carbs: real("carbs").notNull().default(0),
  fats: real("fats").notNull().default(0),
  fiber: real("fiber").notNull().default(0),
  confidence: real("confidence").notNull().default(0.7),
  items: text("items").notNull().default("[]"),
  notes: text("notes").notNull().default(""),
  source: text("source").notNull().default("web"),
  clientId: text("client_id"),
  syncedToHealthConnect: integer("synced_hc", { mode: "boolean" }).notNull().default(false),
  /** Whose journal this is; null only for rows written before family mode (treated as the owner's). */
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type MealRow = typeof meals.$inferSelect;

/** Coach messages already sent (dedupe + history for the journal page). */
export const coachMessages = sqliteTable("coach_messages", {
  id: text("id").primaryKey(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  day: text("day").notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  reasoning: text("reasoning").notNull().default(""),
});
export type CoachMessageRow = typeof coachMessages.$inferSelect;

/** Water log: one row per glass. The desk button (ESP32 GPIO13) is the main
 *  source; the phone and /home are fallbacks. */
export const hydration = sqliteTable("hydration", {
  id: text("id").primaryKey(),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  day: text("day").notNull(),
  ml: integer("ml").notNull(),
  source: text("source").notNull().default("web"),
  userId: text("user_id"),
});
export type HydrationRow = typeof hydration.$inferSelect;

/** Per-member nutrition profile (targets, body, coach). The owner's legacy
 *  profile lives in turzx_settings row 5 and is copied here on first read. */
export const nutritionProfiles = sqliteTable("nutrition_profiles", {
  userId: text("user_id").primaryKey(),
  json: text("json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

/** Phones / desktops paired with this vmui (see lib/devices/pairing.ts). One
 *  revocable token per device instead of the shared ESP_DISPLAY_TOKEN. */
export const pairedDevices = sqliteTable("paired_devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  /** sha256 of the bearer token; the clear token is shown once at approval. */
  tokenHash: text("token_hash").notNull(),
  /** pending | approved | revoked */
  status: text("status").notNull().default("pending"),
  /** 4-digit code the approver compares with what the device shows. */
  code: text("code"),
  approvedBy: text("approved_by"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
  lastIp: text("last_ip"),
  /** FCM registration token (Android) — wakes the app for a notification */
  pushToken: text("push_token"),
  /** UI language the device asked for (`en` | `ro`); notifications render in it */
  language: text("language"),
  /** Family member this device acts as; its room permissions apply to every call the device makes. */
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type PairedDeviceRow = typeof pairedDevices.$inferSelect;

/** Family membership for /home (lib/home/access.ts). Separate from `users.role`,
 *  which governs the VM control plane: an infrastructure viewer can be the
 *  household owner, and a family guest never sees a VM. `rooms` is JSON
 *  `{ [roomId]: "view" | "control" }`; a room absent from it is hidden. */
export const homeMembers = sqliteTable("home_members", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "adult", "child", "guest"] }).notNull(),
  rooms: text("rooms").notNull().default("{}"),
  /** Guests stop having access after this; null = no expiry. */
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type HomeMemberRow = typeof homeMembers.$inferSelect;

/** Single-use invitation links for new family members (/invite/<token>). The
 *  clear token is only in the link; we store its sha256. */
export const homeInvites = sqliteTable("home_invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  /** Pre-filled display name the inviter typed (the invitee may change it). */
  name: text("name").notNull(),
  role: text("role", { enum: ["adult", "child", "guest"] }).notNull(),
  rooms: text("rooms").notNull().default("{}"),
  /** Guest access expiry copied onto the member at acceptance. */
  accessExpiresAt: integer("access_expires_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  acceptedBy: text("accepted_by"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type HomeInviteRow = typeof homeInvites.$inferSelect;

/** Replay guard for /api/hooks/contact: `n:<nonce>` and `s:<sha256(signature)>`, purged after expiry. */
export const contactHookNonces = sqliteTable("contact_hook_nonces", {
  key: text("key").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

/** Notification centre (lib/notify). One row per card; `tag` lets a source
 *  update a card in place (progress, agents summary). Actions are JSON
 *  [{id,label,style,body}] executed by /api/notify/act. */
export const homeNotifications = sqliteTable("home_notifications", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  tag: text("tag"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  subtitle: text("subtitle"),
  /** hex accent for the card, e.g. #f2b85a */
  color: text("color"),
  /** lucide icon name */
  icon: text("icon"),
  image: text("image"),
  /** low | default | high | urgent */
  priority: text("priority").notNull().default("default"),
  /** 0..100 or null */
  progress: integer("progress"),
  actions: text("actions").notNull().default("[]"),
  /** deep link opened on tap (codai://session/…, vmui://casa) */
  url: text("url"),
  /** structured payload for the client (session ids, entity ids) */
  data: text("data").notNull().default("{}"),
  sticky: integer("sticky", { mode: "boolean" }).notNull().default(false),
  readAt: integer("read_at", { mode: "timestamp" }),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
  /** action id that resolved it, if any */
  actedWith: text("acted_with"),
  actedBy: text("acted_by"),
  /** which device acknowledged delivery first (fallback to HA Companion if none) */
  deliveredTo: text("delivered_to"),
  fallbackAt: integer("fallback_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type HomeNotificationRow = typeof homeNotifications.$inferSelect;

/** Turzx desk display preferences: one row, validated JSON (see lib/turzx/settings.ts). */
export const turzxSettings = sqliteTable("turzx_settings", {
  id: integer("id").primaryKey(),
  json: text("json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

/**
 * Link between a vmui-managed VM and a codai Environment (BYO provider),
 * created by "Provision codai environment". One link per instance; the codai
 * side owns the environment, vmui only remembers ids + last observed state.
 */
export const codaiEnvironments = sqliteTable("codai_environments", {
  instanceId: text("instance_id")
    .primaryKey()
    .references(() => instances.id, { onDelete: "cascade" }),
  environmentId: text("environment_id").notNull(),
  projectId: text("project_id").notNull(),
  slug: text("slug").notNull(),
  /** Last state read from `GET /v1/environments/:id` (pending | enrolling | running | error | …). */
  lastStatus: text("last_status").notNull().default("pending"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
export type CodaiEnvironmentRow = typeof codaiEnvironments.$inferSelect;

