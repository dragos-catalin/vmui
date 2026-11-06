# Vatra — from a home install to a self-hosted product (PLAN, started 2026-11-06)

Canonical tracker: [TRACKER.csv](TRACKER.csv). Research behind this plan: four reports from
2026-11-06 (blocker inventory, store requirements, Pi/ESP distribution, native mobile),
summarised below. Every decision here came from the owner via askQuestions on 2026-11-06.

## Goal

Anyone can buy a Raspberry Pi (or run a VM), flash the Vatra image, open `vatra.local` or the
phone app, claim the hub, connect Home Assistant (bundled), add ESP32 devices from the browser,
and control the home from native apps published on Google Play, the App Store and the Microsoft
Store. The owner's homepi becomes "just another Vatra on the beta channel".

## Decisions (owner, 2026-11-06)

| Topic | Decision |
|---|---|
| Product | Self-hosted product for anyone; one household per hub |
| Scope | Everything: home, ambilight/PC, nutrition, Turzx/Nest Hub/ESP displays; VM control plane = optional **Vatra Lab** module on web + desktop, not in mobile v1 |
| Mobile | Native: Kotlin 2.4 + Compose (phone, Wear OS, Google TV) and SwiftUI (iOS, iPadOS, watchOS) |
| Desktop | Tauri 2 Windows app stays (tray + PC agent); its Android target is retired once the native app ships |
| Publisher | Dragos Catalin (personal accounts: Play Console, Apple Developer, Partner Center) |
| Home Assistant | HA Container bundled in the image + a Vatra add-on repo for existing HAOS users + BYO HA by URL |
| OS image | rpi-image-gen, Pi 4 + Pi 5, EROFS A/B + tryboot (Rugix Ctrl), signed container updates with rollback; x86 qcow2/OVA via Packer |
| Remote + push | Vatra-run: SNI passthrough relay (E2E TLS), E2E-encrypted push relay (FCM + APNs), ACME DNS-01 proxy |
| Domain | `vatra.dragoscatalin.ro` until the owner picks a product domain (free candidates on 2026-11-06: vatra.house, usevatra.com, hivatra.com, vatra.network). Every domain lives in ONE config value |
| Licence | Hub AGPL-3.0, firmware + SDK MIT, store apps from the same repo; git history scrubbed of secrets before going public |
| Money | Free + optional Vatra Cloud subscription (remote, push, backup) billed through brivio → DSA trader (P.O. box + dedicated phone) |
| ESP hardware v1 | ideaspark ESP32 + SSD1306, ESP32-S3 colour display (Guition 4848S040 / Waveshare 4.3), M5Stack Atom / ESP32-C3 button, stock ESPHome BT proxy |
| New ideas in scope | widgets + Control Center/QS + App Intents; intercom Live Activity / CallStyle "Open door"; Google TV + Wear/watchOS; encrypted backup + restore; AI assistant on the existing MCP tools (AI Act art. 50, Apple 5.1.2(i)); geofence presence; NFC tags; Matter via HA; community scene marketplace |
| Trademark | Check EUIPO/OSIM classes 9/42 for "Vatra"; rename only on a real collision |

## Target architecture

```mermaid
flowchart LR
  subgraph Cloud["Vatra Cloud (opt-in)"]
    REL[GHCR + Releases + Pages<br/>signed channel manifests, images, firmware]
    ACME[ACME DNS-01 proxy]
    SNI[SNI relay, E2E TLS]
    PUSH[Push relay FCM+APNs<br/>payload E2E-encrypted]
    BILL[Subscription via brivio]
  end
  subgraph Hub["Vatra hub: Pi 4/5 image (A/B) or x86 VM"]
    FB[vatra-firstboot: secrets, CA, setup code]
    UPD[vatra-updater: verify, pull, snapshot, health, rollback]
    subgraph Compose["docker compose, pinned digests"]
      APP[Vatra hub (Next.js): setup wizard, API v1, web UI, fw server]
      HA[Home Assistant Container]
      MQ[Mosquitto]
      AG[vatra-agent: turzx, GPIO, cast]
    end
    DB[(/persistent: vatra.db, ha, secrets, backups)]
  end
  subgraph Clients
    AND[Android phone / Wear / TV]
    IOS[iOS / iPad / watchOS]
    WIN[Windows desktop + PC agent]
    ESP[ESP32 devices: Improv + http OTA]
  end
  REL --> UPD --> Compose
  APP <--> HA
  HA <--> ESP
  ESP -- per-device token --> APP
  AND & IOS & WIN -- /api/v1/app + SSE --> APP
  APP -. opt-in .-> SNI & ACME & PUSH
  PUSH --> AND & IOS
```

