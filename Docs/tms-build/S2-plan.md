# Step S2 — restyle every TMS page onto the green tokens + kit (and fill the kit pieces the pages need)

Spec: `REDESIGN_UI_REFERENCE.md` §1 tokens, §3 kit, §4 "every page", §7 Chat/Tracking cues. S1 (`S1-plan.md`, deployed, job 131) re-valued the
`--tms-*` tokens, rebuilt the shell and converted `/tms/dashboard`. S2 converts **everything else under `/tms/*`**, every dialog/drawer/toast/empty
state those pages open, and the public (tokenised) pages the TMS sends out. Legacy BCAT Ops pages, the legacy shell, the driver PWA, `/track/:code`,
`/onboard/:token`, `/amazon-disputes`, the login page and e-mail templates are **S3** and are not touched.

Batch rule (`TMS_BUILD_BRIEF.md`): S2 and the rate-con items (`RATECON-plan.md`) ship in **one** commit/push/Amplify deploy. This plan is a doc and rides that
deploy. Branch `dev` only; `npm run typecheck && npm run lint && npm run test` green once, by Main, after every slice has landed.

Evidence base: S1 plan/log, a read of the shell/kit/CSS, and seven read-only inventory passes over every file named below (line numbers cited are today's).
Where a claim could not be confirmed from the repo it is marked **[INFERENCE]** and has a check attached.

---------------------------------------------------------------------------------------------------

## 0. At a glance

| Slice | Builder scope | New / major deliverables |
|---|---|---|
| **A** Foundation | `theme.css`, `kit/*`, `tmsTokens.ts`, `index.html`, `eslint.config.js`, `App.tsx` (toaster line) | CSS split into `styles/*.css`; shadcn bridge; layered border default; DataTable/quick-tab/tab restyle; **12 kit pieces** (StatRow, SegmentedTabs, MetaList, DetailSplit, ProfileHeader/Avatar, Timeline, ApprovalCard, Alert, SegmentedBar, Drawer, Toaster, PublicFrame); `useTmsTokens`; hex-literal lint rule |
| **B** Board family + public | `ShipmentsBoard`, `board/*`, Dispatch/Documents/CustomerLinks workstations, document review/preview, check calls, 5 public pages | board card frame, `DocumentPreview` → `TmsDialog`, offer queue → approval cards, public pages on `TmsPublicFrame` (blue/dark-header gone) |
| **C** Tracking + Inbox | `TrackingWorkstation`, `workstations/tracking/*`, `TrackingSection`, tracking dialogs | three-pane Inbox (chat header, green bubbles, quick-action bar, Info panel, driver card, status timeline, location card), map colours from tokens |
| **D** Shipment detail + AR + AP | `ShipmentPage` + 26 `shipments/components/*`, `ar/*`, `ap/*`, `RepPicker`, `DirectoryCreateDialog` | profile-header page head, `TmsDrawer` drawer, `NewShipmentDialog` off legacy tokens, MetaList/StatRow/Timeline adoption, aging strip |
| **E** Records + rates | `directory/*`, `carriers/*` (minus rate-con files), `factoring/*`, `vendor-ap`, `quotes/*`, `LoadDrawer` class | profile headers (customer/carrier drawer), OTR tones → badges, QuoteDetail split view, credit bars |
| **F** Admin | `tms/brokerage/*`, `tms/settings/*`, `tms/integrations/*`, `settings/*`, users, commissions, reports, audit, workflows, academy, `RequirePage` | `settingsKit` → classes, Users KPI/profile headers, approval cards for proposals, academy typography |
| **V** Verification (wave 2) | `scripts/lib/{cdpBrowser,devIdentity}.mjs`, `scripts/devVerifyS2.mjs` | route walk × light/dark, legacy-colour + console audit, ~95 screenshots, public pages unauthenticated |

Counts: 39 TMS route entries + 5 public pages + ~12 dialog/drawer families; 266 non-test source files in the affected folders, of which roughly 110 are expected to change (estimate; the rest are logic or already correct — §1.1).

---------------------------------------------------------------------------------------------------

## 1. Inventory — what S1 already made correct, and what is still wrong

### 1.1 Already correct (verified; S2 must not rework it)

| Area | Evidence |
|---|---|
| All five TMS stylesheets are token-clean | `theme.css`, `shell.css`, `kit/kit.css`, `dashboard/dashboard.css`: zero colour literals outside the two token blocks (light `theme.css` L16–126, dark L128–220). `theme.scope.test.ts` enforces it. |
| Whole-row board tones, chart palette, badge tints, scroll, shadow, overlay, count tokens | In both blocks (row tones L91–109 / L189–206). |
| AR, AP, Quotes, Directory, Carriers, Factoring, Vendors, Settings, Reports, Commissions, Users, Workflows, Audit TSX | Colour comes from `var(--tms-*)` + kit components. Zero Tailwind/shadcn colour utilities in these folders (only `workflows/*` uses Tailwind *layout* utilities). They re-skinned for free in S1. |
| Dashboard charts | `ChartCard.tsx` uses `var(--tms-chart-N)`, `--tms-chart-axis/-grid`, pie stroke `var(--tms-card)`. Nothing to do. |
| Kit dialogs | `TmsDialog` renders `tms-portal tms-dialog-*` into `document.body`; every `TmsDialog` consumer is already themed incl. dark. |
| Kit tests | `TmsDialog`, `TmsBadge`, `TmsListPage`, `TmsKpiCard`, `TmsCountBadge` pass unchanged. |

### 1.2 The delta — what is still hard-coded / legacy / unstyled (numbered; slices reference these ids)

**G = global (slice A), then per-area.**

| # | Finding | Evidence | Fix (slice) |
|---|---|---|---|
| **G1** | **shadcn tokens are theme-blind inside TMS.** shadcn/Tailwind utilities (`bg-popover`, `text-muted-foreground`, `border-input`, `bg-primary`, `ring`, `bg-background`) resolve through `index.css` `:root` (blue `#1ea8f3` brand, white popover). Portals render into `<body>` so they never see `--tms-*` unless the content carries `tms-portal`; even then only `--tms-*` change, not `--popover` etc. Affects: `ui/dropdown-menu` (StatusActions L117/289, StopCards L107, DocumentsSection L209), `ui/checkbox` (3), `ui/switch` (ArCard, DraftOrderEditor), `ui/label` (11), `DirectoryPicker` (`bg-popover`, `hover:bg-accent`), `NewShipmentDialog` (`bg-background`, `border-input`), `legForm` pieces. | `src/index.css` L7–40, L100–123; `InvGlobal` §2 | **A**: a *bridge* rule inside `.tms-shell, .tms-portal` re-pointing the shadcn variables at `--tms-*` (§4.1). No edit to `src/components/ui/*` (legacy S3 pages share them). |
| **G2** | **Tailwind v4 bare `border` is `currentColor`** [INFERENCE — v4 changed the default from gray-200; confirm with the first board screenshot]. ~9 bare-`border`/`border-b`/`border-r` sites in the board family (DispatchWorkstation L198/379/380/486/675, OfferQueue L143, PostingPanel L70, ShipmentsBoard L296/885) and "bordered box" markup everywhere else render with the text colour (near-black rules on white cards). | `InvBoard` B | **A**: `@layer base { .tms-shell *, .tms-portal * { border-color: var(--tms-border) } }` — *layered* so explicit `border-[color:var(--tms-…)]` utilities still win (an un-layered rule would beat every utility). §4.2 has the fallback if `theme.scope.test` rejects `@layer`. |
| **G3** | **Toaster is theme-blind.** `App.tsx` L380 `<Toaster position=… richColors />`: no `theme`, no classNames; sonner's own green/red/yellow. ~84 TMS files call `toast.*`. | `InvGlobal` §3 | **A**: `kit/TmsToaster.tsx` (§3), one-line swap in `App.tsx`. |
| **G4** | **Sheet drawer is hard white** (`ui/sheet.tsx` L18/41/64/85: `bg-white`, `border-slate-200`, `bg-slate-50/50`, overlay `bg-black/40`); `ShipmentDrawer` keeps white in dark with light `--tms-text`; `ScrollArea h-[calc(100vh-56px)]` hard-codes the header height. Consumers: `ShipmentDrawer` (board, factoring, **legacy calendar**), `CarrierProfile` (overrides bg with a var). | `InvDetail`, `InvDirectory` | **A** builds `TmsDrawer`; **D** (ShipmentDrawer) and **E** (CarrierProfile) migrate. `ui/sheet.tsx` stays (still used by legacy). |
| **G5** | **Map polylines/markers are gold `#f4c50c` / blue** in JS options (CSS cannot reach them): `BoardMapView.tsx` L65; `TrackingDetailMap.tsx` L41, L147, L153, L159, L165–166, L201–202. Google base-map colours come from the cloud `mapId` style (outside the repo) and cannot follow the theme. | `InvBoard` A, `InvTracking` A | **A** `tmsTokens.ts` (`readTmsToken`, `useTmsTokens`, §3.12); **B**/**C** consume it. |
| **G6** | **Dark-assuming idioms in `theme.css`.** `.tms-board-grid tbody tr:hover td { filter: brightness(1.15) }` (L1232 pre-split) whites-out light tone rows; `.tms-board-grid thead th` uses `--tms-bg` (L1209); `--tms-topbar` abused as hover/selected row fill (`DocumentsWorkstation` L320–321, `.tms-pod-outcome` L1987, `.tms-select option` L469) — white on white now; `.tms-portal` base has **no background** (L945). | `InvGlobal` §1 | **A** (hover = `inset 0 0 0 9999px color-mix(in srgb, var(--tms-text) 6%, transparent)`; surfaces → `--tms-surface-*`). |
| **G7** | **Undefined tokens / unscoped CSS.** `TrackingConversation.css` (outside `src/features/tms`, so outside the scope test) uses `--tms-link` and `--tms-bg-2` (neither exists in `theme.css`) behind slate hex fallbacks (`#e2e8f0 #1e293b #94a3b8 #2563eb …`) and one `rgba(239,68,68,.06)` (L157). | `InvTracking` | **C** moves it to `styles/conversation.css`, scoped under `.tms-shell`, tokens only (no fallbacks). |
| **G8** | **Missing / mis-scoped classes.** No rule anywhere: `tms-board-shell`, `tms-board-toolbar` (ShipmentsBoard L295–296, Dispatch, Documents, Tracking), `tms-board-exception`, `tms-board-tag-input`, `tms-board-check-label`, `tms-board-batch-rows`, `tms-board-key-section`, `tms-link`, `tms-board-create-list`, `tms-thread-subject`, `tms-thread-body`, `tms-convo-card-load/-link/-pod`, `tms-tracking-views-dropdown`, `tms-academy-body`, `tms-academy-code`, `tms-view-desc`, `tms-badge-yellow`, `tms-grid-1`. `tms-overdue`/`tms-due` are hook-only (asserted by `ShipmentsBoard.test` L642–645) — leave. **Mis-scoped:** `.tms-shell .tms-grid-col-2` (theme.css L1907 pre-split) is used inside a portal dialog (`CarrierOffersSection` L264) where `.tms-shell` does not match. (One scout reported `tms-ready-refusal` as missing; it has a rule at L1999 — builders re-grep every name before adding a rule; the devVerify class audit is the arbiter.) | all scouts | owner of the file that uses the class (§6); `.tms-portal .tms-grid-col-2` → **A**. |
| **G9** | **Stale user-facing/dev copy.** `BrandingPage.tsx` L282–285 says "Only the dark theme is built; LIGHT and SYSTEM will follow" — false since S1. Comments saying "yellow": `kit/TmsEmptyState.tsx` L14, `kit/TmsTabs.tsx` L14. `AcademyPage.tsx` L172 uses `var(--ds-red)`. | `InvAdmin`, `InvGlobal` | F (copy + `--ds-red`), A (comments). |
| **G10** | **Pre-paint theme flash.** `data-tms-theme` is only set after `TmsShell` mounts; a dark-theme user reloading `/tms/*` paints light `--ds-bg` first. | `InvGlobal` §6 | **A**: tiny inline script in `index.html` (§4.6). |
| **B1** | `BoardTagPicker.tsx` L140 `bg-[#333]`, L193/194 `#1d1d1d` (near-black option highlight on a light card); `ColumnsPickerDialog.tsx` L231 `border-[#333]`. | `InvBoard` A | **B** → `--tms-surface-selected/-hover`, `--tms-input-border`. |
| **B2** | `DocumentPreview.tsx` — fixed-position hand-built modal, ~22 inline `style` objects, backdrop `rgba(8,8,8,.62)` L99, shadow `rgba(0,0,0,.45)` L111, `#fff` matte L152/158 (PDF/image page — legitimate), `#dc2626` fallback L51, `--ds-*` fallbacks L45–50. | `InvBoard` | **B** rewrites onto `TmsDialog` (size `xl`), matte via `--tms-paper`. |
| **B3** | Public pages (`CustomerTrackPage`, `CarrierPingPage`, `CarrierUploadPage`: ~30 inline `style` each, hex palette `#f4f6f8 #15202b #e3e8ee #5c6b7a`, **blue** accent `#1ea8f3`; `RateConSignPage`, `QuoteRespondPage`: legacy `--ds-*`, dark `#0e1116` header L377/L501, ~35 inline each). Render outside `.tms-shell`/`.tms-portal`, so no `--tms-*` at all. | `InvTracking` | **B** — `TmsPublicFrame` (§3.11) + kit pieces. |
| **C1** | Inbox lacks the §7 elements (see §8 gap map): no contact row/last-ping dot, no quick-action bar, no closable Info panel, no status timeline, no driver card with call, solid-green "ours" bubble, map/ETA card in the stream. | `InvTracking` | **C** (§8). |
| **C2** | `TrackingDetailMap` also reads legacy `--ds-bg`/`--ds-t3` (L140/143). `TrackingSection` timeline = hand-rolled bordered `li` rows; stray class `0/5` L135. | `InvTracking` | **C**. |
| **D1** | `NewShipmentDialog.tsx` — shadcn `Dialog`/`Button`/`Input` **without** `tms-portal`; `--ds-*` ×12; hex `#ecfdf5 #86efac #15803d #16a34a` L543–545/629; ~20 inline styles; mode `<select>` with `bg-background text-foreground`. Composes legacy `features/loads/legForm` + `DirectoryPicker` + `DirectoryCreateDialog` (no `tms-portal`). | `InvDetail`, `InvDirectory` | **D**: root gets `tms-portal` (G1 bridge restyles the legacy pieces); literals → tokens/`TmsAlert`; `DirectoryCreateDialog` gets an opt-in prop (§6 D). |
| **D2** | `DocumentsSection` tone strings lost their tint: `'border-[color:var(--tms-badge-orange)] 0/5'` L501–505 (dangling `0/5`, no background). Same untinted "alert box" pattern in `DraftOrderEditor` L353–356, `DeliveryCard` (error p; `fill-amber-400` stars L199), `EmailDocumentsDialog` `text-primary` L242, `UploadDocumentDialog` `border-primary` L160, `DivisionCard` `#121212` ink L84. | `InvDetail` | **D** → `TmsAlert`/tint tokens. |
| **D3** | `ShipmentPage.tsx` renders its own "‹ Shipments" back strip (`px-6`) — S1's breadcrumb now says the same, and the strip double-pads the gutter. `ShipmentPageBody` builds the page head by hand (not `TmsPage`). | `InvDetail` | **D**: delete strip; head → `TmsProfileHeader`. |
| **D4** | Status ladders `ArCard` L162–176 / `ApCard` L199–215: lit rung has a primary border but **no fill**. | `InvDetail` | **D**: add `--tms-primary-tint` fill (keep `aria-current="step"`, `data-testid="*-rung-*"`). |
| **E1** | Hex pills: `FactoringDocCell.tsx` L188–189 (`#86efac/#dcfce7/#15803d`, `#fca5a5/#fee2e2/#b91c1c`); `src/lib/otrInvoiceStatus.ts` L27–33 seven `{bg,fg,border}` hex tones applied inline at FactoringPage L375–380, L722–728, OtrPanel L204; `FactoringPage` L733 `rgba(0,0,0,.15)`; OtrPanel L652 `#2563eb` fallback. | `InvDirectory` A | **E** → `TmsBadge` tones; `otrStatusMeta` returns `tone: TmsTone`. |
| **E2** | Red/orange alert tints hard-coded `rgba(237,90,118,.14)` / `rgba(255,136,10,.12)` (old dark hues): QuoteDetail L914, AcceptOfferDialog L192/L204, ConvertQuoteDialog L137, CounterDialog L182, DuplicateQuoteDialog L151, SendQuoteDialog L46, CreditLimitCard L95, VendorApPage L419. | `InvMoney`, `InvDirectory` | **E** → `TmsAlert`. |
| **E3** | `RepPicker.tsx` L206 `boxShadow: '0 12px 30px rgba(0,0,0,.45)'` on a light popover. | `InvDirectory` | **D** (owner of the file, §6) → `var(--tms-shadow-pop)`. |
| **E4** | `CarrierProfile` Sheet header hand-rolled (L210–283); `CustomerProfile` dialog header row (L174–203); both want a profile header + pill tabs; activity/driver-note logs hand-rolled (CarrierProfile L433, LocationDetail L69). | `InvDirectory` | **E** (`TmsProfileHeader`, `TmsSegmentedTabs`/`TmsTabs`, `TmsTimeline`, `TmsDrawer`). |
| **E5** | **Legacy islands rendered on TMS routes:** `features/loads/LoadDrawer.tsx` (Factoring PRO column; shadcn `Dialog`, `--ds-t1/t3`, `border-border bg-muted/40`), `legForm` pieces (inside NewShipmentDialog), `features/files/PrivateDocsModal`, `compliance/EmailSettingsCard`/`EscalationRulesCard` (these two are already kit/tokens — fine). | `InvDirectory`, `InvAdmin` | Treatment in §6 (E, F): `tms-portal` class + bridge; full conversion is S3. |
| **F1** | Inline-style-dense admin pages: `UsersPage` ~70, `CommissionsPage` ~55, `ReportsPage` ~50, `DivisionsPage` ~25, `NotificationsPage` ~18, `ShipmentViewsPage` ~17, `BrandingPage` ~15; shared primitives `settings/settingsKit.tsx` (Panel/GroupLabel/Stack/CheckRow, CSSProperties constants, ~25 callers). Colours are already tokens; the debt is hand-rolled KPI tiles, user cards, pill toggles, event lists. | `InvAdmin` | **F** (StatRow, ProfileHeader, Timeline, ApprovalCard where the pattern exists). |
| **F2** | Academy markdown typography is inline; `tms-academy-body`/`-code` have no CSS; answer box is card-on-card (invisible on light). | `InvAdmin` | **F** (`styles/admin.css`). |
| **F3** | `RequirePage.tsx` `NoAccess` (shared with legacy routes): `boxShadow: '0 12px 30px rgba(0,0,0,0.25)'`, `borderRadius: 6`. | grep | **F**: shadow → `var(--tms-shadow-pop, …)` is not possible (no fallback literals allowed in lint scope) → use `var(--tms-shadow-pop, none)`. |
| **P1** | Hand-rolled "kit patterns" (counts): KPI tiles ×8 (QuotesPage `Totals`, AgingStrip, FactoringPage `StatusTotals`, CreditLimitCard, CustomerArTab, UsersPage KPIs, ReportsPage tiles ×4, FinancialLines totals), label/value `dl` ×14, vertical logs ×7, pill groups ×6, profile headers ×4, approve-style cards ×3, tinted boxes ×20+. | scouts | §3 kit pieces + §6 mandated conversions. |

### 1.3 Things deliberately left alone

* `kit/TmsListPage.tsx`, `TmsTable.tsx`, `TmsCard.tsx`, `TmsDialog.tsx` — class names unchanged; the table/quick-tab/tab look comes from CSS (§4.3). Not rewritten, so ~25 list pages and their tests need no TSX change.
* Ownership `division.color` (data), `CustomerSettingsCard` `TAG_COLORS` (maps keys to tokens), `DivisionsPage.tsx` L151 `'#888888'` colour-input default (data) — kept, each with an `eslint-disable-next-line -- data colour`.
* Google base-map styling (cloud `mapId`): cannot be themed from the repo — **dark theme keeps a light base map**. Accepted (Risk R4).
* `TmsShell.tsx`, `shell.css`, `TmsLayout.tsx`, `dashboard/*` — owned by S1 and the concurrent `S1Nits` pass; S2 only *verifies* them.
* `TrackPage.tsx` (`/track/:code`, truck tracking, legacy palette) — S3.

---------------------------------------------------------------------------------------------------

## 2. Route inventory (every route under `/tms/*` in `src/App.tsx` L247–283, plus `BrokeragePage` L33–108, plus public routes L214–230)

Slice letters: **A** foundation · **B** board family + public pages · **C** tracking & inbox · **D** shipment detail + AR + AP · **E** records & rates · **F** admin.
"States" = the URL variants/tabs/dialogs the screenshot plan (§10) must show. Paths under `src/features/` unless absolute.

### 2.1 TMS shell routes

| # | Route | Component (file) | States / tabs | Slice |
|---|---|---|---|---|
| 1 | `/tms` (index) | `<Navigate to="/tms/dashboard">` | — | — |
| 2 | `/tms/dashboard` | `tms/dashboard/DashboardPage.tsx` | company view, save-view dialog | **verify only** (S1 / `S1Nits`) |
| 3 | `/tms/shipments` | `shipments/ShipmentsBoard.tsx` + `shipments/board/*` | filter rail, grid with tone rows, footer, Columns / Filter set / Batch / Icon-key dialogs, row ⋮ menu, map view, empty | **B** (row menu = `StatusActions` → D) |
| 4 | `/tms/shipments/view/:slug` | same `ShipmentsBoard` | a saved department view | **B** |
| 5 | `/tms/shipments/:id` | `shipments/ShipmentPage.tsx` → `components/ShipmentDrawer.tsx` (`ShipmentPageBody`) → `components/ShipmentDetail.tsx` | tabs `overview, stops, carrier, tracking, documents, financials, invoicing, carrierPay, history, aiAgent` (`detailTabs.ts`); voided banner; draft shipment (no tabs) | **D** (tab `tracking` body = `TrackingSection` → **C**) |
| 5a | shipment drawer (board row click, factoring, calendar) | `components/ShipmentDrawer.tsx` | open | **D** |
| 5b | New shipment / create dialogs | `components/NewShipmentDialog.tsx`, `CreateShipmentDialog.tsx` | open | **D** |
| 6 | `/tms/dispatch` | `shipments/workstations/DispatchWorkstation.tsx` (+ `dispatch/OfferQueue.tsx`, `PostingPanel.tsx`) | queue, suggestions, offers | **B** (after rate-con builder, §11) |
| 7 | `/tms/tracking?tab=tracking` | `shipments/workstations/TrackingWorkstation.tsx` → `tracking/TrackingBoard.tsx` | table, map, recent chips, save-view dialog | **C** (uses B's `board/*`) |
| 8 | `/tms/tracking?tab=inbox[&shipment=id]` | `TrackingWorkstation.tsx` → `tracking/InboxPanel.tsx` + `TrackingConversation.tsx` | list · chat · info panel (§8) | **C** |
| 9 | `/tms/tracking/links` | `shipments/workstations/CustomerLinksPage.tsx` | list, extend/revoke dialogs | **B** |
| 10 | `/tms/documents` · `/tms/documents/view/:slug` | `shipments/workstations/DocumentsWorkstation.tsx` (+ `documents/PodReviewCard.tsx`) | list, detail aside, POD review | **B** |
| 11 | `/tms/documents/review` | `documents/DocumentReviewPage.tsx` (+ `DocumentPreview.tsx`) | list, preview modal, accept/reject dialog | **B** |
| 12 | `/tms/check-calls` | `tracking/CheckCallsPage.tsx` | tabs exceptions / worklist | **B** |
| 13 | `/tms/rates` | `quotes/QuotesPage.tsx` | status tabs, totals banner, dialogs | **E** |
| 14 | `/tms/rates/lanes` | `quotes/LaneRatesPage.tsx` (+ `LaneHistoryPanel`) | lookup result | **E** |
| 15 | `/tms/rates/new` · `/tms/rates/:id` | `quotes/QuoteDetail.tsx` (+ `quotes/components/*`) | draft, sent, offers, thread; Send / Accept / Counter / Convert / Duplicate / Mark-lost dialogs | **E** |
| 16 | `/tms/invoicing` | `ar/InvoicingPage.tsx` → `ar/ArPage.tsx` | views `to-invoice, docs-needed, ready-for-billing, unpaid, paid, payments`; aging strip; filters card | **D** |
| 17 | `/tms/invoicing/invoices/:id` | `ar/InvoiceDetail.tsx` | tabs `summary, pdf, email, payments, factoring`; Generate / Email / Receive / Credit memo / Write-off / Send-to-factor dialogs | **D** |
| 18 | `/tms/invoicing/payable` | `ar/InvoicingPage.tsx` → `ap/ApPage.tsx` | views `awaiting, review, to-pay, paid, payments` | **D** |
| 19 | `/tms/invoicing/payable/bills/:id` | `ap/BillDetail.tsx` | tabs `summary, payee, approval, payments`; Record / Approve / Pay / Credit / Remittance / Charges dialogs | **D** |
| 20 | `/tms/carriers` | `carriers/CarriersPage.tsx` | tabs, filter rail, add dialog | **E** |
| 21 | `/tms/carriers/:id` | `CarriersPage` + `carriers/components/CarrierProfile.tsx` (drawer) | tabs `profile, equipment, compliance, contacts, payment, ap, aiAgents, loads, activity`; Book / Status dialogs; `RateConPanel` (**rate-con builder owns**, §11) | **E** |
| 22 | `/tms/factors` | `factoring/FactoringPage.tsx` (+ `OtrPanel`, `ManualInvoicePanel`, legacy `loads/LoadDrawer`) | OTR strip, totals, row dialog | **E** |
| 23 | `/tms/customers` | `directory/DirectoryPages.tsx` (`CustomersPage`) + `components/CustomerProfile.tsx` | tabs, profile dialog tabs account/contacts/documents/locations/settings/AI/AR, merge dialog | **E** |
| 24 | `/tms/locations` | `directory/DirectoryPages.tsx` (`LocationsPage`) + `LocationDetail.tsx` | list, detail dialog with map | **E** |
| 25 | `/tms/vendors` | `vendor-ap/VendorApPage.tsx` | tabs, detail dialog, payment dialog | **E** |
| 26 | `/tms/workflows` | `workflows/WorkflowsPage.tsx` (`?tab=errors` / `?tab=agents`) | Errors, Agents, identify dialog | **F** |
| 27 | `/tms/workflows/runs/:id` | `workflows/RunTracePage.tsx` → `RunTrace.tsx`, `proposalCards.tsx` | steps rail, facts, proposals | **F** |
| 28 | `/tms/academy` · `/tms/academy/:slug` | `tms/pages/AcademyPage.tsx` | index, article (headings/code/table), Ask box | **F** |
| 29 | `/tms/brokerage` (Settings) | `tms/brokerage/BrokeragePage.tsx` → `settings/SettingsPage.tsx` + 17 `settings/*Card.tsx` + `settingsKit.tsx` | all cards | **F** |
| 30 | `/tms/brokerage/users` | `users/UsersPage.tsx` | KPI strip, user cards expanded | **F** |
| 31 | `/tms/brokerage/commissions` | `commissions/CommissionsPage.tsx` | tabs, rows, 3 dialogs | **F** |
| 32 | `/tms/brokerage/reports` | `reports/ReportsPage.tsx` | tabs (4+) | **F** |
| 33 | `/tms/brokerage/audit` | `audit/AuditPage.tsx` | list | **F** |
| 34 | `/tms/brokerage/divisions` | `tms/settings/DivisionsPage.tsx` | tree, rule list, dialogs | **F** |
| 35 | `/tms/brokerage/views` | `tms/settings/ShipmentViewsPage.tsx` | list, editor dialog | **F** |
| 36 | `/tms/brokerage/integrations` · `…/integrations/:provider` | `tms/integrations/IntegrationsTab.tsx` → `IntegrationsIndex.tsx`, `IntegrationPage.tsx`, `providerExtras.tsx` | index, provider | **F** |
| 37 | `/tms/brokerage/ai-agents` | `tms/settings/AiAgentsPage.tsx` | tabs General + per-agent | **F** |
| 38 | `/tms/brokerage/company/{company,billing,branding,notifications,import,aljex-import,account}` | `tms/brokerage/company/CompanyTab.tsx` → `CompanyPage, BillingPage, BrandingPage, NotificationsPage, ImportPage, AljexImportPage, AccountPage` | 7 pages | **F** |
| 39 | `/tms/brokerage/demo` | `tms/brokerage/DemoPage.tsx` | steps, confirm dialog | **F** |

### 2.2 Public pages (outside `AuthGuard`/shell — App.tsx L214–230)

| # | Route | Component | Slice |
|---|---|---|---|
| P1 | `/track/s/:token` customer tracking link | `tracking/CustomerTrackPage.tsx` | **B** |
| P2 | `/track/l/:token` carrier ping | `tracking/CarrierPingPage.tsx` | **B** |
| P3 | `/track/u/:token` carrier upload | `tracking/CarrierUploadPage.tsx` | **B** |
| P4 | `/sign/rate-con/:token` | `carriers/RateConSignPage.tsx` (rate-con items also touch the signing flow — §11) | **B** |
| P5 | `/quote/:token` | `quotes/public/QuoteRespondPage.tsx` | **B** |
| — | `/track/:code`, `/onboard/:token`, `/amazon-disputes`, `/driver/*` | legacy / driver | **S3, not touched** |

### 2.3 Cross-cutting surfaces (not routes) and who owns them

| Surface | Where | Slice |
|---|---|---|
| Toasts (sonner) | `App.tsx` L380 → `kit/TmsToaster.tsx` | **A** |
| Radix dropdown menus (`ShipmentRowActions`, `LoadActions`, stop menu, Generate menu) | `StatusActions.tsx`, `StopCards.tsx`, `DocumentsSection.tsx` | look via G1 bridge (A); markup **D** |
| Drawers | `ShipmentDrawer` (D), `CarrierProfile` (E) → `TmsDrawer` (A) | A/D/E |
| Empty states | `TmsEmptyState` (17 uses) vs ~55 hand-rolled `<p className="tms-muted">No …</p>` | each slice, rule L9 (§5) |
| `RequirePage` "No page access" | `components/RequirePage.tsx` | **F** |
| Shared pickers | `components/RepPicker.tsx`, `components/directory-picker/*` | **D** |
| Legacy islands on TMS routes | `loads/LoadDrawer.tsx` (E), `files/PrivateDocsModal.tsx` (F), `loads/legForm.tsx` (inside NewShipmentDialog, D) | see E5 |

---------------------------------------------------------------------------------------------------

## 3. Kit pieces S2 adds (REDESIGN §3) — only the ones pages need

All new files in `src/features/tms/kit/`, exported from `kit/index.ts`, rules in `kit/kit.css`, classes under `.tms-shell`/`.tms-portal`, tokens only.
**Kit files import each other directly, never the `kit` barrel** (the barrel re-exports `TmsShell`; S1 R4). Existing class names stay.

| Piece | Built? | Why / first consumers (mandatory in §6) |
|---|---|---|
| `TmsStatRow` | **yes** | 8 hand-rolled KPI tile sets (P1). |
| `TmsSegmentedTabs` | **yes** | Pill groups for filters/views: tracking Active/Inbox, board Table/Map + Active/Inactive, LaneHistory window, Billing division picker. `TmsTabs` stays the page-section strip. |
| DataTable restyle | **CSS only** | `.tms-table`, `.tms-board-grid`, `.tms-postings-table` (§4.3). No new component. |
| `TmsMetaList` | **yes** | 14 hand-rolled `dl`s. |
| `TmsDetailSplit` | **yes** | QuoteDetail 2fr/1fr grid, InvoiceDetail PDF tab, DocumentsWorkstation detail. |
| `TmsProfileHeader` (+ `TmsAvatar`) | **yes** | Shipment page head, CustomerProfile, CarrierProfile, UsersPage user card (compact). |
| `TmsTimeline` | **yes** | HistorySection, TrackingSection feed, Inbox status timeline, QuoteDetail events, RunTrace steps, CarrierProfile activity, commission events, public step bar. |
| `TmsApprovalCard` | **yes** | `proposalCards.tsx` (5 cards), `OfferQueue` (carrier offers), CommissionsPage approve rows. |
| `TmsAlert` | **yes** (not in REDESIGN §3; needed — kills ~20 hard-coded tinted boxes) | E2, D2. |
| `TmsSegmentedBar` | **yes** (chart piece) | `CreditLimitCard` usage/aging bars, `ReportsPage` aging share. |
| `Gauge`, `PillBarChart` | **no** | No S2 page needs them; belong to S4 (Financial operations / Expenses). Recorded so S4 builds them. |
| `TmsDrawer` | **yes** (Modal/Drawer) | ShipmentDrawer, CarrierProfile. `TmsDialog` is the Modal (already built). |
| `TmsToaster` | **yes** | G3. |
| `TmsPublicFrame` | **yes** | the 5 public pages. |
| `tmsTokens.ts` | **yes** | G5. |

### 3.1 Exact contracts (A implements; B–F code against these signatures before A lands)

```ts
// kit/TmsKpiCard.tsx — EXTEND (existing props unchanged; root stays <div className="tms-kpi-card">)
interface TmsKpiCardProps { /* …existing… */
  tone?: 'default' | 'good' | 'warn' | 'bad'      // colours the value (aging "late" = 'bad'); default 'default'
  compact?: boolean                                 // in-card use: 20px value, no shadow, tighter padding
  onClick?: () => void                              // renders the card as <button type="button" className="tms-kpi-card tms-kpi-card-button">
  testId?: string                                   // data-testid on the root
}

