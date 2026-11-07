# Step AW stage F: palette (BCAT production blue on the dev UI)

Rule (Ryne, round 2, item 7): the dev layout, shell, components, typography, spacing and logo stay; the dev green
ACCENT family is replaced by BCAT Ops' production blue. Semantic colours (success green badges, red destructive,
amber, the status badge palette, whole-row board tones) are unchanged.

## Production source (origin/main, `src/index.css`)

| Role | Hex | main:line |
|---|---|---|
| Brand blue `--ds-blue`, `--primary`, `--ring` | `#1ea8f3` | 61, 100-102, 136-138 (dark) |
| Brand dark / pressed / link ink `--ds-blue-dark` | `#0369a1` | 62, 404, 415 |
| Brand tint `--ds-blue-bg` | `#e6f4fd` | 63, 405 |
| Brand gradient end (sidebar logo mark) | `#0b8fd9` | 381 |
| Active KPI tint | `rgba(30,168,243,0.04)` | 195-198 |
| Neutral surfaces: bg / border | `#f4f7fb` / `#e2e8f0` | 46, 52 |

Production has no separate hover token; production's blue text/active-nav ink is `--ds-blue-dark`.

## Mapping to the TMS tokens (`src/features/tms/theme.css`, the only place colour literals live)

| Token | Light | Dark |
|---|---|---|
| `--tms-primary` (fills, focus ring, tab underline, switch on) | `#0369a1` | `#1ea8f3` |
| `--tms-primary-hover` / pressed | `#075985` | `#52bbf6` |
| `--tms-primary-tint` and `--tms-surface-selected` | `#e6f4fd` | `#0f2a40` |
| `--tms-primary-ink` (links, active tab/nav text) | `#0369a1` | `#5cc0f7` |
| `--tms-on-primary` | `#ffffff` | `#0b1220` |
| `--tms-chart-1` / `-2` / `-10` | `#0b8fd9` / `#0369a1` / `#8fd0f7` | `#1ea8f3` / `#0b8fd9` / `#7cc9f5` |
| `--tms-chart-5` (was blue, now teal so it stays distinct from the new series 1) | `#14b8a6` | `#2dd4bf` |
| neutrals (bg, surface, hover, border, input-border, scrollbar) | production blue-slate: `#f4f7fb #f7f9fc #edf2f8 #e2e8f0 #cbd5e1` | unchanged (neutral grey) |

`vite.config.ts` manifest `background_color` follows `--tms-bg` (`#f4f7fb`; pinned by pwaColors.test).

## Deviations from "exact production hex" (needed for AA)

1. Production's brand `#1ea8f3` with white text is 2.7:1: it fails AA, so it cannot be the light primary button fill.
   Light uses production's own `--ds-blue-dark` `#0369a1` (5.93:1 with white) for fills, focus ring, links.
   `#1ea8f3` is kept as the DARK primary (6.72:1 against the `#181818` card) with dark ink text `#0b1220` on it (7.09:1).
2. Light `--tms-primary-hover` `#075985` is not a production token (production has none); it is the next step darker.
3. Dark `--tms-primary-ink` `#5cc0f7`, dark hover `#52bbf6`, dark tint `#0f2a40`, light chart-10, chart-5 teal are derived, picked for AA on the dark surfaces.
4. Light chart-1 uses production's gradient end `#0b8fd9` (3.53:1 on white) instead of `#1ea8f3` (2.7:1).
5. Light neutrals were hue-shifted from green-grey to production's blue-slate so the surfaces do not fight the blue accent.

## Contrast (`node scripts/contrastCheck.mjs`, gated by `scripts/contrastCheck.test.mjs`)

| theme | pair | fg | bg | ratio | floor | result |
|---|---|---|---|---|---|---|
| light | primary button text on fill | `#ffffff` | `#0369a1` | 5.93 | 4.5:1 | PASS |
| light | primary button text on hover fill | `#ffffff` | `#075985` | 7.56 | 4.5:1 | PASS |
| light | primary button fill vs card | `#0369a1` | `#ffffff` | 5.93 | 3:1 | PASS |
| light | link on card | `#0369a1` | `#ffffff` | 5.93 | 4.5:1 | PASS |
| light | link on page bg | `#0369a1` | `#f4f7fb` | 5.52 | 4.5:1 | PASS |
| light | active tab text (quick tab) on card | `#0369a1` | `#ffffff` | 5.93 | 4.5:1 | PASS |
| light | active tab underline vs card | `#0369a1` | `#ffffff` | 5.93 | 3:1 | PASS |
| light | tab count ink on tint | `#0369a1` | `#e6f4fd` | 5.29 | 4.5:1 | PASS |
| light | focus ring vs card | `#0369a1` | `#ffffff` | 5.93 | 3:1 | PASS |
| light | focus ring vs page bg | `#0369a1` | `#f4f7fb` | 5.52 | 3:1 | PASS |
| light | selected row text | `#111827` | `#e6f4fd` | 15.82 | 4.5:1 | PASS |
| light | link on selected row | `#0369a1` | `#e6f4fd` | 5.29 | 4.5:1 | PASS |
| light | chart series 1 vs card | `#0b8fd9` | `#ffffff` | 3.53 | 3:1 | PASS |
| light | disabled text on card (exempt) | `#9ca3af` | `#ffffff` | 2.54 | exempt | info |
| dark | primary button text on fill | `#0b1220` | `#1ea8f3` | 7.09 | 4.5:1 | PASS |
| dark | primary button text on hover fill | `#0b1220` | `#52bbf6` | 8.74 | 4.5:1 | PASS |
| dark | primary button fill vs card | `#1ea8f3` | `#181818` | 6.72 | 3:1 | PASS |
| dark | link on card | `#5cc0f7` | `#181818` | 8.74 | 4.5:1 | PASS |
| dark | link on page bg | `#5cc0f7` | `#232323` | 7.74 | 4.5:1 | PASS |
| dark | active tab text (quick tab) on card | `#5cc0f7` | `#181818` | 8.74 | 4.5:1 | PASS |
| dark | active tab underline vs card | `#1ea8f3` | `#181818` | 6.72 | 3:1 | PASS |
| dark | tab count ink on tint | `#5cc0f7` | `#0f2a40` | 7.25 | 4.5:1 | PASS |
| dark | focus ring vs card | `#1ea8f3` | `#181818` | 6.72 | 3:1 | PASS |
| dark | focus ring vs page bg | `#1ea8f3` | `#232323` | 5.95 | 3:1 | PASS |
| dark | selected row text | `#fafaf9` | `#0f2a40` | 14.10 | 4.5:1 | PASS |
| dark | link on selected row | `#5cc0f7` | `#0f2a40` | 7.25 | 4.5:1 | PASS |
| dark | chart series 1 vs card | `#1ea8f3` | `#181818` | 6.72 | 3:1 | PASS |
| dark | disabled text on card (exempt) | `#6b6b6b` | `#181818` | 3.33 | exempt | info |

Disabled controls are exempt from WCAG 1.4.3; the ratio is shown for information.

## Merged production pages

Production pages already read `var(--tms-*)` (Calendar, Dispatch/Planner, Appts, cash check-in, etc.), so they pick the blue
up with no class edits. A grep of `src` for the old green hexes and for tailwind green/emerald/lime utilities found none outside
`theme.css`. Remaining literals are data/identity colours (driver colours, ownership colours, email chrome, star gold), not the accent.

## Screenshots

`node scripts/devShotsPalette.mjs --out before|after` (BCAT_STACK=dev default) writes
`Docs/tms-build/screenshots/palette/<out>/` and `index.txt` (before/after pairs).