## Phases (order chosen by the owner: foundation first)

| Phase | Content | Exit check |
|---|---|---|
| **P0 Security + product/owner split** | Close the auth holes (unauth audit SSE, device tokens bypassing room grants, insecure cookie, open-until-claimed), move owner-specific values into config, per-member settings instead of `dragos` literals | `rg` for owner literals hits only `config/owner.example`; security tests red→green |
| **P1 House as data** | Rooms/devices/entities in DB, imported from HA areas/devices; catalog becomes a seed for the owner; access, whitelists and floor plan read the DB | Fresh DB + HA demo = working home UI with no code edit |
| **P2 Setup wizard + secrets** | `/setup` claim with setup code, owner, locale/timezone, HA onboarding automation (bundled) or URL+token (BYO), integration secrets encrypted in SQLite with UI, master key mandatory and generated at first boot | Fresh container → browser → working dashboard, no terminal |
| **P3 API v1 for native apps** | `/api/v1/app/*` with `defineRoute` (zod in/out, family-model auth per op), generated OpenAPI 3.1 + contract fixtures, QR pairing, per-device scoped tokens replace `ESP_DISPLAY_TOKEN`, `minClient` in discover | OpenAPI drift test green; guest token cannot control a room it lacks |
| **P4 Containers + releases** | Next standalone image (arm64/amd64), vatra-agent image, GHCR + cosign + SBOM, compose v2 `/srv/vatra`, channel manifests | `docker compose up` on clean Debian = working hub |
| **P5 Pi + x86 images** | rpi-image-gen layers, firstboot, hotspot captive portal, avahi `_vatra._tcp`, Imager os_list, Packer qcow2/OVA, updater + A/B | Image boots on Pi 4 + Pi 5, bad update rolls back |
| **P6 ESP32 product** | `vatra.display` (SSD1306 + S3 LVGL), `vatra.button`, BT proxy; Improv, runtime keys, http_request OTA from the hub, CI matrix, Devices → Add with ESP Web Tools + adoption | Stranger flashes from Chrome, device adopted in Vatra + HA |
| **P7 Android** | apps/android: core/ui/app/wear/tv, brand tokens → Compose, M3 Expressive motion, FCM + UnifiedPush flavours, widgets, QS tile, Device Controls, CallStyle intercom, geofence, NFC | Closed test 12×14 d passed → production |
| **P8 iOS** | apps/ios: VatraCore SPM, SwiftUI app, WidgetKit + Controls + Live Activity, NSE, App Intents, watchOS | TestFlight → App Store approved |
| **P9 Windows Store** | Tauri desktop as product: no repo/disk reads, pairing, signed NSIS via a Trusted Root cert, Store listing | Partner Center certification passed |
| **P10 Vatra Cloud** | SNI relay, ACME proxy, push relay, demo hub for reviewers, subscription via brivio | Remote URL over CGNAT; reviewer demo works |
| **P11 Legal, docs, launch** | Privacy policy, ToS, DSA, AI Act art. 50, licences/NOTICE, docs site, git history scrub, public repo | Legal Review clean; stores live |

## Store prerequisites known now (2026-11-06)

- Play: target API 36 (Wear 35, TV 34), 16 KB pages, closed test 12 testers × 14 days for personal
  accounts, Data safety + web account deletion page, no AccessibilityService, reviewer email+password.
- Apple: Xcode 26 SDK, PrivacyInfo.xcprivacy, NSLocalNetworkUsageDescription + NSBonjourServices
  `_vatra._tcp`, DSA trader info, in-app account deletion, demo account with a live backend, AI consent.
- Microsoft: EXE/MSI route, installer + PEs signed by a Trusted Root CA cert, offline WebView2,
  silent install, hub dependency disclosed first in the description, generative AI disclosure (11.16).

## Effort (research estimate)

Hub/foundation P0–P3 ≈ 6–8 weeks; containers/images/ESP P4–P6 ≈ 8–10 weeks; Android ≈ 6–8,
iOS ≈ 7–9, Windows Store ≈ 1–2, Cloud ≈ 3–4, legal/docs ≈ 2. Parallelisable to ~5–6 months
elapsed with agents, plus store review waits (Play closed test alone is ≥ 14 days).

## Owner-only actions (cannot be done by an agent)

- Product domain purchase (deferred; `vatra.dragoscatalin.ro` meanwhile).
- Code-signing certificate for Windows (Trusted Root CA, identity verification).
- App Store Connect app record, DSA trader verification, critical-alerts entitlement request.
- 12 closed testers for Play.
- P.O. box + dedicated phone for the public trader listing.
