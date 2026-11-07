# Vatra for iPhone, iPad and Apple Watch (apps/ios)

SwiftUI app, iOS 18+ / watchOS 11+, bundle `ro.vatra.app`. Same hub contract and features as
[apps/android](../android): pairing (QR `vatra://pair`, Bonjour `_vatra._tcp`, e-mail + password, or a
4-digit approval), Home / Lights / Alerts / Settings, several homes, push, presence, NFC tags.

| Path                                | What                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.yml`                       | XcodeGen spec (the `.xcodeproj`, Info.plists and entitlements are generated, never committed)                                                                              |
| `VatraCore/`                        | Swift package: wire models of `/api/v1/app/*`, `HubClient`, `Pairing`, `HubStore` (Keychain), `QuickAction`, `PushPayload`, Bonjour discovery, brand tokens — `swift test` |
| `Vatra/`                            | App: screens, APNs registration, notification actions, presence (region monitoring), NFC writer, App Shortcuts, watch pairing                                              |
| `Shared/`                           | Code + String Catalog shared by every target: theme, mark, App Intents, Live Activity attributes, glance snapshot                                                          |
| `VatraWidgets/`                     | House widget (Home + Lock Screen, interactive), Control Center controls, intercom Live Activity                                                                            |
| `VatraNotificationService/`         | NSE: fetches a trimmed card, attaches the card's own action buttons, groups by tag                                                                                         |
| `VatraWatch/`, `VatraWatchWidgets/` | Watch app (own `vmd_` token, platform `vatra-watchos`) + complications                                                                                                     |
| `scripts/build.sh`                  | `test` / `build` / `all` on a Mac (renders the app icon from the brand geometry first)                                                                                     |
| `scripts/strings.mjs`               | builds `Shared/Localizable.xcstrings` (en + ro) from the Android strings + iOS-only keys; `--check`                                                                        |

From Windows (ships the committed tree, or `-WorkingTree`, to the devcloud Mac `vmui-mac`):

```powershell
pwsh -NoProfile -File scripts/ios-build.ps1 -Mode all            # swift test VatraCore + unsigned build of every target
pwsh -NoProfile -File scripts/ios-build.ps1 -Mode test -WorkingTree
```

Contract: `VatraCore` `ContractTests` decode every `docs/api/fixtures/*.json` response and encode the
fixture requests byte-for-byte equal, the same files the Android `ContractTest` and the hub's
`openapi.test.ts` use. Brand: `node brand/scripts/emit-swift.mjs` regenerates `VatraTokens.swift`;
`src/lib/native-apps.test.ts` fails the hub test suite when it or the strings are stale.

Push: when the hub has Vatra Cloud push on, `GET /api/v1/app/push` returns `relay {url, hub}`; the app
registers its APNs device token (and the Live Activity push-to-start token) with the relay as opaque
handles bound to that hub, then `PUT kind: relay` and keeps the returned per-device `e2eKey` in the
shared keychain. Cards arrive AES-256-GCM encrypted under a generic localised alert; the NSE decrypts
or fetches `/api/v1/app/push/card` (P10-03, `docs/product/cloud/CONTRACT.md`). A hub with its own APNs
key (`APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID`) still gets `apns: true` and `kind: apns` direct.

Signing and TestFlight wait for the App Store Connect record of `ro.vatra.app` (owner step, P8-04).