// kit/TmsStatRow.tsx
export interface TmsStat { key?: string; label: string; value: string | null; icon?: LucideIcon; sub?: string | null
  delta?: TmsKpiCardProps['delta']; positiveIsGood?: boolean; tone?: TmsKpiCardProps['tone']; onClick?: () => void; testId?: string }
export interface TmsStatRowProps { items: TmsStat[]; columns?: 2 | 3 | 4 | 5; compact?: boolean; className?: string; 'aria-label'?: string }
export function TmsStatRow(p: TmsStatRowProps): JSX.Element      // <div role="group" className="tms-stat-row tms-stat-row-N"> of TmsKpiCard; columns default = min(items.length, 4); value null → '—'

// kit/TmsSegmentedTabs.tsx
export interface TmsSegmentedTabsProps { tabs: TmsTab[]; active: string; onSelect: (key: string) => void
  size?: 'sm' | 'md'; 'aria-label'?: string; className?: string }
export function TmsSegmentedTabs(p): JSX.Element                 // role="tablist"; buttons role="tab" aria-selected; class tms-seg / tms-seg-item (.tms-active) / tms-seg-count;
                                                                  // ←/→ moves selection to the neighbouring tab and focuses it (roving tabindex); Home/End jump

// kit/TmsMetaList.tsx
export interface TmsMetaItem { label: ReactNode; value: ReactNode; hidden?: boolean; wide?: boolean; testId?: string }
export interface TmsMetaListProps { items: TmsMetaItem[]; columns?: 1 | 2 | 3 | 4; dividers?: boolean /* default columns === 1 */; dense?: boolean; className?: string }
export function TmsMetaList(p): JSX.Element                      // <dl className="tms-meta tms-meta-cols-N">; per item <div class="tms-meta-row"><dt class="tms-meta-label"/><dd class="tms-meta-value"/></div>;
                                                                  // null | undefined | '' value → muted '—'; `hidden` items are skipped; `wide` spans all columns

