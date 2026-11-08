# Step S3 — the green look on everything that is not `/tms/*`

Spec: `REDESIGN_UI_REFERENCE.md` (§1 tokens, §3 kit, §4 "every page"), `S1-plan.md` (tokens, shell), `S2-plan.md` (kit contracts §3.1, look rules §5, devVerify §9). S1 (deployed, job 131) re-valued the `--tms-*` tokens and rebuilt the shell; S2 + rate-con (deployed, Amplify job 133, commit `5c52438`) put every `/tms/*` page, its dialogs and the five tokenised public pages on the kit. **S3 puts the rest of the product on the same look**: the legacy BCAT Ops pages, the legacy shell, the sign-in screens, the driver PWA, the remaining public pages, every hand-built modal, drawer, toast and empty state in those areas — and decides what happens to the e-mail templates.

Everything stays on `dev`. Nothing here touches `main`, production, `invoice_*.json`, or `amplify_outputs.json` (the checked-in one points at the **production** pool `us-east-1_IbPKPNJC9`; every local run uses the temporary dev-outputs alias `vite.s2dev.config.ts` + `/tmp/s2dev/amplify_outputs.json`, see §9.4). The lead commits, pushes and deploys; builders and this plan never do.

Evidence base: a read of the shell/kit/CSS as they stand after S2; node-counted literal tallies over all of `src/` (§1.2); three read-only scout passes (mail, driver PWA, third-party styling); direct reads of `App.tsx`, `NavBar/Topbar/AppLayout`, `index.css`, `LoginPage`, `TrackPage`, `DriverApp`, `DriverAuthContext`, `devVerifyS2.mjs`, `cdpBrowser.mjs`, `devIdentity.mjs`, `eslint.config.js`, `vite.config.ts`, `index.html`. Anything not confirmed from the repo is marked **[INFERENCE]** with the check that settles it.

---------------------------------------------------------------------------------------------------

## 0. At a glance — decisions, and what is still Ryne's call

### 0.1 The architecture in five lines
1. **One token source.** `--tms-*` (theme.css) is promoted from "only inside `.tms-shell/.tms-portal`" to **also `:root`**. The legacy `--ds-*` names are **codemod-renamed** to their `--tms-*` equivalents everywhere (≈3,700 `--ds-*` references in 130 files, mechanical, §2.2) and the `--ds-*`/`.dark` blocks are deleted from `index.css`. The shadcn variables (`--background`, `--primary`, `--border` …) stay as the Tailwind bridge, defined **once at `:root`** as aliases of `--tms-*`. Tailwind palette classes (`bg-slate-50`, `text-emerald-700`, `bg-[#1ea8f3]`) are codemodded to semantic/`--tms-*` classes (§2.3).
2. **One shell.** The legacy `AppLayout/NavBar/Topbar` are **deleted**. Legacy routes render inside the S1 `TmsShell` through the same `TmsLayout`, in a new `fill` mode that gives every legacy page the fixed-height scroll container it was written for (§2.4). Company switcher, theme toggle, log out, collapse, bell, search, breadcrumb are the same component — parity by construction, not by copying.
3. **Re-token first, rebuild where the pattern is plain.** Treatment per route is **R** (re-token only: calendar, planner, maps, charts, dense inline grids) or **K** (re-token + kit page head + kit stat rows/badges/dialogs where the file already has that pattern; §2.6). No logic, handler, or data change anywhere.
4. **Every hand-built modal/drawer becomes `TmsDialog`/`TmsDrawer`** (24 sites in 22 files, plus 4 full-screen driver overlays, §4); shadcn `ui/*` gets the `tms-portal` look from its own file so its 14 dialog + 39 button consumers follow without edits.
5. **Driver PWA** gets the same tokens in a `tms-driver` root: light green by default, dark on a toggle (Account), the `dark` class retired, camera/paper surfaces stay black/white, the manifest and `theme-color` follow the tokens (§6 Slice G, §9.5).

