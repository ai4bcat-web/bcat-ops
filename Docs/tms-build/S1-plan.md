# Step S1 — tokens + component kit + app shell + company dashboard (the green admin)

Spec: `REDESIGN_UI_REFERENCE.md` §1 tokens, §2 shell anatomy, §3 kit, §6 gate, §7 shell details.
Scope of S1: re-skin the `/tms/*` shell (`TmsLayout` → `TmsShell`, `theme.css`) and convert the
company dashboard (`/tms/dashboard`). Legacy shell (`AppLayout`/`NavBar`/`Topbar`, `src/index.css`)
is S3 and is NOT touched. Every other `/tms/*` page re-skins automatically through the re-tokened
`--tms-*` variables but is only smoke-checked in S1; its real conversion is S2.
Hard rules (`TMS_BUILD_BRIEF.md`): branch `dev` only; `npm run typecheck && npm run lint && npm run test` green;
commit; one push, one deploy (wait for the Amplify job); STOP after the screenshots for Ryne's review (§6 gate).

Reference images consulted: `dashboard-trucking.jpg`, `user-overview-admin.jpg`, `financial-operations-admin.jpg`.
What they fix: white 14px-radius cards on a flat grey-green canvas; sidebar and top bar are separate floating
cards; active nav item = solid green pill, white text/icon; bell sits in the top-bar card with an amber count
badge; KPI = icon+label, 24–28px bold number, green/red delta with arrow + muted "vs last month"; charts are
green → dark green → black with a dark tooltip; status pills are tinted with matching ink.

---------------------------------------------------------------------------------------------------

## 1. Decisions

### D1. Re-token the existing `--tms-*` names; light is the default; dark kept as an override
* Every existing variable name stays (`--tms-bg`, `--tms-card`, `--tms-text`, `--tms-primary`, `--tms-badge-*`,
  `--tms-radius`, …). Only the values change, so the ~150 `var(--tms-border)`, ~138 `var(--tms-badge-red)`,
  ~134 `var(--tms-radius)` etc. already used inline by TSX pages re-skin at once. No TSX page is edited in S1.
* Light values live on the existing `.tms-shell, .tms-portal` block (default). Dark values live on
  `:root[data-tms-theme='dark'] .tms-shell, :root[data-tms-theme='dark'] .tms-portal` (specificity 0,3,0 beats the
  default). The attribute is on `<html>`, not on `.tms-shell`, because `.tms-portal` content (Radix dialogs,
  dropdowns, sheets, sonner) renders into `document.body`, outside `.tms-shell`, and must follow the theme too.
* Persisted toggle: `localStorage['tms-theme']` = `'light' | 'dark'`; absent/unknown = `'light'`. `useTmsTheme()`
  (new `src/features/tms/tmsTheme.ts`) sets/removes `data-tms-theme` on `document.documentElement` in a layout effect
  and **removes it on unmount**, so the legacy app is untouched outside `/tms/*`.
* `theme.scope.test.ts` still enforces scope, with one allowed prefix (`:root[data-tms-theme='dark'] `) because the
  dark selector must start at `:root`. A selector must still contain `.tms-shell` or `.tms-portal` as the first
  compound after that prefix, so nothing can leak onto legacy pages.
* Both blocks set `color-scheme` (`light` / `dark`) so native controls and scrollbars follow.
* Yellow `#f4c50c` is retired from the shell in both themes: dark keeps its dark neutrals but takes the same green primary.
  (Known leftovers that hard-code yellow in TSX and stay until S2: `TrackingDetailMap.tsx`, `BoardMapView.tsx`
  map strokes. `ownership.ts` division `color` is data and is not changed.)

### D2. Token table (names are the contract between slices A/B/C)
Values in parentheses are "tune by eye against the screenshots"; names are not negotiable.

| Token | Light (default) | Dark (override) | Note |
|---|---|---|---|
| `--tms-bg` | `#F3F6F4` | `#232323` | app canvas |
| `--tms-sidebar` | `#FFFFFF` | `#0E0E0E` | sidebar card |
| `--tms-topbar` | `#FFFFFF` | `#181818` | top-bar card |
| `--tms-card` | `#FFFFFF` | `#181818` | |
| `--tms-card-body` | `#FFFFFF` | `#232323` | |
| `--tms-bg-elevated` | `#FFFFFF` | `#2A2A2A` | used by 6 TSX spots; was undefined |
| `--tms-surface` | `#F7F9F8` | `#1D1D1D` | subtle fill (strip pills, heading hover); **was undefined** (dashboard.css) |
| `--tms-surface-subtle` | `#F7F9F8` | `#1B1B1B` | **was undefined** (1 TSX use) |
| `--tms-surface-hover` | `#EEF3F0` | `#2A2A2A` | row/nav/icon hover; **was undefined** (theme.css 1931, DispatchWorkstation) |
| `--tms-surface-selected` | `#E8F7EF` | `#123524` | selected row; **was undefined** |
| `--tms-border` | `#E6EAE8` | `#383838` | |
| `--tms-input` | `#FFFFFF` | `#383838` | input fill |
| `--tms-input-border` | `#D5DBD8` | `#656565` | |
| `--tms-text` | `#111827` | `#FAFAF9` | |
| `--tms-text-2` | `#4B5563` | `#D4D4D4` | secondary ink (new) |
| `--tms-muted` | `#6B7280` | `#A7A7A7` | |
| `--tms-disabled` | `#9CA3AF` | `#6B6B6B` | new |
| `--tms-primary` | `#1DB36A` | `#1DB36A` | fills, borders, focus ring |
| `--tms-primary-hover` | `#169A5A` | `#25C97A` | replaces hard-coded `#ffd222` |
| `--tms-primary-tint` | `#E8F7EF` | `#123524` | active child row, tint pills |
| `--tms-primary-ink` | `#15803D` | `#4ADE80` | **text** in green (links, add-filter, picker btn) |
| `--tms-on-primary` | `#FFFFFF` | `#FFFFFF` | |
| `--tms-destructive` | `#DC2626` | `#E5484D` | replaces `hsl(349 67% 39%)` |
| `--tms-destructive-hover` | `#B91C1C` | `#F0616A` | |
| `--tms-on-destructive` | `#FFFFFF` | `#FFFFFF` | replaces literal `#fff` (line 624) |
| `--tms-radius` | `10px` | same | inner cards, controls (was `0.4rem`) |
| `--tms-radius-card` | `14px` | same | new — cards, sidebar, top bar, dialogs |
| `--tms-radius-sm` | `8px` | same | new |
| `--tms-radius-pill` | `999px` | same | new |
| `--tms-gap` | `16px` | same | grid gap (new) |
| `--tms-gutter` | `24px` | same | page padding (new) |
| `--tms-pad` | `20px` | same | card padding (new) |
| `--tms-shell-gap` | `16px` | same | space around the floating sidebar/top-bar cards (new) |
| `--tms-sidebar-w` | `248px` | same | was 175px |
| `--tms-sidebar-collapsed-w` | `76px` | same | was 56px |
| `--tms-topbar-h` | `56px` | same | was 38px |
| `--tms-row-h` / `--tms-control-h` | `44px` / `40px` | same | unchanged |
| `--tms-shadow` | `0 1px 2px rgba(16,24,40,.04)` | `none` | card |
| `--tms-shadow-pop` | `0 12px 40px rgba(16,24,40,.12)` | `0 12px 40px rgba(0,0,0,.45)` | menus (replaces 4 hard-coded `rgba(0,0,0,.45)`) |
| `--tms-shadow-modal` | `0 24px 60px rgba(16,24,40,.18)` | `0 24px 60px rgba(0,0,0,.55)` | dialog (line 1251) |
| `--tms-overlay` | `rgba(17,24,39,.45)` | `rgba(0,0,0,.6)` | dialog overlay (line 1235) |
| `--tms-scroll-track` / `-thumb` / `-thumb-hover` | `#F3F6F4` / `#CBD5D1` / `#AEB9B4` | `#1B1B1B` / `#4A4A4A` / `#5D5D5D` | replaces hexes at lines 106–119, 1321, 1325 |
| `--tms-count-bg` / `--tms-count-ink` | `#F5A524` / `#422006` | same | bell + attention counts (reference amber badge); replaces `--tms-badge-orange` bg + `#1a0408` (lines 362, 443, 1453, 2214) |
| `--tms-tooltip-bg` / `--tms-tooltip-ink` | `#111827` / `#F9FAFB` | `#0E0E0E` / `#FAFAF9` | dark chart tooltip in both themes |