// kit/TmsDetailSplit.tsx
export interface TmsDetailSplitProps { children: ReactNode /* primary */; aside: ReactNode; ratio?: '2/1' | '7/5' | '6/6' /* primary/aside, default '2/1' */
  asideSide?: 'left' | 'right' /* default 'right' */; sticky?: boolean; className?: string }
export function TmsDetailSplit(p): JSX.Element                   // CSS grid; ≤1100px collapses to one column, primary first

// kit/TmsProfileHeader.tsx
export interface TmsProfileColumn { title: string; rows: Array<{ icon?: LucideIcon; label?: string; value: ReactNode; hidden?: boolean }> }
export interface TmsProfileHeaderProps { name: ReactNode; as?: 'h1' | 'h2' | 'h3' | 'div' /* default 'h2' */
  avatarLabel?: string /* initials source; defaults to `name` when it is a string */; icon?: LucideIcon /* entity tile instead of initials (a shipment, a location) */
  subtitle?: ReactNode; chips?: ReactNode; actions?: ReactNode; columns?: TmsProfileColumn[]; compact?: boolean; className?: string }
export function TmsProfileHeader(p): JSX.Element
export function TmsAvatar(p: { label: string; icon?: LucideIcon; size?: 'sm' | 'md' | 'lg'; className?: string }): JSX.Element   // --tms-primary-tint circle
export function initialsOf(text: string): string                 // "Ryne Sanchez"→"RS", "ryne@x.com"→"R", ""→"?"

// kit/TmsTimeline.tsx
export interface TmsTimelineItem { id: string; title: ReactNode; tag?: ReactNode; description?: ReactNode; at?: ReactNode
  tone?: 'green' | 'orange' | 'red' | 'blue' | 'gray'; state?: 'done' | 'current' | 'upcoming'; testId?: string }
export interface TmsTimelineProps { items: TmsTimelineItem[]; compact?: boolean; ariaLabel?: string; empty?: ReactNode; className?: string; 'data-testid'?: string }
export function TmsTimeline(p): JSX.Element                      // <ol className="tms-timeline">; <li data-state>; done = filled green node with check, current = ringed + aria-current="step",
                                                                  // upcoming = hollow muted; `tone` recolours the node for log-style timelines (state defaults to 'done'); items.length===0 → `empty`

// kit/TmsApprovalCard.tsx   (+ TmsButton variants 'approve' | 'reject': green / red OUTLINE, added to TmsButtonVariant)
export interface TmsApprovalCardProps { title: ReactNode; subtitle?: ReactNode; chip?: ReactNode; meta?: ReactNode; children?: ReactNode
  to?: string /* eye-icon "View" link */; onApprove?: () => void; onReject?: () => void; approveLabel?: string; rejectLabel?: string
  actions?: ReactNode /* extra buttons, rendered before Approve/Reject */; busy?: boolean; testId?: string; className?: string }
export function TmsApprovalCard(p): JSX.Element

// kit/TmsAlert.tsx
export interface TmsAlertProps { tone?: 'red' | 'orange' | 'green' | 'blue'; icon?: LucideIcon | false; title?: ReactNode; children?: ReactNode; className?: string; role?: 'alert' | 'status' }
export function TmsAlert(p): JSX.Element                         // .tms-alert .tms-alert-{tone}: --tms-badge-{tone}-tint fill, 1px --tms-badge-{tone} border, ink --tms-text; default role red/orange 'alert', else 'status'

// kit/TmsSegmentedBar.tsx
export interface TmsSegment { key: string; label: string; value: number }
export interface TmsSegmentedBarProps { segments: TmsSegment[]; ariaLabel: string; formatShare?: (pct: number) => string; className?: string }
export function TmsSegmentedBar(p): JSX.Element                  // one horizontal bar, shares above (54% / 20% / 26%); segment i uses var(--tms-chart-{i+1}) (green→dark green→near-black…);
                                                                  // shares are largest-remainder rounded so they ALWAYS sum to 100; total 0 → empty track + "No data"

