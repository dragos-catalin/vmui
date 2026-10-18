# Vatra — brand

Version 1.0.0 · owner Dragos Catalin Vladulescu · source of truth for every surface (web, PWA, desktop, tray, kiosk).

Everything in `dist/` is generated. Change the generators in `scripts/`, never the outputs:

```powershell
node brand/scripts/tokens.mjs    # DTCG tokens, contrast pairs, dist/css/vatra-theme.css
node brand/scripts/motion.mjs    # dist/css/vatra-motion.css, animated SVGs, motion demo
node brand/scripts/export.mjs    # every icon/OG/tray asset, copied into the consumers
node $HOME/.claude/skills/brand-system/scripts/contrast-gate.mjs brand/contrast-pairs.json   # must exit 0
```

## Platform

- **Meaning.** _Vatra_ (Romanian: the hearth) is the heart of a house, the place where everything gathers. The
  product is the one place where the house and the machines are watched and controlled. **Vatra = a home whose
  hearth is lit.**
- **For whom.** One household that also runs its own machines: VMs across clouds, a home server, a desk PC, lights,
  screens, a kiosk. Private, local-first, never a SaaS.
- **Personality (this, not that).** Calm, not cold · warm, not cute · precise, not dense for its own sake · present,
  not loud · local, not folkloric.
- **Hybrid tone.** The control plane (instances, costs, ops, govern) is a calm control room: dense, mono for
  numbers, no exclamation marks. The house surfaces (/home, kiosk, desktop Casă) are the warm hearth: larger
  tiles, ember accents, a greeting in the evening. Same palette and mark everywhere; density and radius change
  through tokens.

### Voice

| Context               | EN                                               | RO                                            |
| --------------------- | ------------------------------------------------ | --------------------------------------------- |
| Success               | VM stopped. Saves €1.20/day.                     | VM oprit. Economisești 1,20 €/zi.             |
| Error                 | Couldn't reach Home Assistant. Retrying in 30 s. | Home Assistant nu răspunde. Reîncerc în 30 s. |
| Empty                 | No lights in this room yet.                      | Nicio lumină în camera asta încă.             |
| Greeting (house only) | Good evening.                                    | Bună seara.                                   |
| Destructive confirm   | Delete 3 snapshots? This can't be undone.        | Ștergi 3 snapshot-uri? Nu se poate anula.     |

Rules: sentence case; numbers before words; no emoji in UI copy; Romanian with correct comma-below ș ț and
„quotes”; second person singular in RO ("tu"), never "dumneavoastră".

### Naming

- Product: **Vatra** (capital V). Never "VATRA", never "vatra" in prose.
- Descriptor: "Vatra · home & machines" / "Vatra · casă și mașini" wherever the name appears alone in a public
  context, to avoid confusion with unrelated organisations of the same name.
- Technical identifiers stay `vmui` (repo, package, env vars `VMUI_*`, cookies `vmui_*`, API key prefix `vmui_*`,
  systemd units, MCP server id) — renaming them would break paired devices and saved keys for no user benefit.

## Mark

A house drawn as one continuous line (roof → chimney → roof), walls floating below it, a flame on the hearth and
smoke rising from the chimney. The smoke is the live part of the brand: it is the loader, the "thinking" state,
the tray's "something is on" signal and the splash intro.

Construction (`dist/logo/construction.svg`, 48-unit keyline grid):

- roof pitch 0.861 (40.7°); eaves overhang the walls by 5 units each side
- chimney's right edge sits on the right wall's axis
- roof and walls are separated by a gap ≥ 1 stroke (the "floating roof"); walls end with round caps
- the flame tip leans right, the same way the smoke drifts — the wind reads consistently
- smoke puffs shrink ×0.75 per step along a gently bending path
- optical centring: horizontally on the house axis (smoke trails off to the right), vertically lifted 2 %

Optical sizes (generated, never scaled):

| Size   | Use      | Stroke (of 48)   | Flame                   | Smoke                |
| ------ | -------- | ---------------- | ----------------------- | -------------------- |
| master | ≥ 64 px  | 4                | two-tone (ember + core) | 3 puffs              |
| small  | 24–48 px | 4.5              | single tone             | 2 puffs              |
| micro  | ≤ 20 px  | 6 (= 2 px at 16) | single, wider           | 1 puff, walls square |