Semantic accent + tint pairs. `--tms-badge-X` is now the **accent / ink** (legible as text and border on white and on its own tint — the 138 TSX
uses of `--tms-badge-red`/orange/green are text or border colours, verified: no TSX uses them as a `background`). `-tint` is the pill/background.

| Tone | `--tms-badge-X` light / dark | `--tms-badge-X-tint` light / dark |
|---|---|---|
| green | `#15803D` / `#4ADE80` | `#E8F7EF` / `#123524` |
| orange (amber) | `#B45309` / `#FBBF24` | `#FFF4D6` / `#3A2A08` |
| red | `#B91C1C` / `#F87171` | `#FDE8E8` / `#3B1212` |
| blue | `#1D4ED8` / `#60A5FA` | `#E6F0FF` / `#10233F` |
| purple | `#6D28D9` / `#A78BFA` | `#EFE7FD` / `#2A1B4D` |
| pink | `#BE185D` / `#F472B6` | `#FCE7F6` / `#3B1230` |
| turquoise | `#0E7490` / `#22D3EE` | `#DDF6F8` / `#0B2E33` |
| gray | `#4B5563` / `#A7A7A7` | `#F3F4F6` / `#2A2A2A` (pill gets a `1px solid var(--tms-border)` outline) |

`.tms-badge-X { background: var(--tms-badge-X-tint); color: var(--tms-badge-X); }` — this is the whole "Pill" component of the
spec: **`TmsBadge` restyled, no new `TmsPill`** (it is already status/role/tag; gray = neutral outline chip).

