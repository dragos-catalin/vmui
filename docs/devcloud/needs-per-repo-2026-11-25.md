# What each repository's heavy operations need from a cloud machine

Artifact asked for on 2026-11-25. Purpose: decide placement by reading, not guessing.
Every claim carries an evidence path. Claims that could not be sourced are in
[Unverified](#unverified) at the end rather than in a table.

Scope: the active repositories under `E:\gh` — vitals, codai, brivio, metu, money, mmo,
titi, dashy, HIDE, axiom, afti, caelia, gta-nexus, dragoscatalin, vmui, notai, cursuri.
`cursuri` resolves to `E:\gh\cursuri-studiai` (the only match on disk).

## Vocabulary

- **cloud-able today**: `yes` — a declared `devcloud-ci-*` family covers the toolchains;
  `yes-with-image` — a family nearly covers it but needs another layer baked in;
  `no` — a hard constraint no VM in the current fleet can satisfy.
- **Declared families** (image bakery): `node24`, `android-jdk21`, `rust-tauri-linux`,
  `rust-tauri-win`, `python-uv`, `flutter`, `polyglot`, `win-desktop`. Layers per family:
  `vmui/infra/devcloud/images/image-setup.sh` (Linux) and `image-setup-win.ps1`
  (`win-desktop`, Windows Server 2025). Machine classes named by a repo are quoted where
  the repo states them.

---

## vitals

Tauri 2 desktop (React + Rust), Rust crates, Tauri Android (Kotlin/Compose), CLI, Astro
site. Windows-first; a Linux lane exists for CI parity.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| typecheck / lint / test (TS monorepo) — `pnpm exec turbo run typecheck lint test` | OS windows; node24 + pnpm12 | yes (`win-desktop`) | `vitals/scripts/verify.ps1` (`$ts` lane); `vitals/package.json` `scripts.typecheck` |
| rust clippy + tests — `cargo clippy --workspace --all-targets -- -D warnings`; `cargo test --workspace` | OS windows; rust msvc + node24; machine `c4d-standard-16`, dedicated | yes (`win-desktop`) | `vitals/scripts/verify.ps1` (`$rust`); `vitals/.devcloud/profile.json` lane `rust` |
| perf budget — `cargo test -p vitals-win --release --test overhead -- --nocapture` | OS windows; rust msvc release; machine to itself (a stated budget, not a benchmark) | yes, but `dedicated: true` | `vitals/.devcloud/profile.json` lane `rust` `why`; `vitals/docs/devcloud.md` |
| linux clippy (CI parity) — `cargo clippy` on Linux | OS linux; rust-tauri-linux | yes (`rust-tauri-linux`, on `ws-codai`) | `vitals/scripts/verify.ps1` (`$linux`); `vitals/docs/devcloud.md` |
| build / packaging (NSIS installer) — `pnpm --filter @vitals/desktop tauri build` | OS windows; rust + NSIS/WebView2 (or cargo-xwin on Linux) | yes (`rust-tauri-win` cross, or `win-desktop`) | `vitals/package.json` `scripts.tauri`; `.vscode` task `build: installer (nsis)` |
| native / Android build — `apps/android/gradlew.bat` / `tauri android build` | OS windows or linux; jdk21 + android-sdk + gradle + rust; machine `c4d-standard-16`, dedicated | yes (`android-jdk21`), `dedicated: true` | `vitals/.devcloud/profile.json` lane `android` `why` (Gradle daemon holds stdio); `vitals/apps/android/build.gradle.kts` |
| protocol bindings — `cargo test -p vitals-core --features ts` | rust + node | yes | `vitals/package.json` `scripts.protocol:generate` |
| iOS / macOS screenshots | OS darwin; xcode; Apple hardware | **no** — macOS is not a declared family and the owner path has no Xcode/Metal | `vitals/.github/workflows/ios-screenshots.yml:26`, `macos-screenshots.yml:21` |

## codai

Next.js console, Hono services (gateway/mgmt/auth), Rust crates (`codaid`, desktop),
Tauri Windows desktop, Kotlin phone/TV/Wear, Python services, Terraform, Vertex GPU
training.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| monorepo typecheck / lint / test | OS linux; node24 | yes (`node24`, on `devcloud-linux-4/16`) | `codai/.github/workflows/ci.yml:62,561`; `codai/package.json` `scripts.typecheck` |
| Rust (Linux) clippy/tests | OS linux; rust-tauri-linux | yes (`rust-tauri-linux`) | `codai/.github/workflows/ci.yml:819`; `codai/.github/workflows/ci.yml` label `devcloud-rust-tauri-linux` |
| Windows desktop build / e2e | OS windows; msvc, CMake + NASM (libopus, aws-lc-sys), WebView2 | yes (`win-desktop`) | `codai/.github/workflows/ci.yml:881`; `codai/.github/workflows/desktop-nightly.yml:41`; `vmui/infra/devcloud/images/image-setup-win.ps1` |
| Android release (phone / TV / Wear) | OS linux; jdk21 + android-sdk | yes (`android-jdk21`) | `codai/.github/workflows/release-phone.yml:49` |
| Docker images / deploy to Cloud Run | OS linux; docker + gcloud + service-account secrets | yes (`node24`), needs cloud creds | `codai/apps/*/Dockerfile`; `codai/.github/workflows/deploy-cloud-run.yml:53` |
| migrations (Drizzle) | node + Cloud SQL reachability; runs BEFORE the image | yes, needs prod DB access | `codai/.github/workflows/migrate.yml:45`; `codai/.github/copilot-instructions.md` ("Migrations BEFORE images") |
| GPU training / eval (H200/B200, Vertex) | GPUs, not a CI family; cobalt/Vertex quota; long jobs | no CI family — a separate GPU lane | `codai/.github/copilot-instructions.md` ("H200 8x SPOT is the proven lane") |
| product release (codaid) macOS / Windows / arm64 | OS darwin/windows; hosted images | partly — macOS leg is hosted-only by design | `codai/.github/workflows/release-codaid.yml:145` |

## brivio

Next.js web, Hono gateway/mcp/worker, Pulumi/Docker, Playwright E2E, Android/iOS native,
multi-language SDKs (TS, Go, Python, PHP, Java, .NET).

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| monorepo build / lint / typecheck | OS linux; node24 | yes (`node24`, `devcloud-linux-16`) | `brivio/.github/workflows/ci.yml:130`; `brivio/package.json` `scripts.build` |
| unit + integration tests — `turbo test --concurrency=6` | OS linux; node24; memory-hungry (concurrency 6) | yes | `brivio/package.json` `scripts.test`; `scripts.run-int-tests.mjs` |
| E2E / browser — `pnpm e2e:cloud` (Playwright) | OS linux; node24 + chrome + Playwright deps (fonts, xvfb); **never on the workstation** | yes (`node24`) | `brivio/.github/instructions/brivio-conventions.instructions.md` (ADR-0214); `brivio/.github/workflows/e2e-nightly.yml` |
| a11y nightly (IBM + axe) | OS linux; `devcloud-linux-32` (32 vCPU) | yes (`node24`, `linux-32`) | `brivio/.github/workflows/a11y-nightly.yml:68` |
| Android / iOS native builds | OS linux (Android) / darwin (iOS); jdk21 + android-sdk; xcode for iOS | Android yes (`android-jdk21`); **iOS no** | `brivio/.github/workflows/release-android.yml`; `build-store-app.yml:56`; `brivio/apps/ios/core-build/build.gradle.kts` |
| desktop (Tauri Windows) build | OS linux cross or windows; rust-tauri-win (NSIS, jsign, osslsigncode) | yes (`rust-tauri-win`) | `brivio/.github/workflows/release-desktop.yml`; `vmui/infra/devcloud/images/image-setup.sh` (`rust-tauri-win` layers) |
| SDK release — Go / Python / PHP / Java / .NET | go, uv/python, php, jdk, dotnet SDKs | partly — python covered; **go/php/dotnet missing** | `brivio/.github/workflows/release-sdk-go.yml`, `release-php-sdk.yml`, `release-sdk-dotnet.yml`, `release-sdk-java.yml`; `brivio/packages/sdk-go/go.mod` |
| migrations (hand-written SQL) | node + Cloud SQL; hand-written, never `db:generate` | yes, needs prod DB access | `brivio/.github/instructions/brivio-conventions.instructions.md`; `brivio/package.json` `scripts.db:generate` |
| deploy (Cloud Run, Pulumi) | linux + docker + gcloud/pulumi + secrets; build LOCALLY (web peaks ~30 GB) | partly — `apps/web` cannot be built in Cloud Build | `brivio/.github/instructions/brivio-conventions.instructions.md` ("Build LOCALLY") |

## metu

Next.js web, Hono hub (ws), Cloud Run worker/mcp, Expo mobile, Tauri companion,
VS Code + browser extensions, Inngest.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| monorepo build / lint / typecheck / test | OS linux; node24 | yes (`node24`) | `metu/package.json` `scripts.build`; `metu/.github/workflows/ci.yml:39` |
| docker infra (Postgres, MinIO) for tests — `docker compose up -d --wait` | OS linux; docker + compose | yes (`node24` has docker) | `metu/package.json` `scripts.infra:up` |
| companion desktop build — `pnpm companion:build` (Tauri) | OS windows; rust msvc + WebView2 (+ NSIS/WiX at bundle time) | yes (`win-desktop`) | `metu/package.json` `scripts.companion:build`; `metu/apps/companion/src-tauri/Cargo.toml` |
| mobile build (Expo) | OS darwin for iOS; linux/android-sdk for Android | Android yes; **iOS no** | `metu/.github/instructions/mobile-expo.instructions.md`; `metu/apps/mobile` |
| E2E / browser (Playwright) | OS linux; node24 + chrome | yes (Playwright available per repo docs) | `metu/.github/copilot-instructions.md` ("Playwright is available") |
| deploy (Vercel web, Cloud Run hub/worker/mcp) | linux; node + provider CLI + secrets | yes, needs cloud creds | `metu/.github/workflows/deploy-web.yml:16`, `deploy-hub.yml:32` |
| migrations (Drizzle) | node + Neon Postgres | yes, needs DB access | `metu/.github/workflows/db-migrate.yml:22` |

## money

Next.js web (Vercel) + Python 3.12 FastAPI quant/sigint services on Cloud Run, Drizzle +
PostgreSQL 17, Terraform.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| web build / lint / typecheck / test | OS linux; node24 | yes (`node24`) | `money/.github/workflows/ci.yml:66,110`; `money/package.json` `scripts.build` |
| Python quant/sigint build + tests | OS linux; python-uv (uv-managed CPython 3.12) | yes (`python-uv`) | `money/apps/quant/pyproject.toml`, `uv.lock`; `money/apps/sigint/pyproject.toml` |
| docker images (quant / sigint) → Cloud Run | OS linux; docker + gcloud + secrets | yes, needs cloud creds | `money/apps/quant/Dockerfile`; `money/apps/sigint/Dockerfile` |
| migrations (Drizzle) | node + Cloud SQL Postgres 17 | yes, needs DB access | `money/package.json` `scripts.db:migrate` |
| E2E on cloud — `pnpm e2e:cloud` | linux; node + a deployed target | yes | `money/package.json` `scripts.e2e:cloud` |

## mmo

Next.js web (PWA) + Express MMO server + Electron companion, Tauri MixAI (Rust audio:
cpal/symphonia), Capacitor native shell, many Kotlin Android/TV apps, Tizen/webOS TV app,
MV3 extension, Cloud Run audio services.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| web build / typecheck / lint / test | OS linux; node24 | yes (`node24`) | `mmo/.github/workflows/web-ci.yml:31`; `mmo/AGENTS.md` (golden commands) |
| server build + tests (Node 22 ABI, better-sqlite3) | OS linux; node 22 + native build | yes (`node24`) | `mmo/AGENTS.md` ("Node 22 for server (native ABI)") |
| Rust audio (mixai-listen) build | OS linux/windows; rust | yes (`rust-tauri-linux` / `rust-tauri-win`) | `mmo/crates/mixai-listen/Cargo.toml`; `mmo/apps/mixai/src-tauri/Cargo.toml` |
| android / TV Android builds | OS linux; jdk + android-sdk + gradle | yes (`android-jdk21`) | `mmo/.github/workflows/tv-android-release.yml:18`; `mmo/apps/tv-android/build.gradle.kts` |
| TV packaging (.wgt / .ipk) | Tizen SDK and webOS CLI, plus a Tizen signing certificate | **no** — neither SDK is declared | `mmo/apps/tv-tizen/package.json` `scripts.package`, `scripts.setup:cert` |
| desktop releases (Tauri/Electron, Windows + macOS) | rust-tauri-win on Windows; **macOS needs darwin** | Windows/linux yes; macOS **no** | `mmo/.github/workflows/native-release.yml:124,308`; `mmo/.github/workflows/companion-release.yml:130` |
| docker server image + `/health` smoke | OS linux; docker | yes | `mmo/.github/workflows/mmo-server-docker.yml:70` |
| migrations (Drizzle) — **prod DB** | node + Cloud SQL; `DATABASE_URL` is production | yes, needs DB access, run deliberately | `mmo/AGENTS.md` ("db:migrate is a prod migration") |

## titi

Offline-first walkie-talkie: shared Rust core (`titi-core`) + UniFFI/wasm, native Kotlin
(Android/Wear/Google TV), SwiftUI iOS, Next.js PWA, Tauri desktop, Tizen TV, Hono relay
(no DB). Protobuf via `buf`.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| JS monorepo check — `turbo run typecheck lint test` | OS linux; node24 + pnpm10 (oxlint) | yes (`node24`) | `titi/package.json` `scripts.check`; `titi/.github/workflows/ci.yml:24` |
| Rust core tests — `cargo test --manifest-path core/Cargo.toml` | OS linux/windows; rust | yes (`rust-tauri-linux` / `win-desktop`) | `titi/package.json` `scripts.core:test` |
| wasm build — `cargo build --target wasm32-unknown-unknown` + wasm-bindgen-cli | rust + `wasm32-unknown-unknown` target + wasm-bindgen-cli | yes-with-image — rust family lacks the wasm target/bindgen | `titi/scripts/build-wasm.ps1` |
| protobuf — `pnpm dlx @bufbuild/buf@1.73.0 generate` | node (buf via pnpm dlx) | yes | `titi/package.json` `scripts.proto:gen` |
| Android / Wear / TV builds — `android/gradlew.bat -p android :app:assembleGmsDebug …` | OS linux or windows; jdk + android-sdk + gradle | yes (`android-jdk21`) | `titi/package.json` `scripts.android:debug`; `titi/android/build.gradle.kts` |
| iOS build | OS darwin; xcode | **no** | `titi/.github/workflows/ios.yml:25` (`macos-26`) |
| desktop build (Tauri, Windows/macOS/Linux) | rust-tauri-win on Windows; darwin macOS | Windows/linux yes; macOS **no** | `titi/.github/workflows/release.yml:99`; `titi/AGENTS.md` |
| Tizen TV package | Tizen SDK + certificate | **no** | `titi/AGENTS.md`/ADR-0008 (Tizen listed as a surface) |
| relay image deploy | OS linux; docker + Cloud Run secrets | yes | `titi/.github/workflows/deploy.yml:24`; `titi/apps/backend/Dockerfile` |

## dashy

Ambient display: Tauri 2 + Rust (Android primary, Windows full app + Rust agent),
Kotlin Android plugin, reuses `vitals-core`/`vitals-win`.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| JS build / lint / typecheck / test | OS linux; node24 | yes (`node24`) | `dashy/.github/workflows/ci.yml:29`; `dashy/package.json` `scripts.build` |
| Rust clippy/tests — `cargo clippy --workspace --all-targets -- -D warnings` | OS linux/windows; rust | yes (`rust-tauri-linux` / `win-desktop`) | `dashy/package.json` `scripts.rust:lint`; `dashy/.github/workflows/ci.yml:63` |
| Tauri desktop / Windows build (NSIS) | OS windows; rust msvc + NSIS/WebView2 | yes (`rust-tauri-win` / `win-desktop`) | `dashy/package.json` `scripts.tauri`; `dashy/.github/workflows/release.yml` |
| Android build — `pnpm --filter @dashy/app tauri android build` | jdk + android-sdk + rust + gradle | yes (`android-jdk21`) | `dashy/package.json` `scripts.android:build` |
| E2E / browser — `pnpm --filter @dashy/app e2e` | OS linux; node + chrome (Playwright) | yes | `dashy/package.json` `scripts.e2e` |
| on-device verification (Samsung S25 Ultra, wireless adb) | physical Android 16 device; `adb` | **no** — physical device | `dashy/.github/instructions/android.instructions.md` (target device SM-S938B) |

## HIDE

Rust protocol workspace (`hide-*` crates), Rust CLI, Tauri desktop, FFI, wasm, cargo-fuzz,
SDKs in eight languages (node, python, go, java, dotnet, php, ruby, wasm).

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| Rust suite — `cargo test --workspace --all-features` | OS linux/windows; rust | yes (`rust-tauri-linux` / `win-desktop`) | `HIDE/package.json` `scripts.verify`; `HIDE/AGENTS.md` |
| release CLI — `cargo build --release -p hide-cli` | rust; exact pins (wire format) | yes | `HIDE/package.json` `scripts.verify` |
| desktop build (Tauri, outside the workspace) — `pnpm tauri build` | OS windows; rust + frontend build | yes (`win-desktop`) | `HIDE/AGENTS.md` ("desktop crate deliberately OUTSIDE the cargo workspace") |
| fuzz — cargo-fuzz (libFuzzer) | rust **nightly** + sanitizer build | yes-with-image — rust family is `stable` | `HIDE/fuzz/Cargo.toml` ("libfuzzer needs nightly and a sanitizer build") |
| conformance — `node verify.mjs` | node | yes | `HIDE/AGENTS.md` (`conformance/node`) |
| SDK builds (8 languages) | node, python/uv, rust; **go, java, dotnet, php, ruby missing** | partly | `HIDE/sdk/{dotnet,go,java,node,php,python,ruby,wasm}`, `HIDE/sdk/go/go.mod`, `HIDE/sdk/python/pyproject.toml` |
| cross-OS check (WSL) | linux rust | yes (`rust-tauri-linux`) | `HIDE/AGENTS.md` ("Linux check: copy … into WSL") |

## axiom

TS monorepo (MCP server, CLI, hook, GitHub Action, LSP + VS Code extension), Rust crate
(`axiom-hook`), Biome, Vitest, mutation testing, Astro site.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| build / typecheck (packages) | OS linux; node24 | yes (`node24`) | `axiom/package.json` `scripts.build`; `axiom/.github/workflows/ci.yml:36` |
| unit tests — `vitest run` | node | yes | `axiom/package.json` `scripts.test` |
| mutation smoke — `node scripts/mutation-smoke.mjs` | node (Stryker-family mutation) | yes | `axiom/package.json` `scripts.test:mutation`; `axiom/.github/workflows/mutation.yml:53` |
| Rust hook crate — `cargo` | rust | yes (`rust-tauri-linux`) | `axiom/crates/axiom-hook/Cargo.toml` |
| VS Code extension build | node (vsce) | yes | `axiom/.github/workflows/vscode-extension.yml:32` |
| site build (Astro) | node | yes | `axiom/package.json` `scripts.build:site` |

## afti

Offline PWA (Next.js 16), Hono + zod-openapi API, Python/uv FastAPI ML, pgvector,
Terraform, Cloud Run.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| monorepo build / lint / typecheck / test | OS linux; node24 | yes (`node24`) | `afti/.github/workflows/ci.yml:24`; `afti/package.json` `scripts.build` |
| E2E / browser — `turbo run test:e2e` | OS linux; node + chrome | yes | `afti/package.json` `scripts.test:e2e` |
| ML service build + tests | OS linux; python-uv (CPython 3.12) | yes (`python-uv`) | `afti/apps/ml/pyproject.toml`, `uv.lock` |
| docker + migrations (hand-written SQL) | linux; docker + Cloud SQL + secrets | yes, needs DB access | `afti/apps/ml/Dockerfile`; `afti/package.json` `scripts.db:migrate` |

## caelia

Flutter (Android → iOS → Windows) + Hono/zod-openapi API on Cloud Run, Drizzle + Neon.
Dart pub workspace + melos; Flutter SDK lives outside PATH.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| Flutter verify (gates · analyze · tests · ts · openapi drift) — `tool/verify.ps1` | OS **windows** (CI runs it on `windows-latest`); Flutter stable 3.47.3 + node22 + pnpm | yes-with-image — `flutter` family is Linux; the repo's own verify host is Windows | `caelia/.github/workflows/ci.yml:27`; `caelia/AGENTS.md` |
| Android release AAB — `flutter build appbundle --release …` | OS linux; Flutter + jdk17 + android-sdk + gradle | yes (`flutter` family includes `android-jdk21`) | `caelia/.github/workflows/ci.yml:61` |
| Windows build — `flutter build windows --release` | OS windows; Flutter + MSVC | yes-with-image — `flutter` family is Linux-only | `caelia/.github/workflows/ci.yml:110` |
| golden / widget / unit tests — `flutter test` + alchemist goldens | OS linux or windows; Flutter | yes | `caelia/.github/instructions/flutter.instructions.md` |
| perf gate on a real device | physical device (no device on hosted runners) | **no** — physical device | `caelia/.github/workflows/ci.yml:129` ("No device on GitHub runners") |
| API build + deploy | OS linux; node + docker + Cloud Run secrets | yes | `caelia/apps/api/Dockerfile`; `caelia/.github/workflows/deploy-api.yml:57` |
| iOS build | OS darwin; xcode | **no** | `caelia/AGENTS.md` (Flutter Android → iOS → Windows) |

## gta-nexus

Next.js panel + Hono gateway + worker, better-auth, Redis, Storybook, 155 Playwright E2E,
Docker compose, open-core licensing.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| monorepo build / lint / typecheck / test | OS linux; node22 | yes (`node24`) | `gta-nexus/.github/workflows/ci.yml:28`; `gta-nexus/package.json` `scripts.build` |
| E2E / browser — `pnpm --filter @nexus/web test:e2e` | OS linux; node + chrome (155 tests, Pixel 7 + 3440-wide viewports) | yes | `gta-nexus/package.json` `scripts.test:e2e`; `gta-nexus/docs/NEXUS.md` |
| Storybook build | node | yes | `gta-nexus/docs/NEXUS.md` (`@nexus/ui`, Storybook) |
| docker infra (Postgres, Redis) — `docker compose -f docker/compose.yaml up -d` | OS linux; docker + compose | yes | `gta-nexus/package.json` `scripts.infra:up` |
| worker / gateway / web docker images + deploy | linux; docker + secrets | yes | `gta-nexus/.github/workflows/deploy.yml:40`; `gta-nexus/apps/*/Dockerfile` |
| migrations (Drizzle) | node + Postgres | yes, needs DB access | `gta-nexus/package.json` `scripts.db:migrate` |

## dragoscatalin

Single Next.js portfolio package; hand-written UI; Lighthouse 100×4 gate; Playwright E2E.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| build / typecheck / lint | OS linux; node24; `next build` | yes (`node24`) | `dragoscatalin/package.json` `scripts.build`, `scripts.typecheck` |
| unit tests — `vitest run` | node + esbuild/sharp native | yes | `dragoscatalin/package.json` `scripts.test` |
| E2E / browser — `playwright test` | OS linux; node + chrome | yes | `dragoscatalin/package.json` `scripts.test:e2e` |
| Lighthouse gate — `node scripts/lighthouse-local.mjs` | OS linux; node + headless Chrome | yes | `dragoscatalin/package.json` `scripts.lh`; `dragoscatalin/.github/workflows/lighthouse.yml:16` |
| deploy (Vercel) | linux; node + Vercel token | yes, needs Vercel creds | `dragoscatalin/.github/workflows/ci.yml:22` |

## vmui

Local-first multi-cloud control plane: Next.js 16 + better-sqlite3 + ssh2 + ws, Drizzle
SQLite, Go CLI + Go cloud relay, QEMU/Hyper-V orchestration, ESP32/ESPHome firmware,
Playwright E2E, Docker.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| build / typecheck / lint / unit tests | OS linux; node24; **native modules** (better-sqlite3, ssh2, ws) | yes (`node24` builds native modules) | `vmui/package.json` `scripts.build`, `scripts.test`; `vmui/AGENTS.md` (serverExternalPackages) |
| E2E / browser — `playwright test` | OS linux; node + chrome + dev server on :3737 | yes | `vmui/package.json` `scripts.test:e2e` |
| Go CLI — `cli/go.mod` / `vmui-cli.exe` | Go compiler | **no** — no declared family ships Go | `vmui/cli/go.mod`, `vmui/cli/main.go` |
| Go cloud relay — `cloud/go.mod` | Go compiler + docker | **no** — no declared family ships Go | `vmui/cloud/go.mod` |
| ESP32 / ESPHome firmware build — ESPHome pinned 2026.10.2 | Python + ESPHome/PlatformIO + toolchain download | no CI family — a firmware lane, not a devcloud family | `vmui/firmware/README.md`; `vmui/.github/workflows/firmware.yml:27` |
| local-kvm provider (QEMU/QMP, Hyper-V, macOS VM) | nested virtualisation (machine class C4; c4d has **no** nested virt) | **no** on c4d — needs C4/N4D nested-virt class | `vmui/AGENTS.md`; `vmui/docs/devcloud/RESEARCH.md` §5 |
| image/container build — `Dockerfile`, `release-image.yml` | OS linux; docker | yes | `vmui/.github/workflows/release-image.yml:31`; `vmui/Dockerfile` |
| migrations (SQLite bootstrap + column-adds) | node + **single writer** (the SQLite file); `next build` evaluates the module in ~30 workers | yes, but one build per directory | `vmui/AGENTS.md` (`addColumnIfMissing`); `vmui/package.json` `scripts.db:push` |
| TV/Android app build | jdk + android-sdk | yes (`android-jdk21`) | `vmui/apps/android/build.gradle.kts` |

## notai

Next.js web + Yjs realtime server, Tauri desktop, Android + iOS mobile, Drizzle +
PostgreSQL, Docker.

| operation | needs | cloud-able today | evidence |
| --- | --- | --- | --- |
| build / lint / typecheck / test | OS linux; node22 | yes (`node24`) | `notai/.github/workflows/ci.yml:12`; `notai/package.json` `scripts.build` |
| a11y check — `a11y.yml` | OS linux; node + chrome | yes | `notai/.github/workflows/a11y.yml:18` |
| desktop build (Tauri) | OS windows (Windows legs run on `windows-2025`); rust + WebView2 | yes (`win-desktop`) | `notai/.github/workflows/release-desktop.yml:236` (`windows-2025`) |
| Android release | OS linux; jdk + android-sdk | yes (`android-jdk21`) | `notai/.github/workflows/release-mobile-android.yml:41` |
| iOS release | OS darwin; xcode | **no** | `notai/.github/workflows/release-mobile-ios.yml:42` (`macos-14`) |
| realtime server docker + deploy | linux; docker + secrets | yes | `notai/apps/realtime-server/Dockerfile`; `notai/.github/workflows/release-realtime.yml:46` |
| migrations (Drizzle) | node + Postgres | yes, needs DB access | `notai/package.json` `scripts.db:migrate` |

## cursuri (E:\gh\cursuri-studiai)

**No heavy operation.** The repository contains five markdown files under `sisteme/` and no
manifest of any kind; there is nothing to build, test or deploy.
Evidence: `cursuri-studiai/sisteme/{00-introducere,01-tipuri-aplicatii,02-arhitectura,03-tehnologii,04-ghid-decizie}.md`.

---

## Families that would have to be baked

The union of toolchain needs across the repositories, mapped onto the families declared in
`vmui/infra/devcloud/images/build.json` (`--toolchain` arguments) and defined in
`image-setup.sh` / `image-setup-win.ps1`.

| declared family | what it actually contains (evidence) |
| --- | --- |
| `node24` | node 24, pnpm 12, Chrome, pwsh 7, gh, Docker + compose, GitHub runner, warm pnpm store |
| `android-jdk21` | `node24` + Temurin 21 + Android SDK (platform/build-tools/NDK) |
| `rust-tauri-linux` | `node24` + rustup stable (clippy/rustfmt) + Tauri 2 Linux deps (webkit2gtk-4.1, appindicator, rsvg) |
| `rust-tauri-win` | `rust-tauri-linux` + `x86_64-pc-windows-msvc` + cargo-xwin + clang/lld/llvm + NSIS + JRE 21 + jsign + osslsigncode |
| `python-uv` | `node24` + uv (astral, `/usr/local/bin`) + `/opt/uv-python` shared CPython 3.12 + 3.13 |
| `flutter` | `android-jdk21` + Flutter stable |
| `polyglot` | `node24` + jdk + android + rust + python + flutter + warm store — i.e. **every declared layer, and no more** |
| `win-desktop` | Windows Server 2025: node 24, pnpm 12, pwsh 7, Rust msvc (rustfmt/clippy), VS 2022 Build Tools + Windows 11 SDK, CMake + NASM, WebView2, Chrome, gh, ripgrep, 7-Zip, actions runner |

Evidence: `vmui/infra/devcloud/images/build.json`; `vmui/infra/devcloud/images/image-setup.sh`
(header comment and `case "$TC"`); `vmui/infra/devcloud/images/image-setup-win.ps1` (header
comment); `vmui/docs/devcloud/ci-runners.md` (§Images).

### Repositories that no declared family can serve

| repository | missing | needed by | evidence |
| --- | --- | --- | --- |
| vmui | **Go** compiler | `cli/`, `cloud/` | `vmui/cli/go.mod`, `vmui/cloud/go.mod` |
| vmui | **ESPHome / PlatformIO** (+ ESP32 toolchain download) | firmware lane | `vmui/firmware/README.md`; `.github/workflows/firmware.yml` |
| vmui | nested-virtualisation machine class (C4/N4D; c4d has none) | `local-kvm` provider, macOS VM | `vmui/docs/devcloud/RESEARCH.md` §5 |
| titi | **darwin + Xcode** | iOS (`ios.yml`), desktop macOS | `titi/.github/workflows/ios.yml:25` |
| titi | **Tizen SDK + certificate** | Tizen TV package | `titi/AGENTS.md` / ADR-0008 |
| titi | `wasm32-unknown-unknown` target + `wasm-bindgen-cli` | `scripts/build-wasm.ps1` | `titi/scripts/build-wasm.ps1` |
| notai | **darwin + Xcode** | iOS release | `notai/.github/workflows/release-mobile-ios.yml:42` |
| brivio | **Go, PHP, .NET** SDKs (+ Java) | SDK release workflows | `brivio/.github/workflows/release-sdk-go.yml`, `release-php-sdk.yml`, `release-sdk-dotnet.yml`, `release-sdk-java.yml`; `brivio/packages/sdk-go/go.mod` |
| brivio | **darwin + Xcode** | iOS native | `brivio/.github/workflows/release-android.yml`; `brivio/apps/ios/core-build/build.gradle.kts` |
| HIDE | **Go, Java, .NET, PHP, Ruby** SDKs; **Rust nightly** (cargo-fuzz) | SDKs, fuzz | `HIDE/sdk/{go,java,dotnet,php,ruby}`; `HIDE/fuzz/Cargo.toml` |
| mmo | **Tizen SDK + webOS CLI + signing certificate** | TV packaging | `mmo/apps/tv-tizen/package.json` `scripts.package`, `scripts.package:webos`, `scripts.setup:cert` |
| mmo | **darwin + Xcode** | desktop macOS leg | `mmo/.github/workflows/native-release.yml:308` |
| caelia | **Flutter-on-Windows** (the declared `flutter` family is Linux) | `tool/verify.ps1` host, `flutter build windows` | `caelia/.github/workflows/ci.yml:27,110` |
| codai | **GPU lane** (H200/B200, Vertex) — not a CI family at all | training / eval | `codai/.github/copilot-instructions.md` |
| codai | **darwin (macOS) / arm64** release images | `release-codaid` matrix | `codai/.github/workflows/release-codaid.yml:145` |
| vitals | **darwin + Xcode** | iOS / macOS screenshots | `vitals/.github/workflows/ios-screenshots.yml:26` |

Two consequences worth naming:

- **`polyglot` is mislabelled relative to the research table.** `RESEARCH.md` §8 lists
  `polyglot-sdk` as "Go / .NET / PHP / JDK", but the actual `polyglot` case in
  `image-setup.sh` adds only jdk + android + rust + python + flutter + store — **no Go,
  .NET or PHP**. Anything that trusts the research table will be wrong about Go.
- **No family is `darwin`.** iOS/Xcode for titi, notai, brivio, mmo, vitals and codai is
  deliberately out of the declared set; the only macOS paths are the owner OSX-KVM VM
  (no Metal, no Xcode — ADR-0003) and hosted runners.

## Concurrency notes

Which operations can share one machine, and which cannot — each with the reason found in the
repository itself.

**Must have the machine to themselves**

- **vitals `rust` lane** — `dedicated: true`. Reason: the lane ends with the release
  performance budget; another heavy job moves the numbers and turns a healthy tree red.
  Measured 2026-11-24: the same gate member ran 21.3 s idle and 129.9 s under load.
  Evidence: `vitals/.devcloud/profile.json` lane `rust` `why`; ADR-0004 §Consequences
  (`vmui/docs/devcloud/ADR-0004-repo-profiles-and-placement.md`).
- **vitals `android` lane** — `dedicated: true`. Reason: the Gradle daemon outlives its
  client and keeps the job's inherited stdio open (which stopped the runner publishing an
  exit code on 2026-11-25); a second job in the same Gradle user home corrupts incremental
  state. Evidence: `vitals/.devcloud/profile.json` lane `android` `why`.