Clear space: the height of the flame on every side. Minimum size: 16 px (micro). Colourways: dark, light,
mono white, mono black. Never: outline the flame, recolour the house, add a gradient, rotate, place the mark on a
busy photo without a tile.

Wordmark: "Vatra" in Inter Tight Bold, tracking −4.5 %. Lockup: mark at 1.15× cap height, gap = 0.5× mark.

## Colour

Authored in OKLCH (`scripts/tokens.mjs`), DTCG 2025.10 in `tokens/`, CSS in `dist/css/vatra-theme.css`.

- **Ember** (primary, h48): light `oklch(0.56 0.16 48)` with near-white text; dark `oklch(0.70 0.16 48)` with dark
  text. Deliberately deeper and more saturated than the clay hue used by a large AI vendor (h≈40, C 0.12).
- **Warm neutrals** (h55) — inherited from the desktop app's style.
- **Indigo** (h262) — secondary/accent: links, info, "cool" state.
- **Amber** (h78) — the "lit / on" state only (lights on, VM running on the house surfaces). Never decorative.
- Status: success h150, warning h75, danger h25, info h230.
- The Appearance settings still let a user pick another accent hue (`--accent-h`); ember is the default and the
  brand colour. Vibes remain presets on top.

Contrast policy: design with APCA, prove WCAG 2.2 AA. `contrast-pairs.json` holds all 70 shipped pairings (both
themes); the gate exits 0 (0 WCAG failures, 23 APCA advisories — mostly dark-mode muted text at Lc 57–60, which
is above WCAG AA at 7–9 : 1 and accepted).

## Typography

- UI: **Inter Variable** (OFL-1.1), display: **Inter Tight Variable** (OFL-1.1), both self-hosted via
  `@fontsource-variable/*` with `latin` + `latin-ext` subsets. Mono: system stack.
- Romanian glyph check (ă â î ș ț Ă Â Î Ș Ț, comma-below, not cedilla): see `brand.json → fonts[].verifiedGlyphs`.
- Numbers in tables and stats use `tabular-nums`.

## Motion

UI motion tokens (`tokens/motion.tokens.json`): instant 80 · fast 140 · base 220 · slow 360 · page 420 ms;
ease-out `(0.16, 1, 0.3, 1)`, in-out `(0.65, 0, 0.35, 1)`, emphasized `(0.2, 0, 0, 1)`; springs default
(380/32/0.9) and soft (220/28/1).

Logo motion (`scripts/motion.mjs` → `dist/css/vatra-motion.css`, demo `dist/motion/demo.html`), all on the
`.vt-mark[data-state]` element, every state ending on the static mark:

| State       | Behaviour                                                                             | Where                                     |
| ----------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| intro       | roof and walls draw, the flame ignites with overshoot, puffs pop in sequence (1.15 s) | web cold-start splash, desktop splash     |
| thinking    | smoke rises and fades in a 2.1 s loop (rising wisp), flame breathes                   | NavProgress, loading states, desktop busy |
| success     | flame flares, a puff leaves and re-forms                                              | toasts after long actions                 |
| error       | smoke fades out, flame gutters to an ember                                            | error states                              |
| hover/press | one rising puff, press scales to 0.94                                                 | sidebar brand, title bar                  |
| idle        | slow flame breathing (opt-in)                                                         | kiosk                                     |
| morph       | splash mark flies into its place in the sidebar / title bar                           | web (Motion `layoutId`), desktop (FLIP)   |

`prefers-reduced-motion` and the in-app "reduce motion" setting turn every animation off; the static mark shows.

## Assets (generated)

- Web: `favicon.ico` (16/32/48), `favicon.svg` (light/dark media query), `apple-touch-icon.png` 180,
  `icon-192/512.png`, `icon-maskable-192/512.png` (80 % safe zone), `badge-96.png` (mono, Android push),
  `og-1200x630.png`.
- Windows/Tauri: `icon.ico` (16/20/24/32/40/48/64/128/256), PNG set, MSIX Square\* logos.
- Tray: `ok / warn / down / active` × `dark / light` taskbar × 16/20/24/32/40/48 px (+ multi-size `.ico`).

## Changelog

- **1.0.0** (2026-10-18) — first brand: name Vatra (was vmui), house-with-chimney mark with flame and smoke,
  ember palette on warm neutrals, Inter / Inter Tight, logo motion set, full export pipeline.