### 0.2 Open decisions for Ryne (each has a default so work does not wait)
| # | Decision | Default taken in this plan | Why it needs a human |
|---|---|---|---|
| **D-1** | Driver PWA default theme: light (like staff) or stay dark-only? | **Light by default, dark via Account toggle** (shares the `tms-theme` key on the device) | Drivers work nights and in cabs; dark was a deliberate choice (`index.css` L126 comment). The toggle keeps it one tap away. |
| **D-2** | Recolour the **Best Care Auto Transport** quote/confirmation e-mails to green? | **No — left exactly as is** (§8) | They are customer-facing mail for a *different brand* (red/black, own logo, "Your Best Care Contact"). The scout found no BCAT-Ops-branded HTML mail at all and **no e-mail snapshot/colour tests exist**, so the brief's "retarget snapshot tests" has nothing to retarget. If you want green anyway it is a 6-constant edit (`emailChrome.ts` L14–19) + a characterization test first — say so. |
| **D-3** | Phone navigation: off-canvas drawer + hamburger for **both** shells (legacy has it today; S1's TMS shell shows a 76 px icon rail at ≤900 px) | **Drawer for both** (one behaviour) | Changes the S1/S2 phone look of `/tms/*`. Keeping the 76 px rail would make the two shells diverge on phones, which the brief forbids. |
| **D-4** | PWA / favicon artwork (`public/icons/*`, `bcat-favicon.png`, `src/assets/bcat-logo.png`) is blue-on-navy brand art | **Kept** — only `theme_color`, `background_color`, `<meta theme-color>` change | A green icon is design work, not a recolour I can verify. A blue icon beside a green UI is a known, small inconsistency. |
| **D-5** | Legacy-only chrome that has no TmsShell twin: the sidebar "Quick Add" button, the topbar "Live · Ns" ticker, the topbar search live-filtering the Calendar through the shared store (`useAppStore.searchQuery`), the duplicate "Users" rail link | **Dropped** (§2.4.3 parity matrix) | Each is decorative or duplicated (Quick Add only navigates to `/tms/shipments`; Users is a tab under My Brokerage; Calendar has its own search box). Listed so nothing disappears silently. |
| **D-6** | Customer-facing **PDFs** (`invoicePdf`, `remittancePdf`, `filePacketPdf`, `carrierRateCon` — navy/black bands) | **Untouched** | Documents customers keep; not UI. Out of S3. |
| **D-7** | iOS standalone status bar: `black-translucent` (white text) is unreadable over a light UI | **`default`** in `index.html` + theme-aware top inset in the driver shell | **[INFERENCE]** that `default` follows system dark appearance — Ryne checks once on an iPhone; fallback is `black-translucent` with a dark top safe-area strip. |

### 0.3 Slice map
| Slice | Scope | Size (non-test LOC / colour literals) |
|---|---|---|
| **A** Foundation + shell | tokens at `:root`, `index.css`, `ui/*`, TmsShell/TmsLayout/shell.css legacy mode + mobile drawer, badge resolver, breadcrumb, `TmsScrollPage`, toaster, theme/PWA meta, lint, **Phase-0 codemod**, delete `AppLayout/NavBar/Topbar` | ~3.5k / (shell) |
| **B** Dashboards, calendar, dispatch, appointments | `dashboard`, `calendar`(+`calendar.css`), `dispatch`(+`DispatchDrawer`), `appts`, 4 shared popovers, `driverColors.ts`, `apptStatus.ts` | ~10.9k / ~560 |
| **C** Fleet, assets, people-ops | `trucks`, `truck-docs`, `maintenance`, `fleet-dashboard`, `fuel`, `insurance`, `hours`, `schedule`, `time-off`, `driver-info`, `drivers`, `tasks`, `intake`, `reddit-queue`, `pricing-margin`, `vehicle-quote`, `vehicle-confirmation` | ~9.2k / ~430 |
| **D** Money and pay | `finances`, `fleet-profitability`, `cash-checkin`, `expenses`, `invoices`, `driver-pay`, `driver-pay-box-trucks`, `owner-operator-pay`, `ivan-driver-app` | ~11.9k / ~560 |
| **E** Files, loads, PODs, disputes + login + public legacy | `files`, `loads`, `pods`, `disputes`, `compliance`, `driver-docs`, `driver-portal`, `tracking/TrackPage`, `pages/LoginPage`, `AuthGuard` | ~12k / ~500 |
| **G** Driver PWA | `driver-app/**`, the extracted `DriverRoutes`, `vite.config.ts` manifest, driver install/update surfaces | ~8.8k / ~650 (mostly Tailwind palette) |
| **V** (wave 2) | `scripts/devVerifyS3.mjs`, `scripts/lib/uiWalk.mjs`, `scripts/lib/driverIdentity.mjs` | scripts |

Six parallel builders (A, B, C, D, E, G) + V when A's tokens are in. **B–G start only after A broadcasts "Phase 0 done"** (§5.1) — a few minutes, because it is a script.

---------------------------------------------------------------------------------------------------

## 1. What is wrong today (the delta S3 closes)

### 1.1 Findings (ids are referenced by the slices)
| # | Finding | Evidence | Closed by |
|---|---|---|---|
| **S1** | **Two token systems.** Legacy pages colour with `--ds-*` (`index.css` L45–124: blue `#1ea8f3` brand, slate neutrals) and shadcn variables; TMS uses `--tms-*` scoped to `.tms-shell/.tms-portal`. Anything outside the shell (portals, login, driver, public) sees only the blue set. `body` paints `--ds-bg #f4f7fb`. | `index.css` L45–124, L170; `theme.css` L16, L128 | A (§2.1–2.2) |
| **S2** | **`--ds-*` is referenced 3,691 times in 130 files** (`--ds-t3` 986, `--ds-border` 718, `--ds-t1` 464, `--ds-surface` 349, `--ds-t2` 331, `--ds-blue` 217, `--ds-bg` 199 …, node count) plus `--sh-*` ×117, and **3 undefined names, 8 uses** (`--ds-surface1` ×3, `--ds-surface2` ×2, `--ds-accent` ×3 — they resolve to nothing today; the codemod reports them, the owning builder picks by context). | counted | A codemod (§2.2) |
| **S3** | **Hard-coded colour outside tokens.** Hex+`rgba()` literals per legacy folder: calendar 186, dashboard 98, driver-pay 78, files 69, owner-op-pay 61, fleet-dashboard 52, box-trucks 45, expenses 25, pods 21, fleet-profitability 27, trucks 16, … plus Tailwind palette utilities: driver-app 273, expenses 131, calendar 112, trucks 107, pods 41, dashboard 38, intake 28, hours 27. These are what make dark mode impossible on the legacy pages (white cards, `#f1f5f9` bands). `#1ea8f3` alone: 71 hits in 34 files. | node tally §1.2 | A (codemod) + B–G (residue) |
| **S4** | **Legacy shell is a separate implementation.** `AppLayout` (flex row `.app`, 100vh, `overflow:hidden`), `NavBar` (own badge resolver, black logo tile, Quick Add, Users link, 12 hex), `Topbar` (own search/Live ticker/stub bell). No company switcher, no theme toggle. The `.tms-shell` rail already lists every legacy page (`buildNavSections` is shared) — so a user hops between two chromes. | `AppLayout.tsx`, `NavBar.tsx`, `Topbar.tsx`, `navSections.ts` L7–9 | A (§2.4) |
| **S5** | **Legacy pages assume a fixed-height host** (`height:100%; overflow-y:auto`, sticky `top:0` headers, calendar/dispatch `height:100%` flex). `.tms-main` is page-scroll (`padding: gutter 0`, no height) — dropping them in unchanged collapses calendar/dispatch and slides sticky headers under the floating top bar (z-index 20). | `TrucksPage.tsx` L1190, `CalendarPage.tsx` L194, `DispatchPage.tsx` L384, `shell.css` L520–550 | A `fill` mode (§2.4.2) |
| **S6** | **Phone navigation.** Legacy: hamburger + off-canvas drawer + backdrop at ≤900 px. TMS shell: stays a 76 px rail (`shell.css` L651–660) — 20 % of a 390 px screen, and the legacy `index.css` mobile rules (tap targets, inline-style reflow) are written against the old shell. | `index.css` L295–420 | A (§2.4.4) |
| **S7** | **24 hand-built modal/drawer overlay sites in 22 files** (`position:fixed; inset:0; background:rgba(0,0,0,.4)` + `var(--ds-surface)` box), three of them byte-identical `Modal` copies (`DriverPayForms`, `BoxTruckPayForms`, `OwnerOperatorPayForms`) plus `fleet-profitability/DriverPayForm`. No focus trap, no Esc, no `role="dialog"`, white in dark. | §4 | B–E (§4) |
| **S8** | **shadcn primitives carry blue/slate**: `ui/button` default = `from-[#3bb5f5] to-[#1ea8f3]` gradient + `bg-slate-*`; `ui/sheet` `bg-white/border-slate-200`; `ui/tooltip` `bg-[#102346]`; `ui/toggle-group` `bg-[#1ea8f3]`; `ui/kpi-card` hex; overlays `bg-black/40–50`. 39 legacy files use `Button`, 14 `Dialog`, 14 `Input`. | `lib/ui/button-variants.ts` L8–13, `ui/*` | A |
| **S9** | **Login = "Control Tower"**: 359 lines, dark navy canvas, cyan `#38bdf8` map, glass card, 19 hex + 31 `rgba()`, inline `<style>`; `AuthGuard` loading screen `#07122b`. Nothing in the staff app is dark-only except this. | `LoginPage.tsx`, `AuthGuard.tsx` L14 | E |
| **S10** | **Driver PWA is a dark-only island**: `className="dark …"` on 7 roots/dialogs, `.dark` navy token set (`index.css` L133–157), tab bar `bg-[#0b1220]/95 text-[#1ea8f3]`, login/signup/install-hint slate palette, **light-only** palettes (`bg-white`, `bg-slate-50`, `amber-50`, `emerald-50`) in `SubmissionsPage`, `ScanPage`, `UnattachedPods`, `ShipmentRows`, `CurrentLoadCard` that already look wrong on the navy shell; `TrailerPicker`/`PaperworkGates` dialogs render **light** (portal outside the `.dark` root). Manifest `theme_color #1ea8f3`, `background_color #0b1220`; `<meta theme-color #1ea8f3>`; iOS `black-translucent`. | DriverScout §1–3 | G + A |
| **S11** | **Toaster** has a `/driver` carve-out (plain sonner) that S2 added to protect the dark driver look. | `TmsToaster.tsx` L51; `TmsToaster.test.tsx` L22–26 | A removes it once G lands |
| **S12** | **Public legacy pages**: `TrackPage` (`/track/:code`; hex palette `#f4f6f8 #15202b #1ea8f3`, exempted from the hex lint in `eslint.config.js`), `DriverPortalPage`+`ApplicationForm` (`/onboard/:token`; 112 `--ds-*`), `DriverDisputesPage` (`/amazon-disputes`; 38 KB, 11 `--ds-blue`). | `eslint.config.js` L40, files | E |
| **S13** | **Pre-paint theme flash only on `/tms`** (`index.html` script tests `pathname.indexOf('/tms')===0`). Legacy/driver/login would flash light for a dark-preference user. | `index.html` L16 | A (§2.5) |
| **S14** | **Dead CSS:** `.ds-kpi/.ds-dashboard/.ds-logo-pill/.ds-panel/.ds-list/.ds-pill/.ds-bar-h/.ds-section-label` (≈120 lines, 40 hex) have **zero** TSX users; `.mobile-only/.mobile-scroll-x` unused; `.sidebar*/.topbar/.app*/.menu-btn/.desktop-only` are used only by the shell being deleted. Still used: `.maint-row` (4 files), `.dot-pulse` (1), the ≤900 px inline-style reflow rules (they target `[style*=…]` of legacy pages). | grep | A |
| **S15** | **Look-pinned tests** (small): `LoadDrawer.render.test.tsx` L79–82 (`var(--ds-surface)`), `PaperworkPage.test.tsx` L450–460 (source grep for `text-white|text-slate|#0b1220`), `TmsToaster.test.tsx` L22–26, `theme.scope.test.ts`, `NavBar.test.tsx`. | greps | §10 |
| **S16** | **No HTML mail carries the BCAT Ops brand**; the only HTML mail is Best Care Auto Transport (red/black). | MailScout | §8 (decision D-2) |

### 1.2 Literal tally (node count over `src/**/*.{ts,tsx,css}`, tests excluded; "ds" = `--ds-*` + shadcn var refs; "tw" = palette utilities; "sem" = semantic utilities such as `bg-card`)
| Folder | files | LOC | hex | rgb | ds | tw | sem | `fixed` overlays |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| calendar | 12 | 4693 | 149 | 37 | 149 | 112 | 32 | 2 |
| dashboard | 15 | 3019 | 90 | 8 | 303 | 38 | 19 | 1 |
| driver-app | 42 | 8787 | 23 | 1 | 18 | 273 | 372 | 4 |
| driver-pay | 4 | 2348 | 76 | 2 | 248 | 0 | 0 | 1 |
| owner-operator-pay | 5 | 1546 | 59 | 2 | 155 | 0 | 0 | 1 |
| files | 10 | 2248 | 60 | 9 | 272 | 0 | 0 | 7 |
| fleet-dashboard | 7 | 1194 | 47 | 5 | 131 | 0 | 0 | 1 |
| driver-pay-box-trucks | 2 | 852 | 43 | 2 | 128 | 0 | 0 | 1 |
| expenses | 3 | 2211 | 25 | 0 | 83 | 131 | 101 | 1 |
| fleet-profitability | 7 | 1179 | 23 | 4 | 197 | 0 | 0 | 1 |
| finances | 7 | 1016 | 22 | 0 | 181 | 0 | 0 | 0 |
| pods | 7 | 1395 | 21 | 0 | 53 | 41 | 45 | 0 |
| trucks | 2 | 1593 | 16 | 0 | 54 | 107 | 57 | 2 |
| disputes | 6 | 2928 | 14 | 4 | 194 | 1 | 1 | 0 |
| fuel | 2 | 697 | 30 | 0 | 101 | 0 | 0 | 0 |
| loads | 5 | 2226 | 8 | 0 | 35 | 5 | 66 | 0 |
| intake | 1 | 901 | 1 | 0 | 35 | 28 | 37 | 0 |
| cash-checkin | 1 | 1495 | 3 | 1 | 140 | 0 | 0 | 0 |
| driver-portal | 3 | 954 | 6 | 3 | 112 | 0 | 0 | 0 |
| appts / dispatch | 1 / 14 | 1201 / 2027 | 9 / 15 | 0 / 3 | 107 / 208 | 0 / 2 | 9 / 1 | 0 / 1 |
| components/* (shared) + layout + ui | 33 | 2922 | 43 | 4 | 133 | 20 | 59 | 4 |
| `pages/LoginPage` | 1 | 359 | 19 | 31 | 0 | 0 | 0 | 0 |
| `index.css` | 1 | 606 | 117 | 17 | 91 | 0 | 0 | 2 |

Read: most legacy pages are **already token-driven** (`ds` column), so the unified-token + codemod step restyles them with no per-page edits; the residue is hex/rgb/tw literals and the overlays. That is why S3 is feasible in one wave.

---------------------------------------------------------------------------------------------------

## 2. Architecture — decided explicitly

### 2.1 One token source: `--tms-*` at `:root`, shadcn variables as a bridge

**theme.css (slice A).** The two token blocks keep every declaration; only their selectors widen:

```
/* light default */
:root,
.tms-shell,
.tms-portal { …unchanged declarations… }

/* dark variant */
:root[data-tms-theme='dark'],
:root[data-tms-theme='dark'] .tms-shell,
:root[data-tms-theme='dark'] .tms-portal { …unchanged declarations… }
```
Why `:root` and not only the shell: legacy pages now live inside `.tms-shell` (§2.4) and would be fine, but Radix portals (`ui/dialog`, `ui/dropdown-menu`, `ui/select`, `ui/tooltip`), sonner, the login page, the driver PWA and the public pages render **outside** it. `:root` is the one place that reaches all of them; `.tms-shell/.tms-portal` stay in the selector list so every S1/S2 rule keeps working unchanged.

* **shadcn bridge** — the S2 one-liner (`--background: var(--tms-card); --primary: var(--tms-primary); --border: var(--tms-border); …`) widens to `:root, .tms-shell, .tms-portal`. `index.css` loses its own `:root` shadcn values and its `.dark` block. Tailwind's `@theme inline` (`--color-background: var(--background)` …) is untouched, so `bg-background`, `text-muted-foreground`, `border-border`, `ring-ring`, `bg-primary` resolve through the bridge to the green tokens in both themes with **no edit to the 14 dialog / 39 button / 14 input consumers**.
* **border default** — the S2 layered rule widens from `.tms-shell *, .tms-portal *` to `*, ::before, ::after` inside the same `@layer base { … }` (Tailwind v4's bare `border` is `currentColor` **[INFERENCE, S2 G2 — confirmed or refuted by the first S2 screenshot run; either way the global default is harmless]**).
* **`index.css` shrinks** to: Tailwind imports; `@theme inline` colour map (the `--color-blue*/success/warning/danger` extras are deleted — no TSX uses `text-blue`/`bg-success`; builder A greps first); `body { background: var(--tms-bg); color: var(--tms-text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 14px }` (Geist Sans and its `ss01/cv11` features go; Geist **Mono** stays — 58 `var(--font-mono)` uses — and so does the Google Fonts `<link>` for it, the Geist Sans weight list is dropped); `.maint-row`, `.dot-pulse`, `ds-dot-pulse`; the ≤900 px inline-style reflow block (§2.4.4, selectors renamed); the `calendar.css` import. **Deleted:** every `--ds-*`, `--sh-*`, `.dark`, `@custom-variant dark` (no `dark:` utility exists in `src/` — only `index.css` and one string in `lib/carrierRateCon.ts`), `.ds-*`, `.app*`, `.sidebar*`, `.topbar`, `.menu-btn`, `.desktop-only`, `.mobile-only`, `.mobile-scroll-x`, `.app-backdrop`, `.page-content` (S14).
* **`theme.scope.test.ts` is retargeted, not loosened** (§10): the "every selector starts with `.tms-shell/.tms-portal`" assertion becomes "…or is one of the two token blocks / the bridge / the `*` border default"; dark-parity and no-literals-outside-token-blocks stay.

### 2.2 `--ds-*` / `--sh-*` → `--tms-*` (Phase-0 codemod, slice A)
Cleaner than aliases (repo rule: clean cutover) and cheaper than hand edits: one deterministic script, `scripts/s3Codemod.mjs` (throwaway; removed in cleanup), balanced-paren aware so `var(--ds-blue-soft, #eff6ff)` and `var(--sh-lg, -10px 0 40px rgba(0,0,0,.2))` lose their fallbacks cleanly. Runs over `src/**/*.{ts,tsx,css}` **excluding** `src/features/tms/**` (already tokens), tests, and `index.css` (A edits that by hand).

| Old | New | Note |
|---|---|---|
| `--ds-bg` | `--tms-bg` | page canvas |
| `--ds-bg-2` | `--tms-surface` | |
| `--ds-bg-3` | `--tms-surface-hover` | |
| `--ds-surface`, `--ds-card` | `--tms-card` | |
| `--ds-border`, `--ds-border-soft` | `--tms-border` | |
| `--ds-border-strong` | `--tms-input-border` | |
| `--ds-t1` / `--ds-t2` / `--ds-t3` | `--tms-text` / `--tms-text-2` / `--tms-muted` | |
| `--ds-muted` / `--ds-muted-soft` | `--tms-text-2` / `--tms-disabled` | |
| `--ds-blue` | `--tms-primary` | **brand/CTA/link/active.** See "info-blue review" below. |
| `--ds-blue-dark` | `--tms-primary-ink` | |
| `--ds-blue-bg`, `--ds-blue-soft` | `--tms-primary-tint` | |
| `--ds-green` / `--ds-red` / `--ds-amber` / `--ds-violet` | `--tms-badge-green` / `-red` / `-orange` / `-purple` | text/ink |
| `--ds-green-bg` / `-red-bg` / `-amber-bg` / `-violet-bg` / `-cyan-bg` and `-soft` forms | `--tms-badge-green-tint` / `-red-tint` / `-orange-tint` / `-purple-tint` / `-turquoise-tint` | |
| `--sh-sm`, `--sh-md` / `--sh-lg` | `--tms-shadow` / `--tms-shadow-pop` | |
| `--ds-surface1`, `--ds-surface2`, `--ds-accent` | **not mapped — reported** (undefined today, 8 uses) | owning builder chooses by context |

**Info-blue review (builders, after Phase 0).** Mapping `--ds-blue` to the green primary is right for brand uses (buttons, links, active tabs, focus) and **wrong where blue meant "informational / in-transit / category"** — e.g. a status map with green = delivered, amber = late, blue = in transit would now show two greens. Rule for every owner: in each file that contains **both** `--tms-primary` (from the codemod) **and** another `--tms-badge-*` colour inside the same status/series/legend expression, change the primary hit to `--tms-badge-blue` (ink) / `--tms-badge-blue-tint` (fill), or `--tms-chart-5` for chart series. Phase 0's report lists those files (`blue-near-status: file:line`) so no one has to hunt.

**Hex mapping (exact-match only; the rest stays for the builders and trips the lint).** Applied only when the property context is unambiguous: `color:'#fff'|'#ffffff'` → `var(--tms-on-primary)`; `background(Color):'#fff'|'#ffffff'` → `var(--tms-card)`; `#1ea8f3`/`#3bb5f5`/`#0d8fd9`/`#0b8fd9` → `var(--tms-primary)`; `#0369a1` → `var(--tms-primary-ink)`; `#15803d`/`#16a34a` → `var(--tms-badge-green)`; `#b91c1c`/`#dc2626` → `var(--tms-badge-red)`; `#b45309` → `var(--tms-badge-orange)`; `#e2e8f0` in a `border*` property → `var(--tms-border)`; `#f1f5f9`/`#f8fafc`/`#f1f4f9`/`#f4f7fb` as a background → `var(--tms-surface)` / `var(--tms-bg)`; `#0f172a`/`#0b1220`/`#0a0a0a` as `color` → `var(--tms-text)`; `#64748b`/`#6b7588`/`#4a5568` as `color` → `var(--tms-muted)` / `var(--tms-text-2)`. Anything else (gradients, rgba overlays, per-driver identity colours, chart hex) is reported as `residue: file:line value`.

### 2.3 Tailwind palette → semantic (same Phase-0 script; driver-app, expenses, calendar, trucks, pods, intake, hours, dashboard)
| Pattern | Becomes |
|---|---|
| `bg-white` | `bg-card` |
| `bg-slate-50/100`, `bg-gray-50/100`, `bg-neutral-*` | `bg-muted` |
| `text-slate-900/800/700`, `text-gray-900/800/700`, `text-black` | `text-foreground` |
| `text-slate-600/500/400`, `text-gray-600/500/400` | `text-muted-foreground` |
| `border-slate-*`, `border-gray-*`, `divide-slate-*`, `ring-slate-*` | `border-border` / `divide-border` / `ring-ring` |
| `text-white` on a coloured fill | `text-primary-foreground` (on `bg-primary`) or `text-[color:var(--tms-on-primary)]` |
| `bg-blue-*/sky-*/indigo-*`, `text-blue-*…`, `from-[#3bb5f5] to-[#1ea8f3]` | brand → `bg-primary` / `text-primary`; info → see info-blue rule |
| status hues: `emerald|green` → green, `amber|yellow|orange` → orange, `red|rose` → red, `sky|blue|cyan|indigo` → blue, `violet|purple|fuchsia` → purple | weights 50–200 → `bg-[color:var(--tms-badge-X-tint)]` (border: `border-[color:var(--tms-badge-X)]`); 300–900 as text → `text-[color:var(--tms-badge-X)]`; solid fills 400–600 → `bg-[color:var(--tms-badge-X)]`; any `/NN` alpha suffix is dropped |
| overlay `bg-black/NN` on a `fixed inset-0` scrim | `bg-[color:var(--tms-overlay)]` (but the modal itself is converted, §4) |
| **Left alone (reported, not rewritten):** `bg-black`, `text-white`, `border-white/NN` inside `driver-app/scanner/ScanCamera.tsx` (camera must stay black), `DocPreviewSheet` `bg-white` paper (marked `data-tms-paper`) | the file carries an `eslint-disable-next-line … -- camera` / `-- paper` per site |

Why mechanical is safe: every target class is a Tailwind utility reading a CSS variable that §2.1 now defines in both themes, so a wrong guess shows as a mis-tinted chip (visible in the screenshot pass) rather than a break.

### 2.4 One shell: the legacy pages run inside `TmsShell`

#### 2.4.1 Routing (App.tsx — slice A)
```tsx
<Route element={<TmsLayout />}>                  {/* the ONE staff layout */}
  <Route path="/tms">…existing /tms children, unchanged…</Route>   {/* path-only parent: <Outlet/> */}
  <Route index element={<LandingRedirect />} />
  …every legacy route and redirect exactly as today, minus <Route element={<AppLayout/>}>…
</Route>
```
`TmsLayout` decides the mode from the URL: `const legacy = !pathname.startsWith('/tms')`. `AppLayout.tsx`, `NavBar.tsx`, `Topbar.tsx`, `NavBar.test.tsx` are **deleted**; AppLayout's three duties move to a `LegacyRuntime` child that `TmsLayout` mounts only in legacy mode: (a) `useAppStore.initializeData(user.email)`, (b) the `isDesktop` media query (`min-width: 901px`), (c) `<DispatchDrawer key={user.email} isDesktop />` as the shell `aside`. `/tms` pages keep paying nothing for them.

#### 2.4.2 `fill` mode (the S5 fix)
`TmsShell` gains `fill?: boolean` and `aside?: ReactNode` (additive; both default off, so every S1/S2 caller and test is unchanged):

| Piece | Rule (shell.css, slice A) |
|---|---|
| `.tms-shell.tms-fill` | `height: 100dvh; min-height: 0; overflow: hidden` |
| `.tms-shell.tms-fill .tms-content` | `height: 100dvh; padding-bottom: var(--tms-shell-gap)` |
| `.tms-shell.tms-fill .tms-main` | `flex: 1 1 auto; min-height: 0; padding: var(--tms-shell-gap) 0 0; display: flex; gap: var(--tms-gap)` |
| `.tms-legacy-host` (rendered by `TmsLayout` around `<Outlet/>`) | `flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; font-variant-numeric: tabular-nums` — i.e. exactly `.page-content` (`flex:1; overflow:hidden`), so **every legacy page keeps the `height:100%` contract it was written against** |
| `.tms-aside` (DispatchDrawer card) | `flex: 0 0 400px; min-height: 0; background: var(--tms-card); border: 1px solid var(--tms-border); border-radius: var(--tms-radius-card); overflow: hidden` |
| ≤ 900 px | `.tms-legacy-host { overflow: auto; -webkit-overflow-scrolling: touch }` (the old `.page-content` phone rule — wide tables scroll, the page does not clip them) |

`/tms/*` routes stay page-scroll (no `fill`). The two scroll models are visually identical (top bar always visible, same gutters, same canvas) — the difference is where the scrollbar lives, which is why pages are **not** rewritten to page-scroll (calendar/dispatch could not be).

#### 2.4.3 Parity matrix (legacy → unified shell)
| Legacy (`NavBar`/`Topbar`/`AppLayout`) | Unified `TmsShell` | Status |
|---|---|---|
| Nav sections, pinned items, permission gating, labels | same `buildNavSections` (already shared) | ✓ identical |
| 12 nav badges (`loads, intake, appts, maintenance, review, truckDocs, dispatch, checkCalls, documentReview, arToInvoice, apToReview, quotesToReply`) | `useShellBadgeCounts` (§2.4.5); `TmsShell` already renders `badgeCounts[badgeKey]` for any key | ✓ — also *adds* the previously-missing counts to the `/tms` rail |
| Collapsible rail (`bcat.sidebar.collapsed`) | `tms-sidebar-collapsed` | ✓ (preference restarts expanded once) |
| Phone hamburger + off-canvas drawer + backdrop | new in `TmsShell` (§2.4.4) | ✓ for both shells |
| **Company switcher** | `CompanySwitcher` (folds sections per business, `useTmsCompany`) | ✓ new on legacy routes — same component |
| **Theme toggle** | topbar `.tms-theme-toggle` (`aria-label="Switch to dark theme"`) | ✓ new on legacy routes |
| **Log out** | `.tms-logout` (`aria-label="Log out"`) | ✓ (legacy was `aria-label="Sign out"`; one tests-visible rename) |
| Bell (stub, no behaviour) | bell → `/tms/check-calls` with due count | ✓ improved |
| Settings gear (→ `/tms/brokerage`) | "My Brokerage" rail item, same `settings` gate | ✓ (gear dropped, destination kept) |
| Search: Enter → `/tms/shipments?q=` | `TmsShell` search → same destination | ✓ (note below) |
| Breadcrumb `BCAT Ops › {page}` | breadcrumb extended to legacy paths (§2.4.5) | ✓ |
| `DispatchDrawer` right column, hideable, not on `/dispatch`, not on phones | `aside` slot, same component, same rules | ✓ |
| `initializeData` on login | `LegacyRuntime` | ✓ |
| Quick Add button, "Live · Ns" ticker, topbar→Calendar live filter, duplicate "Users" link, logo tile + "Operations Command Center" | — | ✗ dropped (D-5; logo tile was already dropped on `/tms` in S1) |

*Search note (pre-existing, not S3):* `TmsShell.handleQuery` calls `onSearch` on every keystroke and `TmsLayout` navigates to `/tms/shipments?q=…`, so the first character typed on **any** page jumps to Shipments. On legacy pages the old Topbar only navigated on Enter. S3 does not change this; if Ryne wants Enter-only, it is a one-line change in `TmsShell` (`onSearch` on submit only) and must be done for both shells together. Flagged in §12.

#### 2.4.4 Phone drawer (D-3) — slice A
At ≤ 900 px (`shell.css`): `.tms-sidebar` becomes `position: fixed; inset: 0 auto 0 0; width: min(84vw, 300px); transform: translateX(-110%); transition: transform .2s; z-index: 90`; `.tms-shell.tms-nav-open .tms-sidebar { transform: none }`; `.tms-nav-backdrop { position: fixed; inset: 0; background: var(--tms-overlay); z-index: 80 }`; `.tms-content { margin-left: 0; padding-left: var(--tms-shell-gap) }`; `.tms-menu-btn` (hamburger `<button aria-label="Open menu" aria-expanded>` at the start of the top bar) is `display:none` above 900 px; collapsed-rail state is ignored on phones (full labels in the drawer — the old drawer rule); `.tms-search` hidden ≤ 640 px (the old `.desktop-only` search). `TmsShell` closes the drawer on nav-link click, backdrop click and `Escape`; focus returns to the hamburger. The 76 px `@media (max-width:900px)` block in `shell.css` L651–690 is replaced, not extended. The tap-target rule (`button, a[role=button] { min-height: 40px }` at ≤ 900 px) moves to `.tms-shell` scope.

#### 2.4.5 Badge resolver, breadcrumb, titles — slice A
```ts
// src/features/tms/useShellBadgeCounts.ts  (new; TmsLayout calls it)
export function useShellBadgeCounts(args: {
  shipments: ShipmentListRow[]; userId: string; staffById; staff; myTeamKeys: string[]
}): Record<string, number>
// keys: myQueue, teamQueue, tracking                          (today's TmsLayout set — logic moved verbatim)
//       loads, maintenance, intake, appts, review, truckDocs, dispatch, checkCalls,
//       documentReview, arToInvoice, apToReview, quotesToReply (NavBar.getBadgeCount — logic moved verbatim)
// Zero/absent → key omitted (TmsShell renders no badge for 0). Every sub-hook keeps the page-access gate it has today.
```
`NavBar.test.tsx`'s three real assertions (a nav item is hidden without its grant; every `badgeKey` in the nav config is answered by the resolver — the "wired but never answered" bug; fleet-only users group under the asset business) are **ported** to `TmsShell`/`useShellBadgeCounts` tests (§10), not dropped.

`tmsBreadcrumb(pathname, views)` (in `navSections.ts`) falls through to `ITEM_POOL` (all nav defs, longest prefix wins) before returning `[{label:'TMS'}]`, so `/trucks` → `Fleet`, `/driver-pay` → `Driver pay`. Non-nav routes get an explicit table:
| Path | Crumbs |
|---|---|
| `/finances/review` | Finances › Profit review |
| `/finance/cash-checkin` | Cash check-in |
| `/driver-view/:id` | Owner operator pay › Driver app |
| `/truck-docs` | Truck documents |
| `/ivan-driver-app` | Ivan driver app |
| `/invoices` | Invoices |
| unknown | `titleCase(first segment)` (never `TMS` on a legacy path) |

#### 2.4.6 Kit addition for legacy page heads (slice A) — `TmsScrollPage`
Almost every K-level page opens with the same hand-built block: a sticky white band, `h1` 20 px, a subtitle line, right-aligned buttons, sometimes a filter row. One kit piece replaces it and gives all of them the S2 head:
```ts
// kit/TmsScrollPage.tsx
export interface TmsScrollPageProps {
  title: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode
  actions?: ReactNode                 // right side of the title row (buttons)
  toolbar?: ReactNode                 // filter/tab row directly under the title row
  width?: 'full' | 'wide'             // 'wide' (default) = max-width 1400px centred; 'full' = edge to edge
  scroll?: boolean                    // default true: root is height:100%; overflow-y:auto. false: height:100%; display:flex column; overflow:hidden; body is flex:1; min-height:0 (calendar/dispatch-style pages)
  stickyHead?: boolean                // default false; true pins title row + toolbar (the old sticky band)
  className?: string; 'data-testid'?: string
  children: ReactNode
}
export function TmsScrollPage(p: TmsScrollPageProps): JSX.Element
// <div class="tms-scroll-page [tms-scroll-page-fill]"> <div class="tms-page-head">…same h1/actions classes as TmsPage…</div> [toolbar] <div class="tms-scroll-body">children</div> </div>
// h1 is the page's only h1. Reuses TmsPage's `.tms-page-head/.tms-page-actions`; adds `.tms-scroll-page*` in kit.css.
```
It is *not* a replacement for `TmsPage` (page-scroll, `/tms`); it is its fixed-host sibling. Barrel-exported; kit files import each other directly (S2 rule).

### 2.5 Theme, pre-paint and PWA colours (slice A; G and E consume)
* **Pre-paint script** (`index.html`): drop the `/tms` test, add the negative public list:
  `try{var p=location.pathname;if(!/^\/(track|sign|quote|onboard|amazon-disputes)(\/|$)/.test(p)&&localStorage.getItem('tms-theme')==='dark')document.documentElement.setAttribute('data-tms-theme','dark')}catch(e){}` — staff pages, login, `/driver/*` honour the stored preference with no flash; public tokenised pages stay light (S2 rule).
* **`useTmsTheme` contract is unchanged** (apply in `useLayoutEffect`; remove on unmount so a surface that does not call it — a public page — never inherits dark). Callers: `TmsShell` (all staff pages now), `LoginPage` (read-only apply, no toggle), `DriverApp`/`DriverLoginPage`/`DriverSignupPage` (G). The existing `tmsTheme.test`/`TmsShell.test` assertions stay valid.
* **`theme-color` sync:** after applying, `useTmsTheme` sets `<meta name="theme-color">` to `readTmsToken('--tms-topbar')` (`#ffffff` light / `#181818` dark), so the browser/PWA chrome follows the toggle on every surface that calls the hook. `index.html` default is `#ffffff`; `vite.config.ts` manifest `theme_color` is `#ffffff` and `background_color` is `#f3f6f4` (the light `--tms-bg`: a manifest cannot switch per theme, so the splash is light). A tiny test (`pwaColors.test.ts`, §10) pins manifest = meta = tokens so a token change cannot silently strand the PWA colours.
* **iOS** (D-7): `apple-mobile-web-app-status-bar-style` → `default`; `viewport-fit=cover` stays; the driver shell pads `env(safe-area-inset-top)` with `--tms-topbar` so the inset belongs to the app.
* **`color-scheme`** is already set per theme in the token blocks; at `:root` it now also themes native scrollbars/inputs on every surface.

### 2.6 R versus K — what each route gets (the explicit "re-token vs rebuild" list)
* **Tier 0 (free, slice A, every non-TMS surface):** colours, canvas, text, borders, shadcn primitives (Button/Dialog/Input/Select/Tooltip/Sheet/Toggle/Switch/Label), toasts, scrollbars, focus ring, dark variant — via §2.1–2.3.
* **R — re-token only** (builder removes residual literals, adds `data-user-color`/`data-tms-paper` where a surface is intentionally data/paper, converts hand-built modals): `/calendar` (FullCalendar + Planner/Grid/Compact views), `/dispatch` + `DispatchDrawer` (chat threads), `/appts` (dense table), dashboard map/chart widgets, `/trucks` (76 KB single file), `/finances` charts, `/cash-checkin`, `/fleet-profitability` panels, `/disputes`, `/expenses` manage view, driver-app scanner overlays.
* **K — re-token + kit chrome**, only where the file already has the pattern (no new behaviour, no new data): page head → `TmsScrollPage`; KPI tile sets → `TmsStatRow`; status pills/chips → `TmsBadge` (tone via `statusTone` or an explicit map to `TmsTone`); list-or-"No …" blocks → `TmsEmptyState` (`compact` inside cards); hand-built modals/panels → `TmsDialog`/`TmsDrawer`; plain `<table>` with inline th/td styles → adopt `className="tms-table"` (the S2 table look) without touching rows/columns; alert-looking boxes → `TmsAlert`; label/value `dl`-like rows → `TmsMetaList`.
* **Never converted** (S2 R5 analog): form controls, grid templates, dynamic widths, maps, charts' structure, anything that needs a handler change. A page is "done" when it has no legacy colour, no hand-built overlay and — if K — its head and obvious kit patterns.

---------------------------------------------------------------------------------------------------

## 3. Route inventory — every route in `src/App.tsx` outside `/tms/*`

Slice letters per §0.3. **Lvl**: R = re-token, K = re-token + kit chrome (§2.6), P = rebuild on `TmsPublicFrame`, S = screen of the shell/auth, — = no UI. Paths under `src/features/` unless absolute. "Overlays" are the §4 items rendered by that route.

### 3.1 Staff app — inside the unified shell (`TmsLayout`, legacy `fill` mode)
| # | Route | Page key | Component (file) | Overlays / sub-surfaces | Lvl | Slice |
|---|---|---|---|---|:-:|:-:|
| 1 | `/` (index) | — | `components/RequirePage.tsx` `LandingRedirect` → preferred landing; `NoAccess` when nothing granted | `NoAccess` card | S | A |
| 2 | `/dashboard` | `dashboard` | `dashboard/DashboardPage.tsx` + 14 widgets (`TruckMapWidget`, `DriverLeaderboardWidget`, `YearProfitWidget`, `PerMileWidget`, `DieselPriceWidget`, `MonthlyComparisonWidget`, `OpenTasksWidget`, `VendorApCard`, `FleetMiniMap`, `TrackingLinkCell`, `PerMileKpis` …) | `OpenTasksWidget` Add-task modal (fixed overlay); recharts colours (`YearProfit`, `MonthlyComparison`, `PerMile`, `DieselPrice`) | K | B |
| 3 | `/calendar` | `calendar` | `calendar/CalendarPage.tsx`, `CalendarToolbar`, `GridCalendarView`, `PlannerView`, `SchedulerView`, `CompactWeekView`, `MobileLoadAgenda`, `CalendarPaperwork`, `calendar.css` (FullCalendar overrides, ~30 hex) | `DriverAvailabilityModal` (fixed), `GridCalendarView` picker popover, `ShipmentDrawer` (S2 `TmsDrawer`, already done), `ApptEditPopover` | R | B |
| 4 | `/dispatch` | `dispatch` | `dispatch/DispatchPage.tsx`, `DispatchDialogs`, `Thread`, `ConversationList`, `DriverSchedulePanel`, `RouteStrip`, `MediaThumb`, `driverWhereabouts` | `DispatchDialogs` (ui/dialog), message bubbles | R | B |
| 4a | *(every legacy route)* `DispatchDrawer` | `dispatch` | `dispatch/DispatchDrawer.tsx` → `DispatchPage compact` | right `aside` card + corner button | R | B |
| 5 | `/appts` | `appts` | `appts/ApptsPage.tsx` (59 KB) | `components/ApptEditPopover`, `ApptProofPanel` (fixed email modal) | R | B |
| 6 | `/driver-info` | `dispatch` | `driver-info/DriverInfoPage.tsx`, `IvanPhones.tsx` | — | K | C |
| 7 | `/fleet-dashboard` | `fleetManagerDashboard` | `fleet-dashboard/FleetManagerDashboardPage.tsx` + `FaultCodes/PmDue/ExpiringTruckDocs/RepairSpend/MaintenanceTasks/DotDue` widgets | `PmDueWidget` PM modal (fixed); `RepairSpendWidget` recharts | K | C |
| 8 | `/trucks` | `trucks` | `trucks/TrucksPage.tsx` (76 KB), `TruckParking.tsx` | **2 fixed modals** (Add Maintenance Task, Add Invoice; Tailwind `bg-white rounded-2xl`) | R | C |
| 9 | `/truck-docs` | `truckDocs` | `truck-docs/TruckDocumentsPage.tsx` | — | K | C |
| 10 | `/maintenance` | `maintenance` | `maintenance/MaintenancePage.tsx`, `maintenanceUi.tsx` | `maintenanceUi` `Modal` (fixed, `rgba(15,23,42,.32)`, blur) | K | C |
| 11 | `/fuel` (also `/expenses` → redirect) | `fuel` | `fuel/FuelPage.tsx`, `TruckMpgTable.tsx` (+ imports `expenses/*`) | uses `expenses/FuelUploadModal` (D-owned) | K | C |
| 12 | `/insurance` | `insurance` | `insurance/InsurancePage.tsx` | — | K | C |
| 13 | `/hours` | `hours` | `hours/HoursPage.tsx` | — (Tailwind semantic utilities already) | K | C |
| 14 | `/schedule` | `schedule` | `schedule/SchedulePage.tsx` | — | K | C |
| 15 | `/time-off` | `timeOff` | `time-off/TimeOffPage.tsx`, `TimeOffFormModal.tsx` | `TimeOffFormModal` (fixed) | K | C |
| 16 | `/tasks` | `tasks` | `tasks/TasksPage.tsx` | — | K | C |
| 17 | `/intake` | `intake` | `intake/IntakePage.tsx` (36 KB; Tailwind palette ×28) | queue cards/rows | K | C |
| 18 | `/vehicle-quote` | `vehicleQuote` | `vehicle-quote/VehicleQuotePage.tsx` | e-mail **preview pane** renders the Best Care HTML (stays red, D-2) | K | C |
| 19 | `/vehicle-confirmation` | `vehicleConfirmation` | `vehicle-confirmation/VehicleConfirmationPage.tsx` | same preview pane | K | C |
| 20 | `/reddit-queue` | `redditQueue` | `reddit-queue/RedditQueuePage.tsx` | — | K | C |
| 21 | `/pricing-margin` | `pricingMargin` | `pricing-margin/PricingMarginPage.tsx` | — | K | C |
| 22 | *(drawer)* driver file | — | `drivers/DriverDrawer.tsx` (opened from `/files`; frame = `files/SidePanel`, E) | `SidePanel` | R | C |
| 23 | `/finances` | `finances` | `finances/FinancesPage.tsx` → `CombinedMonthlyProfit`, `AmazonDriverProfit`, `OwnerOperatorProfitPanel`, `DispatchCostsCard`, `FleetExpensesCard`, fleet-profitability sections | recharts | K | D |
| 24 | `/finances/review` | `finances` | `finances/ProfitReviewPage.tsx` (39 KB) | — | R | D |
| 25 | `/finance/cash-checkin` | `cashCheckIn` | `cash-checkin/WeeklyCashCheckInPage.tsx` (60 KB; recharts) | — | R | D |
| 26 | `/invoices` | `invoices` | `invoices/InvoicesPage.tsx` | column-filter popover with fixed click-catcher (L216) | K | D |
| 27 | `/driver-pay` | `driverPay` | `driver-pay/DriverPayPage.tsx` (52 KB), `DriverPayForms.tsx`, `FixedExpenseEditor.tsx` | **`Modal` (fixed)**; settings/credit modals | K | D |
| 28 | `/driver-pay-box-trucks` | `driverPayBoxTrucks` | `driver-pay-box-trucks/BoxTruckPayPage.tsx`, `BoxTruckPayForms.tsx` | **`Modal` (fixed, duplicate of #27)** | K | D |
| 29 | `/owner-operator-pay` | `ownerOperatorPay` | `owner-operator-pay/OwnerOperatorPayPage.tsx`, `OwnerOperatorPayForms.tsx`, `SettlementDocUpload`, `SendDriverInvite` | **`Modal` (fixed, duplicate)** | K | D |
| 30 | `/ivan-driver-app` | `ivanDriverApp` | `ivan-driver-app/IvanDriverAppPage.tsx`, `IvanDriverWeek.tsx` | — | K | D |
| 31 | `/driver-view/:driverId` | `ownerOperatorPay` | `owner-operator-pay/DriverAppViewPage.tsx` — renders the **driver's own** `SettlementPage/PaperworkPage/TimeClockPage` in a 390 px frame through the driver API's admin-impersonation path, which the API restricts to a hard-coded list (`IMPERSONATION_ADMINS = ryne@, dennis@bcatcorp.com`, `driver-app-api/handler.ts` L218) — so the harness's temp admin gets the **denied** state there, see §9.5 | phone frame | K | D |
| 32 | *(no route; used by `/fuel`)* | — | `expenses/ExpensesPage.tsx` (55 KB, Tailwind ×131), `ExpenseManageView.tsx`, `FuelUploadModal.tsx` | `FuelUploadModal` (fixed, `bg-white rounded-2xl`) | R | D |
| 33 | *(sections of #23)* | — | `fleet-profitability/*` (`MonthlyFleetPL`, `RevenueAuditPanel`, `FleetProfitabilitySection`, `FleetPLTrendChart`, `DriverPayForm`) | `DriverPayForm` modal (fixed) | K | D |
| 34 | `/disputes` | `disputes` | `disputes/DisputesPage.tsx` (49 KB), `StatusUpdateModal`, `EvidenceGallery`, `FileDrop` | `StatusUpdateModal` (via `maintenanceUi.Modal`, C) | R | E |
| 35 | `/files` | `files` | `files/FilesPage.tsx`, `EntityFilePanel`, `DriverOnboardingSection`, `TruckOnboardingSection`, `InviteDriverModal`, `PacketPickerModal`, `PrivateDocsModal`, `DocumentPreviewModal`, `SidePanel` | **7 fixed overlays** (§4) | K | E |
| 36 | `/pods` | `pods` | `pods/PodsPage.tsx`, `PodReviewPanel`, `PodCard`, `PodPreviewDialog`, `PodShared`, `LoadPods` | `PodPreviewDialog` | K | E |
| 37 | *(opened from calendar/appts/pods/intake/tasks/fleet-dashboard/owner-op)* load drawer | — | `loads/LoadDrawer.tsx` (39 KB), `legForm.tsx`, `LoadDriverDocs`, `LoadPodNotes` | `ui/dialog` ×2, `SidePanel` | R | E |
| 38 | *(opened from FilesPage / dashboard)* | — | `compliance/{EmailSettingsCard,EscalationRulesCard,components,DriverApplicationView}.tsx`, `driver-docs/DriverDocUploadDialog` | dialog | K | E |

### 3.2 Redirect-only routes (no UI; `devVerifyS3` asserts each lands where it should)
`/loads`→`/tms/shipments` · `/shipments`, `/shipments/:id`, `/check-calls`, `/documents`, `/factoring`, `/ar`, `/ar/invoices/:id`, `/ap`, `/ap/bills/:id`, `/vendor-ap`, `/customers`, `/locations`, `/carriers`, `/carriers/:id`, `/quotes`, `/quotes/new`, `/quotes/:id`, `/rates`, `/commissions`, `/reports`, `/settings`, `/settings/integrations(/:provider)`, `/audit-log`, `/audit`, `/users`, `/grid` → their `/tms/*` home (via `ParamRedirect`) · `/drivers`, `/compliance`, `/compliance/onboarding`, `/compliance/review`, `/compliance/driver/:id`, `/compliance/truck/:id` → `/files` · `/expenses` → `/fuel`. **There is no catch-all route**: an unknown path renders the shell with an empty host (unchanged by S3; flagged in §12).

### 3.3 Sign-in and gate screens
| Surface | File | Notes | Lvl | Slice |
|---|---|---|:-:|:-:|
| Staff sign-in (+ "Set new password" mode, error banner, forgot link) | `pages/LoginPage.tsx` (359 LOC) | Rendered by `AuthGuard` at *any* URL while signed out. Rebuilt light-green (§6 E). **No test exists** — a render/behaviour test is added (§10). | P | E |
| Auth loading screen | `components/AuthGuard.tsx` L12–19 (`#07122b`) | tokens; shows the logo-less spinner on `--tms-bg` | P | E |
| "No page access" | `components/RequirePage.tsx` `NoAccess` | already `var(--tms-*, var(--ds-*))` fallbacks — fallbacks removed | S | A |
| Update banner | `components/UpdateBanner.tsx` | inverse pill → `--tms-tooltip-bg/-ink` | S | A |
| Toasts | `kit/TmsToaster.tsx` | `/driver` carve-out removed | S | A |

### 3.4 Public pages not already done in S2
| Route | Component | Lvl | Slice |
|---|---|:-:|:-:|
| `/track/:code` (truck tracking) | `tracking/TrackPage.tsx` — **eslint exemption in `eslint.config.js` L40 removed** | P | E |
| `/onboard/:token` (driver onboarding portal) | `driver-portal/DriverPortalPage.tsx` (21 KB), `ApplicationForm.tsx` (23 KB), `portalApi.ts` (logic) | P | E |
| `/amazon-disputes` (driver dispute portal) | `disputes/DriverDisputesPage.tsx` (38 KB), `FileDrop`, `EvidenceGallery` (shared with #34 — E owns both) | P | E |
| *(S2, done: `/track/s|l|u/:token`, `/sign/rate-con/:token`, `/quote/:token`)* | — | — | — |

### 3.5 Driver PWA (`/driver/*`, separate Cognito pool, outside `AuthGuard`)
| Route / state | Component | Slice |
|---|---|:-:|
| loading, profile-error (the "We couldn't load your driver profile" screen) | `DriverLoading`, `DriverProfileError` — **moved out of `App.tsx` in Phase 0** into `driver-app/DriverRoutes.tsx` | G |
| `/driver/login` (sign-in · forgot · reset-code modes) | `DriverLoginPage.tsx` (≥282 LOC), `InstallHintSection` | G |
| `/driver/signup` (form · confirm · done) | `DriverSignupPage.tsx` (≥311 LOC), `InstallHintSection` | G |
| shell + tab bar + `OnTheClockBar` + `DispatchBar` | `DriverApp.tsx` (`TabButton`) | G |
| `/driver` index → `DriverLanding` | `DriverRoutes.tsx` | G |
| `/driver/settlement` | `settlement/SettlementPage`, `StatementCard`, `ShipmentRows`, `DocPreviewSheet` (fixed sheet) | G |
| `/driver/paperwork` | `paperwork/PaperworkPage`, `TodayStops`, `DayLogs`, `HosPanel`, `PmGauge`, `PaperworkGates` (Dialog) | G |
| `/driver/timeclock` | `timeclock/TimeClockPage`, `OnTheClockBar` | G |
| `/driver/loads` | `SubmissionsPage.tsx` | G |
| `/driver/scan` | `scanner/ScanPage`, `PagePicker`, `ScanCamera` (3 full-screen overlays) | G |
| `/driver/account` | `AccountPage.tsx` (+ theme toggle, new), `ReportIssue` (Dialog), `TruckPicker`/`TrailerPicker` (Dialogs), `CurrentLoadCard`, `UnattachedPods` | G |

### 3.6 Non-overlap check (folder → exactly one owner)
`dashboard, calendar, dispatch, appts` + `components/{ApptEditPopover,ApptProofPanel,DriverFilterMenu,TruckAssignSelect}` + `lib/{driverColors,apptStatus}.ts` → **B** · `trucks, truck-docs, maintenance, fleet-dashboard, fuel, insurance, hours, schedule, time-off, driver-info, drivers, tasks, intake, reddit-queue, pricing-margin, vehicle-quote, vehicle-confirmation` → **C** · `finances, fleet-profitability, cash-checkin, expenses, invoices, driver-pay, driver-pay-box-trucks, owner-operator-pay, ivan-driver-app` → **D** · `files, loads, pods, disputes, compliance, driver-docs, driver-portal, tracking/TrackPage.tsx, pages/LoginPage.tsx, components/AuthGuard.tsx` → **E** · `driver-app/**, vite.config.ts` → **G** · everything else non-TMS (`index.css`, `index.html`, `eslint.config.js`, `App.tsx`, `components/{layout,ui,charts}/**`, `components/{RequirePage,UpdateBanner,DriverAutoUpdate}.tsx`, `lib/ui/**`, `lib/navSections.ts`, `features/tms/**`) → **A**. The S2-done TMS folders (`ap, ar, audit, carriers, commissions, directory, documents, factoring, quotes, reports, settings, shipments, tracking/* except TrackPage, users, vendor-ap, workflows`) are **not touched** except where A edits a shared kit/shell file. A file one slice needs changed in another's list → `hub` message to the owner, never a direct edit.

---------------------------------------------------------------------------------------------------

## 4. Hand-built overlays — inventory and the one conversion rule

Found by grepping `position:'fixed'` / `fixed inset-0` / `role="dialog"` across `src/features` and `src/components`. Each becomes a kit overlay **keeping its public props and mount semantics** (they are conditionally mounted with an `onClose`, so the conversion is `<TmsDialog open onOpenChange={(o) => { if (!o) onClose() }} title=… footer=…>`; the unconditional `open` is intentional).

| File:line | Today | Becomes | Slice |
|---|---|---|:-:|
| `dashboard/OpenTasksWidget.tsx` L160 | `fixed inset-0 bg-black/40` + `bg-white rounded-2xl` | `TmsDialog` | B |
| `calendar/DriverAvailabilityModal.tsx` L77 | fixed, `rgba(0,0,0,.45)` | `TmsDialog` | B |
| `calendar/GridCalendarView.tsx` L530 | fixed popover (z 9999) positioned from `pickerPos` | stays a positioned popover; tokens only, `className="tms-portal"` | B |
| `components/ApptProofPanel.tsx` L299 | fixed email modal | `TmsDialog` (wide) | B |
| `dispatch/DispatchDrawer.tsx` L44 | fixed corner button | stays; tokens | B |
| `trucks/TrucksPage.tsx` L489, L572 | two `fixed inset-0 bg-black/40` + `bg-white rounded-2xl` | `TmsDialog` ×2 | C |
| `maintenance/maintenanceUi.tsx` L121 | fixed, blur, `rgba(15,23,42,.32)` | `TmsDialog` (exported `Modal` signature kept) | C |
| `fleet-dashboard/PmDueWidget.tsx` L182 | fixed `<form>` modal | `TmsDialog` (form stays the dialog body) | C |
| `time-off/TimeOffFormModal.tsx` L81 | fixed | `TmsDialog` | C |
| `driver-pay/DriverPayForms.tsx` L26, `driver-pay-box-trucks/BoxTruckPayForms.tsx` L21, `owner-operator-pay/OwnerOperatorPayForms.tsx` L18, `fleet-profitability/DriverPayForm.tsx` L72 | **identical** `Modal({ title, width, onClose, children })` ×3 (+1 variant) | **One** `PayModal` exported from `driver-pay/DriverPayForms.tsx` (thin `TmsDialog` wrapper, same props, `width` → `tms-dialog-wide` when > 560); the other three files import it and delete their copies | D |
| `expenses/FuelUploadModal.tsx` L207 | fixed, `bg-white max-w-4xl` | `TmsDialog` (`tms-dialog-wide`) | D |
| `invoices/InvoicesPage.tsx` L216 | transparent fixed click-catcher behind a filter popover | stays (not an overlay); popover tokens | D |
| `files/DocumentPreviewModal.tsx` L66 | fixed 900 px preview | `TmsDialog` (`tms-dialog-xl`; PDF/img on `--tms-paper`, `data-tms-paper`) | E |
| `files/EntityFilePanel.tsx` L288, L551 | fixed right panel + fixed confirm | `TmsDrawer size="lg"` + `TmsDialog` | E |
| `files/InviteDriverModal.tsx` L131, `PacketPickerModal.tsx` L53, `PrivateDocsModal.tsx` L64 | fixed centred modals | `TmsDialog` | E |
| `files/SidePanel.tsx` L37 | fixed right panel (`zIndex` prop, `width` prop) — **the load drawer's frame** | `TmsDrawer` mapped from `width` → `size` (≤460 `md`, ≤640 `lg`, else `xl`); `zIndex` prop kept and applied via `style` on the content | E |
| `pods/PodPreviewDialog.tsx`, `loads/LoadDrawer.tsx` `Dialog`s | shadcn `Dialog` | stay shadcn; look comes from `ui/dialog` (A) | E |
| `disputes/StatusUpdateModal.tsx`, `disputes/EvidenceGallery.tsx`, `disputes/DisputesPage.tsx`, `invoices/InvoicesPage.tsx`, `trucks/TrucksPage.tsx`, `vendor-ap/VendorApPage.tsx` | import `Modal, Field, FormSection, inputStyle, btnPrimary, btnGhost` from `maintenance/maintenanceUi` | follow automatically when C converts `maintenanceUi.Modal`; **those exports keep their signatures** (cross-slice contract, §5.2 C2) | C owns the file |
| `components/UpdateBanner.tsx` L35 | fixed pill | stays; tokens | A |
| `components/ui/dialog.tsx`, `ui/sheet.tsx` | shadcn overlays | A restyles inside the file: content gets `tms-portal` + `--tms-radius-card`, overlay `--tms-overlay`, sheet drops `bg-white/border-slate-*`; **props and exports unchanged** | A |
| `driver-app/scanner/ScanCamera.tsx` L344/355/450, `settlement/DocPreviewSheet.tsx` L69 | full-screen overlays | stay full-screen; camera stays black, error/paper surfaces tokenised (G) | G |

Rule for the converted ones: no copy changes, no new buttons, `Esc`/overlay click now close them (that is the kit's behaviour and is the intended gain); a modal that confirms destructive work keeps its explicit buttons. Footer buttons use `TmsButton` (`primary`/`secondary`/`destructive`).

---------------------------------------------------------------------------------------------------

## 5. Start protocol and the shared contracts

### 5.1 Phase 0 — one script, one broadcast (slice A alone, first)
Everyone else reads this plan and the kit while A does, **in this order**:
1. **Codemod** (`scripts/s3Codemod.mjs`, dry-run first, then write): §2.2 `--ds/--sh` rename, §2.3 Tailwind palette, §2.2 safe-hex map. Output to stdout and `'/Users/adminoid/.omp/agent/sessions/-bcat-ops/2026-10-28T02-49-06-027Z_01a18069-48eb-75fe-9f30-7e805b0059e5/local/s3-codemod-report.md'`: counts per file, `residue:` lines (literals it would not touch), `undefined-token:` lines (the 8 `--ds-surface1/2/accent` uses), `blue-near-status:` lines (files that mix the new `--tms-primary` with other `--tms-badge-*` colours in one expression). The script **does not touch** `src/features/tms/**`, tests, `index.css`, `src/features/driver-app/scanner/ScanCamera.tsx` (camera) or any `data colour`/`paper` line carrying an `eslint-disable` comment.
2. **Driver extraction (verbatim move):** `DriverLoading`, `DriverLanding`, `DriverProfileError`, `DriverRoutes` leave `App.tsx` for `src/features/driver-app/DriverRoutes.tsx` (`export function DriverRoutes()`); `App.tsx` imports it. After this G owns that file.
3. **Lint triage:** extend `eslint.config.js` per §7, run `npx eslint src --rule …` once to list false positives of the hex regex (expected < 20, e.g. `#123` ticket numbers) and fix each with `-- not a colour`; publish the per-folder violation counts so owners know their to-do list.
4. **Broadcast (hub, `all`): "Phase 0 done"**. From here B, C, D, E, G edit their own files. A continues with §6 A in parallel; it **never** edits a file in another slice's list.

### 5.2 Cross-slice contracts (nobody changes these without a `hub` message to the owner)
| # | Contract | Owner → consumers |
|---|---|---|
| **C1** | Token names are final and exactly the `--tms-*` set in `theme.css` (+ `--tms-paper`, `--tms-overlay`, `--tms-on-primary`, `--tms-topbar`). No new token is invented by a page; a missing one is requested from A. | A → all |
| **C2** | `maintenance/maintenanceUi.tsx` keeps exporting `Modal({ title, width?, onClose, children, … })`, `Field`, `FormSection`, `inputStyle`, `btnPrimary`, `btnGhost` with today's signatures. C converts `Modal` to `TmsDialog` internally. Importers: `disputes/{StatusUpdateModal,EvidenceGallery,DisputesPage}` (E), `invoices/InvoicesPage` (D), `trucks/TrucksPage` (C), `vendor-ap/VendorApPage` (S2, untouched). | C → D, E |
| **C3** | `files/SidePanel.tsx` keeps exactly `SidePanel({ title: string; subtitle?: string; avatar?: ReactNode; actions?: ReactNode; footer?: ReactNode; onClose: () => void; children; width?: number /*620*/; zIndex?: number /*50*/ })`. E re-implements it on `TmsDrawer`: `avatar`+`title` → the `title` node, `subtitle` → `description`, `actions` → `headerExtra`, `footer` → `footer`, `width` → `size` (≤460 `md`, ≤640 `lg`, else `xl`), `zIndex` → inline `style.zIndex` on the drawer content **and** its overlay (stacked panels — driver file over a load — must still order correctly), `open` is always true while mounted. Importers: `loads/LoadDrawer` (E), `drivers/DriverDrawer` (C). | E → C |
| **C4** | `TmsScrollPage` (§2.4.6) — the only page head for K pages. Written by A first (types + CSS in the first hour); B–E code against §2.4.6 meanwhile. | A → B, C, D, E |
| **C5** | `TmsShell` additive props `fill`, `aside`; `useShellBadgeCounts`; `tmsBreadcrumb` fall-through (§2.4). `DispatchDrawer({ isDesktop })` keeps its prop; **B** adds `className="tms-aside"` to its `<aside>` and drops its inline width/border-left (the shell frames it). | A ↔ B |
| **C6** | `PayModal` exported from `driver-pay/DriverPayForms.tsx` (`{ title: string; width?: number; onClose: () => void; children }`). Importers: `driver-pay-box-trucks/BoxTruckPayForms`, `owner-operator-pay/OwnerOperatorPayForms`, `fleet-profitability/DriverPayForm` — all D. | D internal |
| **C7** | `useTmsTheme(): { theme, setTheme, toggleTheme }` unchanged (§2.5). `DriverApp` calls it once and passes `{ theme, toggleTheme }` to `AccountPage` through `<Outlet context>` — never two instances in one tree. | A → E, G |
| **C8** | PWA colours: `<meta theme-color>` default and manifest `theme_color` = `#ffffff` (= light `--tms-topbar`); manifest `background_color` = `#f3f6f4` (= light `--tms-bg`). A edits `index.html`, G edits `vite.config.ts`; `pwaColors.test.ts` (A) pins all three to `theme.css`. | A ↔ G |
| **C9** | Intentional non-token surfaces are marked so the audit can allow-list exactly them: `data-tms-paper` (white page/PDF/image matte), `data-user-color` (per-driver/per-truck identity colours from `lib/driverColors.ts`), `data-camera` (driver scanner black). Each such line also carries `// eslint-disable-next-line … -- paper|data colour|camera`. | all |
| **C10** | Driver-app files import kit pieces **by file** (`@/features/tms/kit/TmsAlert`), never the `kit` barrel (the barrel pulls `TmsShell`, `theme.css` side effects and the board stylesheets into the driver bundle). `theme.css` itself is loaded by `main.tsx` through `App → TmsLayout`; G adds **no** second stylesheet import for tokens. | G |
| **C11** | `lib/driverColors.ts` and `lib/apptStatus.ts` (B) keep their export names/shapes: `COLOR_MAP`, `DRIVER_COLOR_KEYS`, `STATUS_TONE_COLORS`, … — consumed by `ui/DriverChip`, `DriverDrawer`, owner-op pages, `ApptEditPopover`. | B → A, C, D |
| **C12** | Driver API / auth / SW stay byte-identical: `driverApi.ts`, `DriverAuthContext.tsx`, `useDriver*.ts`, `scanner/scanIntent.ts`, `public/sw-reload.js`, `lib/swUpdate.ts`, workbox config. | G must not edit |

### 5.3 Rules every builder applies (extends S2 §5; second convention beside S2's is prohibited)
| Rule | |
|---|---|
| **T1** | **No colour literal in any owned `.ts/.tsx/.css`** (lint + CSS guard enforce). Colour = `var(--tms-*)`, a shadcn semantic utility (`bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`), `TmsBadge tone`, or `TmsAlert`. |
| **T2** | **No logic change.** No handler, query, hook, route, copy, `data-testid`, `aria-*`, role or accessible name changes (S2 R6). A converted overlay keeps its heading text and button labels. |
| **T3** | After the codemod, **review its output in your files**: every `--tms-primary` that is really "info/in-transit" (list in the report), every `bg-[color:var(--tms-badge-X-tint)]` chip (is the hue right for the status?), every dropped fallback. |
| **T4** | Page head → `TmsScrollPage` on K routes; the page's `h1` text is unchanged; its buttons move into `actions` unchanged. Pages that depend on `height:100%` flex layouts (R routes) keep their root and may use `scroll={false}` only if that is a pure wrapper swap. |
| **T5** | Hand-built overlay → `TmsDialog`/`TmsDrawer` per §4; focus/Esc/overlay-close come from the kit. Shadcn `Dialog/DropdownMenu/Select` content that stays gets nothing extra — `ui/*` carries `tms-portal` after A. |
| **T6** | Status colour → `TmsBadge`/`statusTone` or the explicit `TmsTone` map; never a new hex map. Charts read `--tms-chart-N` via `useTmsTokens` (hook exists in `tms/tmsTokens.ts`); SVG paint uses `style={{ fill: 'var(--tms-…)' }}` (a `fill="var()"` *attribute* does not resolve). |
| **T7** | Both themes: only tokens, so dark follows. A surface that cannot (PDF/iframe/image matte, user data colours, camera) is marked per C9. |
| **T8** | Do not run typecheck/lint/test project-wide (Main does, once). Scoped only: `npx vitest run <your test files>`, `npx eslint <your files>`, `npx tsc --noEmit -p tsconfig.app.json` is **not** run (project-wide). Yield with files touched and states you could not exercise. |
| **T9** | Unknown requirement or a file outside your list → `hub` the owner; do not "just fix it". |

---------------------------------------------------------------------------------------------------

## 6. Slices — six parallel builders, non-overlapping ownership

Every builder: §5.3 rules; a test file belongs to the slice that owns its component; yield with the list of files touched, the states not exercised, and any `residue:` lines left on purpose (each with its reason). Builders run **no** project-wide command.

### Slice A — Foundation, tokens, unified shell, kit, lint, Phase 0
**Owns:** `scripts/s3Codemod.mjs` (throwaway); `src/index.css`; `index.html`; `eslint.config.js`; `src/App.tsx`; `src/components/{layout/*,ui/*,charts/*,RequirePage.tsx,RequirePage.test.tsx,UpdateBanner.tsx,UpdateBanner.test.tsx}`; `src/lib/ui/*`; `src/lib/navSections.ts` (+tests); `src/features/tms/{theme.css,shell.css,TmsShell.tsx,TmsLayout.tsx,tmsTheme.ts,tmsTokens.ts,useShellBadgeCounts.ts(new),theme.scope.test.ts,pwaColors.test.ts(new)}` + their tests; `src/features/tms/kit/**` (incl. `TmsToaster`, `TmsDrawer`, `kit.css`); `src/features/tms/styles/*.css`.
**Order:** Phase 0 (§5.1) → broadcast → then in this order, publishing each as it lands: (1) `TmsScrollPage` types/CSS and `TmsDrawer.zIndex` (B–E wait on these), (2) `theme.css` selector widening + shadcn bridge + `*` border default + `index.css` rewrite (§2.1), (3) `ui/*` restyle, (4) shell: `fill`/`aside`/mobile drawer/`useShellBadgeCounts`/breadcrumb/`TmsLayout` legacy mode/`LegacyRuntime`/`App.tsx` single layout/delete `AppLayout, NavBar, Topbar, NavBar.test`, (5) theme-color sync + `index.html` + pre-paint, (6) `TmsToaster` carve-out removal (after G lands), `RequirePage`/`UpdateBanner`, (7) scope-test and lint finishing, (8) final: re-run the codemod dry-run and confirm no `--ds-/--sh-` reference remains anywhere.
**Mandated changes**
* §2.1 in full. `theme.scope.test.ts` retargeted (§10).
* `ui/*` (all inside the files, exports/props unchanged): `button` (`lib/ui/button-variants.ts`: `default` = `bg-primary text-primary-foreground hover:bg-[color:var(--tms-primary-hover)]`, no gradient; `destructive` = `TmsAlert`-style red tint via `--tms-badge-red*`; `outline/secondary/ghost` = `border-border bg-card`/`bg-muted`/`hover:bg-accent`; `rounded-[var(--tms-radius)]`), `dialog` (content `tms-portal`, radius `--tms-radius-card`, overlay `bg-[color:var(--tms-overlay)]`, shadow `--tms-shadow-modal`), `sheet` (same; kills `bg-white/border-slate-*`), `tooltip` (`bg-[color:var(--tms-tooltip-bg)] text-[color:var(--tms-tooltip-ink)]`), `toggle-group`, `kpi-card`, `table-cells` (`CHIP_TONES` → badge tokens), `form-section`, `avatar`, `DriverChip` (identity colours stay data → `data-user-color`), `dropdown-menu/select/input/textarea/switch/checkbox/label/separator/scroll-area` (already semantic; verify and add `tms-portal` to portal content), `lib/ui/panel-btn.ts`. Sparkline default colour `var(--tms-primary)`.
* §2.4 in full: `TmsShell` (`fill`, `aside`, mobile drawer, `Menu` button, backdrop, `Escape`), `shell.css`, `TmsLayout` (legacy mode, `LegacyRuntime`, `useShellBadgeCounts`), `navSections.tmsBreadcrumb` fall-through + title table, `App.tsx` single `TmsLayout` route, **delete** `components/layout/*`.
* `TmsToaster`: after G reports, remove the `/driver` branch (the same themed card toaster everywhere; phone top-centre already). `TmsDrawer`: additive `zIndex?: number`.
* `RequirePage.NoAccess`: drop the `var(--tms-x, var(--ds-y))` fallbacks (now plain `var(--tms-x)`), shadow `--tms-shadow-pop`. `UpdateBanner`: `--tms-tooltip-bg/-ink`.
* `index.html`: pre-paint script (§2.5), `theme-color #ffffff`, `apple-mobile-web-app-status-bar-style default`, Geist Sans removed from the font link.
* `useTmsTheme`: add the `theme-color` meta sync (§2.5).
* `eslint.config.js`: §7. `pwaColors.test.ts`.
**Not touched:** any page/feature folder listed under B–G; `ui/*` consumers.
**Acceptance:** `theme.scope.test`, all `kit/*.test`, `TmsShell.test`, `TmsLayout.test`, `RequirePage.test`, `UpdateBanner.test` green; `grep -rn "\-\-ds-\|\-\-sh-" src` empty; `grep -rn "components/layout" src` empty; `/tms/dashboard` and `/trucks` render the same sidebar/top bar rectangles (checked by devVerify §9.3 check 4); light/dark toggle works on a legacy route.

### Slice B — Dashboards, calendar, dispatch, appointments
**Owns:** `features/dashboard/**`, `features/calendar/**` (incl. `calendar.css`), `features/dispatch/**`, `features/appts/**`, `components/{ApptEditPopover,ApptProofPanel,DriverFilterMenu,TruckAssignSelect}.tsx` (+tests), `lib/driverColors.ts`, `lib/apptStatus.ts` (+tests).
**Mandated changes**
* `/dashboard` (K): root `h-full overflow-y-auto` + 1400 px wrapper → `TmsScrollPage` (title text unchanged); widget frames (inline white card: border + radius + `--sh-sm`) get `className="tms-card"` where the widget root is a plain frame (no markup change); `PerMileKpis`/KPI tile sets → `TmsStatRow` **only if** the tiles are plain label/value (otherwise token-only); recharts series colours → `useTmsTokens(['--tms-chart-1',…])`, axis/grid/tooltip → `--tms-chart-axis/-grid` and the `tms-chart-tip` class (S2 audit allow-list); `TruckMapWidget`/`FleetMiniMap` d3-geo SVG fills → `style={{ fill/stroke: 'var(--tms-…)' }}` (map land `--tms-surface-hover`, border `--tms-border`, pins `--tms-primary`); `OpenTasksWidget` Add-task → `TmsDialog`.
* `/calendar` (R, `fill`): **no page-head swap** (dense toolbar); tokens only. `calendar.css` (~30 literals): map FullCalendar's own CSS variables on `.fc` (`--fc-border-color`, `--fc-page-bg-color`, `--fc-neutral-bg-color`, `--fc-today-bg-color: var(--tms-primary-tint)`, `--fc-event-bg-color`, `--fc-now-indicator-color`, `--fc-button-*`) to tokens, replace remaining slate/brand literals; **[INFERENCE]** FullCalendar v6 exposes these variables — confirm in `package.json` (`@fullcalendar/*` version) before relying on them, else override the class rules with tokens. `DriverAvailabilityModal` → `TmsDialog`. Grid picker popover → `tms-portal` + tokens. Load-highlight palettes and per-driver colours stay data (`data-user-color`).
* `/dispatch` + `DispatchDrawer` (R): `DispatchDrawer` root `<aside>` gets `className="tms-aside"`, loses its inline width/`borderLeft`/background (the shell frames the card); collapsed corner button on tokens with `--tms-primary`; thread bubbles (`Thread.tsx`) — "ours" = `--tms-primary` fill with `--tms-on-primary` text, "theirs" = `--tms-surface-hover`; unread count → `TmsCountBadge` look via tokens.
* `/appts` (R): tokens; `ApptProofPanel` email modal → `TmsDialog wide`; status chips via `statusTone`/`TmsBadge` driven by `apptStatus.STATUS_TONE_COLORS` → rewrite that table to `TmsTone` keys and update the 3 chip sites (hex `#15803d/#b45309/#0369a1/#dc2626` and `#fcd34d/#86efac` borders disappear).
* `lib/driverColors.ts`: 82 hex are **identity colours** — keep as data with a single file-level `/* eslint-disable no-restricted-syntax -- data colour */`; export shapes unchanged (C11).
**Tests:** `ApptsPage.render.test`, `PlannerView.test`, `SchedulerView.duplicate.test`, `TruckMapWidget.test`, `dispatchUi.test`, `driverWhereabouts.test`, `QueueRow/QueueCard` untouched — run and keep green.
**Acceptance:** §11 rows L01–L04a (+ states B1–B6) render with no legacy colour in both themes (§9.3); calendar and dispatch keep their full-height inner scroll (no page scrollbar at 1600×1000).

### Slice C — Fleet, assets and people-ops pages
**Owns:** `features/{trucks,truck-docs,maintenance,fleet-dashboard,fuel,insurance,hours,schedule,time-off,driver-info,drivers,tasks,intake,reddit-queue,pricing-margin,vehicle-quote,vehicle-confirmation}/**` (+tests).
**Mandated changes**
* K pages (`/driver-info, /fleet-dashboard, /truck-docs, /maintenance, /fuel, /insurance, /hours, /schedule, /time-off, /tasks, /intake, /vehicle-quote, /vehicle-confirmation, /reddit-queue, /pricing-margin`): page head → `TmsScrollPage` (the sticky band `position:sticky; top:0; background: surface; borderBottom` that opens `MaintenancePage`, `TrucksPage` and most list pages becomes `stickyHead` only where the page is a long list); KPI tiles → `TmsStatRow`; pills → `TmsBadge`; "No …" blocks → `TmsEmptyState`; `intake` queue cards/rows: Tailwind palette (28 hits) → badge tokens, status chips `TmsBadge`.
* `/trucks` (R, 76 KB single file): codemod residue only + the **two fixed modals** (Add Maintenance Task L489, Add Invoice L572) → `TmsDialog`; do not restructure the page.
* `maintenance/maintenanceUi.tsx`: `Modal` → `TmsDialog` keeping the signature (C2); `btnPrimary/btnGhost/inputStyle/Field/FormSection` on tokens (they are imported by D/E pages, so their look is changed here once).
* `fleet-dashboard`: `PmDueWidget` modal → `TmsDialog` (the `<form>` stays the body, submit unchanged); `RepairSpendWidget` recharts → `useTmsTokens`; widgets' card frames `tms-card`.
* `time-off/TimeOffFormModal` → `TmsDialog`. `drivers/DriverDrawer` (frame is `SidePanel`, E) — tokens + `FormSection` look only.
* `vehicle-quote` / `vehicle-confirmation`: the e-mail **preview** pane shows the Best Care HTML (red/black, D-2): wrap it in a `data-tms-paper` white card so the audit and dark mode treat it as paper; everything around it tokens.
**Tests:** run the ones that exist in these folders and keep them green: `intake/QueueRow.test`, `intake/QueueCard.test`, `fleet-dashboard/FaultCodesWidget.render.test`, `fleet-dashboard/RepairSpendWidget.test`, `schedule/sms.test`. None pins a colour or class.
**Acceptance:** §11 rows L05–L21; every fixed overlay in §4 for C is gone.

### Slice D — Money and pay
**Owns:** `features/{finances,fleet-profitability,cash-checkin,expenses,invoices,driver-pay,driver-pay-box-trucks,owner-operator-pay,ivan-driver-app}/**` (+tests).
**Mandated changes**
* `PayModal` (C6): one thin `TmsDialog` wrapper exported from `driver-pay/DriverPayForms.tsx`; the three duplicate `Modal`s and `fleet-profitability/DriverPayForm`'s frame use it. `width` ≤ 560 default dialog, > 560 `tms-dialog-wide`. All the pay forms (settings, credit, fixed-expense editor) keep their bodies.
* `/driver-pay`, `/driver-pay-box-trucks`, `/owner-operator-pay`, `/ivan-driver-app`, `/invoices`, `/finances` (K): page head → `TmsScrollPage` (week picker / tabs move into `toolbar`); KPI/total tile sets → `TmsStatRow` (settlement totals); pills → `TmsBadge`; `driver-pay` hex (76) → tokens, money sign colours `--tms-badge-green/-red`.
* `/finances/review`, `/finance/cash-checkin`, `expenses/*` (R): codemod residue only (Tailwind ×131 in `ExpensesPage` is almost all neutral → handled by §2.3); `FuelUploadModal` → `TmsDialog wide`; recharts (`cash-checkin`, `ExpensesPage`, `FleetPLTrendChart`) → `useTmsTokens`.
* `DriverAppViewPage` (`/driver-view/:driverId`): the 390 px frame uses `--tms-card`/`--tms-border`/`--tms-shadow-pop`; it renders G's driver pages — no import path change (`owner-operator-pay` imports 4 things from `driver-app`; G keeps those exports, C12).
* `InvoicesPage` column-filter popover: tokens, `tms-portal`.
**Tests:** `DriverPayPage.test`, `DriverPayForms.CreditModal.test`, `*.SettingsModal.test`, `FixedExpenseEditor.test`, `BoxTruckPayPage.test`, `OwnerOperatorPayPage.test`, `DriverAppViewPage.test`, `CombinedMonthlyProfit*.test`, `ivanDriverApp.test` — the `Modal` tests query by role/text; if one finds the dialog by a removed wrapper, rewrite the query to `getByRole('dialog', { name })` (do **not** re-pin to markup).
**Acceptance:** §11 rows L22–L33; no duplicate `Modal` left (`grep -rn "position: 'fixed'" features/driver-pay* features/owner-operator-pay features/fleet-profitability` empty).

### Slice E — Files, loads, PODs, disputes, sign-in, public legacy pages
**Owns:** `features/{files,loads,pods,disputes,compliance,driver-docs,driver-portal}/**`, `features/tracking/TrackPage.tsx`, `pages/LoginPage.tsx`, `components/AuthGuard.tsx` (+tests; new `pages/LoginPage.test.tsx`).
**Mandated changes**
* **Overlays (§4):** `SidePanel` → `TmsDrawer` (C3 exact mapping), `EntityFilePanel` (panel + confirm), `InviteDriverModal`, `PacketPickerModal`, `PrivateDocsModal`, `DocumentPreviewModal` (→ `tms-dialog-xl`, matte `--tms-paper` + `data-tms-paper`) → `TmsDialog`/`TmsDrawer`; `PodPreviewDialog` and `LoadDrawer` dialogs stay shadcn.
* `/files` (K): head → `TmsScrollPage`; driver/truck roster and onboarding progress pills → `TmsBadge`; "No …" → `TmsEmptyState`. `/pods` (K, Tailwind ×41/sem ×45): codemod residue, `PodCard` status chips → `TmsBadge`. `/disputes` (R): tokens, status chips `TmsBadge`, `FileDrop` dashed border `--tms-input-border`.
* `loads/LoadDrawer` + `legForm` + `LoadDriverDocs` (R): residue only (35 `ds`, 66 semantic utilities already follow the bridge). **`LoadDrawer.render.test` L79–82 retargeted** (§10).
* **`pages/LoginPage.tsx` rebuild (P):** the "Control Tower" concept stays (quiet fleet map behind a card) but on the light canvas: `--tms-bg` background; graticule/lane/hub strokes `--tms-primary` at 8–22 % (via `color-mix(in srgb, var(--tms-primary) N%, transparent)` — allowed, it is a token expression); moving unit and pings `--tms-primary`; vignette removed; the card is a `.tms-card`-style surface (`--tms-card`, `--tms-border`, `--tms-radius-card`, `--tms-shadow-pop`) 420 px wide; the logo sits on a `data-tms-paper` plate so the wordmark's white "LOGISTICS" strip reads as intended in dark too; inputs/buttons: `TmsInput` / `TmsButton variant="primary"` (full width) imported **by file**; the error banner → `TmsAlert tone="red"`; the two modes (sign-in; set-new-password via `needsNewPassword`) keep every field, label, `autoFocus`, password toggle, "Keep me signed in" checkbox, "Forgot?" mailto and error semantics; `useTmsTheme()` is called (apply only, no toggle) so a dark-preference user gets the dark card. The inline `<style>{CSS}</style>` block and `S` style object lose every literal. The hard-coded status rail text ("LIVE", "16 UNITS ROLLING") is **left as is** — copy is not S3's call (noted in §12).
* `AuthGuard` loading screen: `--tms-bg` canvas + muted "Loading…", no hex.
* **Public pages (P, on `TmsPublicFrame`):** `TrackPage` (status header, `FleetMiniMap` card, driver/last-seen/current-load rows as `TmsMetaList`, error as `TmsAlert`; **remove its exemption in `eslint.config.js`** — A deletes the `ignores` entry, E guarantees the file is clean first; message A when ready); `DriverPortalPage` + `ApplicationForm` (multi-step application: frame `width="lg"`, steps on `TmsSegmentedTabs`-free styling → keep the existing step markup, tokens only; file inputs untouched); `DriverDisputesPage` (frame; its own hero/stepper → tokens; evidence `FileDrop`/`EvidenceGallery` shared with `/disputes`). Each keeps a `.tms-public` root, **no** sign-in redirect, no shell.
**Tests:** `FilesPage.render.test`, `LoadDrawer.render.test` (retargeted) / `LoadDrawer.rate.test`, `LoadDriverDocs.test`, `PodsPage.test`, `PodDownloadBtn.test`, `DisputesPage.render.test`, `DriverDisputesPage.test`, `DriverDocUploadDialog.test`, `portalApi.test` — keep green; **new** `LoginPage.test.tsx` (§10).
**Acceptance:** §11 rows L34–L38, A1–A3, P1–P3; `grep -n "TrackPage" eslint.config.js` empty.

### Slice G — Driver PWA
**Owns:** `features/driver-app/**` (incl. new `DriverRoutes.tsx` after Phase 0 and new `driver.css`), `vite.config.ts` (manifest block only). (`driver-docs/` is the *staff* upload dialog and belongs to E.)
**Mandated changes**
* **Root + theme (S10, C7):** every `className="dark …"` (`DriverApp`, `DriverLoginPage`, `DriverSignupPage`, `DriverLoading`, `DriverProfileError`, `TruckPicker`, `ReportIssue`) becomes the new `tms-driver` root (`driver.css`: `min-height:100dvh; background: var(--tms-bg); color: var(--tms-text); font-family: Inter…; padding-top/bottom: env(safe-area-inset-*)` where the page owns the inset). `DriverApp`, `DriverLoginPage`, `DriverSignupPage` call `useTmsTheme()` (apply); `DriverApp` passes `{theme, toggleTheme}` to `AccountPage` via `<Outlet context>`; `AccountPage` gains an "Appearance" row — a button with `aria-label="Switch to dark theme"|"Switch to light theme"` (same labels as the shell) — default **light** (D-1). Dialogs (`TruckPicker`, `TrailerPicker`, `ReportIssue`, `PaperworkGates`) carry no `dark` class: shadcn `Dialog` content is `tms-portal` after A and follows the html attribute, which fixes today's light-dialog-on-dark-shell mismatch for `TrailerPicker`/`PaperworkGates`.
* **Tab bar** (`DriverApp.tsx` L93–110, `TabButton`): `bg-[#0b1220]/95 border-slate-800` → `bg-[color:var(--tms-topbar)] border-t border-[color:var(--tms-border)]`; active label `text-[color:var(--tms-primary-ink)]`, active pill `bg-[color:var(--tms-primary-tint)]`, inactive `text-muted-foreground`; keep `h-20`, `max(env(safe-area-inset-bottom),8px)`, `aria-label="Driver navigation"`, 11 px labels, icon weights. `OnTheClockBar` emerald → `--tms-badge-green*`.
* **Screens:** codemod output reviewed (T3) on `DriverLoginPage`/`DriverSignupPage` (slate login card → `.tms-card`-style, error/success banners → `TmsAlert`, blue gradient CTA → primary token button), `InstallHintSection`, `SubmissionsPage`, `ScanPage`/`PagePicker`, `UnattachedPods`, `ShipmentRows`, `CurrentLoadCard`, `TodayStops`, `TimeClockPage`, `PmGauge`, `DayLogs`, `ReportIssue`. Status colours → `TmsBadge`/badge tokens with **lighter tint surfaces** (the old light-only `amber-50/emerald-50` chips that were wrong on navy are now right on both themes).
* **Overlays:** `DocPreviewSheet` stays a full-screen sheet on `--tms-card`, header `--tms-topbar`, paper `--tms-paper` + `data-tms-paper`, safe-area insets kept. `ScanCamera` live + review stay `bg-black` with white controls (`data-camera`, one `eslint-disable … -- camera` each); its error state (L344) is tokenised; the canvas outline `#22c55e` / `rgba(34,197,94,.14)` (JS, cannot use `var()`) read `readTmsToken('--tms-primary')` at draw time.
* **PWA** (C8): `vite.config.ts` manifest `theme_color: '#ffffff'`, `background_color: '#f3f6f4'`; name/short_name/icons/scope/start_url/display/orientation unchanged (D-4).
* **Imports:** kit pieces by file path only (C10). **Untouchable:** C12 list. `UpdateBanner`/`DriverAutoUpdate` unchanged (the banner is staff-only; `DriverAutoUpdate` renders null).
* **Test edits:** delete the source-text assertion in `paperwork/PaperworkPage.test.tsx` L450–460 (the §7 lint rule is the stronger, structural twin); add `AccountPage` theme-toggle test (§10). `TmsToaster.test.tsx` is A's.
**Tests kept green unchanged:** `DriverLoginPage.test`, `DriverSignupPage.test`, `DriverAuthContext.test`, `SubmissionsPage.test`, `TruckPicker.test`, `useDriverProgram.test`, `driverApi.test`, `installHint.test`, `signupOutcome.test`, `PaperworkPage.test` (minus the deleted block), `HosPanel.test`, `PmGauge.test`, `dayEld/daySheet/scheduleFingerprint/sheetDay.test`.
**Acceptance:** §11 rows D01–D17 (phone viewport, both themes); `grep -rn "className=\"dark\|bg-\[#0b1220\|text-\[#1ea8f3" src/features/driver-app` empty; the driver app behaves identically (all existing tests green, no handler diff — reviewed by `git diff --stat` showing only className/style/markup lines in `driver-app` except `DriverRoutes.tsx`, `AccountPage.tsx`, `DriverApp.tsx` outlet context).

### Slice V — verification harness (wave 2, starts when A has landed tokens+shell; no overlap with A–G)
**Owns:** **new** `scripts/lib/uiWalk.mjs`, `scripts/lib/driverIdentity.mjs`, `scripts/devVerifyS3.mjs`; refactor `scripts/devVerifyS2.mjs` to import the walker from `uiWalk.mjs` (behaviour and output unchanged; it must still PASS, which doubles as the shell regression). Details §9.

---------------------------------------------------------------------------------------------------

## 7. Guards that keep it fixed

### 7.1 TSX guard (`eslint.config.js`, slice A)
Replace the S2 override with one covering **all UI source**:
`files`: `src/{features,components,pages}/**/*.{ts,tsx}`, `src/App.tsx`, `src/lib/ui/**/*.{ts,tsx}`, `src/lib/{driverColors,apptStatus}.ts` · `ignores`: `**/*.test.{ts,tsx}` (the `TrackPage.tsx` entry is deleted). PDF builders, e-mail HTML builders, `types`, `store`, `mocks`, `hooks` are outside the glob (no UI colour; PDFs/e-mail are D-2/D-6).
Four `no-restricted-syntax` selectors (the `\|` below are Markdown table escapes — in the config they are plain `|`; A verifies the esquery regexes compile), each on `Literal[value=/…/]` **and** `TemplateElement[value.raw=/…/]` (so `className`, inline-style values and template strings are all covered, not just strings *starting* with `#` as in S2):
| Selector regex | Message |
|---|---|
| `/(?:^\|[^\w&])#(?:[0-9a-fA-F]{8}\|[0-9a-fA-F]{6})(?![\w-])\|(?:^\|[\s:(,'"])#[0-9a-fA-F]{3,4}(?![\w-])\|\brgba?\(\|\bhsla?\(/` | Use a --tms-* token (or TmsAlert/TmsBadge). |
| `/\[#[0-9a-fA-F]{3,8}\]/` | Arbitrary hex class — use `[color:var(--tms-…)]`. |
| `/\b(?:bg\|text\|border\|ring\|fill\|stroke\|from\|via\|to\|divide\|outline\|decoration\|shadow\|accent\|caret)-(?:slate\|gray\|zinc\|neutral\|stone\|red\|orange\|amber\|yellow\|lime\|green\|emerald\|teal\|cyan\|sky\|blue\|indigo\|violet\|purple\|fuchsia\|pink\|rose)-\d{2,3}(?:\/\d+)?\b\|\b(?:bg\|border)-white\b\|\bbg-black\b/` | Palette class — use a semantic utility or badge token. |
| `/--(?:ds\|sh)-[a-z]/` | Retired token — use --tms-*. |
Exemptions are explicit one-liners: `// eslint-disable-next-line no-restricted-syntax -- data colour | paper | camera | not a colour`. The 3–4-digit hex branch will flag ticket-number-like strings (`'PRO #123'`); A triages those in Phase 0 and reports the count. Because the rule now reaches S2 folders too, A also fixes/justifies any new S2-folder hit (expected: a handful of `1px solid …` strings).
Proof it works: a throwaway file with `style={{ color: '#fff' }}`, `className="bg-slate-50"`, `var(--ds-bg)` fails `npx eslint` — shown once, not committed.

### 7.2 CSS guard (`theme.scope.test.ts`, slice A)
Scans **every `.css` under `src/`** (not only `features/tms`): outside the two token blocks there is no colour literal (`#…`, `rgb(`, `hsl(`; `color-mix(…)` of tokens is allowed), and outside the token/bridge/border-default rules every selector in `features/tms` starts with `.tms-shell`/`.tms-portal`/the dark prefix (unchanged assertion, now allowing exactly: the two token blocks, the bridge, the `*` border default). This covers `index.css`, `calendar.css`, `driver.css`. Dark parity (every light colour token has a dark twin) stays.

---------------------------------------------------------------------------------------------------

## 8. E-mail templates — finding and decision

**Finding (MailScout, confirmed by grep):**
* The only HTML mail in the repository is **Best Care Auto Transport** quote and confirmation mail: builders `src/lib/emailChrome.ts` (palette L14–19: `INK #111318`, `RED #e11d2a`, `TEXT`, `MUTED`, `LINE`, `CARD`; header L88–97, amount band L100–108, reviews pill L146–153, contact footer L165–177), `quoteEmail.ts` (`buildQuoteEmailHtml`, `buildQuoteSubject`), `confirmationEmail.ts` (`buildConfirmationEmailHtml`, `buildConfirmationSubject`); sent by `amplify/functions/vehicle-quote-emailer` (SES multipart/related with an inline `bestcarelogo` CID); called only from `VehicleQuotePage` L79/L95 and `VehicleConfirmationPage` L68/L85 (preview with the bundled PNG, send with the CID).
* **Every other Lambda mail is plain text** (`shipmentNotices`, `tms-shipment-actions`, `tms-tracking-actions`, `driver-pay-emailer`, `driver-app-api/notify`, `appt-request-emailer`, `compliance-scanner`, `driver-welcome`, `onboarding-emailer`, `vendor-ap-actions`). No Lambda returns an HTML page.
* **No test touches the HTML builders** and none asserts a colour, hex, style or logo (`quoteNotices.test`, `shipmentNotices.test` assert plain-text substrings; `notify.test` decodes raw MIME for headers). So there are **no e-mail snapshot tests to retarget** and no plain-text change is needed.

**Decision (D-2):** the HTML belongs to a *different company brand* that the customer sees; its red/black identity is that brand, not the ops tool's palette. **Left byte-identical in S3.** What S3 does: (1) the two ops pages that *preview* the mail wrap the preview in a white `data-tms-paper` card (slice C) so the preview is correct in dark mode and does not trip the audit; (2) the `lib/` e-mail files stay outside the §7.1 glob.
**If Ryne decides to recolour:** change the six constants and the inline literals (`#ffffff`, `#aeb6c4`, `#ffe1e3`, `#ff6b73`, `#c3cad6`, `#8b93a3`, `#7f8798`, `#5c6373`, `#2a2e37`, page background `#eef1f5`) in `emailChrome.ts` + the two `RED` uses in `confirmationEmail.ts` L46 / `quoteEmail.ts` L65–68; **first** add a characterization test (`emailChrome.test.ts`: `renderEmailDocument` output contains the header title, the amount band, the contact block, no `undefined`; colours asserted through the exported constants, not literals) — it does not exist today. Not done now.

---------------------------------------------------------------------------------------------------

## 9. devVerify plan — `scripts/devVerifyS3.mjs` (slice V)

Goal: one command proves, against the **deployed dev site** (and `npm run dev` on localhost before pushing), that **no page outside `/tms/*` renders a legacy token or a console error, in light and dark**, that the legacy and TMS shells are the same chrome, and that the driver PWA renders correctly on a phone viewport with a real (temporary) driver session — and leaves the screenshots for Ryne.

### 9.1 Structure (reuses the S2 harness; no second CDP stack)
* **`scripts/lib/cdpBrowser.mjs`**, **`scripts/lib/devIdentity.mjs`** — unchanged (`launchBrowser`, `setViewport`, `addInitScript`, `mark/problems`, `screenshot`, `mintIdentity`, `deleteIdentity`, `routerAs`, `gql`).
* **`scripts/lib/uiWalk.mjs`** (new, extracted from `devVerifyS2.mjs`, **moved not rewritten**): `auditInPage`, `auditFailures`, `publicAuditInPage`, and a `createWalk({ shots, hookClasses, allowProblems, skipAllowed })` factory returning `{ line, report, written, waitLoaded, judge, setTheme, closeOverlays, runRoute, runState, menuProbe }`. `auditInPage(opts)` gains two optional lists, `opts.extraBanned` and `opts.extraBannedSurface` (default empty ⇒ S2 behaviour byte-identical). `devVerifyS2.mjs` imports from it; it must still produce the same PASS set — that run is also the **regression proof that `/tms/*` is unchanged under the new shell** (§9.4).
* **`scripts/lib/driverIdentity.mjs`** (new): the driver-pool twin of `mintIdentity` (§9.5).
* **`scripts/devVerifyS3.mjs`** (new): the walk below. Refuses any endpoint but the dev AppSync URL (`DEV_APPSYNC` regex, same as S2) and any pool/client other than the dev driver pool `us-east-1_nnJzcFvTY` / client `qvnqkida69qhuquir2tahjvq` and dev staff pool `us-east-1_UKhMNVAG1`; allowed origins = S2's list; never reads `amplify_outputs.json`; passwords/tokens never printed; temp identities `zz-s3-*@example.invalid`; `finally` deletes every identity and driver row it created and re-reads each to prove it is gone. **Production safety is also structural:** a dev token is invalid against the production pool, so a mis-pointed local build would show the sign-in screen and the script fails its first assertion (`.tms-sidebar` visible) instead of touching anything.

### 9.2 Completeness gate (fails first)
`requiredLegacyPatterns()` parses `src/App.tsx`: every `<Route path=…>` **outside** the `/tms` block (staff, public, driver) must appear in exactly one of `ROUTES` (rendered), `REDIRECTS` (asserted landing URL), `PUBLIC`, `DRIVER`, or `NO_UI` in the script. A route added later without coverage fails the run. Redirect assertions: each §3.2 path `navigate`s and `location.pathname` is polled to its expected target (params preserved, e.g. `/ar/invoices/X` → `/tms/invoicing/invoices/X`).

### 9.3 The walk
Viewport 1600×1000 (phone passes 390×844, `deviceScaleFactor` 2, mobile emulation). Browser A = staff ADMIN (`groups ['ADMIN','page-tms']`, storage injected) · Browser B = clean profile (logged out / public) · Browser C = driver, phone viewport, driver tokens injected (§9.5).

**`ROUTES` (staff, every theme):** `L01 /dashboard` · `L02 /calendar` (wideOk) · `L03 /dispatch` (wideOk) · `L04 /appts` (wideOk) · `L05 /driver-info` · `L06 /fleet-dashboard` · `L07 /trucks` (wideOk) · `L08 /truck-docs` · `L09 /maintenance` · `L10 /fuel` · `L11 /insurance` · `L12 /hours` · `L13 /schedule` · `L14 /time-off` · `L15 /tasks` · `L16 /intake` · `L17 /vehicle-quote` · `L18 /vehicle-confirmation` · `L19 /reddit-queue` · `L20 /pricing-margin` · `L21 /finances` · `L22 /finances/review` · `L23 /finance/cash-checkin` · `L24 /invoices` · `L25 /driver-pay` · `L26 /driver-pay-box-trucks` · `L27 /owner-operator-pay` · `L28 /ivan-driver-app` · `L29 /driver-view/{driver}` (the temp Settlement driver from §9.5; the temp admin is **not** on the API's impersonation list, so this row verifies the page frame and its 403 "not permitted" state — never add a temp identity to that list) · `L30 /disputes` · `L31 /files` · `L32 /pods` · `L33 /` (asserts it lands on the user's preferred page). Light **and dark for all 33** (S2 ran dark on a subset; S3's point is that dark now works everywhere).

**For every route × theme:** `navigate` → wait for `.tms-main` content and no spinner (≤ 30 s) → `browser.mark()` → `auditPage()` → screenshot. Checks:
1. **Console/network:** zero exceptions, console errors, 4xx/5xx and failed requests (S2's `problems()`; `ALLOW_PROBLEMS` starts empty; every entry needs a reason).
2. **Legacy colour audit** (S2's `auditInPage` with the S3 lists). `extraBanned` (computed `color`/`background-color`/border/fill/stroke): `rgb(30,168,243)` `#1ea8f3`, `rgb(59,181,245)`, `rgb(13,143,217)`, `rgb(11,143,217)`, `rgb(3,105,161)`, `rgb(230,244,253)`, `rgb(56,189,248)` (login cyan), `rgb(125,211,252)`, and the Tailwind slate ramp `rgb(248,250,252) (241,245,249) (226,232,240) (203,213,225) (148,163,184) (100,116,139) (71,85,105) (51,65,85) (30,41,59) (15,23,42)`. `extraBannedSurface`: `rgb(241,244,249) (231,236,244) (7,18,43) (11,18,32) (20,31,54) (28,41,66) (46,61,91) (6,10,18) (11,19,34)`. `EXCLUDE` gains `[data-camera]` and keeps `[data-tms-paper]`, `[data-user-color]`, `.gm-style`, `iframe`. A hit is a FAIL listing selector, property, colour.
3. **Surface/contrast:** S2's dark-surface-in-light / light-surface-in-dark and invisible-text checks (ratio < 1.5), currentColor-border count ≤ 3, unstyled `tms-*` classes.
4. **Shell parity (the "two shells must not diverge" assertion):** on each legacy route, `getBoundingClientRect()` of `.tms-sidebar`, `.tms-topbar` equals that recorded on `/tms/dashboard` (±1 px) for the same viewport; exactly one `aside.tms-sidebar` and no `.sidebar`, `.topbar`, `.app`, `.menu-btn` legacy node; `.tms-theme-toggle`, `button[aria-label="Log out"]`, bell, search present; `[aria-label^="Business:"]` present when the identity sees ≥ 2 businesses; `.tms-legacy-host` present on every legacy route and absent on `/tms/*`.
5. **Token resolution probe (proves the codemod + `:root` promotion):** in page, `getComputedStyle(document.documentElement)`: `--tms-bg` non-empty, `--ds-t1`/`--ds-bg`/`--sh-sm` **empty**, `--primary` resolves to `--tms-primary`; `getComputedStyle(body).backgroundColor` equals the `--tms-bg` value (light and dark).
6. **Layout:** at 1600×1000 the document does not scroll (`scrollHeight ≤ innerHeight + 2`) and `.tms-legacy-host` is the scroll container for non-`wideOk` pages; `html[data-tms-theme]` equals the expected theme; no horizontal overflow beyond 2 px except `wideOk` (checked on the page's own scroller).
7. **Phone pass** (390×844) for `L01, L07, L25, L31, L03`: no horizontal page overflow; hamburger `[aria-label="Open menu"]` visible and the sidebar off-screen; click it → sidebar in view + backdrop; click a nav link → drawer closes and the URL changed; `Escape` closes it; screenshot closed and open (light + dark).

**States (each runs checks 1–3 with portals included; best-effort triggers — V pins the exact selectors against the slice yields and reports any state it cannot open as `SKIPPED (allowed: no data / not reachable: …)`; a state that cannot be opened for lack of a trigger on dev data is the only allowed skip, never a failure to find a kit overlay):**
| id | Route → trigger | Themes |
|---|---|---|
| B1 | `/dashboard` → "Add task" (OpenTasksWidget) → `TmsDialog` | L D |
| B2 | any legacy route as dispatch-capable user → `aside[aria-label="Dispatch"]` card present at ≥ 901 px, absent on `/dispatch` and at 390 px | L D |
| B3 | `/calendar` → driver availability modal; grid/planner/scheduler view toggles | L (D one) |
| B4 | `/appts` → "Email appt request" dialog | L |
| C1 | `/trucks` → Add Maintenance Task; Add Invoice | L D |
| C2 | `/maintenance` → New (maintenanceUi `Modal`) | L |
| C3 | `/fleet-dashboard` → PM modal | L |
| C4 | `/time-off` → request form | L D |
| C5 | `/intake` → first queue row expanded | L |
| D1 | `/driver-pay` → settings / credit `PayModal` | L D |
| D2 | `/driver-pay-box-trucks`, `/owner-operator-pay` → their `PayModal` | L |
| D3 | `/fuel` → upload (`FuelUploadModal`) | L |
| D4 | `/invoices` → column filter popover | L |
| E1 | `/files` → driver row → `SidePanel` drawer; `InviteDriverModal`; `PacketPickerModal`; `PrivateDocsModal`; `DocumentPreviewModal`; stacked panel over panel (z-order) | L (E1 drawer D) |
| E2 | `/pods` → card → `LoadDrawer`; `PodPreviewDialog` | L D |
| E3 | `/disputes` → status update (`maintenanceUi.Modal`) | L |
| SH1 | company switcher menu open (legacy route) | L D |
| SH2 | collapsed rail on a legacy route (persisted `tms-sidebar-collapsed`) | L |
| SH3 | theme toggle on `/trucks`: click, assert `html[data-tms-theme="dark"]`, `Page.reload` → attribute present **at first script execution** (recorded via `addInitScript`, proves the widened pre-paint script), toggle back | — |
| SH4 | toast: `<Toaster>` root carries `tms-portal` on a legacy route and on `/driver/login` (S2's toast probe covers the colour) | L D |
| A3 | no-access: second temp staff identity with `groups []` → `/dashboard` shows `NoAccess` (tokens, Sign out works) | L D |

**Auth (Browser B, no storage):** `A1` `/dashboard` logged out → `LoginPage` (assert `.tms-portal`, card/inputs/CTA tokens, no console error, no legacy colour, 1600 and 390); `A2` same with `localStorage tms-theme=dark` preset (stored preference honoured; first-paint attribute present); `A4` set-new-password mode via a temp staff user left in `FORCE_CHANGE_PASSWORD` (`AdminCreateUser` with a temporary password, **never completed**, deleted in `finally`; `SKIPPED (allowed)` if the pool refuses). Typed credentials are only the throwaway user's.

**Public (Browser B):** `P1 /track/{truckCode}` (discover a code from the Equipment list via the ADMIN token: the tracking-link field `src/lib/trackingClient.ts` reads — **[UNVERIFIED field name; V reads the client before coding]**; fallback `/track/zz-none` → the "no longer active" state, same frame), `P2 /onboard/{token}` (token from the temp Driver row's onboarding link if the model exposes one, else `/onboard/zz-none`), `P3 /amazon-disputes` (loads without a token). Assert `.tms-public` root, light body background, no shell, no sign-in redirect, no console error, no legacy colour (S2's `publicAuditInPage`), 1600 and 390.

**Report:** one line per (route|state, theme): `PASS`/`FAIL` with the first three offenders; summary `{ pass, fail, skipped, skippedNotAllowed }`; exit non-zero on any `FAIL` or non-allow-listed `SKIPPED`; `Docs/tms-build/screenshots/S3/index.txt` lists every image.

### 9.4 How it is used
* **Local, before the push:** `hub start` `npx vite --config vite.s2dev.config.ts` (dev outputs via `/tmp/s2dev/amplify_outputs.json`, **not** the checked-in prod file; `jq .auth.user_pool_id /tmp/s2dev/amplify_outputs.json` must print `us-east-1_UKhMNVAG1`; delete both the alias config and `/tmp/s2dev` afterwards) → `DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS3.mjs`, iterate until green (this also produces the screenshots). Then `DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS2.mjs` — **must stay green** (shell regression).
* **After the deploy (the logged proof):** `DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com` for `devVerifyS3.mjs`, `devVerifyS2.mjs`, and `node scripts/devVerifyP.mjs` (48/48 must still PASS — functional regression through the new layout). The manifest/service-worker checks of §9.5 only exist on the deployed build (`devOptions.enabled` is false locally).

### 9.5 Driver PWA harness — can it mint a driver identity? **Yes, with one infrastructure check**
What exists: the driver app signs in against its **own Cognito pool** (`bcat-driver-pool`, `backend.ts` L203; dev pool `us-east-1_nnJzcFvTY`, client `qvnqkida69qhuquir2tahjvq`, from the dev outputs `custom`), `USER_PASSWORD_AUTH` is enabled on that client (`backend.ts` L258–260), the session lives in `localStorage['bcat:driver:tokens'] = { idToken, accessToken, refreshToken, expiresAt(ms) }` (`DriverAuthContext.tsx` L26, L71–93), and the API resolves the caller from the token's lower-cased **`email`** (requires `email_verified: true`) against an **active `Driver` row**, falling back to a `DriverPaySetting` by email (`driver-app-api/handler.ts` L483–504, L658–677); no match → 401 "Driver not found" — which is exactly the profile-error screen. The `Driver` model is `allow.authenticated()` (`resource.ts` L257–329), so the ADMIN staff token can create/delete rows. Nothing in `scripts/` mints a driver today (`devIdentity.mjs` is staff-pool only).
`driverIdentity.mjs`:
1. With the ADMIN token: `createDriver` ×2 — **Settlement** (`fleetGroup:'AMAZON'`, `timeClock:false`) and **Paperwork** (`ivanApp:true`, `timeClock:true` so the Hours tab shows), emails `zz-s3-driver-settle-<ts>@example.invalid` / `…-paper-…`, `phone:'+15555550100'`, `active:true`, names `ZZ S3 Settlement` / `ZZ S3 Paperwork`. A third Cognito user with **no** `Driver` row exercises the profile-error screen.
2. Driver pool (`AdminCreateUser` with `MessageAction:'SUPPRESS'` + `email_verified`, `AdminSetUserPassword Permanent`), then `InitiateAuth USER_PASSWORD_AUTH` → tokens → storage `{ 'bcat:driver:tokens': JSON.stringify({ idToken, accessToken, refreshToken, expiresAt: Date.now() + ExpiresIn*1000 }) }`. The driver pool's `PreSignUp` gate only applies to self-sign-up; `AdminCreateUser` bypasses it.
3. `finally`: `AdminDeleteUser` ×3, `deleteDriver` ×2, re-read all five to prove gone; cleanup failure sets exit code 1.
**Two checks V does first (≈ 2 minutes):** (1) a `Driver` row with no `DriverPaySetting` yields a usable `/me` (the handler builds a default setting for the email, L540–549 — **[INFERENCE]**, confirmed by loading `/driver/settlement` once); (2) the infrastructure check: `AdminGetUser` for a nonexistent user on the driver pool with the developer's AWS credentials. **[INFERENCE]** the credentials that already do `AdminCreateUser` on the staff pool also reach the driver pool (same account); the `userManagement` Lambda's grant (`backend.ts` L324) is for the staff pool only and is irrelevant to the local script. If `AccessDeniedException`: the driver passes become `SKIPPED (allowed: no driver-pool access)` and the **documented gap** is:
* verified: `/driver/login`, `/driver/signup` (need no identity; D01–D03, D14) and the loading/`/driver` → login redirect;
* **not verified by the harness:** every authenticated driver screen — shell/tab bar, Settlement, Paperwork, Timeclock, Loads, Scan chooser, Account + theme toggle, Report-issue / truck-picker dialogs, the profile-error screen. The staff admin viewer (`/driver-view`) is **not** a substitute for the harness (impersonation is limited to two named admins, above). Mitigation: vitest render coverage of those components with mocked `driverApi` (§10), and **Ryne does a 10-minute phone pass** on the dev PWA from the checklist in §11.3, with Dennis's or his own admin account via `/driver-view/{driver}` for the page bodies if a real driver is wanted. This is a **documented gap**, not a pass.
**Driver passes (phone 390×844 ×2, light and dark):** `D01 /driver/login` sign-in · `D02` forgot mode · `D03 /driver/signup` form · `D04` profile-error (third user) · `D05 /driver/settlement` · `D06 /driver/paperwork` · `D07 /driver/timeclock` · `D08 /driver/loads` · `D09 /driver/scan` (chooser phase only — **no camera, no upload, no punch, no submit, no quick action clicked; they mutate**) · `D10 /driver/account` (+ toggle round trip: click `Switch to dark theme` → attribute set → persists across reload and across tab navigation) · `D11` Report-issue dialog (opened, not submitted) · `D12` truck-picker dialog · `D13` Hours tab visible for the Paperwork driver / hidden for the Settlement driver · `D14` install hint block (login, non-standalone) · `D15 /driver` index lands on the program's home. Driver audit = the same `auditInPage` minus the `.tms-main` layout checks, plus: root `.tms-driver` and **no `.dark`** anywhere; tab bar fixed to the viewport bottom with height ≥ 56 px and every tab target ≥ 44 px; no horizontal overflow; `meta[name=theme-color]` content equals the `--tms-topbar` value; (deployed only) `GET /manifest.webmanifest` → `theme_color:#ffffff`, `background_color:#f3f6f4`, `display:standalone`, `scope:/driver`, `start_url:/driver`, icons present; toast root has `tms-portal` and sits top-centre on phone.

---------------------------------------------------------------------------------------------------

## 10. Test plan — retarget only what is pinned to the old look; add only what can fail

### 10.1 Existing tests that change (found by grep; everything else is untouched)
| Test | Pinned to | Action |
|---|---|---|
| `components/layout/NavBar.test.tsx` | the deleted legacy rail | **Delete.** Its three real assertions move: (a) nav item hidden without its grant → `TmsShell`/`TmsLayout` test with the same access table (`['loads','quotes']`, `['loads']`, `['tms']`, `['calendar','trucks']`) asserting the same labels/section headings (`BROKERAGE [BCAT Logistics]`, `ASSETS [Ivan Cartage]`, `Rates` href `/tms/rates`); (b) **every `badgeKey` in `PINNED_ITEMS`/`TMS_ITEMS`/`NAV_ITEMS` is answered by `useShellBadgeCounts`** (data-driven over the config — the "wired but never answered" regression) and the quotes-to-reply `3` renders; (c) fleet-only users group under the asset business. |
| `tms/theme.scope.test.ts` | selectors start `.tms-shell/.tms-portal`; only `features/tms` CSS | **Retarget, don't loosen** (§7.2): scan all `src/**/*.css`; allow the token blocks / bridge / `*` border default; keep no-literals-outside-tokens and dark parity. |
| `tms/kit/TmsToaster.test.tsx` L22–26 | `/driver` ⇒ plain sonner (S2's deliberate carve-out) | S3 deliberately flips the contract: assert the `tms-portal` toaster root on `/driver/home` as on `/tms/…`. (The old assertion pinned a look we retired.) |
| `loads/LoadDrawer.render.test.tsx` L79–82 | `container.innerHTML` contains `var(--ds-surface)` and not `border-slate-200` | Delete the substring pins; assert behaviour: the drawer renders as `role="dialog"` with an accessible name and a Close control (`getByRole('dialog')`, `getByRole('button', { name: 'Close' })`). |
| `driver-app/paperwork/PaperworkPage.test.tsx` L450–460 | source-text grep `text-white\|text-slate\|bg-slate\|#0b1220` | **Delete the block**; §7.1 lint is the structural twin and applies to every driver file, not three. |
| `TmsShell.test.tsx`, `TmsLayout.test.tsx` | S1 behaviour | **Keep passing unchanged**, add cases below. |
| `tmsTheme.test.ts` | apply/remove-on-unmount contract | unchanged (the contract is kept — §2.5). Add the `theme-color` sync case. |
No `toHaveStyle`/`getComputedStyle`/snapshot assertion exists in any legacy or driver test (greps), so no other look pin needs re-pinning. A builder who finds a test pinned to an old wrapper rewrites it to role/text queries or deletes it — never re-pins it to the new markup.

### 10.2 New tests (each defends a plausible bug)
| File | Asserts |
|---|---|
| `kit/TmsScrollPage.test.tsx` (A) | renders exactly one `h1` with the title; `actions`/`toolbar` appear in order; `scroll={false}` yields the flex-column fill root; `stickyHead` adds the sticky class; children render inside `.tms-scroll-body`. |
| `TmsShell.test.tsx` additions (A) | `fill` adds `tms-fill`; `aside` renders; hamburger `aria-expanded` toggles, nav-link click and `Escape` close the drawer and return focus; `badgeCounts` for a legacy key (`intake: 4`) renders a badge, `0`/absent renders none. |
| `TmsLayout.test.tsx` additions (A) | at `/trucks` the outlet is inside `.tms-legacy-host`, `tms-fill` is set and the dispatch aside mounts for a user with `dispatch`; at `/tms/dashboard` there is no host, no fill, no aside, and `initializeData` is **not** called; `/driver-view/x` breadcrumb is `Owner operator pay › Driver app`. |
| `useShellBadgeCounts.test.ts` (A) | the config-driven "every badgeKey is answered" test (above); a user without a grant gets no key (gating preserved). |
| `navSections.test` additions (A) | `tmsBreadcrumb('/trucks')`→`[Fleet]`, `'/finances/review'`→`[Finances › Profit review]`, unknown legacy path never `TMS`. |
| `pwaColors.test.ts` (A) | `index.html` meta, `vite.config.ts` manifest `theme_color`/`background_color` equal `--tms-topbar` / `--tms-bg` read from `theme.css` — a token change cannot silently strand the PWA colours. |
| `ui/dialog` smoke (A) | `DialogContent` renders with class `tms-portal` (defends the portal-outside-shell theming that every legacy dialog depends on). |
| `pages/LoginPage.test.tsx` (E) | **none exists today.** Sign-in submits `login(email, password)` once and shows the error text on rejection; the "Set new password" mode renders when `needsNewPassword` and rejects mismatched passwords with "Passwords do not match" without calling `completeNewPassword`; the password toggle flips the input type. (Behaviour that the rebuild could break.) |
| `driver-app/AccountPage.test.tsx` (G) | the appearance button toggles the `data-tms-theme` attribute and persists `tms-theme`; label flips `Switch to dark theme` ⇄ `Switch to light theme`. |
| `driver-app/DriverApp.test.tsx` (G, only if absent) | the shell renders no element with class `dark`, the tab bar has the program's tabs and **no Hours tab** until the profile says `timeClock` (the existing contract in the file's comment). |
| `driver-pay/PayModal.test.tsx` (D) | `PayModal` renders a `dialog` named by `title`, `onClose` fires on `Escape` and on the close button, children render (the three call sites rely on it). |
| `files/SidePanel.test.tsx` (E) | maps `title/subtitle/actions/footer`, `onClose` on `Escape`, `zIndex` applied (stacked-panel ordering). |
| `TrackPage`/public pages (E) | a render per page proves `.tms-public` root and no sign-in redirect (same pattern as S2's three). |
Not tested (not worth it): colours, class names beyond hooks, CSS values, snapshots, icon choice.

### 10.3 Gates (Main, once, after A–G and V)
`npm run typecheck && npm run lint && npm run test` green. Then confirm specifically: `theme.scope`, `kit/*`, `TmsShell/TmsLayout`, the new login/driver tests, every test named in §6, the amplify suites (unchanged), and run `devVerifyS3` + `devVerifyS2` locally before the push.

---------------------------------------------------------------------------------------------------

## 11. Screenshot plan

Output: `Docs/tms-build/screenshots/S3/<id>-<slug>-<theme>.png` (`index.txt` lists them). Staff pages 1600×1000, `deviceScaleFactor` 1; phone shots 390×844 at 2×; theme set by the real toggle once per pass; tall pages clipped to content height (cap 2400 px). **L** light · **D** dark · **M** phone. Every row also runs the §9.3 audit.

### 11.1 Staff app (unified shell) — all in L and D
| id | Route / state | M |
|---|---|:-:|
| L01–L04 | `/dashboard`, `/calendar` (week + planner view), `/dispatch`, `/appts` | L01 |
| L05–L13 | `/driver-info`, `/fleet-dashboard`, `/trucks`, `/truck-docs`, `/maintenance`, `/fuel`, `/insurance`, `/hours`, `/schedule` | L07 |
| L14–L20 | `/time-off`, `/tasks`, `/intake`, `/vehicle-quote`, `/vehicle-confirmation`, `/reddit-queue`, `/pricing-margin` | |
| L21–L29 | `/finances`, `/finances/review`, `/finance/cash-checkin`, `/invoices`, `/driver-pay`, `/driver-pay-box-trucks`, `/owner-operator-pay`, `/ivan-driver-app`, `/driver-view/{driver}` (denied state) | L25 |
| L30–L33 | `/disputes`, `/files`, `/pods`, `/` (landing) | L31 |
| SH1–SH4 | company switcher open · collapsed rail · phone drawer closed/open · toast | SH3 |
| A1–A4 | sign-in (L, D, 390) · set-new-password · no-access | A1 |
| P1–P3 | `/track/{code}` · `/onboard/{token}` · `/amazon-disputes` (L; 390 for each) | ✓ |
| States B1–B4, C1–C5, D1–D4, E1–E3 | §9.3 table — dialogs, drawers, popovers | |
Count: 33 routes × 2 themes = 66 · states ≈ 30 L + 12 D · shell 8 · auth/public ≈ 14 · phone ≈ 14 → **≈ 145 staff images**.

### 11.2 Driver PWA — phone only (390×844 @2×), L and D
`D01 login` · `D02 forgot` · `D03 signup` · `D04 profile-error` · `D05 settlement` · `D06 paperwork` · `D07 timeclock` · `D08 loads` · `D09 scan chooser` · `D10 account (before/after toggle)` · `D11 report-issue dialog` · `D12 truck-picker dialog` · `D13 tab bar with/without Hours` · `D14 install hint` · `D15 index landing`. If the §9.5 infrastructure check fails, only `D01–D03`, `D14` are produced and the rest are marked **not captured (documented gap)** in `index.txt`.

### 11.3 Ryne's review set (contact sheet) and the manual phone checklist
Review set: `L01`, `L03`, `L07`, `L25`, `L31`, `SH1`, `SH3`, `A1` (L + D), `P1`, `D05`, `D06`, `D10` (L + D). Phone checklist for the driver gap (dev PWA, a real driver login or the harness driver): sign in; Settlement tab; Paperwork tab; open a load → Send → file picker round trip (iOS relaunch → back on the scan screen: `DriverLanding` intent restore); Account → Appearance toggle; Report issue; truck picker; log out; add to home screen and check status-bar text is readable in light and dark (D-7) and the launch splash colour (D-4).

---------------------------------------------------------------------------------------------------

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **Codemod mis-maps semantics** (blue as "info" collapsing onto the green primary; status hues; `bg-black/40` scrims). | Report lists `blue-near-status`; T3 makes every owner review their files; all targets are tokens so a miss is a visible tint, not a break; screenshots + audit are the arbiter. The codemod is dry-run first and deterministic. |
| **R2** | **Legacy pages inside a card-styled shell look "flat/old" next to S2 pages** (inline styles, 6 px radii, dense tables). | Tier 0 gives canvas/colour/dark; K pages get the S2 page head + stat rows + badges + dialogs; R pages are consciously token-only (calendar/dispatch/trucks/appts). The bar is "no legacy colour, no hand-built overlay, K head where the pattern exists", not pixel parity with S2. Stated in §2.6 so Ryne reviews against the right target. |
| **R3** | **`fill` host regression**: a legacy page that relied on `.page-content` being a *sibling of a 64 px topbar in a 100vh flex* now has `100dvh − (gap + topbar 56 + gap)`. Pages measuring `100vh` themselves would overflow. | `.tms-legacy-host` is the same `flex:1; min-height:0; overflow:hidden` contract. Check 6 asserts no document scroll at desktop; builders grep their folders for `100vh`/`calc(100vh` (a few exist in sticky offsets) and convert to `100%`. |
| **R4** | **Mobile drawer changes `/tms` on phones** (D-3). | Called out as a decision; the diff is isolated to one `@media` block; `devVerifyS2` phone passes are not in S2's script, so S3's check 7 is the new coverage for both shells. |
| **R5** | **Driver PWA must keep working untouched functionally.** Largest blast radius (installed on drivers' phones; iOS relaunch behaviour; camera). | C12 freeze list; T2; the diff review rule in Slice G acceptance (only className/style/markup lines + three named files); all 20+ existing driver tests green; `ScanCamera` keeps black/white; no `driverApi`/auth/SW edit; dev only — **no production driver is affected until a later, separate promotion**, and the harness never punches, submits or uploads. |
| **R6** | **No authenticated driver verification if the driver pool is not reachable** by the developer credentials (§9.5), and the admin viewer cannot stand in (named-admin allow-list). | Explicit documented gap + manual phone checklist + vitest renders; the script reports `SKIPPED (allowed: …)` rather than passing. First thing V checks. |
| **R7** | **PWA install behaviour:** `theme_color`/`background_color` changes reach an already-installed PWA only on its next manifest refresh; iOS status-bar style (D-7) is `[INFERENCE]`; icons stay blue (D-4). | Dev-only until promoted; the checklist item above; `default` can be flipped back in one line. |
| **R8** | **Dark mode on surfaces that never had it** (calendar, planner, maps, charts, fleet widgets) exposes contrast bugs the light pass hides. | Dark pass runs on **all** 33 routes (not a subset); audit includes luminance + invisible-text; FullCalendar `--fc-*` mapping verified (B). Per-driver identity colours stay data (`data-user-color`) and are legible by construction (own bg+text pairs). |
| **R9** | **Lint guard false positives / S2-folder hits** (3–4-digit hex regex; broadened rule reaches S2 files). | A triages in Phase 0 with a count; explicit `-- not a colour` disables; guard applies to builders' own `eslint <files>` runs from then on. |
| **R10** | **Concurrent edits.** Phase 0 rewrites ≈130 files; any builder editing before the broadcast would collide. | Hard gate: nobody edits before "Phase 0 done"; ownership lists are disjoint (§3.6); shared files are exports-only contracts (§5.2); cross-slice need → `hub`. |
| **R11** | **Shell data cost:** every legacy page now runs `TmsLayout`'s `useShipments({ kind:'all' })` + the legacy badge hooks (previously `NavBar` ran `useLoads` + 8 hooks, `TmsLayout` ran shipments). | Same total order of magnitude as today's legacy rail + the `/tms` rail; the badge sub-hooks keep their page-access gates; measured in the first local run (network panel count) — if material, gate `useShipments` on `/tms` or on the `myQueue/teamQueue/tracking` rows being rendered. |
| **R12** | **Pre-existing, not changed:** global search navigates to Shipments on the first keystroke (`TmsShell.handleQuery`); no catch-all 404 route; `LoginPage` shows a hard-coded "16 UNITS ROLLING"; `lib/*Pdf.ts` and Best Care e-mail keep the old palette (D-6, D-2). | Listed so no reviewer thinks S3 introduced them; each is a one-line follow-up Ryne can ask for. |
| **R13** | **Production safety.** | All work on `dev`; the checked-in `amplify_outputs.json` (prod) is never read by any script; local runs use the dev-outputs alias and the harness refuses non-dev endpoints/pools; the lead alone commits/pushes; no `main`, no prod deploy; `invoice_*.json` untouched; temp identities are `example.invalid`, deleted and re-read. |
| **R14** | **`useTmsTheme` removing the attribute on unmount** could flash a legacy→public client navigation. | Public routes are reached by link from outside the app (new document → pre-paint script keeps them light); no in-app `<Link>` to a public route exists [verify with grep during A]. |

---------------------------------------------------------------------------------------------------

## 13. Delivery order

1. **A: Phase 0** (codemod, driver extraction, lint triage) → broadcast "Phase 0 done". B, C, D, E, G start together; A publishes `TmsScrollPage` + `TmsDrawer.zIndex` first, then tokens/`ui/*`/shell.
2. G reports → A removes the `TmsToaster` `/driver` branch. E reports `TrackPage` clean → A deletes the lint exemption. V starts once tokens + shell are in; V's first action is the driver-pool check (§9.5).
3. Main, once: `npm run typecheck && npm run lint && npm run test`; fix-forward with the owning builder. (`grep -rn "\-\-ds-\|\-\-sh-" src` empty, `grep -rn "components/layout" src` empty, no `position: 'fixed'` modal left outside `driver-app/scanner|settlement` and the `DispatchDrawer` corner button.)
4. Local pass: `devVerifyS3.mjs` then `devVerifyS2.mjs` against `vite.s2dev.config.ts` (§9.4) until green; eyeball §11.3.
5. **One** commit for S3 (+ this plan + screenshots): `S3: green look on every non-TMS surface (unified shell, tokens, driver PWA, sign-in, public pages)`. Wait until `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not RUNNING/PENDING, `git push origin dev` once, wait for SUCCEED.
6. Deployed proof: `devVerifyS3.mjs`, `devVerifyS2.mjs`, `devVerifyP.mjs` (48/48) against the Amplify dev URL; temp staff identities and driver rows/users deleted and confirmed gone; no `zz-*` users remain in either dev pool.
7. `BUILD_LOG.md` S3 entry (top): commit, job id, counts (routes, images, pass/fail), the decisions D-1…D-7 as taken, the documented driver gap if any, the carry-overs (PDFs, e-mail brand, icons, search-on-keystroke). **Stop for Ryne's review** (REDESIGN §6 gate). Promotion to `main`/production is a separate, later decision — not part of S3.

### Cleanup (after the deploy proof, per the workflow)
Delete `scripts/s3Codemod.mjs`, `vite.s2dev.config.ts`, `/tmp/s2dev`, `local://s3-codemod-report.md`; no throwaway lint fixture remains; `Docs/tms-build/screenshots/S3/` stays with the plan; scratch notes are not committed.