- **vitals `linux` lane** — `concurrency: 1`. Reason: `vitals-core` must compile where
  `vitals-win` does not, and a whole-workspace clippy is the most memory-hungry member of
  the run. Evidence: `vitals/.devcloud/profile.json` lane `linux` `why`.
- **Any Gradle build** (vitals, codai, brivio, mmo, titi, dashy, vmui Android lanes) —
  shared Gradle user home is the documented way to corrupt incremental state (same evidence
  as above). Keep one Gradle client per machine.
- **brivio a11y nightly** — runs on `devcloud-linux-32` (32 vCPU); it is sized for the whole
  machine. Evidence: `brivio/.github/workflows/a11y-nightly.yml:68`.
- **brivio test lane** — `turbo test --concurrency=6`; six parallel vitest workers plus the
  repo's property tests make it memory-bound. Evidence: `brivio/package.json` `scripts.test`.
- **vmui `next build` / SQLite migrations** — `next build` evaluates the DB module in ~30
  workers against one SQLite file, so a second build in the same directory races the file.
  Evidence: `vmui/AGENTS.md` (`addColumnIfMissing`).
- **codai / brivio / metu / mmo / notai migrations** — prod-DB writes; run one at a time
  and before the image that needs them. Evidence: `codai/.github/copilot-instructions.md`
  ("Migrations BEFORE images"); `mmo/AGENTS.md` ("db:migrate is a prod migration").