Whole-row board tones (R2, theme.css 1413–1430) move into the token blocks (dark = today's values, unchanged):

| Row token (`--tms-row-X` / `-text`) | Light bg / ink |
|---|---|
| delivered | `#E8F7EF` / `#14532D` |
| dispatched | `#FFEDD5` / `#9A3412` |
| departed | `#DBEAFE` / `#1E3A8A` |
| arrived | `#E0F2FE` / `#075985` |
| covered | `#FDE7DA` / `#7C2D12` |
| open | `#F3F4F6` / `#374151` |
| hold | `#FEF3C7` / `#92400E` |
| reserved | `#EDE9FE` / `#5B21B6` |
| voided | `#F3F4F6` / `#9CA3AF` |

Chart palette (new tokens, consumed by `ChartCard.tsx` as `var(--tms-chart-N)`):

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| light | `#1DB36A` | `#0F5C3A` | `#111827` | `#F5A524` | `#3B82F6` | `#8B5CF6` | `#EF4444` | `#06B6D4` | `#9CA3AF` | `#86D9AE` | `#D97706` | `#2563EB` |
| dark | `#25C97A` | `#1B8A5A` | `#E5E7EB` | `#FBBF24` | `#60A5FA` | `#A78BFA` | `#F87171` | `#22D3EE` | `#9CA3AF` | `#4ADE80` | `#F59E0B` | `#93C5FD` |

Plus `--tms-chart-axis: var(--tms-muted)` and `--tms-chart-grid: var(--tms-border)`. (Green → dark green → near-black first three =
the reference's segmented bars; the rest keeps 12 distinguishable series because the dashboard groups by division/rep/customer/carrier.)

Type: base Inter (weights 400/500/600 already loaded in `index.html`; **add 700** to the Google Fonts URL for KPI numbers). `h1`/page
title `22px/600` (was 28/400); card title `14px/600`; KPI number `26px/700`; table `13px`; section labels `12px/500` uppercase +0.04em.

### D3. Hard-coded values that must become tokens (exact list)
`theme.css` (line numbers are pre-change):

| Lines | Literal | Becomes | Owner |
|---|---|---|---|
| 106, 119, 1321 | `#1b1b1b` | `var(--tms-scroll-track)` | A |
| 110, 119, 1325 | `#4a4a4a` | `var(--tms-scroll-thumb)` | A |
| 115 | `#5d5d5d` | `var(--tms-scroll-thumb-hover)` | A |
| 595 | `#ffd222` | `var(--tms-primary-hover)` | A |
| 607 | `#444` | `var(--tms-surface-hover)` | A |
| 624 | `#fff` | `var(--tms-on-destructive)` | A |
| 646 | `#4a4a4a` (icon btn hover) | `var(--tms-surface-hover)` | A |
| 660, 674 | `#262626`, `#2c2c2c` | `var(--tms-surface-hover)` | A (660 is in `.tms-icon-btn-sq:hover`) |
| 871 | `#fff` (quick-tab active) | `var(--tms-text)` | A |
| 944, 1491, 1715, 1878, 2102 | `#1d1d1d` | `var(--tms-surface-hover)` | A |
| 1038 | `#3f3f3f` | `var(--tms-surface-hover)` | A |
| 1178 | `#121212` (badge ink) | per-tone `var(--tms-badge-X)` | A |
| 1204 | `#fff` (purple badge) | per-tone ink | A |
| 1235 | `rgba(0,0,0,.6)` | `var(--tms-overlay)` | A |
| 1251 | `0 24px 60px rgba(0,0,0,.55)` | `var(--tms-shadow-modal)` | A |
| 1487, 1693, 1857 | `0 12px 40px rgba(0,0,0,.45)` | `var(--tms-shadow-pop)` | A |
| 1413–1430 | 18 `--tms-row-*` hexes | moved into token blocks (light/dark values above) | A |
| 1453, 2214 | `#1a0408` + orange bg | `var(--tms-count-ink)` / `var(--tms-count-bg)` | A |
| 2047–2048 | `#fff` border, `rgba(0,0,0,.45)` shadow (map marker) | `var(--tms-card)`, `var(--tms-shadow-pop)` | A |
| 2090, 2091 | `rgba(27,167,116,.12)`, `rgba(237,90,118,.12)` | `var(--tms-badge-green-tint)`, `var(--tms-badge-red-tint)` | A |
| 2118 | `#052814` | `var(--tms-on-primary)` | A |
| 2129 | `rgba(255,136,10,.10)` | `var(--tms-badge-orange-tint)` | A |
| 2162, 2229 | `rgba(237,90,118,.10/.12)` | `var(--tms-badge-red-tint)` | A |
| 2177 | `rgba(244,197,12,.08)` | `var(--tms-primary-tint)` | A |
| 208, 240, 376, 381, 407, 362, 443 (+660 neighbours in the sidebar block) | `#767676`, `#141414`, `#1c1c1c`, `#1a0408` … | all inside the sidebar/top-bar block, which B rewrites in `shell.css` | B |
| 1083–1121 "Chart card" section | `--tms-bg`/`--tms-card` on a 6px dark card | rewritten in `kit/kit.css` | C |

Also (A): `.tms-shell a`, `.tms-add-filter`, `.tms-fields-btn` (theme.css) and (C) `.tms-dash-picker-btn` (dashboard.css) use `color: var(--tms-primary)` for **text** → switch to
`var(--tms-primary-ink)` (white-on-green and green-on-white are both ≈2.6:1; ink `#15803D` is ≈5:1). Fills/borders/focus ring keep `--tms-primary`.
`dashboard.css` has no literals; it only references the undefined `--tms-surface` (now defined in D2).
`ChartCard.tsx` literals (`SERIES_COLORS`, `AXIS #a7a7a7`, `GRID #383838`, pie `stroke="#232323"`) → `var(--tms-chart-N)`, `var(--tms-chart-axis)`,
`var(--tms-chart-grid)`, `var(--tms-card)` (C). SVG presentation attributes accept `var()` in all current browsers; verify in the screenshot and fall back to
`style={{ stroke, fill }}` if any series renders black.

Enforcement: a new invariant test (§5) fails if any CSS file under `src/features/tms/` contains a colour literal outside the two token blocks
(allowed: `transparent`, `currentColor`).

### D4. Company switcher semantics (least risky)
Sections are per-division today and permission-gated; nothing may be hidden or re-gated. So the switcher is a **scope preference**, not a
permission or data switch:
* Options = the user's visible business sections (`sections` minus `COMPANY`), named by the division `name` (BCAT Logistics / Ivan Cartage / Best Care
  Auto Transport). Preceded by **"All businesses"** (default; today's behaviour exactly). With fewer than 2 options the card is static (no menu).
* Choosing business X (a) persists `localStorage['tms-company'] = X`; (b) in the sidebar, X's section is expanded and the other business sections are
  **collapsed to their header** (one click re-expands; the `COMPANY` group and the pinned items are always shown); (c) the company dashboard opens
  filtered to X (identical to clicking that business's strip heading today: `filters.divisions = [X]`) and re-filters live if you switch while on it;
  (d) the org card shows X's name and initials. **No navigation, no route change, no permission change, no query change.** The Shipments board and every
  other page are unaffected.
* Choosing "All businesses" clears the preference and reverts (a)–(d).
* A stored code that is no longer an option (division removed/deactivated) is treated as "All businesses" by the shell; the dashboard filter chip
  still shows the stale code and the existing "Clear filters" resets it (accepted, rare; see Risks).
* Store: new `src/features/tms/tmsCompany.ts` — module-level external store (`useSyncExternalStore`) so `TmsShell` and `DashboardPage`, which are separate
  components, stay in sync without a prop path through `<Outlet/>`.

### D5. Bell with count — honest S1 behaviour (drawer is S4 item 6)
The bell is a **link to the existing Check calls page** (`/tms/check-calls`, route already in `App.tsx`) and its badge is the **real count of check
calls due or overdue** — `useCheckCallWorklist().dueCount`, the same number the legacy sidebar badge, the page and the notifier Lambda use (one
`checkCallState` function). Hidden at 0. `aria-label`: `Check calls due: N` (or `Check calls` at 0). S4 replaces the link with the exceptions drawer and widens
the count; S1 never fakes a figure and the control is never inert. Enabled for owner/admin or `hasPageAccess('loads')`/`'tms'` (same gate as the legacy rail).

### D6. Shell controls: every rendered control must work
Removed as inert placeholders: sidebar-foot Bell/Moon/Chat/CircleUser; top-bar Monitor ("Display"), Zap ("Quick actions"), History. Kept/new, all functional:
search (ctrl/cmd+K, existing), **bell** (D5), **help** (links to `/tms/academy`, the existing in-app guide), **theme toggle** (D1; icon Moon in light / Sun in dark;
`aria-label` `Switch to dark theme` / `Switch to light theme`), **user card + Log out** in the sidebar foot (calls `useAuth().logout` — `logout: () => Promise<void>`
already exists in `src/hooks/useAuth.ts`, same function `NavBar` uses), collapse button (existing, same `tms-sidebar-collapsed` key and aria-labels).

### D7. Tracking group with live children and count
Tracking stays where it is (child of Shipments: Active Shipments / Dispatch / Tracking / Documents / Views) — no new route, no second Tracking entry. The
**Tracking child** gets a green count badge (= shipments currently moving) and, like the reference's "ID45216 · 3 loads", an own caret that expands to
the most recently updated moving shipments (max 6; PRO number + muted customer; link `/tms/shipments/<id>`). Moving = `row.loadStatus ∈ MOVEMENT_STATUSES`
(`src/lib/brokerageCharts.ts`) and not voided — the same definition the dashboard's "Tracked" metric uses. Computed in `TmsLayout` from the `useShipments`
call it already makes (no new query).

### D8. Kit scope for S1 — minimal set
Needed by the shell + converted dashboard, built now:
* **`TmsKpiCard`** (icon + label, big value, delta chip with sign/tone + "vs last month", optional `sub`). Also replaces the dashboard's old `.tms-kpi*` tiles
  (`ChartCard` renders `series.kpis` with it) so there is one KPI look, not two.
* **`TmsCountBadge`** (nav, Tracking group, bell).
* **`TmsChartCard`**: restyle + optional `icon` prop. **`TmsPage`**: optional `eyebrow` prop (welcome row above the title).
* **Pill = `TmsBadge` restyled** (no new component).
Explicitly NOT built in S1 (no S1 consumer; built when the stage that needs it starts, per "build once, when first needed"):
`StatRow` (the existing `tms-grid tms-grid-4` already is a 4-card row; a wrapper would be weightless), `SegmentedTabs` (first consumer: S2 customer/carrier lists),
`Timeline` (S2 shipment status history), `ApprovalCard`, `DetailSplit`/`DocumentPreview`/`MetaList`, `ProfileHeader`, `SegmentedBar`, `Gauge`, `PillBarChart`,
`Modal/Drawer`/`ReceiptDetail`, `DataTable` restyle (S2; table CSS is re-tokened in S1 so existing tables are readable), the D/W/M period toggle on KpiCard (S4 Expenses/User overview).
The dashboard uses none of SegmentedBar/Gauge (its charts are recharts bar/line/pie/table cards, restyled).

### D9. Deltas ("+40.93% ↗ vs last month")
`TmsKpiCard` fully supports a delta. The S1 dashboard does **not** pass one: the dashboard loads one pickup window per query (`useBrokerageDashboard(filters)`),
and a delta needs a second, previous equal-length window read (10 more parallel reads, cached 5 min per window). That is new data behaviour, not look, so S1 shows
the real figure plus a factual `sub` line (e.g. "18.4% margin", "12 shipments") and no invented delta. To add later: call `useBrokerageDashboard(previousWindow(filters))`
and pass `delta={{ pct }}` — no kit change. Flag this to Ryne at the review gate.

### D10. KPI strip on the dashboard (4 cards, from existing data)
New pure helper `buildCompanyTotals(data, filters)` in `businessStrips.ts` (reusing the private `stripValues`) computed over **all** filtered rows — **not** the sum of
the per-business strips, because shipments with no division tag fall in no strip and would be silently dropped. Cards:

| Card | Icon | Value | `sub` |
|---|---|---|---|
| Revenue | `CircleDollarSign` | `formatCents(revenueCents)` | `${shipmentCount} shipments` |
| Profit | `TrendingUp` | `formatCents(profitCents)` | `${(marginBps/100).toFixed(1)}% margin` |
| Open AR | `ReceiptText` | `formatCents(arOpenCents)` | `outstanding invoices` |
| Open AP | `Wallet` | `formatCents(apOpenCents)` | `outstanding carrier bills` |

Unknown = `null` → `—` (the existing honesty rule: "no data" is never `$0.00`). Tracked/PODs stay in the per-business strips (unchanged data).
The per-business strips stay (they are the click-to-filter control and the subdivision breakdown) and are restyled as cards; class names unchanged.

### D11. Page-level look decisions
* Floating shell: sidebar and top bar are white cards (`--tms-radius-card`, 1px `--tms-border`, `--tms-shadow`) inset `--tms-shell-gap` from the viewport edges; `.tms-content` is
  transparent on the canvas; `.tms-main` padding `var(--tms-gutter)` (24px).
* Dashboard order: eyebrow Welcome → page title row (title left; Views select, Refresh/Clear/Save icon buttons, "N charts" picker, **Export CSV as primary green button** right) → filter row →
  KPI strip (4) → error/loading → business strips → chart grid. Chart grid: `grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr))`, gap `--tms-gap`;
  cards with `def.kind === 'table'` span the full row (`tms-chart-wide`). Card height 360px (was 410).
* Breadcrumb replaces the top-bar page title (D12). The page's own `TmsPage` title row stays (22/600), so the spec's "Page header row" is satisfied without touching other pages.

### D12. Breadcrumb
`tmsPageTitle()` is **removed** (clean cutover; only `TmsLayout` and its test used it) and replaced by `tmsBreadcrumb(pathname, shipmentViews?)` in `src/lib/navSections.ts` returning
`TmsBreadcrumbItem[] = { label: string; to?: string }[]` (the last item has no `to`). The shell renders `[grid-icon → /tms/dashboard] / crumb / crumb`, last crumb green
(`.tms-crumb-current`, `aria-current="page"`). Rules (also fixes today's `tmsPageTitle('/tms/dispatch') === 'TMS'`):
* longest-matching nav item from `PINNED_ITEMS`/`TMS_ITEMS` → first crumb `{label, to}`;
* Shipments workstation children `/tms/dispatch`, `/tms/tracking`, `/tms/documents`, `/tms/check-calls` → `[Shipments (to /tms/shipments), Dispatch|Tracking|Documents|Check calls]`; `/tms/tracking/links` → `[Shipments, Tracking (to /tms/tracking), Manage links]`;
* `/tms/shipments/view/<slug>` → `[Shipments (to), <view name from shipmentViews, else titleCase(slug)>]`; `/tms/shipments/<id>` → `[Shipments (to), Shipment]`;
* any other deeper path → item crumb (linked) + one trailing crumb: titleCase of the first segment below the item if it contains no digit, else `Details`;
* a path matching nothing → `[{label:'TMS'}]`. Two levels is enough (no business-name prefix; it would need the divisions list and adds no navigation).

---------------------------------------------------------------------------------------------------

## 2. File-by-file change list

### New files
| File | Slice | Purpose |
|---|---|---|
| `src/features/tms/tmsTheme.ts` (+ `tmsTheme.test.ts`) | A | `readTmsTheme`, `useTmsTheme`, `TMS_THEME_KEY` |
| `src/features/tms/kit/TmsCountBadge.tsx` (+ `.test.tsx`) | A | count pill |
| `src/features/tms/shell.css` | B | all sidebar/top-bar/content-frame rules (moved out of theme.css and rewritten) |
| `src/features/tms/tmsCompany.ts` (+ `tmsCompany.test.ts`) | B | switcher preference store |
| `src/features/tms/kit/TmsKpiCard.tsx` (+ `.test.tsx`) | C | KPI card |
| `src/features/tms/kit/kit.css` | C | kit-only rules: KPI card, eyebrow, chart card (moved from theme.css) |
| `src/features/tms/dashboard/WelcomeHeader.tsx` | C | avatar + "Welcome back, <first name>!" |

### Modified files
| File | Slice | Change |
|---|---|---|
| `src/features/tms/theme.css` | A | token blocks (light + dark), D3 literal sweep, base typography (`h1` 22/600), `.tms-btn*`, `.tms-icon-btn*`, inputs, `.tms-page*`, tables, empty state, footer, cards (14px radius, `--tms-pad`), tabs, badges (tint pills), portal surfaces (dialog `background: var(--tms-card)`, radius card, `--tms-overlay`, `--tms-shadow-modal`), `.tms-count-badge*`. **Deletes** (a) lines 122–550 "Sidebar" + "Content column + top bar" blocks and (b) the shell rules inside the `@media (max-width:900px)` block (`.tms-sidebar`, `.tms-content`, `.tms-nav-label/-badge/-caret/-children`, `.tms-search`) — B re-creates them in `shell.css`; (c) the "Chart card" section (1083–1121) — C re-creates it in `kit.css`. Keeps `.tms-icon-btn-sq` (kit button). |
| `src/features/tms/theme.scope.test.ts` | A | §5 |
| `index.html` | A | add `wght@700` to the Inter font URL (one token) |
| `src/features/tms/TmsShell.tsx` | B | new anatomy; imports `./theme.css`, `./shell.css`; **imports kit files directly (`./kit/TmsCountBadge`), never the `./kit` barrel — the barrel re-exports `TmsShell`, which would create an import cycle** |
| `src/features/tms/TmsLayout.tsx` | B | breadcrumb, companies, logout, bell count, tracked loads; drop `pageTitle` |
| `src/lib/navSections.ts` | B | `tmsBreadcrumb` (replaces `tmsPageTitle`), `companyOptions`, export `COMPANY_DIVISION = 'COMPANY'` |
| `src/lib/navSections.test.ts`, `src/features/tms/TmsShell.test.tsx`, `src/features/tms/TmsLayout.test.tsx`, `src/features/tms/brokerage/DemoPage.test.tsx` | B | §5 retargets |
| `src/features/tms/kit/TmsChartCard.tsx` | C | optional `icon?: LucideIcon` rendered before the title; rest unchanged (props `onFilter/onNumbers/onTable/onExpand/menu` same) |
| `src/features/tms/kit/TmsPage.tsx` | C | optional `eyebrow?: ReactNode` rendered as `<div className="tms-page-eyebrow">` above `.tms-page-head` |
| `src/features/tms/kit/index.ts` | C | `import './kit.css'`; export `TmsKpiCard` (+`TmsKpiCardProps`) and `TmsCountBadge` (+`TmsCountBadgeProps`) |
| `src/features/tms/dashboard/DashboardPage.tsx` | C | layout of D11, KPI strip, Welcome, company preset, Export CSV primary button |
| `src/features/tms/dashboard/ChartCard.tsx` | C | CSS-variable colours; kpis via `TmsKpiCard`; icon + `tms-chart-wide` for `kind==='table'`; pie stroke token |
| `src/features/tms/dashboard/dashboard.css` | C | restyle (cards, strips, grid); delete `.tms-kpi*`/`.tms-kpi-strip` rules (only `ChartCard` used them) |
| `src/features/tms/dashboard/businessStrips.ts` (+ `.test.ts`) | C | `buildCompanyTotals` |
| `src/features/tms/dashboard/DashboardPage.test.tsx` | C | add the company-preset test; reconcile any duplicate-text query |

### Untouched on purpose
`src/index.css`, `AppLayout`/`NavBar`/`Topbar` (S3); `buildNavSections` and its legacy consumers (`NavBar`, `RequirePage`); every page under `src/features/shipments`, `customers`, `carriers`, …
(S2); `kit/TmsBadge.tsx`, `TmsButton.tsx`, `TmsDialog.tsx`, `TmsTable.tsx` (class names unchanged → look comes from theme.css).

---------------------------------------------------------------------------------------------------

## 3. Slices for 3 parallel builders — non-overlapping file ownership

Rules for all three: do not run project-wide typecheck/lint/test mid-flight (siblings are editing); run only your own test files
(`npx vitest run <file>`). Main runs typecheck/lint/test once all three land. Only edit files you own; if you need a change in someone else's file, message
that builder (`hub`).

Why `theme.css` is split: it is one 2,335-line file with the sidebar/top-bar block (122–550) and the chart-card block (1083–1121) in the middle. Two builders
cannot safely edit it concurrently, so ownership is by **file**: A keeps `theme.css` minus those blocks, B re-creates the shell block in new `shell.css`, C
re-creates the chart-card block in new `kit/kit.css`. A deletes the three blocks (listed in §2) in its first edit; B and C write their files from scratch (they do
not need to read the deleted text — the class names they must style are listed below). The page is only visually coherent when all three have landed.

### Slice A — tokens, `theme.css`, theme store, CountBadge, scope test
Owns: `theme.css`, `theme.scope.test.ts`, `tmsTheme.ts`, `tmsTheme.test.ts`, `kit/TmsCountBadge.tsx`, `kit/TmsCountBadge.test.tsx`, `index.html`.
Do **first** (others compile against them): `tmsTheme.ts` and `kit/TmsCountBadge.tsx` exactly as specified below.
Then: token blocks per D2 (light on `.tms-shell, .tms-portal`; dark on the `:root[data-tms-theme='dark']` prefixed pair; both set `color-scheme`; both include the row, chart,
badge-tint, count, tooltip, scroll, radius, gap tokens); D3 sweep of everything A owns; restyle base/buttons/inputs/page head/tables/cards/tabs/badges/dialog/portal to
the reference (white 14px cards, 1px border, 12–13px table text with light header `--tms-surface-subtle`, row dividers, primary button = `--tms-primary` fill / `--tms-on-primary`
text / `--tms-radius`, secondary = white + border, `.tms-btn-destructive` uses the new destructive tokens; focus ring `2px --tms-primary`);
`.tms-count-badge` + `.tms-count-{green,amber,red}` rules (below). Acceptance: `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(' theme.css` returns only lines inside the two token
blocks (plus `transparent`/`currentColor`).

### Slice B — shell
Owns: `TmsShell.tsx`, `TmsShell.test.tsx`, `TmsLayout.tsx`, `TmsLayout.test.tsx`, `shell.css`, `tmsCompany.ts`, `tmsCompany.test.ts`, `src/lib/navSections.ts`, `src/lib/navSections.test.ts`,
`src/features/tms/brokerage/DemoPage.test.tsx`.
Do **first**: `tmsCompany.ts` (slice C imports it).
Class names `shell.css` must style (existing, kept so nothing else breaks): `tms-sidebar, tms-sidebar-head, tms-collapse-btn, tms-sidebar-scroll, tms-pinned, tms-section-head,
tms-section-brand, tms-nav-rowwrap, tms-has-children, tms-nav-row, tms-active, tms-nav-icon, tms-nav-label, tms-nav-badge, tms-nav-caret, tms-nav-children, tms-nav-childgroup,
tms-nav-child, tms-nav-child-label, tms-nav-child-badge, tms-sidebar-foot, tms-content, tms-is-collapsed, tms-topbar, tms-topbar-spacer, tms-topbar-icons, tms-search, tms-search-icon,
tms-main`; new: `tms-company-card, tms-company-avatar, tms-company-menu, tms-company-option, tms-nav-live, tms-nav-live-item, tms-user-card, tms-user-avatar, tms-logout, tms-breadcrumb,
tms-crumb, tms-crumb-current, tms-bell, tms-theme-toggle`. Active nav row = filled `--tms-primary` pill, `--tms-on-primary` text and icon; its `TmsCountBadge` inverts
(`background: var(--tms-card); color: var(--tms-primary-ink)`); active child row = `--tms-primary-tint` background + `--tms-primary-ink` 600; hover `--tms-surface-hover`; section head 11px/600
uppercase muted; sidebar/top bar = floating cards per D11; ≤900px rail collapse rules re-created (width `--tms-sidebar-collapsed-w`, hide labels/badges/carets/children). No colour literals.

### Slice C — kit components, dashboard, charts
Owns: `kit/TmsKpiCard.tsx`, `kit/TmsKpiCard.test.tsx`, `kit/kit.css`, `kit/TmsChartCard.tsx`, `kit/TmsPage.tsx`, `kit/index.ts`, `dashboard/DashboardPage.tsx`, `dashboard/DashboardPage.test.tsx`,
`dashboard/ChartCard.tsx`, `dashboard/dashboard.css`, `dashboard/businessStrips.ts`, `dashboard/businessStrips.test.ts`, `dashboard/WelcomeHeader.tsx`.
Depends on: A's tokens (names only), A's `TmsCountBadge` file (only to re-export it in `kit/index.ts`), B's `useTmsCompany` (signature below).
`kit.css` contains: `.tms-kpi-card*`, `.tms-delta*`, `.tms-page-eyebrow`, and the rewritten chart card (`.tms-chart-card` white, `--tms-radius-card`, 1px border, height 360px,
header transparent with 14/600 title and leading muted 16px icon, `.tms-chart-head*`, `.tms-chart-body`, `.tms-chart-wide { grid-column: 1 / -1 }`).

### Shared interfaces (exact)

```ts
// A — src/features/tms/tmsTheme.ts
export type TmsTheme = 'light' | 'dark'
export const TMS_THEME_KEY = 'tms-theme'
export function readTmsTheme(): TmsTheme            // localStorage; anything but 'dark' → 'light'; never throws (private mode → 'light')
export function useTmsTheme(): { theme: TmsTheme; setTheme: (t: TmsTheme) => void; toggleTheme: () => void }
//   setTheme persists to localStorage (swallowing storage errors) and sets/removes
//   document.documentElement's data-tms-theme="dark" in a layout effect; the effect cleanup removes it.
//   Only TmsShell calls it.

// A — src/features/tms/kit/TmsCountBadge.tsx
export interface TmsCountBadgeProps { count: number; tone?: 'green' | 'amber' | 'red'; max?: number; className?: string }
export function TmsCountBadge(p: TmsCountBadgeProps): JSX.Element | null
//   renders null when count <= 0; text `${max}+` when count > max (max default 99);
//   <span className={`tms-count-badge tms-count-${tone}${className ? ' ' + className : ''}`}>; tone default 'green'
//   CSS (A, theme.css): green = --tms-primary-tint bg / --tms-primary-ink; amber = --tms-count-bg / --tms-count-ink; red = --tms-badge-red-tint / --tms-badge-red;
//   min-width 18px, height 18px, radius pill, 11px/700.

// B — src/features/tms/tmsCompany.ts
export const TMS_COMPANY_KEY = 'tms-company'
export function readTmsCompany(): string | null     // localStorage value or null; never throws
export function useTmsCompany(): { company: string | null; setCompany: (code: string | null) => void }
//   module-level store + useSyncExternalStore; setCompany(null) removes the key; writes notify all subscribers in the same tab.

// B — src/features/tms/TmsShell.tsx (exported types)
export interface TmsCompanyOption { code: string; name: string }
export interface TmsBreadcrumbItem { label: string; to?: string }
export interface TmsLiveChild { id: string; label: string; sub?: string | null; to: string }
export interface TmsNavChild { to: string; label: string; badgeKey?: string; live?: TmsLiveChild[] }   // `live` is new, set by childrenFor for Tracking
export interface TmsShellProps {
  pinned?: TmsNavItem[]
  sections: TmsNavSection[]
  activePath: string
  breadcrumb: TmsBreadcrumbItem[]                    // replaces pageTitle
  user: { initial: string; email: string; name?: string | null }
  shipmentViews: Array<{ slug: string; name: string }>
  badgeCounts?: Record<string, number>               // now also carries `tracking` (moving shipments)
  companies?: TmsCompanyOption[]                     // [] or <2 entries → static org card, no menu
  notificationCount?: number                         // default 0; bell badge; bell links to /tms/check-calls
  trackedLoads?: TmsLiveChild[]                      // newest-updated first, already sliced to 6
  onLogout?: () => void                              // Log out button rendered only when provided
  onSearch?: (q: string) => void
  children?: ReactNode
}
// TmsShell reads useTmsTheme() and useTmsCompany() itself (no theme/company props).

// B — src/lib/navSections.ts
export const COMPANY_DIVISION = 'COMPANY'
export function tmsBreadcrumb(pathname: string, shipmentViews?: Array<{ slug: string; name: string }>): TmsBreadcrumbItem[]
export function companyOptions(sections: Array<{ key: string }>, divisions: Array<Pick<OwnershipDivisionRecord, 'code' | 'name'>> | null): TmsCompanyOption[]
//   one option per non-COMPANY section, in section order; name from the division list (SEED_DIVISIONS when null), falling back to the section key.

// C — src/features/tms/kit/TmsKpiCard.tsx
export interface TmsKpiCardProps {
  label: string
  icon?: LucideIcon                                  // 16px line icon, muted
  value: string | null                               // preformatted; null renders '—'
  delta?: { pct: number; label?: string } | null     // pct in percentage points (40.93); label default 'vs last month'
  positiveIsGood?: boolean                           // default true; false for AR/AP/cost, flips tone only, never the sign
  sub?: string | null                                // muted line shown when there is no delta
  className?: string
}
//   delta text: `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(2)}%` + ArrowUpRight / ArrowDownRight / ArrowRight (pct === 0);
//   class `tms-delta tms-delta-good|bad|flat` (good/bad = sign vs positiveIsGood; 0 = flat). Root `<div className="tms-kpi-card">`.
// C — kit TmsChartCardProps gains `icon?: LucideIcon`;  TmsPageProps gains `eyebrow?: ReactNode`.
// C — businessStrips.ts
export interface CompanyTotals {
  shipmentCount: number | null
  revenueCents: number | null; profitCents: number | null; marginBps: number | null
  arOpenCents: number | null; apOpenCents: number | null
}
export function buildCompanyTotals(data: DashboardData, filters: DashboardFilters): CompanyTotals   // over applyFilters(data, filters), no division bucketing
```

### Behaviour details the builders must implement

**B — `TmsShell` structure**
```
div.tms-shell[.tms-is-collapsed]
  aside.tms-sidebar
    div.tms-sidebar-head
      company card: <button.tms-company-card aria-haspopup="listbox" aria-expanded> avatar(initials of selected name, or 'BC' for All) + name ('BCAT Ops' for All) + chevron
      ul.tms-company-menu[role=listbox] (open state): "All businesses" + companies; li.tms-company-option[role=option aria-selected]; selecting calls setCompany(code|null) and closes. Never render division CODES (existing test matches /BROKERAGE/ once).
      button.tms-collapse-btn  (aria-label 'Collapse sidebar'/'Expand sidebar', same localStorage key 'tms-sidebar-collapsed')
    nav.tms-sidebar-scroll[aria-label="TMS sections"]   pinned rows, then sections
      section header: <button.tms-section-head aria-expanded> NAME<span.tms-section-brand> [Brand]</span> (keeps the "NAME [Brand]" text); a section is collapsed when
        companyActive && section.key !== COMPANY_DIVISION && section.key !== company; a local toggle overrides it until `company` changes.
      NavRow unchanged in logic (parentActive/anyChildActive/caret); Tracking child (`to === '/tms/tracking'`) additionally gets badgeKey 'tracking' and `live` = trackedLoads;
        when live.length > 0 it has its own caret (aria-label 'Expand Tracking'/'Collapse Tracking', default open when under /tms/tracking) and renders .tms-nav-live > a.tms-nav-live-item (label + muted sub).
        TmsCountBadge replaces the old `.tms-nav-badge` text for numeric counts; a non-numeric `item.badge` (Academy 'BETA') stays a `.tms-nav-badge` text pill.
    div.tms-sidebar-foot (card): div.tms-user-card (avatar initial, name = user.name ?? email local part, email muted) + button.tms-logout 'Log out' (LogOut icon) → onLogout()
  div.tms-content
    header.tms-topbar (card): nav[aria-label="Breadcrumb"] > ol.tms-breadcrumb (grid icon link to /tms/dashboard with aria-label 'Dashboard home', '/' separators, last li.tms-crumb-current aria-current="page")
      spacer · form.tms-search (unchanged: aria-label 'Search anything', placeholder 'Search anything (ctrl+k)', ctrl/cmd+K focus, onSearch) ·
      <Link.tms-bell to="/tms/check-calls" aria-label=…> Bell icon + TmsCountBadge tone="amber" count=notificationCount (top-right overlap) ·
      <Link to="/tms/academy" aria-label="Help"> CircleHelp · button.tms-theme-toggle (D6)
    main.tms-main
```
Collapsed rail: company card shows only the avatar; labels/badges/carets/children/user text/Log out label hidden (Log out remains as an icon button with `aria-label="Log out"`).
Removed: `tms-wordmark`, `tms-foot-btn`, `tms-foot-count`, `tms-avatar`, `tms-topbar-title`, `tms-icon-btn-sq` Monitor/Zap/History buttons (delete their CSS too — they are in the deleted block).

**B — `TmsLayout`**
* `const { user, isOwner, isAdmin, hasPageAccess, logout } = useAuth()`; `onLogout={() => { void logout() }}`.
* `const { dueCount } = useCheckCallWorklist({ enabled: isOwner || isAdmin || hasPageAccess('loads') || hasPageAccess(TMS_PAGE_KEY) })` → `notificationCount={dueCount}`.
* `trackedAll = shipments.filter(r => r.loadStatus != null && MOVEMENT_STATUSES.includes(r.loadStatus) && !r.voidedAt)`; `badgeCounts = { ...useTmsBadgeCounts(...), tracking: trackedAll.length }`;
  `trackedLoads = [...trackedAll].sort((a,b) => (b.lastUpdateAt ?? '').localeCompare(a.lastUpdateAt ?? '')).slice(0, 6).map(r => ({ id: r.id, label: r.number, sub: r.customerName ?? null, to: `/tms/shipments/${r.id}` }))` (memoised).
* `breadcrumb={tmsBreadcrumb(location.pathname, shipmentViews)}`; `companies={companyOptions(sections, divisions)}`; `user={{ initial, email, name: me?.name ?? null }}`.

**C — `DashboardPage`**
* `const { company } = useTmsCompany()`. Initial `filters = { ...defaultFilters(now), divisions: company ? [company] : [] }`. Live switch while mounted: use the render-time
  "adjust state when a prop changes" pattern (`const [seen, setSeen] = useState(company); if (seen !== company) { setSeen(company); setFilters(c => ({ ...c, divisions: company ? [company] : [], subdivisions: [] })) }`)
  — not an effect (the repo's `react-hooks/set-state-in-effect` lint rule forbids it). `clearAll` keeps resetting to `defaultFilters(now)` (all divisions) as today.
* Welcome: `<TmsPage eyebrow={<WelcomeHeader name={…} />}>`. Name = signed-in profile's `name` from `data.profiles` (match on `email`), else the email local part's first `.`/`_`/`-` token capitalised ("ryne@…" → "Ryne"). Avatar = initial in a `--tms-primary-tint` circle.
* KPI strip: `<div className="tms-grid tms-grid-4">` of four `TmsKpiCard` per D10, `positiveIsGood={false}` on AR/AP; rendered when `data` is loaded; `—` for nulls.
* Title row: Export CSV becomes `<TmsButton variant="primary"><Download size={15}/> Export CSV</TmsButton>` (accessible name stays "Export CSV"); Refresh/Clear/Save keep their `aria-label`s; picker button text `N charts` unchanged.
* Strips: same markup/class names (`tms-business-strips`, `tms-business-strip`, `tms-strip-active`, `tms-strip-heading`, `tms-strip-statuses`, `tms-strip-pill`, `tms-strip-metrics`, `tms-strip-subdivisions`, `tms-strip-sub*`); CSS only. Heading buttons keep their names (a test counts exactly 4 buttons named after the divisions — the KPI strip/welcome must not add more).
* Keep every current feature: Views select + save/export/refresh/clear, chart picker, all 9 filter chips + panels + group-by, per-chart group-by override, number/table/expand views, `failedMonths` and error lines, saved views in `tms-dashboard-views:<email>`.

---------------------------------------------------------------------------------------------------

## 4. Existing tests: exactly what changes

| Test file | What it pins today | Action |
|---|---|---|
| `src/features/tms/theme.scope.test.ts` | every selector starts `.tms-shell`/`.tms-portal`; literal `--tms-bg: #232323`, `--tms-sidebar-w: 175px`, `--tms-topbar-h: 38px`, `--tms-primary: #f4c50c`, `--tms-badge-turquoise: #09e2e5` | **Delete the 5 literal-value pins** (they pin incidental values and are the reason a re-theme "breaks"; never re-pin them to the new numbers). Keep + extend the scope test to read **every** `*.css` under `src/features/tms/` (`theme.css`, `shell.css`, `kit/kit.css`, `dashboard/dashboard.css`) with the dark-prefix allowance. Keep the "a `.tms-portal` rule exists" assertion. Add the two invariants in §5. |
| `src/features/tms/TmsShell.test.tsx` | section text `NAME [Brand]`, pin order, `tms-active`, workstation links, Views group, caret collapse, ctrl+k, search callback, `tms-sidebar-collapsed` persistence, `pageTitle="Shipments"` prop | Prop `pageTitle` → `breadcrumb={[{label:'Shipments'}]}`. All link assertions scoped with `within(screen.getByRole('navigation', { name: 'TMS sections' }))` because the breadcrumb now also renders a "Shipments" link when it has a `to`. Everything else stays as is. |
| `src/features/tms/TmsLayout.test.tsx` | the rail gets exactly the viewable views; mocks `TmsShell`, `useAuth` (no `logout`), `apiClient` (no worklist reads) | Add `logout: vi.fn()` to the auth mock; add `listCheckCallWorklist: vi.fn(async () => [])` and `listLoadCarriersByLoad: vi.fn(async () => [])` to the `@/lib/apiClient` mock (the new `useCheckCallWorklist` call would otherwise throw on a missing mock export). |
| `src/features/tms/brokerage/DemoPage.test.tsx` (2 renders, lines ~216, ~242) | passes `pageTitle="TMS"` to `TmsShell` | `pageTitle="TMS"` → `breadcrumb={[{ label: 'TMS' }]}` |
| `src/lib/navSections.test.ts` | `tmsPageTitle` cases; 2 renders pass `pageTitle: 'Shipments'` | Delete the `tmsPageTitle` describe; replace with the `tmsBreadcrumb` cases (§5); `pageTitle: 'Shipments'` → `breadcrumb: [{ label: 'Shipments' }]` at lines ~80 and ~157. `buildNavSections` tests untouched. |
| `src/features/tms/dashboard/DashboardPage.test.tsx` | chart titles via `.tms-chart-title`, `.tms-chart-card`, `.tms-business-strip`, `.tms-strip-statuses`, `.tms-strip-sub`; exactly 4 buttons named BCAT Logistics/Ivan Cartage/Best Care Auto Transport/Company; `Export CSV`, `Save view`, `Views`, `N charts` roles; localStorage key | Should pass unchanged — class names and accessible names are deliberately stable. Run it; fix only a genuine duplicate-text collision from the new KPI strip (`screen.getByText` is not used for money values today; all are scoped with `within(card)`). Add the company-preset test (§5). |
| `kit/TmsBadge.test.tsx`, `kit/TmsDialog.test.tsx`, `kit/TmsListPage.test.tsx` | class names `tms-badge`, `tms-badge-green`, `tms-portal`, `tms-dialog-content`, `.tms-dialog-overlay`, `tms-active`, `tms-chip`, `tms-chip-set`, `tms-footer-count` | No change (class names stable). Run to confirm. |
| `dashboard/brokerageCards.test.tsx`, `businessStrips.test.ts` | card/strip arithmetic | No change; `businessStrips.test.ts` gains the totals tests. |
| `src/components/layout/NavBar.test.tsx` (legacy) | `BROKERAGE [BCAT Logistics]`, hrefs | No change (`buildNavSections` untouched). |

Stable class names kept (no test needs retargeting for them): `tms-active`, `tms-badge`, `tms-badge-{blue,green,orange,pink,purple,red,turquoise,gray}`, `tms-chart-card`, `tms-chart-title`,
`tms-business-strip*`, `tms-strip-*`, `tms-portal`, `tms-dialog-*`, `tms-chip*`, `tms-footer-*`, `tms-tab*`.

---------------------------------------------------------------------------------------------------

## 5. Test plan — what is worth keeping (behavioural only)

New tests (each fails on a plausible bug):
1. **`tmsTheme.test.ts`** (A): default light with empty storage; `setTheme('dark')` persists `tms-theme` and sets `data-tms-theme="dark"` on `<html>`; a stored garbage value reads as light;
   unmounting removes the attribute (legacy pages must never inherit it); `toggleTheme` twice returns to light with the attribute removed.
2. **`theme.scope.test.ts`** (A): (a) every selector in every `src/features/tms/**/*.css` is scoped (allowing only the `:root[data-tms-theme='dark'] ` prefix); (b) **token parity** — every `--tms-*`
   colour token declared in the light block is also declared in the dark block (catches "added a token, forgot dark → dark mode shows the light value"); (c) **no colour literals** outside the token blocks
   (catches re-hard-coding a hex, which is what made the old theme impossible to flip).
3. **`TmsCountBadge.test.tsx`** (A): renders nothing for 0 and negatives; `150` with default max prints `99+`; honours a custom `max`.
4. **`TmsKpiCard.test.tsx`** (C): delta sign and tone — `+40.93` → text `+40.93%` with `tms-delta-good`; `-1.63` → `-1.63%` with `tms-delta-bad`; `0` → `0.00%` `tms-delta-flat`;
   `positiveIsGood={false}` keeps the `+` but flips to `tms-delta-bad`; `value={null}` renders `—` and no delta; `sub` is shown only when there is no delta.
5. **`businessStrips.test.ts`** (C): `buildCompanyTotals` counts a shipment/sample with **no division tag** (which the per-business sum would drop); returns `null`, not `0`, when the window has no priced samples/invoices/bills;
   margin = profit ÷ revenue in bps; respects the division filter.
6. **`DashboardPage.test.tsx`** (C): with `localStorage['tms-company'] = 'ASSETS'` the page opens with `Division is Ivan Cartage`; calling `setCompany(null)` (via `act`) while mounted restores `All divisions`; the KPI strip shows `$1,500.00` revenue / `20.0% margin` for the fixture.
7. **`tmsCompany.test.ts`** (B): default null; `setCompany('ASSETS')` persists and notifies two subscribers; `setCompany(null)` removes the key.
8. **`TmsShell.test.tsx`** (B): theme toggle flips `aria-label` and the `<html>` attribute and survives an unmount/remount (persistence); company switcher: "All businesses" shows every section expanded, choosing "Ivan Cartage"
   collapses the BROKERAGE section's items but keeps the COMPANY group and pinned rows, choosing "All businesses" restores them; a stored company that is not in `companies` behaves as All; menu absent for fewer than 2 companies;
   **Log out** calls `onLogout` once (and is absent when not provided); bell link `href="/tms/check-calls"`, badge shows `notificationCount` and is absent at 0; breadcrumb renders crumb links and marks the last `aria-current="page"`;
   Tracking child shows the count from `badgeCounts.tracking` and lists `trackedLoads` when expanded.
9. **`navSections.test.ts`** (B): `tmsBreadcrumb` — `/tms/shipments/view/my-queue` → `Shipments › My queue`; `/tms/dispatch` → `Shipments › Dispatch` (was `TMS` before); `/tms/tracking/links` → `Shipments › Tracking › Manage links`;
   `/tms/invoicing/payable/bills/B-1` → `Invoicing › Payable`; `/tms/shipments/SHP-1` → `Shipments › Shipment`; `/tms/nothing` → `TMS`; `companyOptions` skips `COMPANY` and honours section order/permission-filtered sections.

Not tested (not worth a test): CSS values, colours, snapshots, prop forwarding, the Welcome name fallback beyond what test 6 touches, icon choice.

---------------------------------------------------------------------------------------------------

## 6. Verification plan (S1 gate: Ryne reviews before S2)

1. **Unit gate (Main, once, after A/B/C land):** `npm run typecheck && npm run lint && npm run test` — all green. Specifically confirm green: `theme.scope.test`, `TmsShell.test`, `TmsLayout.test`, `DemoPage.test`, `navSections.test`, `NavBar.test`, `DashboardPage.test`, `businessStrips.test`, `kit/*.test`.
2. **Local visual pass before pushing** (fast iteration, no deploy): `npm run dev` started with `hub` (`op:"start"`, ready on port 5173) against the dev backend. Throwaway script `scripts/s1Shots.mjs` (deleted afterwards) reusing the headless-Chrome/CDP pattern of
   `scripts/lib/verifyTrackingUi.mjs` (origin `http://localhost:5173` is already on its allow-list) and `mintIdentity(email, ['ADMIN','page-tms'])` from `scripts/devVerifyP.mjs` to put an authenticated session in `localStorage` (temporary identity removed in `finally`; password never printed).
   Viewport 1600×1000, `deviceScaleFactor` 1 (+ one 2× of the sidebar).
3. **Screenshots to capture** (light and dark each, `Docs/tms-build/screenshots/S1-<name>-<theme>.png`; set the theme by clicking the real toggle once, then reload to prove persistence):
   * `dashboard` — full `/tms/dashboard` (welcome, 4 KPI cards, filters, business strips, first chart rows) loaded with data;
   * `shell-switcher` — company menu open; `shell-company-ivan` — Ivan Cartage selected (BROKERAGE collapsed, dashboard filter chip = Ivan Cartage);
   * `shell-tracking` — Tracking group expanded with live children + count;
   * `shell-collapsed` — collapsed rail;
   * `dialog` — the dashboard's "Save this dashboard view" dialog (proves the `.tms-portal` theme follows `data-tms-theme`);
   * `regression-shipments` + `regression-shipment-detail` — `/tms/shipments` and one shipment page (not converted until S2; must be readable in both themes: no dark-on-dark / light-on-light text, no yellow chrome).
4. **Interaction assertions in the script** (exit non-zero on failure): toggle flips `document.documentElement.dataset.tmsTheme` and persists across `Page.reload`; switcher choice persists across reload and the dashboard opens with `Division is <name>`; bell is a link to `/tms/check-calls` and its badge equals the number the legacy sidebar would show (compare with `useCheckCallWorklist` dueCount via the Check calls page's Overdue + Due tab counts); Log out ends at the login page (run last, separate session); zero `console.error`/uncaught exceptions during the walk; recharts series fills resolve to non-black computed colours (`getComputedStyle` on `.recharts-bar-rectangle path` / `.recharts-line-curve`).
5. **Side-by-side with the references** (`dashboard-trucking.jpg`, `user-overview-admin.jpg`, `financial-operations-admin.jpg`): checklist — flat `#F3F6F4` canvas; floating white sidebar/top-bar cards, 14px radius; active nav = green pill with white text/icon; section heads muted; breadcrumb with last crumb green; bell amber count; KPI number weight/size; delta colours (card supports them; none shown on the dashboard by D9); tinted status pills; chart colours green → dark green → black; dark tooltip. Tune token values by eye here (names stay).
6. **One deploy:** commit on `dev` ("S1: green design tokens, TMS shell, KPI kit, company dashboard"), wait until `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not RUNNING/PENDING, `git push origin dev` once, wait for SUCCEED, then re-take the dashboard light + dark screenshots against `https://dev.d3dejqzs77khq6.amplifyapp.com` (`DEV_VERIFY_UI_URL`) to prove the deployed build. Delete `scripts/s1Shots.mjs`. Add a `BUILD_LOG.md` S1 entry with the screenshots and the D9 note.
7. **Stop.** Report to Ryne with the screenshots; S2 (TMS pages) does not start before his review (`REDESIGN_UI_REFERENCE.md` §6).

---------------------------------------------------------------------------------------------------

## 7. Risks

1. **Re-token blast radius.** ~hundreds of inline `var(--tms-*)` uses in S2 pages re-skin at once. Text/border uses are safe (D2 accents are legible on white). Literal dark-assuming styling in TSX (`TrackingDetailMap`/`BoardMapView` yellow strokes, `DivisionsPage` hex, any `text-white`) will look off until S2; the regression screenshots in §6.3 are the net. Not fixed in S1 by design.
2. **Contrast.** White on `#1DB36A` ≈ 2.6:1 (the reference does it). Mitigated: green *text* uses `--tms-primary-ink`; the white-on-green pill/button text is ≥14px/600. If Ryne wants AA, darken `--tms-primary` for text-on-fill to `#169A5A` (one token).
3. **Portals and dark mode.** Radix content under `.tms-portal` that is built from shadcn classes (`Sheet`, `DropdownMenu` in `StatusActions`, `ShipmentDrawer`, `CarrierProfile`) takes its fill from `index.css`'s light tokens, as it did in the old dark theme. In the new dark variant those can look wrong; check `dialog` and a dropdown in the dark pass and fix in S2 if needed. Portals opened outside `/tms/*` default to light (attribute is removed on shell unmount) — previously they were dark; light matches those legacy pages.
4. **Import cycle.** `kit/index.ts` re-exports `TmsShell`; `TmsShell` must import kit files directly, never the barrel (spelled out in slice B).
5. **Brittle test selectors.** `TmsShell.test` link queries collide with breadcrumb links → scoped to the nav (§4). `DashboardPage.test` counts exactly four division-named buttons → the KPI strip/welcome/switcher must not add buttons with those names (the switcher is in the shell, not rendered by `DashboardPage`).
6. **Extra polling.** `useCheckCallWorklist` adds one worklist query per minute plus one `listLoadCarriersByLoad` per tracked load under `/tms/*` (same cost the legacy rail pays). Gated by `enabled`. Accepted for an honest bell count.
7. **Stale company preference** (division deactivated after selection): shell shows All, dashboard chip shows the stale code until "Clear filters". Rare; not special-cased.
8. **No deltas on KPI cards (D9).** The reference's `+40.93% ↗ vs last month` needs a prior-window read; deferred and flagged. The kit already supports it.
9. **CSS `var()` in SVG attributes** (recharts). Works in current Chrome/Safari/Firefox; verified by computed-colour assertion; fallback is `style` props.
10. **Concurrent CSS ownership.** The split of `theme.css` (A) / `shell.css` (B) / `kit.css` (C) is by file; if A deletes the shell/chart blocks before B/C land, `/tms/*` is unstyled in that window only (no deploy happens before all three land and Main runs the gates).
11. **Mobile.** ≤900px behaviour is preserved (rail forced to collapsed width); verify one 390px screenshot of the dashboard during the local pass (not a gate).
12. **Fonts.** Inter 700 added to the Google Fonts URL; without it KPI numbers synthesize bold (cosmetic only).
13. **Scope creep guard.** Not in S1: StatRow, SegmentedTabs, Timeline, deltas, notification drawer, Document/Compliance pages, any non-dashboard page conversion, legacy shell, driver PWA, public pages, e-mail templates.