// kit/TmsDrawer.tsx
export interface TmsDrawerProps { open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode
  headerExtra?: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' | 'xl'; onInteractOutside?: (e: Event) => void; className?: string; children: ReactNode }
export function TmsDrawer(p): JSX.Element                        // Radix Dialog: overlay "tms-portal tms-dialog-overlay", content "tms-portal tms-drawer tms-drawer-{size}" docked right, full height,
                                                                  // flex column (header | scrolling body | footer) — no hard-coded header heights; Esc / overlay / × close; works outside .tms-shell (legacy calendar uses ShipmentDrawer)

// kit/TmsToaster.tsx
export function TmsToaster(): JSX.Element                         // sonner <Toaster className="tms-portal" position={isPhone ? 'top-center' : 'bottom-right'} richColors={false} theme from html[data-tms-theme] + style vars
                                                                  // (--normal-bg/-text/-border → card/text/border; --success-*/--error-* → badge tint/ink). `isPhone` rule copied from App.tsx; App.tsx's local copy is deleted.
                                                                  // Uses useLocation(): on `/driver/*` (dark driver PWA, S3) it renders today's `<Toaster richColors>` unchanged, so driver toasts do not turn into light cards.

// kit/TmsPublicFrame.tsx
export interface TmsPublicFrameProps { title?: ReactNode; subtitle?: ReactNode; brand?: ReactNode; width?: 'sm' | 'md' | 'lg'; footer?: ReactNode; children: ReactNode }
export function TmsPublicFrame(p): JSX.Element                   // <div className="tms-portal tms-public"> light canvas (--tms-bg), centred card (--tms-radius-card), brand strip (primary mark + name) — never dark,
                                                                  // no dark #0e1116 header; CTA = <TmsButton variant="primary" className="tms-public-cta">; notices = TmsAlert

// kit/TmsEmptyState.tsx — EXTEND: `compact?: boolean` (in-card, no big icon).  kit/TmsButton.tsx — EXTEND: variants 'approve' | 'reject'.

// tms/tmsTokens.ts   (pure + hook; for JS-only colour consumers: map polylines, SVG fallbacks, chart libs)
export function readTmsToken(name: `--tms-${string}`, from?: Element | null): string          // computed value, trimmed; '' when unresolved; `from` defaults to .tms-shell else <body>
export function useTmsTokens<const N extends readonly `--tms-${string}`[]>(names: N): Record<N[number], string>
                                                                                                // re-resolves when <html data-tms-theme> changes (MutationObserver)
```

---------------------------------------------------------------------------------------------------

## 4. Global CSS / platform delta (slice A) — designed, not left to the builder's taste

### 4.1 shadcn bridge (G1) — one rule, no edits to `src/components/ui/*`
Added to `theme.css` after the portal block, as a **separate one-line-selector rule** (`.tms-shell, .tms-portal { … }` on one line, so the scope test's "first light block" marker `.tms-shell,\n.tms-portal {` is not disturbed). It only contains `var(--tms-*)` references (no literals), so it needs no dark twin — the `--tms-*` values flip with the theme:
```
--background: var(--tms-card);        --foreground: var(--tms-text);
--card: var(--tms-card);              --card-foreground: var(--tms-text);
--popover: var(--tms-bg-elevated);    --popover-foreground: var(--tms-text);
--primary: var(--tms-primary);        --primary-foreground: var(--tms-on-primary);
--secondary: var(--tms-surface);      --secondary-foreground: var(--tms-text);
--muted: var(--tms-surface);          --muted-foreground: var(--tms-muted);
--accent: var(--tms-surface-hover);   --accent-foreground: var(--tms-text);
--destructive: var(--tms-destructive);--destructive-foreground: var(--tms-on-destructive);
--border: var(--tms-border);          --input: var(--tms-input-border);   --ring: var(--tms-primary);   --radius: var(--tms-radius);
```
Why it works [INFERENCE — confirm in the first menu screenshot: `getComputedStyle(menuContent).backgroundColor` equals the card colour]: `@theme inline` compiles `bg-popover` to `var(--popover)` read at the element, so a custom property declared on the same element (`DropdownMenuContent className="tms-portal"`, already how StatusActions/StopCards/DocumentsSection call it) or an ancestor (`.tms-shell`) wins over `:root`. (`.tms-portal` deliberately gets no `background` here: Radix content brings its own `bg-popover`; `TmsDrawer`/`TmsDialog` set their own surface).
Effect on legacy pages: none (selectors are scoped; `index.css` is untouched).

### 4.2 Border colour default (G2)
`@layer base { .tms-shell *, .tms-portal * { border-color: var(--tms-border); } }` in `theme.css`. Layered on purpose: Tailwind utilities live in `@layer utilities`, an **un-layered** rule would override every `border-[color:var(--tms-badge-red)]`. If `theme.scope.test.ts`'s selector parser cannot read a rule nested in `@layer` (it skips `@…` *preludes* only), A teaches the test to descend into `@layer` blocks — it must **not** drop the scope assertion. Acceptance: in the screenshot run, `getComputedStyle` of a bare-`border` element (e.g. `OfferQueue` row) has `border-top-color` = the `--tms-border` value, and an element with `border-[color:var(--tms-badge-red)]` keeps red.

### 4.3 Restyle by CSS (so ~25 pages change with zero TSX)
* **DataTable** (`.tms-table`, `.tms-board-grid` header, `.tms-postings-table`): header row `--tms-surface-subtle`, 12px/600 uppercase muted, 1px bottom border; body 13px, 44px rows, hairline `--tms-border` dividers, last row no divider; hover `--tms-surface-hover`; selected `--tms-surface-selected`; sticky header over the card background; checkbox column 40px; trailing icon actions muted → ink on hover; wrapper = white card (`--tms-radius-card`, 1px border) so a table on the canvas reads as a card.
* **Quick tabs** (`.tms-quick-tabs` / `.tms-quick-tab`, TmsListPage): become the reference *SegmentedTabs* pill group (track `--tms-surface`, active pill = white card with green text/`--tms-shadow`, count chip `--tms-primary-tint`/`--tms-primary-ink`). Same DOM → `TmsListPage.test.tsx` untouched.
* **`TmsTabs`** (`.tms-tabs/.tms-tab`): stays the *underline* strip for page sections (Settings, detail tabs); active = 2px `--tms-primary` underline + `--tms-text` 600, count chip as above, horizontal scroll with fade at ≥8 tabs (shipment detail has 10).
* **Portal grid fix**: `.tms-portal .tms-grid-col-2` alongside the shell rule (G8).
* **Hover idiom** (G6): `box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--tms-text) 6%, transparent)`; no `filter: brightness`.
* `.tms-select option`, `.tms-pod-outcome`, any `--tms-topbar` used as a row fill → `--tms-surface-subtle` / `--tms-surface-hover`.
* New token (parity-tested): `--tms-paper` (`#FFFFFF` in both blocks) — the page/PDF/image matte in document previews; replaces literal `#fff` in `DocumentPreview`.
* Kit CSS for every §3 piece goes in `kit/kit.css` (A). Public-frame rules live there too (no separate `public.css`).

### 4.4 Toaster (G3)
`TmsToaster` carries `className="tms-portal"` and passes sonner's CSS variables (`--normal-bg/-text/-border`, `--success-bg/-text/-border`, `--error-*`, `--warning-*`, `--info-*`) as `style` values that are `var(--tms-…)` strings, so no literal. `theme` prop is read from `html[data-tms-theme]` (re-evaluated on change). Because `App.tsx` mounts it once for the whole app, staff-legacy pages' toasts also take the light card look (accepted; S3 inherits); `/driver/*` is excluded (the driver PWA is dark and keeps sonner's current look until S3). [INFERENCE: sonner 2.x honours those variable names — confirm with the toast screenshot (copy-link in `CustomerLinkDialog` raises one).]

### 4.5 `TmsDrawer` replaces `ui/sheet` in TMS (G4)
`ShipmentDrawer` (D) and `CarrierProfile` (E) migrate; `ui/sheet.tsx` is untouched (legacy `LoadDrawer`-era pages still import it). `ShipmentDrawer` is also opened from the **legacy calendar** (`SchedulerView`) — `TmsDrawer` is self-contained under `.tms-portal`, so it renders correctly there.

### 4.6 Pre-paint theme (G10)
`index.html` `<head>`: `<script>try{if(location.pathname.indexOf('/tms')===0&&localStorage.getItem('tms-theme')==='dark')document.documentElement.setAttribute('data-tms-theme','dark')}catch(e){}</script>`. `useTmsTheme` still owns set/remove; this only removes the first-paint flash. Public routes (`/track/s/…`, `/sign/…`, `/quote/…`) do not start with `/tms`, so they are never dark.

### 4.7 Lint rule that keeps it fixed (`eslint.config.js`)
New override with `files: ['src/features/{tms,shipments,carriers,directory,quotes,ar,ap,factoring,vendor-ap,workflows,tracking,documents,settings,users,commissions,reports,audit}/**/*.{ts,tsx}', 'src/components/{RepPicker,RequirePage}.tsx', 'src/components/directory-picker/**']`, `ignores: ['**/*.test.{ts,tsx}']`, rule `no-restricted-syntax` with selectors for string `Literal`s and `TemplateElement`s whose value matches `^\s*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()` — message "Use a --tms-* token (or TmsAlert/TmsBadge)". Data colours and PDF mattes take `// eslint-disable-next-line no-restricted-syntax -- data colour`. This is the TSX twin of the CSS literal guard `theme.scope.test.ts` already enforces; it runs in the existing `npm run lint` gate. Builders get it as a *failing signal*: they run `npx eslint <owned files>` (scoped) — allowed.

### 4.8 CSS file split (so five builders can edit CSS concurrently)
`theme.css` is 2,048 lines; sections below belong to one page family each. **A's first action** moves them *verbatim* (selectors and declarations unchanged) into new files under `src/features/tms/styles/`, adds `@import`-free `import '../styles/…css'` lines to `kit/index.ts`, and leaves the rest in `theme.css`. Match by section comment — line numbers are today's:

| New file (after the move, owned by) | Moves out of `theme.css` |
|---|---|
| `styles/board.css` (**B**) | "Shipments board extras" L1136–1143, "Aljex-style shipments board (R2)" L1144–1265, "Dispatch workstation" L1909–1933, "POD review" L1934–1997 |
| `styles/tracking.css` (**C**) | "Tracking workstation" L1267–1593, "Inbox" L1594–1818, plus the `.tms-thread-*`, `.tms-checkcall-*` rules inside "Step P — shipment detail additions" |
| `styles/detail.css` (**D**) | the rest of "Step P — shipment detail additions" (building banner, postings table, offers) L1839–1908 |
| `styles/money.css` (**D**) | "Ready for billing (P10)" L1998–2048 |
| `styles/admin.css` (**F**) | "Demo page (Step P11)" L1820–1838 |
| `styles/conversation.css` (**C**, created by C) | `shipments/workstations/tracking/TrackingConversation.css`, scoped under `.tms-shell`, fallbacks removed |
| `styles/directory.css` (**E**, only if E needs one) | new |

Rule: **B–F do not edit any `.css` file until A broadcasts "CSS split done"**; they do their TSX first. After the broadcast each owner has sole write access to the files in the table. `theme.css`, `kit/kit.css` stay A's (others `hub`-ask A for a rule they cannot place in their own file).

---------------------------------------------------------------------------------------------------

## 5. Look rules every builder applies (one list, so six builders converge)

| Rule | |
|---|---|
| **R1** | No colour literals in TSX/CSS (lint + scope test enforce). Colour = `var(--tms-*)`; status = `TmsBadge tone`; tinted box = `TmsAlert`. |
| **R2** | A page body is a stack of white cards (`TmsCard` / `.tms-card`, 14px radius, 1px `--tms-border`) on the canvas. A bare bordered `div` that is a card in effect → `TmsCard`. Board/workstation shells become a single card frame (B, C, `tms-board-shell`). |
| **R3** | Page title via `TmsPage`/`TmsListPage`/`TmsProfileHeader`; no hand-built `h1` + head. |
| **R4** | Label/value rows → `TmsMetaList`; KPI numbers → `TmsStatRow`; vertical logs → `TmsTimeline`; approve/reject style cards → `TmsApprovalCard`; pill choice groups → `TmsSegmentedTabs`. Only where the file has that pattern today (§6 lists them). |
| **R5** | Do not mass-convert inline→class in files that are already token-only. Convert an inline style only when it carries static colour/typography the kit now owns, or the file is on the §6 list. Dynamic values (widths, grid templates) stay inline. |
| **R6** | Keep every `data-testid`, `aria-*`, role, accessible name, table `aria-label`, `<tr>/<td>` order and the class hooks tests select (`tms-overdue/-due`, `tms-demo-step/-tick/-tick-off`, `tms-footer-count`, `tms-board-section-title`, `tms-badge-red` on the OTR red badge, `data-gap`, `input[type=file]` shape in `FactoringDocCell`). |
| **R7** | Dialogs use `TmsDialog`; wide content `tms-dialog-wide` / `tms-dialog-xl`. Any shadcn `Dialog`/`Sheet`/`DropdownMenu` content that must stay carries `className="tms-portal …"` (bridge, §4.1). |
| **R8** | A list/table that renders *only* "No …" gets `TmsEmptyState` (`compact` inside cards). One-line "None" captions inside a card stay `tms-muted`. |
| **R9** | Every new class gets a rule in a file you own, scoped under `.tms-shell`/`.tms-portal`; re-grep the five sheets before adding a rule for a "missing" class. |
| **R10** | Both themes: only tokens, so dark follows. Anything that cannot (PDF/iframe matte, Google base map) is called out in the file with a one-line comment, and an intentionally white surface carries `data-tms-paper` (the devVerify dark-theme audit allow-lists exactly that attribute). |
| **R11** | Do not touch `src/index.css`, `src/components/ui/*`, `AppLayout/NavBar/Topbar`, `TmsShell/shell.css/TmsLayout`, `dashboard/*`, legacy feature folders (S3). |
| **R12** | Do not run typecheck/lint/test project-wide. Your own scoped `npx vitest run <your test files>` and `npx eslint <your files>` only; Main runs the gates once at the end. |

---------------------------------------------------------------------------------------------------

## 6. Slices — six parallel builders, non-overlapping file ownership

Every file in `src/features/` that a TMS route renders is in exactly one list below (checked against the §2 inventory). A test file is owned by the slice that owns its component. A builder that needs a change in a file it does not own sends a `hub` message to the owner (A for `theme.css`/`kit/*`). All builders: R1–R12 (§5); no project-wide validation; when done, `yield` with the list of files touched and the screenshots/states they could not exercise.

### Slice A — Foundation: kit, tokens, global CSS, toaster, lint
**Owns:** `src/features/tms/theme.css`; `src/features/tms/theme.scope.test.ts`; `src/features/tms/kit/{kit.css,index.ts,TmsKpiCard.tsx,TmsKpiCard.test.tsx,TmsButton.tsx,TmsEmptyState.tsx,TmsTabs.tsx}`; **new** `kit/{TmsStatRow,TmsSegmentedTabs,TmsMetaList,TmsDetailSplit,TmsProfileHeader,TmsTimeline,TmsApprovalCard,TmsAlert,TmsSegmentedBar,TmsDrawer,TmsToaster,TmsPublicFrame}.tsx` + a `.test.tsx` for each behavioural one (§12); **new** `src/features/tms/tmsTokens.ts` (+ `.test.ts`); **new** `src/features/tms/styles/{board,tracking,detail,money,admin}.css` (the §4.8 move — then ownership passes); `index.html`; `eslint.config.js`; `src/App.tsx` (swap `<Toaster …/>` for `<TmsToaster/>`, delete the now-unused `isPhone` helper and the `sonner` import — nothing else in the file).
**Order of work (others are waiting on 1–3):**
 1. §4.8 CSS split → `kit/index.ts` imports → scoped `theme.scope.test` → **broadcast "CSS split done"** (hub, `all`).
 2. Kit TSX for §3.1 (types and exports first, CSS second) → **broadcast "kit files in"** (B–F start importing; they have been coding against §3.1 meanwhile).
 3. Tokens/hooks/CSS: §4.1–4.3, `--tms-paper`, kit CSS for all new pieces, `.tms-portal .tms-grid-col-2`, TmsToaster, `tmsTokens.ts`, `index.html` script, `eslint.config.js` override (§4.7), stale comments (G9), `scope.test` extended (§12).
**Not touched:** `ui/*`, `index.css`, shell files, `TmsListPage/TmsTable/TmsCard/TmsDialog` (CSS-only restyle).
**Acceptance:** `theme.scope.test.ts` + all `kit/*.test.tsx` green; `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(' src/features/tms/**/*.css` only inside the two token blocks; every §3.1 export resolvable from `@/features/tms/kit`.

### Slice B — Shipments board family, document/dispatch/check-call workstations, public pages
**Owns (TSX + their tests):** `shipments/ShipmentsBoard.tsx`; `shipments/board/{BatchTaskDialog,BoardFilterPanel,BoardFooterBar,BoardGrid,BoardMapView,BoardTagPicker,ColumnsPickerDialog,FilterSetDialog,IconKeyDialog,parts}.tsx`; `shipments/workstations/{DispatchWorkstation,DocumentsWorkstation,CustomerLinksPage}.tsx`; `shipments/workstations/dispatch/{OfferQueue,PostingPanel}.tsx`; `shipments/workstations/documents/PodReviewCard.tsx`; `documents/{DocumentReviewPage,DocumentPreview,DocumentTypesField}.tsx`; `tracking/{CheckCallsPage,CustomerTrackPage,CarrierPingPage,CarrierUploadPage}.tsx`; `carriers/RateConSignPage.tsx`; `quotes/public/QuoteRespondPage.tsx`; `styles/board.css`.
**Not owned (logic, leave):** `board/{useBoardFilters,detailSearch,types,…}.ts`, `shipmentViews.ts`, `workstations/{coverage,motion,documentMatrix}.ts`.
**Mandated changes**
* G6/G8/B1/B2: board frame rules (`tms-board-shell` = white card frame, `tms-board-toolbar` = card header row, `tms-board-exception`, `-tag-input`, `-check-label`, `-batch-rows`, `-key-section`, `tms-link`), `BoardGrid` per §4.3 (tone rows keep `--tms-row-*`; hover = inset overlay), `BoardTagPicker`/`ColumnsPickerDialog` hex → tokens, `DocumentsWorkstation` row hover/selected → `--tms-surface-hover/-selected`, bare Tailwind `border` sites (G2) get explicit `border-[color:var(--tms-border)]` where the layered default is not enough.
* G5: `BoardMapView` polyline colour via `useTmsTokens(['--tms-primary'])` (no `#f4c50c`).
* `DocumentPreview` → `TmsDialog size xl` body (PDF/img on `--tms-paper` matte, page-nav "‹ 1 of N ›" kept), 22 inline objects → classes in `board.css`; keep keyboard behaviour/testids the existing tests use.
* `DispatchWorkstation`: the `Fact` `dl` → `TmsMetaList`; freight/queue cards use `.tms-card` frame; `OfferQueue` rows → `TmsApprovalCard` (accept = `approve`, counter/decline = `reject`/ghost as they are today — **no new behaviour**). **These three files are also edited by the rate-con builder → do them last, §11.**
* `CheckCallsPage` / `DocumentReviewPage` / `CustomerLinksPage`: `TmsListPage`/`TmsTable` already restyle via CSS; fix only the inline typography/colour listed by the inventory; `CustomerLinksPage` L182 link-button → `TmsButton variant="ghost"`.
* **Public pages (P1–P5):** rebuild each on `TmsPublicFrame`: `CustomerTrackPage` — status header + `TmsTimeline` (the 5-step bar and the stops list become two timelines) + `TmsMetaList` (the `Row` helper) + driver/contact card; `CarrierPingPage` — frame + next-stop `TmsMetaList` + primary CTA (`TmsButton`, disabled state kept) + `TmsAlert` for the error/success boxes + recent check-ins list; `CarrierUploadPage` — frame + checklist (green-check rows) + file input (keep the `input[type=file]` in the DOM) + CTA; `RateConSignPage` / `QuoteRespondPage` — frame (the dark `#0e1116` header goes), `--ds-*` → tokens, price breakdown `<table className="tms-table">`, `Pair` → `TmsMetaList`, notices → `TmsAlert`, PDF `<iframe>` in a `--tms-paper` card. All five keep their fetch/state logic untouched (diff in those files must be markup/style only). `FleetMiniMap` (dashboard, d3, own greens) stays.
**Tests:** run + keep green `ShipmentsBoard`, `board/*`, `DispatchWorkstation` (after rate-con), `DocumentsWorkstation`, `DocumentReviewPage`, `CheckCallsPage`, `CustomerTrackPage`, `CarrierPingPage`, `CarrierUploadPage`, `RateConSignPage.render`. Retarget only if a query was pinned to a removed inline style/wrapper (none found); never re-pin to new wording.
**Acceptance:** §10 rows 02–03, 07, 10–12 and P1–P5 render with no legacy token (devVerify §9); public pages have a `.tms-public` root and no `#1ea8f3`/`#0e1116`.

### Slice C — Tracking workstation, Inbox (§8), shipment Tracking tab
**Owns:** `shipments/workstations/TrackingWorkstation.tsx`; `shipments/workstations/tracking/{InboxPanel,TrackingBoard,TrackingConversation,TrackingDetailMap,TrackingDetailPanel}.tsx` and `types.ts`; **delete** `TrackingConversation.css`; **new** `src/features/tms/styles/conversation.css`; **new** `tracking/{InboxChatHeader,InboxQuickActions,InboxInfoPanel,DriverCard,LocationCard}.tsx`, `tracking/statusTimeline.ts`; `shipments/components/{TrackingSection,TrackingLinkDialog,CustomerLinkDialog,LogCheckCallDialog}.tsx`; `styles/tracking.css`; their tests (`TrackingWorkstation`, `TrackingSection`, new tests per §12).
**Mandated changes**
* §8 in full (three-pane Inbox, bubbles, quick-action bar, Info panel, driver card, status timeline, location card).
* G7: `conversation.css` (tokens only, no fallbacks, `--tms-link`→`--tms-primary-ink`, `--tms-bg-2`→`--tms-surface-hover`, `rgba` error chip → `--tms-badge-red-tint`); add `tms-thread-subject/-body`, `tms-convo-card-*`, `tms-tracking-views-dropdown` rules if the class is really rendered.
* G5/C2: `TrackingDetailMap` — every `#f4c50c`/`#0ea5e9`/`rgba(30,168,243,…)` from `useTmsTokens` (`--tms-primary`, `--tms-badge-blue`, `--tms-badge-blue-tint`), drop `--ds-*`; pin `div` colours (`style={{background:m.color}}`) are token strings.
* `TrackingSection`: feed `ul[data-testid=tracking-timeline]` → `TmsTimeline` (same testid on the `ol`), delete stray `0/5` class, shadcn `Label`/`Checkbox` inside dialogs keep working through the bridge (add `tms-portal` to the Radix content if a `Checkbox` shows blue).
* `TrackingWorkstation`/`TrackingBoard`: `TmsTabs` Active/Inbox + Active-only + Table/Map toggles → `TmsSegmentedTabs`; breadcrumb strip under the toolbar is replaced by the shell breadcrumb (delete `tms-tracking-breadcrumb-bar` markup + CSS).
**Tests:** `TrackingWorkstation.test` (new panel must not duplicate text a `getByText` query expects — scope with testids), `TrackingSection.test`, `TrackingDetailMap` consumers; keep `aria-label="Message body"` (L543/L730) and all `convo-*`, `inbox-*`, `tracking-*` testids.
**Acceptance:** §8 checklist; §10 rows 08, 09, 09a–b; Inbox deep link `?tab=inbox&shipment=<id>` and reload still work (`verifyTrackingUi` assertions keep passing).

### Slice D — Shipment page/drawer/tabs, create/void dialogs, AR (invoicing), AP (carrier pay)
**Owns:** `shipments/ShipmentPage.tsx`; `shipments/components/{ApCard,ArCard,BuildingBanner,CarrierOffersSection,CarrierSection,CreateShipmentDialog,DeliveryCard,DispatchDialog,DivisionCard,DocumentsSection,DraftOrderEditor,EmailDocumentsDialog,FinancialLines,GeneratedDocumentDialog,HistorySection,NewShipmentDialog,PostingsSection,ReleaseGateCard,RepointCustomerDialog,ShipmentDetail,ShipmentDrawer,StatusActions,StopCards,UnvoidShipmentDialog,UploadDocumentDialog,VoidShipmentDialog}.tsx`; `ar/{InvoicingPage,ArPage,InvoiceDetail,AgingStrip}.tsx` + `ar/components/*.tsx`; `ap/{ApPage,BillDetail}.tsx` + `ap/components/*.tsx`; `components/RepPicker.tsx`; `components/directory-picker/DirectoryCreateDialog.tsx`; `styles/detail.css`; `styles/money.css`; their tests.
**Mandated changes**
* D3: delete the `ShipmentPage` back strip; `ShipmentPageBody` (in `ShipmentDrawer.tsx`) head → `TmsProfileHeader as="h1" icon={Truck}`: name = PRO, `chips` = status `TmsBadge` + VOIDED badge, `actions` = `ShipmentRowActions`, `columns` = Customer / Lane (origin → destination) / Appointments; `VoidedBanner` → `TmsAlert tone="red"` (keep `data-testid="voided-note"` and the text — `ShipmentHeader.test`).
* `ShipmentDetail` overview: the 21-field `dl` → `TmsMetaList columns={3}`; Revenue/Cost/Profit lifted into a `TmsStatRow` above it; `Note` boxes → `TmsAlert`/`.tms-card`; `AiAgentRuns` list → `TmsTimeline`. Keep `data-testid` `shipment-detail`, `shipment-workflow-runs`.
* `ShipmentDrawer` → `TmsDrawer size="xl"` (G4); drop `ScrollArea h-[calc(100vh-56px)]`.
* `HistorySection` → `TmsTimeline` (tone from action: VOID* red, else gray; `data-testid="shipment-history"` on the `ol`).
* `CarrierSection`/`ArCard`/`ApCard`/`StopCards` `dl`s → `TmsMetaList`; `ArCard`/`FinancialLines`/`ApCard` totals → `TmsStatRow compact`; **D4** rung fill; `FinancialLines` raw TmsSelect class strings → plain `TmsSelect`.
* D2: `DocumentsSection` dangling `0/5` → `TmsAlert`/tint token; `DraftOrderEditor` credit banner → `TmsAlert`; `DeliveryCard` star fill → `currentColor` with `--tms-count-bg`; `EmailDocumentsDialog` `text-primary`→`text-[color:var(--tms-primary-ink)]`; `UploadDocumentDialog` drop-zone → tokens; `DivisionCard` chip ink `#121212` → `var(--tms-text)` on a `color-mix` of the division colour (or keep the data colour with an `eslint-disable` comment and `--tms-text` ink if contrast is OK); `PostingsSection` table → `TmsTable`-class look via CSS; `CarrierOffersSection` grid class.
* **D1 `NewShipmentDialog`** — `DialogContent` gets `tms-portal`; every `--ds-*`/hex/inline style → tokens, `TmsAlert` (tender-prefilled banner), `TmsMetaList`/`.tms-grid`; the mode `<select>` → `TmsSelect`; `DirectoryCreateDialog` gets an opt-in `tmsTheme?: boolean` prop (adds `tms-portal` to its `DialogContent`) set only by this dialog — the legacy `LoadDrawer` call sites are unchanged. `DirectoryPicker`/`legForm` are legacy files: restyled through the bridge only.
* E3: `RepPicker` shadow → `var(--tms-shadow-pop)`; popover surface already tokens.
* AR/AP: `AgingStrip` → `TmsStatRow` (late cells `tone="bad"`; labels from `agingStripLabels`, keep the `aria-label` card title); `InvoiceDetail` `Field` `dl`s → `TmsMetaList`, PDF tab → `TmsDetailSplit` (summary left, `<iframe>` in a `--tms-paper` card right), email-notice list → `TmsTimeline`; `BillDetail` `dl`s → `TmsMetaList`, acknowledged-warnings → `TmsTimeline compact`; hand-rolled `rgba`/bordered boxes in dialogs → `TmsAlert`; `ar/ArPage` "Release refused" card keeps `tms-ready-refusal`; Switch (ArCard) goes green through the bridge.
**Shared-file order:** `GeneratedDocumentDialog`, `CarrierSection`, `DocumentsSection` are not edited by the rate-con plan (it states so) — safe. `RateConPanel.tsx` is **not** in D (E-owned file, rate-con-edited; S2 does not edit it at all).
**Tests:** `ShipmentDetail`, `ShipmentHeader`, `StatusActions`, `ApCard`, `ArCard`, `DocumentsSection`, `NewShipmentDialog`, `FinancialLines`, `StopCards`, `PostingsSection`, `CarrierOffersSection`, `BuildingBanner`, `RepointCustomerDialog`, `DraftOrderEditor`, `ArPage`, `ApPage`, `EmailInvoiceDialog`, `ReceivePaymentDialog`, `PayCarrierDialog`. Keep testids: `ap-ladder/ap-rung-*/ar-ladder/ar-rung-*` + `aria-current=step`, `financial-totals`, `division-chip`, `voided-note`, `credit-banner`, `required-documents`, `carrier-upload-link`, `invoice-line`, `release-gate-ok`, `ready-release-refusal`.
**Acceptance:** §10 rows 04–06a, 15–16a.

### Slice E — Customers, locations, carriers, factors, vendors, rates/quotes
**Owns:** `directory/DirectoryPages.tsx`, `directory/components/*.tsx`; `carriers/CarriersPage.tsx`, `carriers/components/*.tsx` **except** `RateConPanel.tsx`, `RecipientPicker.tsx` (rate-con builder; S2 leaves them untouched); `factoring/*.tsx`; `src/lib/otrInvoiceStatus.ts` (+ test); `vendor-ap/VendorApPage.tsx`; `quotes/{QuotesPage,QuoteDetail,LaneRatesPage}.tsx`, `quotes/components/*.tsx`; `loads/LoadDrawer.tsx` (one `tms-portal` class on its two `DialogContent`s and the SidePanel root — **no other edit**, E5; full conversion is S3); `styles/directory.css` (create only if needed; imported from the E pages that use it); their tests.
**Mandated changes**
* E1: `otrStatusMeta` returns `{ label, tone: TmsTone }` (the seven hex palettes map: yellow→orange, red→red, orange→orange, tan→gray, green→green, blue→blue, gray→gray — label strings unchanged, `otrInvoiceStatus.test` keeps its label assertions); `FactoringPage` pills/`OtrPanel` status → `TmsBadge`; `FactoringDocCell` chips → `TmsBadge`/`tms-badge-green|red` classes (keep DOM shape for the file-input test); `rgba(0,0,0,.15)` count pill → `TmsCountBadge`/`--tms-surface-hover`; `StatusTotals` → `TmsStatRow`; OTR strip stays chips (status-coloured filter pills with counts) restyled via the kit classes.
* E2: all `rgba` tint boxes (QuoteDetail L914, AcceptOffer/Convert/Counter/Duplicate/SendQuote dialogs, CreditLimitCard L95, VendorApPage L419) → `TmsAlert`.
* E4: `CarrierProfile` → `TmsDrawer size="xl"` with `TmsProfileHeader` (name + status badge + derived hint, chips = Highway/RMIS/MCP/insurance badges, actions = Send setup packet / Change status, columns = MC·DOT·type / contact / safety; the red reason box → `TmsAlert`) + `TmsTabs` (9 tabs) + Loads rows (button rows) + Activity → `TmsTimeline`; `CustomerProfile` dialog header → `TmsProfileHeader` (avatar initials, status chip, "Board: X · effective status Y" subtitle, Activate/Close lead/Deactivate as `actions`, columns = MC / Billing / Account owner), Locations tab rows → `TmsMetaList`; `LocationDetail` driver notes → `TmsTimeline compact`.
* StatRow/MetaList/SegmentedBar where the pattern exists: `QuotesPage` `Totals` banner → `TmsStatRow` (4); `QuoteDetail` pricing summary → `TmsStatRow`, Thread `dl` → `TmsMetaList`, event `ol` → `TmsTimeline`, 2fr/1fr grid → `TmsDetailSplit`; `LaneHistoryPanel` `dl` → `TmsMetaList`, window buttons → `TmsSegmentedTabs`; `CreditLimitCard` 4-up stats → `TmsStatRow compact`, usage/aging bar → `TmsSegmentedBar`; `CustomerArTab` headline tiles → `TmsStatRow compact`; `BookCarrierDialog` money summary → `TmsStatRow compact`; `VendorApPage` `Field` helper → `TmsMetaList`; `ManualInvoicePanel` checklist stepper → `TmsTimeline compact`.
* `CarriersPage` Filters `TmsCard` stays a card (it is a card); list-page tab/search/filter row is the CSS-restyled `TmsListPage` chrome.
* `QuoteDetail` (~28 inline styles), `AcceptOfferDialog` (~17), `CarrierOffersCard` (~18), `LaneHistoryPanel` (~22) are the inline-heavy files: convert only static colour/typography (R5); leave grid templates.
**Shared-file order:** `RateConPanel.tsx` — untouched. `BookCarrierDialog.tsx` — not in the rate-con plan; E may edit. After the rate-con builder lands, E screenshots the carrier drawer's rate-con block; any look defect in `RateConPanel`/`RecipientPicker` goes to Main (not edited by E).
**Tests:** `DirectoryPages.render`, `FlowDefaultsCard`, `CarriersPage.render`, `CarrierProfile`, `CarrierForm`, `BookCarrierDialog.render`, `FactoringPage`, `OtrPanel` (keeps `tms-badge-red` class + `data-gap`), `ManualInvoicePanel`, `FactoringDocCell`, `QuotesPage`, `QuoteDetail`, `ConvertQuoteDialog`, `otrInvoiceStatus`, `RepPicker` (D-owned component, E-visible).
**Acceptance:** §10 rows 13–14a, 17–21.

### Slice F — My Brokerage (all tabs), workflows & AI agents, academy, audit, access screen
**Owns:** `tms/brokerage/{BrokeragePage,DemoPage}.tsx`; `tms/brokerage/company/*.tsx`; `tms/settings/{DivisionsPage,ShipmentViewsPage,AiAgentsPage}.tsx`; `tms/integrations/*.tsx`; `settings/*.tsx` (SettingsPage, 17 `*Card`s, `settingsKit.tsx`, `checkGroupUtils.tsx`); `users/UsersPage.tsx`; `commissions/CommissionsPage.tsx` (keep the `InvoiceCommissionCard` export D imports); `reports/ReportsPage.tsx`; `audit/AuditPage.tsx`; `workflows/*.tsx`; `tms/pages/AcademyPage.tsx`; `components/RequirePage.tsx`; `files/PrivateDocsModal.tsx` (class only); `styles/admin.css`; their tests.
**Mandated changes**
* `settingsKit.tsx` is the lever for ~25 callers: `Panel`, `GroupLabel`, `Stack`, `CheckRow` keep their exports/props and become class-based (`.tms-panel`, `.tms-group-label`, `.tms-stack`, `.tms-check-row` in `admin.css`) — one edit restyles every settings card; the cards' own grid-template pseudo-tables (ChargeCodes, PostalCodeAliases, Consolidation, CustomerSettings, CommissionSettings, Teams, CarrierDocuments) stay inline (R5) unless a card has static colour.
* `UsersPage`: KPI strip → `TmsStatRow` (keep the four counts and labels); user card header → `TmsProfileHeader compact` (avatar, name, Admin chip, email·role, status badge; expanded panel unchanged); `PILL/PILL_ON` toggles → `.tms-chip-toggle` class in `admin.css` (they are multi-select toggles, not tabs); keep `data-testid="user-card"` and the invite form.
* `ReportsPage`: `TILE` `dl` ×4 → `TmsStatRow`; aging buckets → `TmsSegmentedBar` **in addition to** the existing tiles/table (keep table `aria-label`s, e.g. `Profit by group`, and row structure); no new data.
* `CommissionsPage`: approve/counter/override rows → `TmsApprovalCard` where a row has approve/reject actions; events `ul` → `TmsTimeline compact`; `Field` `dl` → `TmsMetaList`.
* `workflows/proposalCards.tsx` ×5 → `TmsApprovalCard` (title, chip, `TmsMetaList` of facts, `to` link; the existing `tms-btn-primary` "open" links stay as `actions`); `RunTrace` steps rail → `TmsTimeline` (`data-testid="steps-rail"`, `failed-step-detail` kept), `Fact` `dl` → `TmsMetaList`; `Tailwind` layout-only classes stay.
* `AccountPage` label/value grid → `TmsMetaList`; `BillingPage` division pill strip → `TmsSegmentedTabs`; `BrandingPage`: G9 copy fix (truthful: "Each person chooses light or dark from the top bar."), `tms-badge-yellow` → a real tone, `tms-grid-1` rule or `.tms-grid`; `ImportPage`/`AljexImportPage` previews already `table.tms-table`.
* `DivisionsPage`: tree rows → table look (`admin.css`), keep native drag-drop and `data-testid="division-*"`; `#888888` kept with `eslint-disable` (data). `ShipmentViewsPage`: `tms-view-desc` rule; keep column order (test uses `row.cells[n]`). `IntegrationsIndex`/`IntegrationPage`/`providerExtras`: `<pre>` payload gets `.tms-code` (shared with Academy); keep `.tms-badge` and `.tms-field-error` selectors.
* `AcademyPage`: `.tms-academy-body` (typography scale: h2 20/600, h3 16/600, p 14/1.6, lists, links = `--tms-primary-ink`), `.tms-code` for `<pre>` and inline code, tables use `.tms-table`; answer box = `--tms-surface` tint (not card-on-card); `--ds-red` → `--tms-badge-red`. No markdown-parser change.
* `AuditPage`: `<pre>` change blob → `.tms-code`.
* `RequirePage` `NoAccess`: F3.
* `PrivateDocsModal` (rendered by Settings): add `tms-portal` to its `DialogContent`; if more than a class is needed, leave for S3 and note it.
* `DemoPage`: nothing but verification (classes `tms-demo-*` unchanged, their CSS now in `admin.css`).
**Tests:** `BrokeragePage`, `DemoPage`, `DivisionsPage`, `ShipmentViewsPage` (cell order), `AiAgentsPage`, `IntegrationsIndex`, `IntegrationPage`, `SettingsPage.render`, `UsersPage`, `CommissionsPage`, `ReportsPage`, `WorkflowsPage`, `RunTrace`, `AcademyPage`, `RequirePage`.
**Acceptance:** §10 rows 22–34.

### Slice V — verification harness (second wave; starts when A has landed, may overlap D–F; no file overlap with A–F)
**Owns:** **new** `scripts/lib/cdpBrowser.mjs`, `scripts/lib/devIdentity.mjs`, `scripts/devVerifyS2.mjs`; refactor `scripts/lib/verifyTrackingUi.mjs` to use `cdpBrowser.mjs` (behaviour unchanged); `scripts/devVerifyP.mjs` — **import lines only** (`mintIdentity`/config come from `devIdentity.mjs`), and only **after** the rate-con builder A has finished its own edit of that file (the rate-con plan adds a pre-step before `SEND_RATE_CON`). Details in §9. Main (or any builder that finishes early) runs this slice.

### 6.1 Non-overlap check (file → exactly one owner)
`board/*`, `ShipmentsBoard`, workstations Dispatch/Documents/CustomerLinks, `documents/*`, `CheckCallsPage`, 3 public tracking pages, `RateConSignPage`, `QuoteRespondPage` → **B**. `TrackingWorkstation`, `tracking/*` (workstation folder), `TrackingSection`, 3 tracking dialogs → **C**. `ShipmentPage`, the other 26 `shipments/components/*`, `ar/*`, `ap/*`, `RepPicker`, `DirectoryCreateDialog` → **D**. `directory/*`, `carriers/*` (minus RateConSign → B, RateConPanel/RecipientPicker → rate-con), `factoring/*`, `otrInvoiceStatus.ts`, `vendor-ap`, `quotes/*` (minus public → B), `LoadDrawer` → **E**. `tms/brokerage/*`, `tms/settings/*`, `tms/integrations/*`, `settings/*`, `users`, `commissions`, `reports`, `audit`, `workflows`, `AcademyPage`, `RequirePage`, `PrivateDocsModal` → **F**. `theme.css`, `kit/*`, `tmsTokens.ts`, `index.html`, `eslint.config.js`, `App.tsx` → **A**. Untouched by anyone: `TmsShell/TmsLayout/shell.css`, `dashboard/*` (S1/`S1Nits`), `ui/*`, `index.css`, `TrackPage`, driver app, legacy folders.

---------------------------------------------------------------------------------------------------

## 7. Shared interfaces and the start protocol

**Cross-slice imports that already exist and must not change shape** (each side keeps the other's contract; if a slice must change one, `hub`-ask the owner first):

| Consumer → provider | Contract kept |
|---|---|
| C `TrackingBoard` → B `BoardFilterPanel`, `BoardGrid`, `BoardMapView` | props as today (`BoardFilterPanelProps`, `ShipmentRow` rows, `mapsKey/mapsMapId`) |
| B `ShipmentsBoard` → D `ShipmentDrawer`, `ShipmentRowActions`, `UnvoidShipmentDialog`, `CreateShipmentDialog` | `ShipmentDrawer({ shipmentId, onClose, onChanged })` unchanged; `ShipmentActionHandlers` unchanged |
| D `ShipmentDetail` → C `TrackingSection` | `TrackingSection` props unchanged; its testids `tracking-timeline`, `check-call-banner`, `tracking-eta`, `tracking-cadence` kept |
| D `InvoiceDetail` → F `InvoiceCommissionCard` (CommissionsPage) | export + props unchanged |
| D/E/F → A kit | §3.1 signatures |
| E, F, D → D `RepPicker` | props unchanged; only the shadow token changes |
| E `FactoringPage` → D `ShipmentDrawer`, E `LoadDrawer` | unchanged |
| calendar `SchedulerView` (legacy) → D `ShipmentDrawer` | unchanged; renders through `TmsDrawer` |
| D `NewShipmentDialog` → legacy `loads/legForm`, `legFields` | untouched; look via bridge |

**Hub messages (fire-and-forget, plain prose):**
1. A → `all`: "CSS split done" (after §4.8), then "kit files in" (after §3.1 TSX exists). Until the first, B–F edit **no `.css`**; until the second, B–F may write code against §3.1 but cannot typecheck.
2. D → B: "ShipmentRowActions/ShipmentDrawer props unchanged" (only if D changes anything near them).
3. Rate-con builder → B/E: "DispatchWorkstation / OfferQueue / RateConPanel done" (§11) — B edits those three files only after this.
4. Anyone → A: a rule or kit prop they need in `theme.css`/`kit.css`.
5. Each builder's final `yield` lists: files touched, states it could not exercise, new classes added, and any file it was asked by another slice to leave alone.

---------------------------------------------------------------------------------------------------

## 8. Tracking workstation + Inbox layout (REDESIGN §7 "Chat" and "Tracking, primary order") — slice C

Functional spec of P8-UI stays (Active/Inbox tabs, `?tab=` and `?shipment=` deep links, motion sort, threads, check-call plan, composer signing). Only the look changes plus the elements below. **Nothing in this section adds a mutation:** every button calls an API the Tracking tab already calls, and anything the data cannot support is omitted rather than faked.

### 8.1 Gap map (from the inventory) → what C builds

| Reference element | Today | S2 |
|---|---|---|
| Header "Chat with <driver>" + truck chip | PRO + "Last activity" only (`TrackingConversation.tsx` L575–583) | `InboxChatHeader`: title `Chat with {driver name ?? 'driver'}`, truck chip (`TmsBadge gray`: `Truck {number}` when the active leg has one), PRO link to the shipment |
| Contact row: avatar, **ONLINE** dot, call / video / info | none | avatar (`TmsAvatar`), name, **"Last ping 4 min ago"** line with a dot — green when the last ping is < 30 min old (`motion.ts` helper), muted otherwise; **no "ONLINE" claim** (no presence data). Call button = `<a href="tel:…">` shown only when a driver phone exists (`aria-label="Call {name}"`). **Video: not built (no capability).** Info icon = toggles the Info panel (`aria-pressed`) |
| Bubbles ours green / theirs white | `.tms-thread-out` = primary-tint, both bordered, uniform radius, metadata badge row *inside* the bubble | ours = solid `--tms-primary` + `--tms-on-primary`, radius 14/14/4/14, right-aligned; theirs = `--tms-card` + 1px border, radius 14/14/14/4; **sender · time under the bubble** (muted 11px, "Agent"/"Person" badge stays there); NOT_SENT/FAILED status = small pill under the bubble; kind pills and structured cards unchanged in function |
| Rich map card in the stream: DISTANCE TO ARRIVAL | map only in the shipment tab's "Map & ETA" card | `LocationCard`, pinned as the **last item of the stream** when the row has `lastKnownLat/Lng`: label, 140px `TrackingDetailMap` (compact), big **Distance to arrival** (miles + `h m`) from the same estimate the Tracking tab shows (`trackingEtaEstimate`/Google matrix result via `EtaView`; `—` when there is none), lane line, last-ping time. It is a snapshot of the latest known position, not a per-message map |
| Quick-action bar above the composer | none (actions live in the Tracking tab) | `InboxQuickActions`: four chips — **Request check call** → `runCheckCallPlan({ shipmentId })` then `onRefresh()`; **Send tracking link** → opens the existing `TrackingLinkDialog` for the active leg; **Request POD** → `requestPod({ shipmentId })` then `onRefresh()`; **Mark delivered…** → navigates to `/tms/shipments/:id?tab=stops` (stop actions live there; no new mutation, label ends with "…" to say it opens something). Each chip: busy spinner, toast on success/failure, `disabled` with a `title` reason (no active leg, no driver phone, shipment voided) |
| Composer (attach, mic, send) | recipient/channel selects, format toolbar, attach, mention, Send | restyled to a pill input row; selects compacted; **mic not built** |
| Info side panel (closable) | none in the Inbox (`TrackingDetailPanel` is the shipment tab only) | `InboxInfoPanel`, 320px third column, × closes, state in `localStorage['tms-inbox-info']`, default open ≥ 1280px: mini map (`TrackingDetailMap` compact, green route from `--tms-primary`), `DriverCard`, key figures `TmsMetaList` (Truck #, Trailer #, PRO, Miles, ETA — only those present), `TmsTimeline` status timeline. "Miles driven per leg" and "Load %" are **omitted** (not in the data). |
| Driver card with call | `tel:` text link in the tab header | `DriverCard`: avatar, name, **status pill** (`ON ROUTE` green when `loadStatus ∈ MOVEMENT_STATUSES`; `SCHEDULED` gray; `ARRIVED` blue; `DELIVERED` green; else `statusTone`), call button (`tel:`), dispatcher sub-row (name, phone, e-mail) |
| Status timeline Scheduled → Confirmed → On route → Rest stop → Arrived → Delivered → Complete | flat event feed (`tracking-timeline`); public 5-step bar | `statusTimeline.ts` → `buildStatusTimeline({ row, bundle, nowMs }): TmsTimelineItem[]`: **Scheduled** (pickup appointment), **Confirmed** (active leg has a carrier/driver and rate con SENT/SIGNED, or own-fleet driver assigned), **On route** (`loadStatus ∈ MOVEMENT_STATUSES` or later), **Arrived**, **Delivered**. "Rest stop" and "Complete" are **not modelled** and are not shown. Each step's time comes only from a stored timestamp (`LoadCarrier.bookedAt / rateConSentAt / rateConSignedAt / dispatchedAt`, `deliveredAt`); if none, no time. First not-done step is `current`. A "N min late" pill on **On route** when the computed ETA exceeds the delivery appointment by ≥ 15 min. Used by the Info panel **and** at the top of the shipment Tracking tab ("Order info timeline"), where the existing event feed follows it |
| Conversation list rows | PRO, time, customer, lane, preview, count | add `TmsAvatar` (driver initials), keep testids `inbox-thread-row`, `data-shipment-id`; **no unread dot** (no read state) |

### 8.2 Layout and CSS
`.tms-inbox` = `grid-template-columns: 340px minmax(0,1fr) [320px]`, white card frame, hairline dividers; ≤1280px the Info panel overlays the chat as a right sheet-like column and is closed by default; ≤1100px the existing stacked layout. Chat column = header (fixed) · stream (scrolls) · quick-action bar · composer (fixed). All in `styles/tracking.css` + `styles/conversation.css`. Dark: bubbles keep the green, cards invert via tokens.

### 8.3 Shipment Tracking tab (`TrackingSection`/`TrackingDetailPanel`)
Same pieces reused (not copied): status timeline on top, big `TrackingDetailMap`, "Distance to arrival" `TmsStatRow` of 3 (Distance, ETA, Last ping), driver `DriverCard`, event feed as `TmsTimeline`, thread card. The lane/"load chips" and "scale tickets" cards in the reference have no data and are not built.

---------------------------------------------------------------------------------------------------

## 9. devVerify plan — `scripts/devVerifyS2.mjs` (slice V)

Goal: one command proves, against the **deployed** dev site (and, before pushing, against `npm run dev` at `http://localhost:5173` — already on the origin allow-list), that **no `/tms/*` page, dialog, drawer, toast or public page renders legacy dark tokens or console errors**, in light and dark, and leaves screenshots for Ryne.

### 9.1 Structure (reuses the `verifyTrackingUi.mjs` patterns; no second CDP stack)
* **`scripts/lib/cdpBrowser.mjs`** — the CDP plumbing lifted out of `verifyTrackingUi.mjs` without behaviour change: allow-listed origins (`https://dev.d3dejqzs77khq6.amplifyapp.com`, `http://localhost:5173`, `http://127.0.0.1:5173`; anything else throws), isolated temp profile (`mkdtemp bcat-s2-…`), `CHROME_BIN`/macOS default, `DevToolsActivePort` discovery, `ws` socket, `command`, `evaluate`, `poll(run, label, timeout)`, `capture(name)`, localStorage injection restricted to the origin (`Page.addScriptToEvaluateOnNewDocument`), SIGTERM→SIGKILL cleanup. **New:** `Runtime.enable` + `Log.enable` + `Network.enable` collectors → `browser.problems()` returns `{ exceptions, consoleErrors, httpErrors, failedRequests }` since the last `browser.mark()`; `setViewport(w,h,dpr)`; `click(selector | {text})`; `waitFor(selector)`; `screenshot(path, { clipToContent })`; `grantClipboard()`.
* **`scripts/lib/devIdentity.mjs`** — `mintIdentity(email, groups)` and its constants moved out of `devVerifyP.mjs` (`DEV_API`, `DEV_POOL`, `DEV_CLIENT`, `PUBLIC_API`, `outputs`, `gql`, `routerAs`) plus `deleteIdentity(email)`. `devVerifyP.mjs` imports them (import-line change only, after the rate-con edit — §11); `verifyTrackingUi.mjs` now builds on `cdpBrowser.mjs` and keeps its assertions and screenshot names (so `devVerifyP` still reports its P8-UI line identically).
* **`scripts/devVerifyS2.mjs`** — the walk below. Refuses any endpoint but the dev AppSync URL; temp ADMIN `zz-s2-admin-<ts>@example.invalid` with groups `['ADMIN','page-tms']`; password/tokens never printed; `finally` deletes the identity and re-reads it to prove it is gone.

### 9.2 Data discovery (no hard-coded ids)
Shipment/carrier/customer/quote/invoice/bill/run/provider/academy slug are discovered from the list pages (first row link or `data-*` id) or `GET_DEMO_STATE` through `routerAs(token,'tmsShipmentActions')`, exactly as `devVerifyP` does. A route whose data does not exist on dev is reported `SKIPPED (no data: …)`; **the deploy gate is 0 skipped** unless the skip is in the script's explicit allow-list with a reason (e.g. `/tms/workflows/runs/:id` if no run exists).
Public tokens are minted through the same routers `devVerifyP` uses: `track('SEND_CUSTOMER_LINK', { via:'COPY', … })` (P1), `track('SEND_TRACKING_LINK', { loadCarrierId, via:'COPY' })` (P2), `track('SEND_UPLOAD_LINK', …)` (P3); revoked in `finally`. P4/P5 (`/sign/rate-con/…`, `/quote/…`) need a sent rate con / sent quote; the script uses an existing one if found, else verifies the **inactive-link state** of the same page (same frame) and the loaded state is covered by the page's vitest render test + Ryne's rate-con review (Risk R6).

### 9.3 The walk
Viewport 1600×1000 (public pages additionally 390×844). Browser A = authenticated (storage injected); Browser B = clean profile (no storage) for P1–P5 to prove they need no sign-in.
1. **Route-inventory completeness (fails first):** parse the `/tms` block of `src/App.tsx` plus the `TABS` of `BrokeragePage`/`CompanyTab`/`detailTabs.ts`; every route pattern/tab must have an entry in the script's `ROUTES` table (normalising `:id`/`:slug`). A route added later without coverage fails the script.
2. **For every `ROUTES` entry × theme** (`light` for all; `dark` for the representative subset in §10): `navigate` → wait for `.tms-main` content and no "Loading…" spinner (≤30 s) → `browser.mark()` → `auditPage()`:
   * **console/network:** `problems()` empty after the allow-list (each allow-list entry is a regex + a reason in a comment; starts **empty**). HTTP ≥ 400 from the origin, AppSync or the public Lambda URL fails.
   * **legacy tokens:** walk every visible element in `document.body` (page *and* open `.tms-portal` overlays) reading computed `color`, `background-color`, `border-*-color`, `fill`, `stroke`; fail on: old yellow (`rgb(244,197,12)`, `rgb(255,210,34)`), legacy brand blue (`rgb(30,168,243)`, `rgb(3,105,161)`), `rgb(14,17,22)` (`#0e1116` header), `rgb(11,18,32)`, `rgb(16,35,70)` (tooltip), legacy `--ds-bg` `rgb(244,247,251)` / `rgb(244,246,248)` as a surface, slate `rgb(226,232,240)` borders, and (light theme only) any surface with luminance < 0.12 and area ≥ 1600 px² — excluding the explicit allow-list: `.gm-style` (Google), `iframe`, `[data-tms-paper]` (a PDF/image matte; builders put the attribute on intentionally white surfaces), `.tms-chart-tip`, `[data-sonner-toast]`'s tooltip, `.tms-count-badge`. **Dark theme:** the inverse — no surface with luminance > 0.85 and area ≥ 1600 px² except `[data-tms-paper]`, `.gm-style`, `iframe`.
   * **invisible text:** for ≤ 400 sampled text nodes, effective background (walk ancestors to first opaque, else `--tms-bg`) vs text colour: WCAG ratio < 1.5 fails (catches white-on-white / dark-on-dark, not AA nit-picking).
   * **unstyled classes:** every `tms-*` class present in the DOM must appear in some rule selector across `document.styleSheets` (recursing `@media`/`@layer`); allow-list = hook-only classes (`tms-overdue`, `tms-due`, plus any a builder lists with a reason).
   * **currentColor borders (G2 probe):** elements with a border where border colour equals the element's text colour and which are not `.tms-btn/.tms-badge/.tms-chip` — more than 3 on a page fails.
   * **layout:** `.tms-main` has no horizontal overflow beyond 2 px (routes flagged `wideOk` — board/tracking grids scroll inside their own wrapper — are checked on the wrapper instead); `html[data-tms-theme]` equals the expected theme; `.tms-shell` computed `background-color` equals the `--tms-bg` token.
   * screenshot → `Docs/tms-build/screenshots/S2/<NN>-<slug>-<theme>.png` (§10).
3. **States** (each runs the same audit with portals included): row ⋮ menu (bridge probe: menu `background-color` == `--tms-bg-elevated`; a `Checkbox`/`Switch` checked fill == `--tms-primary`), Columns / Filter-set / Icon-key dialogs, New shipment dialog, board row → `TmsDrawer`, every shipment-detail tab (`[role=tab]` loop), Tracking Active / Inbox (assert `inbox-chat-header`, `inbox-quick-actions`, `inbox-info-panel`, `inbox-status-timeline`, `inbox-driver-card` exist; close the panel → gone and stays closed after reload; **no quick action is clicked** — they mutate), every invoicing/payable/bill/invoice tab, carrier drawer tabs, customer profile tabs, location dialog, vendor dialog, quote detail dialogs (Send / Counter), commissions dialogs, divisions dialog, `RequirePage` access screen is covered by vitest (ADMIN always has access).
4. **Toast probe:** on `/tms/tracking/links` grant clipboard, click "Copy" on the first active link → `[data-sonner-toast]` appears and its computed background == `--tms-card`, ancestor has `tms-portal`; screenshot light and dark. (Skip-with-report if no link exists.)
5. **Theme:** click the real toggle (`aria-label="Switch to dark theme"`), assert `html[data-tms-theme="dark"]`, rerun the dark subset, `Page.reload` → attribute present **at first script execution** (recorded via `addScriptToEvaluateOnNewDocument`, proves the `index.html` pre-paint script, G10) and still dark; toggle back.
6. **Public pages (Browser B, no storage):** P1–P3 loaded (+ 390 px), P4–P5 per §9.2. Assert root `.tms-public`, `document.body` background is the `--tms-bg` light value, none of the legacy colours above (this is where `#1ea8f3`/`#0e1116` used to live), no console errors, zero sign-in redirect.
7. **Report:** one line per (route|state, theme): `PASS`/`FAIL` with the first three offenders (selector, property, colour); summary `{ pass, fail, skipped }`; exit non-zero if `fail > 0` or `skipped` is not allow-listed; leaves `Docs/tms-build/screenshots/S2/index.txt` listing every file written.

### 9.4 How it is used
Local before the push: `hub start` `npm run dev` (ready on 5173) → `DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS2.mjs` (iterate until green; this also takes the screenshots Ryne would otherwise wait for). After the deploy: `DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyS2.mjs` (the proof that is logged) and `node scripts/devVerifyP.mjs` (48/48 must still PASS — it also re-runs the refactored `verifyTrackingUi` and exercises the rate-con items).

---------------------------------------------------------------------------------------------------

## 10. Route-by-route screenshot plan

Output: `Docs/tms-build/screenshots/S2/<NN>-<slug>-<theme>.png`, 1600×1000 viewport, `deviceScaleFactor` 1 (one 2× of the board header and one of the inbox), theme set by the real toggle once per pass. **L** = light, **D** = dark, **M** = 390×844. Tall pages are captured with `clip` to content height (cap 2400 px). Every row also runs the §9.3 audit.

| NN | Route / state | L | D | M |
|---|---|:-:|:-:|:-:|
| 01 | `/tms/dashboard` (verify only — S1/`S1Nits`) | ✓ | ✓ | |
| 02 | `/tms/shipments` — board with tone rows, filter rail, footer | ✓ | ✓ | |
| 02a | board: row ⋮ menu open · Columns dialog · Icon key · Batch task · Filter-set dialog | ✓ | ✓ (menu, Columns) | |
| 02b | board: map view · empty (filters that match nothing) | ✓ | | |
| 03 | `/tms/shipments/view/<slug>` saved view | ✓ | | |
| 04 | `/tms/shipments/:id` overview (with `TmsStatRow` + `MetaList`) | ✓ | ✓ | |
| 04a–h | detail tabs: stops · carrier · tracking · documents · financials · invoicing · carrierPay · history (+ aiAgent if runs exist) | ✓ (all) | ✓ (documents, tracking) | |
| 04i | voided shipment (red alert) · draft shipment | ✓ | | |
| 05 | board → shipment `TmsDrawer` | ✓ | ✓ | |
| 06 | New shipment dialog · Create shipment dialog | ✓ | ✓ (New) | |
| 06a | Void / Repoint / Dispatch dialogs | ✓ | | |
| 07 | `/tms/dispatch` (queue, suggestions, offers as approval cards) | ✓ | ✓ | |
| 08 | `/tms/tracking?tab=tracking` table · map | ✓ | | |
| 09 | `/tms/tracking?tab=inbox&shipment=` — three panes, Info open · Info closed | ✓ | ✓ | |
| 09a | shipment Tracking tab (status timeline, map, driver card, feed) | ✓ | | |
| 09b | `LogCheckCallDialog` · `TrackingLinkDialog` · `CustomerLinkDialog` | ✓ | | |
| 10 | `/tms/tracking/links` + create-URL dialog | ✓ | | |
| 11 | `/tms/documents` · `/documents/view/<slug>` · POD review card | ✓ | ✓ (documents) | |
| 11a | `/tms/documents/review` + preview modal + accept/reject dialog | ✓ | | |
| 12 | `/tms/check-calls` both tabs | ✓ | | |
| 13 | `/tms/rates` (totals `StatRow`) · status tabs | ✓ | ✓ | |
| 13a | `/tms/rates/lanes` with a lookup result | ✓ | | |
| 14 | `/tms/rates/:id` (split view, timeline) · `/rates/new` | ✓ | ✓ | |
| 14a | Send quote · Counter · Convert dialogs | ✓ | | |
| 15 | `/tms/invoicing` — six views (aging strip on unpaid) | ✓ | ✓ (unpaid) | |
| 15a | `/tms/invoicing/invoices/:id` five tabs (pdf split) | ✓ | ✓ (summary) | |
| 15b | Generate invoice · Receive payment · Email invoice dialogs | ✓ | | |
| 16 | `/tms/invoicing/payable` — five views | ✓ | ✓ (to-pay) | |
| 16a | `/tms/invoicing/payable/bills/:id` four tabs · Pay carrier · Approve bill dialogs | ✓ | | |
| 17 | `/tms/carriers` · `/tms/carriers/:id` drawer (profile, compliance, ap, activity tabs) | ✓ | ✓ (list, drawer) | |
| 17a | Add carrier · Book carrier dialogs | ✓ | | |
| 18 | `/tms/factors` · row dialog (OTR panel) | ✓ | ✓ | |
| 19 | `/tms/customers` · profile dialog (account, AR, locations tabs) | ✓ | ✓ (list) | |
| 20 | `/tms/locations` · detail dialog with map | ✓ | | |
| 21 | `/tms/vendors` · detail dialog | ✓ | | |
| 22 | `/tms/workflows` errors · agents | ✓ | | |
| 23 | `/tms/workflows/runs/:id` (steps timeline, proposal cards) | ✓ | ✓ | |
| 24 | `/tms/academy` · `/academy/<slug>` article | ✓ | ✓ (article) | |
| 25 | `/tms/brokerage` Settings (full-page, top and bottom) | ✓ | ✓ | |
| 26 | `/tms/brokerage/users` (KPI strip, expanded card) | ✓ | ✓ | |
| 27 | `/tms/brokerage/commissions` · dialogs | ✓ | | |
| 28 | `/tms/brokerage/reports` — each tab | ✓ | ✓ (first) | |
| 29 | `/tms/brokerage/audit` | ✓ | | |
| 30 | `/tms/brokerage/divisions` · `/views` | ✓ | | |
| 31 | `/tms/brokerage/integrations` · a provider page | ✓ | | |
| 32 | `/tms/brokerage/ai-agents` General + one agent tab | ✓ | | |
| 33 | `/tms/brokerage/company/{company,billing,branding,notifications,import,aljex-import,account}` | ✓ (7) | | |
| 34 | `/tms/brokerage/demo` | ✓ | | |
| 35 | Toast · dropdown menu · empty state (generic) | ✓ | ✓ | |
| P1–P3 | `/track/s/…` · `/track/l/…` · `/track/u/…` | ✓ | | ✓ |
| P4–P5 | `/sign/rate-con/…` · `/quote/…` (loaded if token available, plus inactive-link state) | ✓ | | ✓ (P4) |

≈ 95 images (roughly 60 light, 25 dark, 6 mobile — counted from the table, ± a few state shots). Ryne's review set (a contact sheet, produced by `index.txt`): 01, 02, 04, 05, 09, 13/14, 15, 17, 19, 25, 26, P1.

---------------------------------------------------------------------------------------------------

## 11. Coordination with the rate-con items (same deploy)

`RATECON-plan.md` (read) edits, among others: `carriers/components/RateConPanel.tsx`, **new** `carriers/components/{RecipientPicker.tsx,rateConRecipients.ts}`, `shipments/workstations/DispatchWorkstation.tsx`, `shipments/workstations/dispatch/OfferQueue.tsx`, `DispatchWorkstation.test.tsx`, `scripts/devVerifyP.mjs`, `src/lib/carrierRateCon.ts`, `amplify/functions/tms-shipment-actions/*`, and states it does **not** touch `dispatch/rateCon.ts`, `CarrierSection.tsx`, `GeneratedDocumentDialog.tsx`.

| Shared file | S2 owner | Rule |
|---|---|---|
| `RateConPanel.tsx`, `RecipientPicker.tsx` | rate-con (E would own by folder) | **S2 never edits them.** `RecipientPicker` is written with tokens/kit by the rate-con builder (brief them: use `TmsBadge`/`TmsInput`/`TmsAlert` from §3.1, no colour literals — lint will fail otherwise). Look defects found in screenshots go to Main after both land. |
| `DispatchWorkstation.tsx`, `OfferQueue.tsx`, `DispatchWorkstation.test.tsx` | B | **B edits them last**, after the rate-con builder messages "done" (§7 msg 3); B re-reads each file immediately before editing and keeps rate-con changes intact (diff review: the `rateConBlockedReason`/`mcpPacketStanding` lines survive). |
| `scripts/devVerifyP.mjs` | V | import-line change only, after rate-con's edit lands. |
| `amplify/**`, `src/lib/*` rate-con libs | rate-con | S2 does not touch. |
| `RateConSignPage.tsx` (public) | B | The rate-con plan does not edit it (public sign API unchanged). If Main later adds a change there, same rule: S2 restyle first, behaviour edit second. |

`devVerifyS2` must be run **after** both batches are in the working tree (it exercises the new picker's page state only as a screenshot of the carrier drawer — no rate con is sent by S2's script).

---------------------------------------------------------------------------------------------------

## 12. Test plan — retarget only what is pinned to the old look; add only what can fail

### 12.1 Existing tests that pin look/structure (found by the inventory; the list is short)
| Test | Pinned to | Action |
|---|---|---|
| `theme.scope.test.ts` | scope + literal + dark-parity over `src/features/tms/**/*.css` | **Extend**, don't loosen: now also covers `styles/*.css`; parse into `@layer` blocks; keep "every light colour token has a dark twin" (`--tms-paper` is the only new one). |
| `ShipmentsBoard.test` L642–645 `.tms-overdue/.tms-due` | hook classes with no CSS | keep classes (R6) |
| `DemoPage.test` L123–147 `.tms-demo-step/-tick/-tick-off` | class hooks | keep classes |
| `ColumnsPickerDialog.test` L66 `.tms-board-section-title` | class hook | keep |
| `ShipmentViewsPage.test`, `ReportsPage.test` | `row.cells[n]`, table `aria-label` | keep order/labels |
| `TmsShell.test`, `TmsDialog.test`, `DashboardPage.test` | S1 | unchanged (S2 does not touch them) |
| `FactoringPage.test` `.tms-footer-count`, `OtrPanel.test` `/tms-badge-red/` + `data-gap`, `FactoringDocCell.test` file-input shape | class/DOM hooks | keep (E, R6) |
| `ShipmentHeader.test` | VOIDED text, `voided-note` | keep through `TmsProfileHeader` + `TmsAlert` |
| `CustomerTrackPage.test` (`mini-map`), `CarrierUploadPage.test` (`input[type=file]`) | testid / DOM | keep |
| Any test that queries by text the new Info panel/KPI/StatRow duplicates | text collisions | scope the query with `within(testid)`; never delete the assertion |
There is **no** `toHaveStyle`, `getComputedStyle` or snapshot assertion in `tms`, `shipments`, `components` today, so no look-pinned assertion needs re-pinning. If a builder finds a test that pins old wording/markup, delete it or rewrite to the behaviour (do not re-pin to the new text).

### 12.2 New tests (each defends a plausible bug)
| File | Asserts |
|---|---|
| `kit/TmsTimeline.test.tsx` | `state` → `data-state`; exactly one `aria-current="step"` on `current`; `tone` recolours without changing `state`; empty `items` renders `empty`; order preserved. |
| `kit/TmsStatRow.test.tsx` | `value:null` → `—` (never `$0.00`); `tone:'bad'` class; `onClick` renders a button with the label as accessible name; column count caps at `min(items, 4)`. |
| `kit/TmsSegmentedTabs.test.tsx` | `role=tab`/`aria-selected`; ←/→ move selection and wrap; Home/End; count chip shows `0` (not hidden) when `count:0`. |
| `kit/TmsSegmentedBar.test.tsx` | shares sum to exactly 100 for awkward inputs (33.3/33.3/33.4, 1/1/1); total 0 → "No data"; negative/NaN segments ignored. |
| `kit/TmsMetaList.test.tsx` | `''`/`null`/`undefined` → `—`; `hidden` skipped; `wide` spans. |
| `kit/TmsProfileHeader.test.tsx` | `initialsOf('Ryne Sanchez')==='RS'`, email → first letter, empty → `?`; `columns` rows with `hidden` omitted; `as="h1"` renders an `h1`. |
| `kit/TmsDrawer.test.tsx` | renders under `.tms-portal` **outside** `.tms-shell`; Esc closes; overlay click closes; focus returns to the trigger; `onInteractOutside` can veto. |
| `kit/TmsApprovalCard.test.tsx` | Approve/Reject call the right handler once; both disabled while `busy`; no buttons when handlers absent. |
| `kit/TmsToaster.test.tsx` | on `/tms/…` the toaster root carries `tms-portal`; on `/driver/…` it does not (driver look untouched). |
| `kit/TmsAlert.test.tsx` | red/orange → `role="alert"`, green/blue → `status`. |
| `tmsTokens.test.ts` | `readTmsToken` returns the current computed value and `''` for an unknown name; `useTmsTokens` updates when `html[data-tms-theme]` flips (this is what keeps map colours in sync). |
| `tracking/statusTimeline.test.ts` (C) | table-driven rows → step states: scheduled only; booked + rate con SENT → Confirmed done; `DEPARTED` → On route current; delivered → all done; a step with no stored timestamp shows no time; late pill only at ≥ 15 min over appointment. |
| `tracking/InboxQuickActions.test.tsx` (C) | Request POD calls `requestPod({shipmentId})` once and refreshes; Request check call calls `runCheckCallPlan`; Send tracking link disabled with a reason and no calls when there is no active leg; Mark delivered links to `?tab=stops`; a failing call toasts and re-enables the chip. |
| `tracking/InboxInfoPanel.test.tsx` (C) | close persists `tms-inbox-info` and survives remount; call link rendered only when a phone exists; no ONLINE text anywhere (regression against fabricating presence). |
| `otrInvoiceStatus.test.ts` (E) | every status still maps to its portal label; every tone is a valid `TmsTone`. |
| Public pages (B) | `CustomerTrackPage`/`CarrierPingPage`/`CarrierUploadPage` renders keep their behavioural tests; add one per page: renders inside `.tms-public` and not inside `.tms-shell` (defends the "no sign-in / no shell" contract). |
| lint (A) | `npm run lint` fails on a hex literal in an owned folder — proven once by a throwaway file, not committed. |
Not tested (not worth a test): CSS values, colours, snapshots, icon choice, class names beyond the hooks above.

### 12.3 Gates (Main, once, after all six + V)
`npm run typecheck && npm run lint && npm run test` — green. Specifically confirm: `theme.scope`, all `kit/*`, every test named in §6, `NavBar.test` (legacy untouched), the rate-con suites, and the amplify function suites.

---------------------------------------------------------------------------------------------------

## 13. Delivery order

1. Builders A–F start together (A first publishes the CSS split, then the kit; B–F do TSX meanwhile, §7). B holds `DispatchWorkstation/OfferQueue` until the rate-con builder reports. V starts when A's kit is in.
2. Main: typecheck / lint / test once; fix-forward with the owning builder.
3. Local visual pass: `hub start` `npm run dev`; `DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS2.mjs` until green; eyeball the Ryne review set.
4. **One** commit for S2 + rate-con + this plan + the screenshots (no doc-only deploy): `S2: restyle every TMS page onto the green kit (+ rate-con logo/cc/picker/MCP gate)`. Wait until `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not RUNNING/PENDING, `git push origin dev` once, wait for SUCCEED.
5. Deployed proof: `devVerifyS2.mjs` against the Amplify URL (light + dark, all rows of §10), `devVerifyP.mjs` 48/48, temp ADMIN identity deleted, no `zz-*` users remain.
6. `BUILD_LOG.md` S2 entry (top): commit, job id, counts (routes covered, images, pass/fail), the kit pieces added and the S4 carry-overs (Gauge, PillBarChart, KPI deltas D9 still open), the legacy islands left for S3 (E5), the dark-map note. **Stop for Ryne's review** before S3 (REDESIGN §6 gate), as after S1.

---------------------------------------------------------------------------------------------------

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Six builders, one design system.** Drift between slices (a card that is a `TmsCard` in one place, a bordered div in another). | §5 look rules; the kit contracts are fixed in §3.1 before anyone codes; V's audit + screenshots are the arbiter; Main's contact-sheet review before the push. |
| R2 | **CSS bridge assumptions are unverified** [INFERENCE]: `@theme inline` reads `var(--popover)` at the element; Tailwind v4 default border colour is `currentColor`; sonner 2.x honours `--normal-bg` etc.; `@layer base` in a late-loaded sheet orders below utilities. | Each has a computed-style probe in §9.3 (bridge, G2, toast). Fallbacks written down: G2 → add explicit `border-[color:var(--tms-border)]` at the ~9 sites; G1 → put `tms-portal` + explicit `bg-[color:var(--tms-bg-elevated)]` on the three dropdown contents. |
| R3 | **Shared kit churn**: A edits `theme.css`/`kit.css` while five builders ask for rules. | Builders own their area CSS after the split; only cross-cutting rules go through A. A's first two broadcasts unblock everyone. |
| R4 | **Maps stay light in dark mode** (cloud `mapId` style is outside the repo); markers/polylines follow the theme, the base map does not. | Documented; a dark `mapId` is an infra change, not S2. The audit excludes `.gm-style`. |
| R5 | **Legacy islands on TMS routes**: `LoadDrawer` (Factoring), `legForm`/`DirectoryPicker` (New shipment), `PrivateDocsModal` (Settings) are shadcn/`--ds-*` legacy. With the bridge + `tms-portal` they read correctly in light; some `--ds-*` surfaces stay white in dark. | S2's bar for an island = no legacy blue/dark header, readable in light, no breakage in dark; the audit lists any island violation as a named allow-list entry that S3 must clear. Logged in BUILD_LOG. |
| R6 | **P4/P5 loaded states may not be verifiable on dev** (no sent rate con/quote with a token). | Inactive-link state verified live; loaded states by vitest render tests; Ryne reviews both in the rate-con walk. |
| R7 | **Inbox/TrackingWorkstation test collisions** from the new panel duplicating text. | Scope queries with `within(testid)`; never delete assertions. |
| R8 | **Rate-con merge** on three shared files. | §11 order; B re-reads before editing; Main reviews the final diff of those files. |
| R9 | **`ShipmentDrawer` is used by the legacy calendar**; it will look new inside the old shell. | Self-contained `TmsDrawer`; acceptable and noted (S3 completes the shell). |
| R10 | **devVerify heuristics** (invisible-text, currentColor borders, luminance thresholds) can false-positive on first runs. | Thresholds live in one block at the top of the script with comments; the first local run is a tuning pass; every allow-list entry needs a reason. A failure never auto-passes. |
| R11 | **Volume**: ~230 TSX files in scope, mostly untouched by design (R5). | The mandated change lists are the work; "no churn" is a rule. Sonnet builders given exact file lists and ids (G*, B*, C*, D*, E*, F*). |
| R12 | **Toaster app-wide**: staff-legacy pages get the new toast look; the driver PWA must not. | `TmsToaster` branches on `/driver/*`; tested (§12). S3 inherits the single style. |
| R13 | **Scope.** Gauge/PillBarChart, KPI deltas (S1 D9), notification drawer, Compliance/User-management/Financial-ops features (S4) are not built; the legacy shell, driver PWA, `/track/:code` and e-mails are S3. | Stated in §3 and §1.3; BUILD_LOG carry-over list. |