**Share only if a port is free**

Each of these pins a dev-server port, so two dev-server lanes of the **same** repository
collide, while different repositories can share a VM (their ports differ):

- metu web `:24890`, hub `:24891` — `metu/.github/copilot-instructions.md`.
- mmo web `:13789`, server `:17899` — `mmo/AGENTS.md`.
- money web `:3100` — `money/.github/copilot-instructions.md`.
- afti web `:23000` — `afti/AGENTS.md`.
- dragoscatalin `:24789` — `dragoscatalin/package.json` (`dev`, `start`).
- vmui app `:3737`, ssh bridge `:3738` — `vmui/AGENTS.md`.

**Can share freely**

- Node-only lint/typecheck/test lanes of different repositories, and any lane that declares
  `concurrency: 2` (e.g. vitals `checks` and `ts`) — ADR-0004 §Consequences: a lane declaring
  `concurrency: 2` may run beside another repository's fast lane.
- Firmware and native-module builds are separate toolchains but light on RAM; they can sit
  beside a Rust lane only if it is not vitals' Rust lane (see above).

**Cannot be placed on any shared machine at all**

- Physical-device work: dashy's Samsung S25 Ultra over wireless adb
  (`dashy/.github/instructions/android.instructions.md`), caelia's on-device perf gate
  (`caelia/.github/workflows/ci.yml:129`), and the ESP32 flashing flows in vmui firmware
  (WebSerial, `vmui/firmware/README.md`).
- Anything needing nested virtualisation (vmui `local-kvm`, Android emulators, macOS VM) —
  c4d has no nested virt. Evidence: `vmui/docs/devcloud/RESEARCH.md` §5.

## Unverified

Claims I could not source to a file in this pass:

- **money / afti Python test runner**: both use `uv` with committed `uv.lock`; I did not read
  their CI to confirm whether the Python suite runs on Linux only or also on macOS.
- **metu / notai / gta-nexus Playwright specifics**: the E2E scripts and workflow runner
  labels are confirmed, but the exact browser set and viewport matrices were not read.
- **codai arm64 release leg**: `release-codaid.yml:145` uses a `matrix.os` I did not expand,
  so the exact runner (macOS vs arm64 Linux) is inferred from the comment, not read.
- **mmo decks/keybpm/live Android apps**: additional Gradle projects exist under `apps/*`
  but I did not read each `build.gradle.kts`; they are assumed to share the Android toolchain.
- **Resource sizes for heavy lanes other than those stated**: only vitals (ADR-0004) and
  vmui (PLAN/ADR) state machine classes; the rest would need a measurement, not a reading.
