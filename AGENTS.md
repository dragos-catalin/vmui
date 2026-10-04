# vmui — Repository guide for AI agents

vmui is a local-first multi-cloud VM control plane. Single-tenant, single-host, no SaaS dependency. Runs at `127.0.0.1:3737` for the app, `127.0.0.1:3738` for the SSH WebSocket bridge.

## Stack

- **Framework**: Next.js 16 App Router, React 19.2, TypeScript 5.9 strict (`noUncheckedIndexedAccess`).
- **DB**: SQLite via `better-sqlite3` + Drizzle ORM. Schema is the source of truth in [src/lib/db/schema.ts](src/lib/db/schema.ts); raw `CREATE TABLE` bootstrap and `PRAGMA table_info` column-add migrations live in [src/lib/db/index.ts](src/lib/db/index.ts).
- **Crypto**: AES-256-GCM via `VMUI_MASTER_KEY` (env, base64). Helpers `encryptJSON` / `decryptJSON` in [src/lib/crypto.ts](src/lib/crypto.ts). Never log decrypted payloads.
- **Styling**: Tailwind v4 CSS-first config (`@theme` in [src/app/globals.css](src/app/globals.css)). Tokens use oklch. No `tailwind.config.js`.
- **Design system**: tokens in `globals.css` are hue-driven (`--accent-h`); appearance = theme × accent × surface × density + vibe presets ([src/lib/appearance/model.ts](src/lib/appearance/model.ts), provider in [src/components/appearance/](src/components/appearance/), stored per user in `users.preferences` and mirrored in the `vmui_appearance` cookie). Primitives in [src/components/ui/](src/components/ui/) (barrel `index.ts`): `PageShell` / `PageHeader` / `PageSection`, `Stat` + `StatGrid`, `EmptyState`, `DataTable` (TanStack Table **v9** wrapper), `Alert`, `Progress`, `ToggleGroup`, `Skeleton*`. Charts in [src/components/charts/](src/components/charts/) (recharts 3, themed via CSS vars); `LogViewer` in [src/components/ops/](src/components/ops/). Shell: sidebar rail (`[` toggles, persisted under `vmui.sidebar.collapsed`), context rail at ≥ 2xl via `useContextRail` ([src/components/nav/context-rail.tsx](src/components/nav/context-rail.tsx)), `NavProgress`. Conventions: every page is a `PageShell`, never a nested `<main>`; tokens only (no palette classes, hex or `dark:`); `useAction` ([src/hooks/use-action.ts](src/hooks/use-action.ts)) for mutations; `nuqs` for URL state; TanStack Query pollers in [src/hooks/use-poll.ts](src/hooks/use-poll.ts); zod **v4** (`z.email()`, `z.flattenError`, `z.partialRecord`).
- **UI**: shadcn-style components in [src/components/ui/](src/components/ui/). Lucide icons. Sonner for toasts. Motion for animation.
- **Forms**: prefer `useActionState` + zod-validated server action. React Hook Form only for complex multi-step flows.
- **Pricing**: static curated table + Azure Retail Prices live API; cached in `pricing_cache` with 24h TTL.
- **SSH bridge**: ws + ssh2 singleton on `globalThis.__vmuiSshBridge`; binary frames are stdin/stdout, JSON frames are control messages (`resize`, `ready`, `error`, `close`). Single-use 60s tokens.
- **i18n**: `next-intl` without URL locales. Locale = `vmui_locale` cookie → `Accept-Language` → `en` ([src/i18n/request.ts](src/i18n/request.ts)); switcher in the topbar. Every user-visible string goes through `useTranslations("ns")` (client) / `getTranslations("ns")` (server/actions) — **no hardcoded UI text, in either language**. Messages: `messages/{en,ro}.json` for `nav`/`common`/`home`; one folder per namespace `messages/<ns>/{en,ro}.json` — `NAMESPACES` in [src/i18n/messages.ts](src/i18n/messages.ts): `homeCards`, `notify`, `nutrition`, `ambilight`, `turzx`, `nestHub`, `devices`, `family`, `shell`, `appearance`, `vm`, `dashboard`, `settings`, `auth`, `misc`, `cloud`, `ops`, `observe`, `govern`, `extras`. Keys are type-checked against the `en` files ([src/i18n/global.d.ts](src/i18n/global.d.ts)); add a key to **both** locales in the same edit. Server-side text sent to devices (notification cards, HA fallback) uses [src/lib/notify/i18n.ts](src/lib/notify/i18n.ts) with the device's stored `language`. `tsgo` caches `messages/*.json`: after editing them delete `tsconfig.tsbuildinfo` if a fresh key still reports as missing.

## Cloud providers

Implemented in [src/lib/providers/](src/lib/providers/) with the `CloudProvider` interface from [types.ts](src/lib/providers/types.ts):

