# Changelog

All notable changes to vmui are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.0] - 2026-10-05

### Added

- MCP stream-lighting tools for TikSee and codai agents (WS21-01): `scene_list`, `scene_set` (curated scenes `party`, `calm`, `red_alert`, `gift_gold`, `rainbow`, `blackout_flash`, `default` with automatic restore) and `flash_color` (rgb or colour name, 1-5 flashes). Catalogue `STREAM_SCENES` in `src/lib/home/catalog.ts`.
- Home Assistant package `pi/ha-packages/vmui_stream.yaml`: `stream_scene_*` (mode: restart, newest wins) snapshot the RGB bulbs into `scene.stream_before` and restore them after the duration; strips go through HyperHDR priority 30 with self-expiry; `stream_flash` builds on `notify_flash`.
- Effect limiter for light effects (WS21-02, `src/lib/mcp/effect-limiter.ts`): per-key per-effect cooldown (flash 1.5 s, scene 10 s; `VMUI_EFFECT_COOLDOWN_{FLASH,SCENE}_MS`), burst merging (last call wins, one trailing run), `idempotencyKey` dedupe for 60 s. A limited call answers a non-error result `{ ok: true, limited: true, retryAfterMs, queued: true }`.
- API key scope preset `stream` (WS21-03): the eight stream tools, the RGB room lights as entity allow-list and the stream scripts; available in Settings → API keys and via `node scripts/mint-api-key.mjs <name> operator --preset stream`.

### Changed

- API key authentication looks a key up by `api_keys.lookup_id` (SHA-256 prefix of the token) and runs scrypt once, instead of against every non-revoked key. Keys minted before this release are found by the old scan once and backfilled.
- `scripts/mint-api-key.mjs` stores the lookup id and accepts `--preset stream` and `--rate`.