| Provider  | Instances            | Resources                                                                | Create-VM                                 | Notes                                                                                                          |
| --------- | -------------------- | ------------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| AWS       | full                 | volume / snapshot / sg / keypair / vpc / subnet / bucket / db / lb / dns | full (incl. Mac dedicated host)           | Uses `@aws-sdk/client-*` v3.10x                                                                                |
| Azure     | full                 | disks / snapshots / vnets / subnets / NSGs / load-balancers              | full (auto-RG/VNet/Subnet/PIP/NIC)        | `@azure/identity` + `arm-compute` + `arm-network` + `arm-resources-subscriptions` (NOT `arm-subscriptions` v6) |
| GCP       | full                 | disks / snapshots / networks / subnets / firewalls / images              | full (image families + ssh-keys metadata) | `@google-cloud/compute` v6; aggregatedListAsync is `for-await`                                                 |
| Scaleway  | bare-metal Mac minis | n/a (no resource graph)                                                  | full                                      | REST via fetch; 24h minimum lease                                                                              |
| local-kvm | full                 | n/a                                                                      | full                                      | qemu/QMP under the hood                                                                                        |

`local-kvm` also carries the Hyper-V kinds `hyperv-win` and `hyperv-haos`
(Home Assistant OS). They share every lifecycle branch via `isHyperV` /
`HYPERV_KINDS` in [local-kvm.ts](src/lib/providers/local-kvm.ts) — adding a
Hyper-V kind means adding it to that list, its `KIND_DEFAULTS`, the Zod enum
in `actions/accounts.ts`, and the UI card. Operations for the appliance live
in `scripts/homeassistant.ps1` + `scripts/ha-configure.ps1`; read
[docs/home-assistant.md](docs/home-assistant.md) before touching it — its
traps section is the list of things that took the instance down.

VM ids:

- AWS: `i-…` (raw EC2 instance id).
- Azure: `{resourceGroup}/{name}` short form.
- GCP: `{zone}/{name}` short form.
- Scaleway: provider UUID.
- local-kvm: synthetic.

Synthetic DB id is always `${accountId}:${region}:${providerInstanceId}`.

## Multi-region sync

- `cloud_accounts.regions` is a JSON-encoded `string[]`; `null` falls back to `defaultRegion`.
- `parseRegions(json, fallback)` helpers exist in both [actions/instances.ts](src/server/actions/instances.ts) and [actions/resources.ts](src/server/actions/resources.ts) — keep them in sync.
- Region picker UI: [account-regions-editor.tsx](src/components/accounts/account-regions-editor.tsx) backed by [REGION_CATALOG](src/lib/providers/regions.ts).
- Sync iterates regions in `Promise.all`; per-region failures are audit-logged, never thrown.

## Conventions

- **No comments unless WHY is non-obvious.** No PR-history comments ("added for X").
- Use `?? defaultValue` for `noUncheckedIndexedAccess` array/object index access.
- Server-side files start with `import "server-only";`. Test stub at [test/stubs/server-only.ts](test/stubs/server-only.ts).
- Never call `revalidatePath` from a query module — only from server actions.
- Audit log every mutation: `db.insert(auditLog).values({ accountId, action, target, status, message })`.
- File path convention in `actions/`: `{domain}.ts` colocated, all marked `"use server"` at the top.
- Agent-facing actions live in ONE place: [src/lib/mcp/tools.ts](src/lib/mcp/tools.ts) (served by `/api/mcp`, bearer `vmui_*` operator). Adding a house/PC capability means adding a tool there (zod schema, description a model can act on, `destructive`/`readOnly` flags) — not a new ad-hoc route. PC verbs are the fixed enum in `scripts/pc-action.ps1`; never expose arbitrary shell.
- API keys carry optional **scopes** (`api_keys.scopes` JSON, [src/lib/api-key-scopes.ts](src/lib/api-key-scopes.ts)): a tool allow-list plus `vmIds` / `entities` / `pcActions` / `scripts` limits. `/api/mcp` filters `tools/list` and refuses `tools/call` outside scope; a tool that targets a specific VM/entity/verb must implement `scopeKey(args)` so the argument check can see it. Malformed stored scopes fail closed. Null = unrestricted.
- Keys are found by `api_keys.lookup_id` (`apiKeyLookupId` = first 16 hex of SHA-256 of the token, indexed), then scrypt-verified once. Any new mint path must store it (`generateApiKey()` returns it; `scripts/mint-api-key.mjs` computes the same value). Rows without it are legacy: scanned, then backfilled on first use.
- **Stream light effects** (`scene_list`, `scene_set`, `flash_color`; `notify_flash` too) carry `effect: { kind }` on the tool and go through [src/lib/mcp/effect-limiter.ts](src/lib/mcp/effect-limiter.ts) in `/api/mcp`: per key per kind cooldown (flash 1.5 s, scene 10 s), burst merge (last wins, one trailing run), `idempotencyKey` dedupe 60 s. A limited call returns `{ok:true, limited:true, retryAfterMs, queued:true}` with `isError:false`. Scenes are `STREAM_SCENES` in [catalog.ts](src/lib/home/catalog.ts) ↔ `script.stream_scene_<id>` in [pi/ha-packages/vmui_stream.yaml](pi/ha-packages/vmui_stream.yaml) — add a scene in both, plus `src/lib/mcp/stream-preset.json` `scripts` (a test checks they agree). Scope keys are `{kind:"script", id:"stream_scene_<id>" | "stream_flash"}`. Never call `light.led_argb` from a stream script (the MELK bridge owns its BLE link; strips go via HyperHDR priority 30) and never `light.desk_light_bar` (white-only). Scope preset `stream` = those tools + RGB room lights + stream scripts.
- `src/lib/db/index.ts` column-adds go through `addColumnIfMissing` — `next build` evaluates the module in ~30 workers against the same SQLite file, so a bare `ALTER TABLE` races and fails the build with `duplicate column name`.
- **Home access is the family model, not `users.role`.** `users.role` (admin/operator/viewer) governs the VM control plane only. Everything under `/home` is gated by [src/lib/home/access.ts](src/lib/home/access.ts): `home_members` rows carry a family role (`owner | adult | child | guest`) and per-room grants (`{ [roomId]: "view" | "control" }`); an infra `admin` with no row is treated as owner. Server actions use `requireEntityControl(entity)` (device actions), `requireOwner()` (settings, layout, family management), `requireDoorAccess()` (intercom open/arm — owner+adult only) or `requireHomeActor()`; never `requireRole` for a home mutation. Queries and the SSE stream filter through `visibleEntities(actor)`; identity-less shared-token callers (ESP32, Nest Hub, HA) resolve to `ownerActor()`; a paired phone acts as the member in `paired_devices.user_id`. Nutrition (meals, hydration, `nutrition_profiles`) is per `user_id`; the owner's legacy profile stays in `turzx_settings` row 5. Members join via `/invite/<token>` ([src/lib/home/family.ts](src/lib/home/family.ts)) or an account the owner creates; UI is the Family section of `/home?tab=settings`. Client components import types/consts from `access-model.ts`, never `access.ts` (it pulls `next/headers`).
- Desktop tray + control window: [apps/desktop](apps/desktop/README.md) (Tauri 2, pnpm workspace member). Its Rust side reads `.private/credentials.env`, `ambilight/settings.json`, Task Scheduler, HyperHDR ws and the Pi's vmui via the shared display token; settings for both screens go through `/api/desktop/settings`. Rebuild with `pnpm exec tauri build` after stopping `vmui-desktop.exe`; the `vmui-tray` task runs it with `--hidden`.

## Native modules

`next.config.ts` lists `serverExternalPackages: ["better-sqlite3", "ssh2", "cpu-features", "ws"]`. Adding any new native binding (e.g. `node-pty`) means adding it here too — otherwise Turbopack tries to bundle it and breaks at runtime.

## Scripts

## Deployment target: homepi (Raspberry Pi 4B)

The production vmui, Home Assistant, ESPHome, Mosquitto, the Turzx renderer
and the desk button run on `homepi` (`192.168.100.232`, `ssh homepi`). Build
here, ship with `pwsh -File scripts\pi-deploy.ps1` (never `pnpm build` on the
Pi — 4 GB RAM). Units and compose live in `pi/`; read the "homepi" section of
[docs/home-assistant.md](docs/home-assistant.md) before touching them. The
vmui instance on this PC only serves the Hyper-V `local-kvm` provider.

- `pnpm dev` — Next dev on `127.0.0.1:3737`.
- `pnpm build` / `pnpm start` — production.
- `pnpm typecheck` — `tsc --noEmit`. Run before declaring a round done.
- `pnpm test` — Vitest unit tests.
- `pnpm test:e2e` — Playwright. Auto-spawns dev server.
- `pnpm db:studio` — Drizzle Studio.
- `pnpm keygen` — generates a fresh `VMUI_MASTER_KEY`.

## Don't

- Don't import from `@azure/arm-subscriptions` (v6 renamed). Use `@azure/arm-resources-subscriptions`.
- Don't iterate `aggregatedListAsync` with `.next()` — it's an `AsyncIterable`, use `for await ... break`.
- Don't add markdown docs unless explicitly requested.
- Don't add backwards-compat shims; we own the whole stack.
- Don't use `process.env.X` in client components — go through [src/lib/env.ts](src/lib/env.ts).
- Don't use raw palette classes (`zinc-*`, `slate-*`, `rose-*`, hex, `dark:`) — tokens from `globals.css` only.
- Don't hand-roll `setInterval`/`EventSource` pollers — add a hook to [src/hooks/use-poll.ts](src/hooks/use-poll.ts).
- Don't create local `Field` / `Stat` / `EmptyState` / `Sparkline` clones — import the shared ones from `@/components/ui`.

## When in doubt

- Check the `audit_log` for what ran last and how it failed: `pnpm db:studio` → `audit_log`.
- Check [README.md](README.md) for user-facing setup; this file is for agents.
