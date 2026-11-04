# Step AA — TMS navigation reorganization, Carrier Sales, Load Review, Vendors (+ Intake review gate, Wednesday payroll label)

Status: PLAN (recon complete, dev only). Built later by Sonnet-class `task` agents; **one** Amplify deploy, together with the rest of the pre-demo batch. Nothing here touches `main`, production tables/buckets/SSM, or any `invoice_*.json`. Requirements: `Docs/tms-build/STEP_AA_NAV_CRM_SPOTQUOTER.md` (incl. **Ryne's answers 2026-11-03**, which are DECIDED and override the earlier defaults). Step AB (spot quoter, Gmail, CRM) is planned in `AB-plan.md`; this plan only **reserves its nav slots** (§2.6).
Author: AAPlan. Evidence base (direct reads, not memory): `src/lib/{navSections,navItems,roles,releaseGate,shipmentLists,podState,demoFlow,intakeLoad,payPeriod}.ts`, `src/features/tms/{TmsShell,TmsLayout,useShellBadgeCounts,navActive}.ts(x)`, `src/App.tsx` (all 291 lines), `src/components/RequirePage.tsx`, `src/features/tms/brokerage/{BrokeragePage,DemoPage}.tsx`, `src/features/shipments/{ShipmentsBoard,ShipmentsSectionTabs,intake/*,components/{ReleaseGateCard,releaseGateView,CarrierOffersSection,PostingsSection}}`, `src/features/quotes/{QuotesPage,quoteViews}.ts*`, `src/features/vendor-ap/VendorApPage.tsx`, `src/hooks/{useArWorklist,useArToInvoiceCount,useQuotesToReplyCount,useQuoteWorklist,useVendorPayables,useShipments}.ts`, `amplify/functions/tms-shipment-actions/{handler.ts L690-833 + L7070-7200,documents.ts L815-916,batch.ts,intake.ts}`, `amplify/data/resource.ts` (Shipment/Order/IntakeLoad/AuditLog), `scripts/{devVerifyS2,S3,S4,U}.mjs` + `scripts/lib/{uRoutes,s4Routes}.mjs`, `U-plan.md`, `V-plan.md`, `W-plan.md`, and the deleted Dispatch workstation recovered from git (`e207e5c^`).

Conventions inherited (S1..W): kit components only (`src/features/tms/kit`), `--tms-*` tokens only (hex-literal ESLint guard, `no-restricted-syntax`), CSS selectors under `.tms-shell` (`theme.scope.test.ts`), no synchronous `setState` inside effects (`react-hooks/set-state-in-effect`), additive optional schema only, **single owner per shared file** (§9), tests only where a plausible bug fails them (§10), `devVerifyX` pattern with registries under `scripts/lib` (§11), one deploy, ZZ-prefixed seeds removed in `finally`.

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F1** | **No URL has to move.** Every page Ryne lists already has a stable route (`/tms/rates`, `/tms/shipments[/intake]`, `/tms/tracking`, `/tms/customers`, `/tms/carriers`, `/tms/locations`, `/tms/invoicing[/payable]`, `/tms/vendors`, `/tms/factors`, `/tms/brokerage/*`). These URLs are hard-coded in ~40 places (`ApCard`, `ArPage`, `BillDetail`, `CustomerProfile`, `QuoteDetail`, `collectNotifications`, `DemoPage`, `DashboardPage`, the tests, S2/S3/U registries, saved e-mails/bookmarks). | grep `/tms/(rates\|invoicing\|vendors\|factors\|tracking)` | AA is a **sidebar/breadcrumb/label/grant reorganization**, not a URL migration. Only two new routes appear (`/tms/carrier-sales`, `/tms/load-review`) plus the AB-reserved ones; one redirect is **retargeted** (`/tms/dispatch` → `/tms/carrier-sales`). "Quotes" is a **label**; its base path stays `/tms/rates` (D-AA2). Zero broken deep links by construction; the registry gate (§11) proves it. |
| **F2** | **The sidebar is one flat list plus division sections.** `PINNED_ITEMS` (Dashboard, Shipments) + `TMS_ITEMS` (9 rows) render in the `BROKERAGE` section; `NAV_ITEMS` (`navItems.ts`) is *also* the permission list; Shipments' children (`Shipments, Intake, Tracking[+live], Documents`) are **hard-wired in `TmsShell.childrenFor` by path** (`item.to === SHIPMENTS_PATH`). No generic grouped-parent concept, no child-level permission gate, child active-state is exact-match only (`isChildActive`). | `navSections.ts` L69-107, `TmsShell.tsx` L96-139 | Slice A turns children into **data** (gated, with active-state rules) and deletes the path hack (§2.3-2.4). |
| **F3** | **Load Review is mostly assembled.** `evaluateReleaseGate` (delivered, documents, references, carrier/driver, carrier bill settled, open exceptions) runs server-side inside `READY_TO_INVOICE`; `ReleaseGateCard` already prints it via `PREVIEW_INVOICE`; `evaluateDocGate`/cached `docsMissing`/`pendingDocReviewCount` are on every board row; the legacy flag (`legacyImported`) exempts imported history in both gates; the board already has Mass Release (`massReleaseReady`) → `BATCH_SHIPMENT_TASK{RELEASE_TO_BILLING}` → `READY_TO_INVOICE` with per-row result + audit (`ORDER/READY_TO_INVOICE`, `SHIPMENT/BATCH/BATCH_SHIPMENT_TASK`). **Not** covered by any gate: sales rep present, customer charges > 0, "load details" complete. | `releaseGate.ts`, `documents.ts` L823-916, `batch.ts`, `shipmentViews.ts` L469 | Load Review = **a queue page + a pure checklist lib + one read action + a small optional audit payload**. No new money path (D-AA5). |
| **F4** | **`PREVIEW_INVOICE` cannot serve a reviewer.** It lives in `tms-finance-actions` behind `page-invoicing`/`page-tms`; a user who holds only `page-loadReview` is refused. `READY_TO_INVOICE`, `SET_SALES_REP`, `SET_REV_TAG` live in `tms-shipment-actions` behind `page-loads`/`page-tms`. | `isActionAuthorized` handler.ts L763-784; finance handler L193-215 | New grant needs (a) `page-loadReview` admitted to exactly four shipment-router actions and (b) a **read-only `REVIEW_LOAD`** action that returns the same `evaluateReleaseGate` verdict from rows the Lambda reads itself (§4.5). Data reads are `allow.authenticated()`, so the queue itself needs no AppSync change. |
| **F5** | **The old Dispatch "needs cover" logic was deleted in Step U, not hidden.** `DispatchWorkstation.tsx`, `workstations/coverage.ts(+test)` (`coverageStateOf`, `suggestCarriers`, `carrierFlags`), `dispatch/{OfferQueue,PostingPanel,rateCon}.*` are gone from the tree (git `e207e5c^`). `/tms/dispatch` is a redirect to `/tms/shipments`. **Survivors:** `CarrierOffersSection` (offers + accept/setup packet), `PostingsSection`, `DispatchDialog`, `AssignCarrierDialog`/`StatusActions`, `lib/carrierRateCon.ts` + `sendRateCon`, `lib/mcpPacket.ts` (`mcpPacketStanding`, `rateConMcpRefusal`), `sendSetupPacket`, `listCarrierOffers`, **`listActivePostings` (orphaned, no caller)**, `useQuoteWorklist` (BUY-side offers are the QuotesPage "Carrier offers" tab), `boardStatusOf` (`OPEN` / `COVERED` / `DISPATCHED`). | git `e207e5c^`, grep | Carrier Sales = a **small queue page that links into the shipment Carrier/Driver tab**, which already holds offers, postings, cover and rate con (D-AA6). `coverageStateOf` (30 lines, pure) is restored as `carrierSalesQueue.ts` from git history, tests included. |
| **F6** | **Vendors is already a page.** `/tms/vendors` = `VendorApPage` (nav label "Vendors", key `vendorAp`) — the queue of `VendorPayable` rows whose `source` is `MAINTENANCE` (Ivan maintenance invoice → "Send to Vendor AP", `manageVendorPayable SEND_MAINTENANCE`) or `EMAIL` (`vendor-ap-intake` mailbox Lambda). **Fuel is not a payable**: `FuelTransaction` rows (EFS imports on `/fuel`) feed fleet P&L and the Expenses receipts view only; nothing writes a `VendorPayable` for them. There is **no manual-create** write path (`vendorPayableAction` = `SEND_MAINTENANCE/UPDATE_DETAILS/COMPLETE/REOPEN`). | `VendorApPage.tsx`, `apiClient.ts` L969-1015, `InvoicesPage.tsx` L327, `ExpensesOverviewPage.tsx` | Vendors page = the existing queue + stat row + source filter + "By vendor" view + an honest "not in this queue" card (carrier bills → Accounts Payable; driver settlements/payroll → Assets; fuel → Fuel). No new write path (D-AA9). |
| **F7** | **Driver pay is payroll and stays out of Vendors/Accounting (Ryne #6).** The three settlements pages (`/driver-pay` Amazon, `/driver-pay-box-trucks`, `/owner-operator-pay`) live in the ASSETS group today and keep it. Pay periods are Sunday–Saturday (`lib/payPeriod.ts`, `driver-pay/week.ts`); nothing in the repo knows "Wednesday". | `navItems.ts` L52-54, `payPeriod.ts` L1-2 | New **label-only** cadence banner (§8). W's money rule applies unchanged: no pay module is edited; a source-diff gate proves it (§11.2 gate 8). |
| **F8** | **Intake's review step is currently implicit.** `INTAKE_MOVE_TO_ACTIVE` gates on `canMoveToActive` (required fields + problems + low-confidence unconfirmed) and then *stamps* `reviewedBy/reviewedAt` **at the moment of moving**, so a load whose every field auto-filled with high confidence can be moved by one click without anyone having looked at it. The UI's "Confirm all auto-filled" button is a bulk tick, not a review. | `intake.ts` L338-420, `intakeLoad.ts` L254-342, `IntakeReviewPage.tsx` L349-356 | Ryne #5 → explicit review act recorded on the `IntakeLoad` with **no schema change** (the `reviewedBy/reviewedAt` columns already exist), enforced server-side (§7). |
| **F9** | **`/compliance`, `/platform-health`, Users and Company/Divisions/Integrations settings are scattered**: Compliance, Platform health, Users and the Settings row are in the `COMPANY` section (NAV_ITEMS, `section: 'COMPANY'`), the rest are My Brokerage tabs. | `navItems.ts` L125-136, `BrokeragePage.tsx` TABS | One **Settings** group (§2.1) whose children point at the existing URLs; the COMPANY section keeps only the money/marketing pages Ryne did not list (D-AA3). |
| **F10** | **Queues that sound alike but are not Load Review:** AR "Docs needed" tab (`useArWorklist('DOCS_NEEDED')`, every DOCS_NEEDED order incl. undelivered), fleet `/pods` and `/intake` (ASSETS group, Ivan paperwork/office intake), Shipments › Intake (tender e-mails). | `useArWorklist.ts`, `navItems.ts` | The ASSETS rows keep their labels (D-AA12); the new nav labels ("Load Review", "Intake" under Shipments) are distinct enough. AR's tab is left alone (D-AA11). |

### 0.2 Decisions taken (defaults; Ryne can overrule — full list with alternatives in §13)

* **D-AA1** One flat top-level list (Company Dashboard → Settings) **without a BROKERAGE header**; ASSETS, CAR_SHIPPING and COMPANY stay sections below it. `BROKERAGE` still exists as a business in the company switcher (§2.2).
* **D-AA2** URLs unchanged; labels change. "Rates" → **Quotes** (+ child **Lane rates**). `/tms/rates` is the base AB builds on.
* **D-AA3** COMPANY section keeps Financial operations, Finances, Profit review, Weekly cash check-in, Reddit queue. Compliance, Platform health, Users, Settings leave it for the Settings group (Ryne listed them there).
* **D-AA4** No page key for Carrier Sales (uses `loads`/`quotes`/`tms`). **New page key `loadReview`** (label "Load review"), distinct from `intakeReview`; MANAGER role carries it; anyone else gets it as an extra page on the Users page.
* **D-AA5** Load Review has no money path of its own: "Move to billing" = `READY_TO_INVOICE` (single) / `BATCH_SHIPMENT_TASK{RELEASE_TO_BILLING}` (batch). The review payload `{review:{source:'LOAD_REVIEW'}}` only adds (a) three extra server refusals, (b) a richer audit row. `page-loads`/`page-tms` users keep their existing release powers (D-AA7).
* **D-AA6** Carrier Sales = needs-cover queue + carrier offers + covered/rate-con-out, every action a deep link to the shipment Carrier/Driver tab. Step T gets a placeholder card that says it is backburnered; no fake controls.
* **D-AA7** The board's Mass Release and `ArCard` keep working for `loads`/`tms`; making release reviewer-only is a one-line server change **not** made by default (would break Demo P10 and existing handler tests).
* **D-AA8** Intake: explicit **Mark reviewed** act; any later edit clears it; Move to active requires `reviewedAt` (server). Review needs a *complete* load (cannot mark an incomplete load reviewed).
* **D-AA9** Vendors excludes carrier bills (Accounts Payable) and driver pay (payroll); no manual vendor-bill create in AA.
* **D-AA10** Payroll label: pay date = the **Wednesday after the Sun–Sat period closes** (period = 4 days before, week Sun..Sat), computed in America/Chicago. Label only.

### 0.3 Schema and deploy impact — stated plainly

* **Schema: none.** `amplify/data/resource.ts` is not edited. Everything reuses existing columns: `IntakeLoad.reviewedBy/reviewedAt`, `Order.readyToInvoiceAt/updatedBy`, `AuditLog`. Load Review audit lives in `AuditLog.changes` JSON. **No data deploy forced** by AA.
* **Backend code (Lambda, same deploy as the rest):** `tms-shipment-actions` — new read action `REVIEW_LOAD`, new action `INTAKE_MARK_REVIEWED`, `page-loadReview` admitted to four actions, `READY_TO_INVOICE` accepts optional `review`, `INTAKE_MOVE_TO_ACTIVE` / `INTAKE_SAVE_DRAFT` changed (§7). No new env var, no new IAM statement (`REVIEW_LOAD` reads the same tables `READY_TO_INVOICE` already reads).
* **Optional (NOT planned, listed so nobody invents it):** `Order.readyToInvoiceBy` would make "released by" cheap for a reporting column; the AuditLog read is enough for the Released tab (≤ 50 ids per page). If wanted later it is one additive field.
* **Frontend self-heal:** no new field groups, so no `apiClient` retry flags.
* **Dependencies:** none added.

### 0.4 Slice map (5 builders; file ownership disjoint, §9)

| Slice | Owns | Size |
|---|---|---|
| **A** Shell, nav, routes, grants, badges (owner of **every** shared nav file) | `navSections.ts`, `navItems.ts`, `roles.ts`, `TmsShell.tsx`, `shell.css`, `TmsLayout.tsx`, `App.tsx`, `RequirePage.tsx`, `BrokeragePage.tsx`, `useShellBadgeCounts.ts`, `navActive.ts`, 4 AB placeholder files + their tests | L |
| **B** Load Review (UI + lib + backend + client wrappers) | `src/lib/loadReview.ts`, `src/features/tms/loadReview/**`, `tms-shipment-actions/{handler.ts,documents.ts,batch.ts}`, `apiClient.ts` (B + D wrappers), `useShipments.ts`, `demoFlow.ts`, `DemoPage.tsx`, `amplify/.../demo.ts` | L |
| **C** Carrier Sales + Vendors + Quotes labels | `src/features/tms/carrierSales/**`, `VendorApPage.tsx` (+ new sibling files), `QuotesPage.tsx`, `LaneRatesPage.tsx`, `QuoteDetail.tsx` (label strings only) | M |
| **D** Intake review gate + Wednesday payroll label | `src/lib/intakeLoad.ts`, `tms-shipment-actions/intake.ts`, `src/features/shipments/intake/**`, `src/lib/payrollCadence.ts`, `src/features/payroll/PayrollCadenceBanner.tsx`, one-line mounts in the 3 settlements pages | M |
| **E** Verification | `scripts/devVerifyAA.mjs`, `scripts/lib/aaRoutes.mjs`, edits to `uRoutes.mjs`, `devVerifyU.mjs`, `devVerifyS2/S3/S4.mjs`, `BUILD_LOG.md`, screenshots | M |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger — what exists today (and what AA does to it)

| Piece | Today | After AA |
|---|---|---|
| `navSections.PINNED_ITEMS` | `Company Dashboard`, `Shipments` (children: Intake; Tracking/Documents injected by `TmsShell`) | The **whole top-level list** (§2.1). Exported name kept; type extended (`children?: NavChildDef[]`, `group?: true`). |
| `navSections.TMS_ITEMS` | 9 BROKERAGE rows (Rates, Invoicing, Carriers, Factors, Customers, Locations, Vendors, Manage Customer Links, My Brokerage) | **Deleted**; its rows become top-level defs or children. `RequirePage` and `ITEM_POOL` imports updated. |
| `buildNavSections` | pinned filtered by `visible()`; one section per top-level division; a division with no pages gets an `Intake · name` fallback | pinned = full list with **child-level gating**; BROKERAGE produces **no section** (and no `Intake · BCAT` fallback); returns `businesses` for the switcher (§2.2). |
| `TmsShell.childrenFor` | injects `Shipments / Tracking(live) / Documents` by `item.to === SHIPMENTS_PATH` | **Deleted**; children come from data; only the live-loads list for the child whose `to === '/tms/tracking'` stays special. |
| `TmsShell.isChildActive` | exact path match (+ prefix for Intake/Tracking) | declarative rules `exact / exclude / params` (§2.3), search string passed in. |
| `tmsBreadcrumb` | Shipments/ITEM label + one level; workstations under "Shipments" | table-driven trails per §2.5; nothing reads "TMS" or "My Brokerage". |
| `NAV_ITEMS` | legacy permission rows incl. old BROKERAGE paths, COMPANY rows | unchanged except: `Compliance`, `Platform health`, `Users`, `Settings`(COMPANY) get `section: 'BROKERAGE'` so `ITEM_POOL` no longer renders them in COMPANY (they are Settings children now); `OFF_NAV_PERMISSION_PAGES` gains `loadReview`. |
| `roles.ts` | `MANAGER` = loads, customers, carriers, locations, quotes, invoicing, carrierPay, reports, commissions, audit | + `loadReview`. |
| `BrokeragePage` | h1 "My Brokerage", 10 tabs, per-tab guards | h1 **"Settings"**, same tabs + `spot-quoter` (AB placeholder). Tab guards untouched. |
| `useShellBadgeCounts` | 14 keys | + `loadReview`, `carrierSales`, `loadTracking`, `accounting`, `spotNew` (slot for AB). |
| `/tms/dispatch` | `Navigate → /tms/shipments` | `Navigate → /tms/carrier-sales`. |
| Demo P10 "Release to billing" | opens `shipment.readytobill` on `?tab=documents` | opens `/tms/load-review?shipment=<id>` (§4.9). |

---------------------------------------------------------------------------------------------------

## 2. The target sidebar

### 2.1 The tree (what an owner/ADMIN sees; every row below is a `<NavLink>`)

`pg` = page keys that open it (route guard `RequirePage page={[…]}`; the nav row uses the first key plus the `tms` grant). `★` = new in AA. Order is final.

```
(no header — pinned block, never folds when a business is chosen)
Company Dashboard                /tms/dashboard                       pg tms
Quotes ▾                         /tms/rates                           pg quotes|tms          badge quotesToReply
   Quotes                        /tms/rates            (also /new, /:id; NOT /lanes)           badge quotesToReply
   Lane rates                    /tms/rates/lanes
   Spot inbox  (reserved AB)     /tms/rates/spot                      pg quotes|tms          badge spotNew
Shipments ▾                      /tms/shipments                       pg loads|tms
   Active                        /tms/shipments                       (exact, list param absent)
   All                           /tms/shipments?list=all
   Intake                        /tms/shipments/intake                pg loads|tms|intakeReview   badge intakeLoads
Carrier Sales ★                  /tms/carrier-sales                   pg loads|tms           badge carrierSales
Load Tracking ▾                  /tms/tracking                        pg loads|tms           badge loadTracking (= checkCalls + documentReview)
   Tracking                      /tms/tracking          (live loads list opens under it)       badge tracking
   Check calls                   /tms/check-calls                                              badge checkCalls
   Document review               /tms/documents/review                                         badge documentReview   ← was "Documents"
   Customer links                /tms/tracking/links                                           ← was top-level "Manage Customer Links"
Load Review ★                    /tms/load-review                     pg loadReview|tms      badge loadReview
Customers ▾                      /tms/customers                       pg customers|tms
   Customers                     /tms/customers
   Follow-ups (reserved AB)      /tms/customers/follow-ups            pg customers|tms
Carriers                         /tms/carriers                        pg carriers|tms
Locations                        /tms/locations                       pg locations|tms
Accounting ▾  (group header)     → first visible child                                          badge accounting (= arToInvoice + apToReview)
   Accounts Receivable           /tms/invoicing  (also /invoices/:id; NOT /payable)  pg invoicing|tms   badge arToInvoice
   Accounts Payable              /tms/invoicing/payable (also /bills/:id)             pg carrierPay|tms  badge apToReview
   Vendors                       /tms/vendors                                         pg vendorAp|tms
   Factoring                     /tms/factors                                         pg factoring|tms
Settings ▾  (group header)       → first visible child
   General & automation          /tms/brokerage (exact)               pg settings|tms
   Company                       /tms/brokerage/company               ADMIN
   Divisions & ownership         /tms/brokerage/divisions             ADMIN
   Users & roles                 /tms/brokerage/users                 ADMIN
   Integrations                  /tms/brokerage/integrations          ADMIN
   AI agents                     /tms/brokerage/ai-agents             ADMIN
   Spot quoter & e-mail (AB)     /tms/brokerage/spot-quoter           ADMIN
   Commissions                   /tms/brokerage/commissions           pg commissions|tms
   Reports                       /tms/brokerage/reports               pg reports|tms
   Audit log                     /tms/brokerage/audit                 pg audit|tms
   Compliance                    /compliance                          pg compliance           badge review
   Platform health               /platform-health                     ADMIN
   Demo                          /tms/brokerage/demo                  pg tms

ASSETS [Ivan Cartage]            (section, unchanged, 22 rows: Dashboard, Dispatch, Driver info, Calendar, Appts, Time Off, Files, Intake, PODs, Box Truck / Amazon / Owner Operator Settlements, Ivan Driver App, Employee Hours, Amazon Disputes, Fleet Manager Dashboard, Maintenance, Invoices, Asset Documents, Fuel, Expenses, Fleet, Insurance)
CAR SHIPPING [Best Care Auto Transport]   (section, unchanged: Vehicle Quote, Booking Confirmation, Pricing Margin)
COMPANY                          (section, reduced to 5): Financial operations, Finances, Profit Review, Weekly Cash Check-in, Reddit Queue
```

Placement decisions for the items Ryne did not name (each lands in **exactly one** place):

| Item | Home | Why |
|---|---|---|
| Car Shipping / Best Care (Vehicle Quote, Booking Confirmation, Pricing Margin) | stay in the **CAR SHIPPING** section | Ryne #7: auto-shipping quotes stay separate. "Quotes" = freight spot quotes (Step H) only. |
| Factors | **Accounting › Factoring** | Spec lists factoring under Accounts Receivable; the page (`/tms/factors`) is a submit-to-OTR queue next to invoices. A child, not a tab: the URL and the page stay. |
| Rates / Lane rates | **Quotes › Lane rates** | Same `quotes` key, same board. |
| Invoicing (receivable + payable tabs of one page) | **Accounting › Accounts Receivable / Accounts Payable** | `InvoicingPage` already renders both from the URL; two nav rows, one component. |
| Manage Customer Links | **Load Tracking › Customer links** | It is the tracking-link manager (V-plan F2). |
| Documents (carrier-upload review) | **Load Tracking › Document review** | Where PODs arrive; upstream of Load Review. |
| Check calls | **Load Tracking › Check calls** | It is the tracking worklist. |
| My Brokerage tabs | **Settings** children (every tab URL kept; the page's own tab strip is kept) | Ryne #8. |
| Reports, Commissions | **Settings** | Ryne #8 (both are My Brokerage tabs already). |
| Compliance overview, Platform health | **Settings** | Ryne #8. `/compliance` stays a legacy fill-mode route. |
| Users | **Settings › Users & roles** | Ryne #8. |
| Audit log | **Settings › Audit log** | tab of the same page. |
| Demo | **Settings › Demo** | tab of the same page; last row so the walkthrough still finds it. |
| Financial operations, Finances, Profit Review, Weekly Cash Check-in | **COMPANY** (unchanged) | Owner money pages not in Ryne's list; moving them is a separate call (D-AA3). |
| Expenses, Fuel, Files, Maintenance, Invoices (maintenance), PODs, fleet Intake, Dispatch (driver texts), Time Off, Hours… | **ASSETS** (unchanged) | "Assets stays its own group as today". |
| Reddit Queue | **COMPANY** (unchanged) | marketing. |
| Workflows (`/tms/workflows[/runs/:id]`) | **HIDDEN** (no nav row; breadcrumb under Settings) | U-plan D-U2; four live deep links. |
| Academy | **HIDDEN** (redirect to dashboard) | U-plan §2. |
| Tasks `/tasks`, Schedule `/schedule`, Driver view `/driver-view/:id` | **OFF-NAV** (page keys `tasks`, `schedule`, `ownerOperatorPay`), unchanged | reached by in-page links. |

### 2.2 Section model and the company switcher

* `buildNavSections` returns `{ pinned, sections, businesses }`. `pinned` is the whole list above filtered per user; `sections` = ASSETS, CAR_SHIPPING, COMPANY (+ any division an admin adds, with the existing `Intake · <name>` fallback); **no BROKERAGE section** (the code path `if (division.code === BROKERAGE) continue`).
* `businesses: Array<{ key: string }>` = visible top-level division codes **including BROKERAGE whenever any pinned row is visible** (and excluding COMPANY, as `companyOptions` already does). `TmsLayout` calls `companyOptions(businesses, divisions)` instead of `companyOptions(sections, divisions)`; the function body is unchanged. Result: the switcher still offers "BCAT Logistics / Ivan Cartage / Best Care…".
* Folding: `NavSectionBlock` folds a section when another business is chosen (unchanged). The pinned block never folds — it is shared freight (this is what "Shipments serves all three businesses" meant). Choosing "BCAT Logistics" folds ASSETS and CAR_SHIPPING; choosing "Ivan Cartage" leaves the pinned block open.
* `TmsShell.TmsNavSection` / `TmsShellProps.pinned` types unchanged apart from `TmsNavChild`.

### 2.3 Data model (slice A, `navSections.ts` + `TmsShell.tsx`)

```ts
// TmsShell.tsx
export interface TmsNavChild {
  to: string                        // may carry a query: '/tms/shipments?list=all'
  label: string
  badgeKey?: string
  live?: TmsLiveChild[]             // set for the child whose path is '/tms/tracking' only
  exact?: boolean                   // default false = prefix match (path or path/…)
  exclude?: string[]                // path prefixes that belong to a sibling ('/tms/invoicing/payable')
  params?: Record<string, string | null>   // query params that must equal (null = must be absent)
}
export interface TmsNavItem { …existing…; group?: boolean }   // group: header row, no page of its own

// navSections.ts
export interface NavChildDef extends TmsNavChild {
  pageKey: string; tms?: boolean; adminOnly?: boolean
}
export interface NavItemDef { …existing…; adminOnly?: boolean; group?: boolean; children?: NavChildDef[] }
```

Rules (`buildNavSections`):

1. `visible(def)` = `everything || (def.adminOnly ? false : hasPageAccess(def.pageKey) || (def.tms && canOpenTms))`.
2. Children are filtered with the same rule. A **group** item is visible iff ≥ 1 child is visible, and its `to` is the first visible child's `to` (so a `compliance`-only user clicking Settings lands on Compliance, not a redirect). A non-group item with children is visible by its own rule even if every child is filtered out (Quotes for a `quotes` user with no Spot inbox).
3. `NavSectionItem.children` is emitted already filtered; `TmsShell` renders it verbatim.
4. Exports for other modules: `PINNED_ITEMS` (top-level defs), `flatNavDefs()` (top-level + children, **group headers excluded**, in sidebar order) — used by `RequirePage` for the landing target, by `tmsBreadcrumb`, and by the registry gate. `TMS_ITEMS` is removed (importers: `RequirePage.tsx`, `navSections.ts` itself, `navSections.test.ts`).
5. `RequirePage.firstAccessiblePath`/`preferredLandingPath` iterate `[...flatNavDefs(), ...NAV_ITEMS]`; landing order unchanged: `tms` → Company Dashboard, `dashboard`, `fleetManagerDashboard`, else first accessible (a carriers-only user lands on `/tms/carriers`; a `loadReview`-only user lands on `/tms/load-review`).

`TmsShell` changes:

* `childrenFor` becomes `item.children ?? []`; it only attaches `live: trackedLoads` to the child whose path is `TRACKING_PATH`. `DOCUMENTS_PATH`, `INTAKE_PATH` constants and the Shipments special-case are deleted; `SHIPMENTS_PATH` stays exported (`kit/index.ts` re-exports it).
* `isChildActive(activePath, activeSearch, child)`: split `child.to` into path/query; path ok = `exact ? activePath === p : isPathActive(activePath, p)` and not under any `exclude` prefix; then every `params` entry must match `activeSearch` (null = absent). New prop `activeSearch?: string` on `TmsShellProps`; `TmsLayout` passes `location.search`.
* `NavRow`: the row is highlighted (`tms-active`) when `isPathActive(activePath, item.to)` **or any child is active** (so Accounting lights on `/tms/vendors`); for `group` items only the second clause applies and the row is `<NavLink to=firstChild>` with `aria-current` driven by it. A group opens when a child is active (existing `open` logic).
* Parent badge: `badgeKey` unchanged mechanism; the four composite keys are computed in `useShellBadgeCounts` (§2.7), nothing summed in the shell.
* `shell.css`: group header styling is the existing `.tms-nav-row`; no new colours. A phone-width pass is part of §11.

Active rules per row:

| Row | `to` | rule |
|---|---|---|
| Quotes (child) | `/tms/rates` | prefix, `exclude: ['/tms/rates/lanes','/tms/rates/spot']` |
| Lane rates | `/tms/rates/lanes` | prefix |
| Spot inbox | `/tms/rates/spot` | prefix (covers `/callback`) |
| Active | `/tms/shipments` | `exact`, `params:{list:null}` — never on `/tms/shipments/:id` or `intake` |
| All | `/tms/shipments?list=all` | `exact`, `params:{list:'all'}` |
| Intake | `/tms/shipments/intake` | prefix (covers `/:intakeId`) |
| Tracking | `/tms/tracking` | prefix, `exclude:['/tms/tracking/links']` |
| Customer links | `/tms/tracking/links` | prefix |
| Customers | `/tms/customers` | prefix, `exclude:['/tms/customers/follow-ups']` |
| Accounts Receivable | `/tms/invoicing` | prefix, `exclude:['/tms/invoicing/payable']` (covers `/invoices/:id`) |
| Accounts Payable | `/tms/invoicing/payable` | prefix (covers `/bills/:id`) |
| General & automation | `/tms/brokerage` | `exact` |
| Company / Divisions / Users / Integrations / AI agents / Spot quoter / Commissions / Reports / Audit / Demo | `/tms/brokerage/<tab>` | prefix (Company has sub-tabs, Integrations has `/:provider`) |
| Compliance / Platform health | `/compliance`, `/platform-health` | prefix |

### 2.4 Phone and collapsed sidebar

Unchanged mechanisms (`tms-nav-open` drawer; collapsed rail shows icons only). Every top-level row needs an icon; use lucide icons already imported in these files where possible: Company Dashboard `LayoutDashboard`, Quotes `LineChart`, Shipments `Package`, Carrier Sales `PhoneCall`, Load Tracking `Activity`, Load Review `ClipboardList`, Customers `Building2`, Carriers `Truck`, Locations `MapPin`, Accounting `Banknote`, Settings `SlidersHorizontal`. (`PhoneCall`, `Activity`, `ClipboardList`, `Banknote`, `SlidersHorizontal` are already imported in `navItems.ts`; the builder confirms any other name compiles.) Children carry no icon (as today). A phone-width pass is part of the verification walk (§11.2 gate 9).

### 2.5 Breadcrumbs (`tmsBreadcrumb`, table-driven; the last crumb never links; group crumbs have no link)

| Path | Trail |
|---|---|
| `/tms/dashboard` | Company Dashboard (existing: via item label) |
| `/tms/rates` | Quotes |
| `/tms/rates/new` | Quotes › New quote |
| `/tms/rates/:id` | Quotes › Quote *(id hidden behind a label, as `Details` today for ids)* |
| `/tms/rates/lanes` | Quotes › Lane rates |
| `/tms/rates/spot` | Quotes › Spot inbox |
| `/tms/shipments` | Shipments |
| `/tms/shipments/intake[/…]` | unchanged (`Shipments › Intake [› Load]`) |
| `/tms/shipments/:id` | `Shipments › Shipment` (unchanged) |
| `/tms/carrier-sales` | Carrier Sales |
| `/tms/tracking` | Load Tracking › Tracking |
| `/tms/tracking/links` | Load Tracking › Customer links |
| `/tms/check-calls` | Load Tracking › Check calls |
| `/tms/documents/review` | Load Tracking › Document review |
| `/tms/load-review` | Load Review |
| `/tms/customers[/…]` | Customers (› Follow-ups) |
| `/tms/carriers[/:id]`, `/tms/locations` | item label (+ `Details`) |
| `/tms/invoicing` | Accounting › Accounts Receivable |
| `/tms/invoicing/invoices/:id` | Accounting › Accounts Receivable *(links to `/tms/invoicing`)* › Invoice |
| `/tms/invoicing/payable` | Accounting › Accounts Payable |
| `/tms/invoicing/payable/bills/:id` | Accounting › Accounts Payable › Bill |
| `/tms/vendors` | Accounting › Vendors |
| `/tms/factors` | Accounting › Factoring |
| `/tms/brokerage` | Settings › General & automation |
| `/tms/brokerage/<tab>[/…]` | Settings › *tab label from §2.1* |
| `/compliance` | Settings › Compliance *(replaces `Compliance › Document overview`)* |
| `/platform-health` | Settings › Platform health |
| `/tms/workflows`, `/tms/workflows/runs/:id` | Settings › Workflows (today these fall to the generic `TMS` crumb) |
| ASSETS / CAR_SHIPPING / COMPANY pages | unchanged (item label; `LEGACY_CRUMBS` unchanged except the two lines above) |

Implementation: replace `SHIPMENT_WORKSTATIONS` and the Shipments-specific branches with one `CRUMBS` table `{ path, prefix?, crumbs }` checked longest-path-first, falling back to the existing "nav item + one level" rule. `LEGACY_CRUMBS` entries for `/compliance` and `/platform-health` move into it.

### 2.6 Slots reserved for Step AB (nav contract with ABPlan — AB builders never touch the nav files)

| Slot | Nav row | Route (declared by AA in `App.tsx`) | Guard | Placeholder component AA creates (**AB overwrites the file, same export**) |
|---|---|---|---|---|
| Spot inbox | Quotes › Spot inbox, badge `spotNew` | `rates/spot` | `['quotes','tms']` | `src/features/spot-quoter/SpotInboxPage.tsx` → `export function SpotInboxPage()` |
| OAuth return | none | `rates/spot/callback` | `['quotes','tms']` | `src/features/spot-quoter/SpotCallbackPage.tsx` → `export function SpotCallbackPage()` |
| Follow-ups | Customers › Follow-ups | `customers/follow-ups` | `['customers','tms']` | `src/features/directory/FollowUpsPage.tsx` → `export function FollowUpsPage()` |
| Spot quoter settings | Settings › Spot quoter & e-mail | `spot-quoter` tab inside `BrokeragePage` (`RequireAdmin`) | ADMIN | `src/features/tms/settings/SpotQuoterSettingsPage.tsx` → `export function SpotQuoterSettingsPage()` |

* The placeholders render `TmsEmptyState` "Arrives with Step AB" (clearly labelled, no controls, no stored state). They exist so AA typechecks, the registry gate has a real page per route, and AB edits only its own files.
* Route order in `App.tsx` (slice A): `rates/spot` and `rates/spot/callback` **before** `rates/:id` (React Router ranks static above dynamic, but the order is kept explicit and commented); `customers/follow-ups` after `customers`.
* `spotNew` badge: AA adds the key to the nav defs and a `spotNew: 0` slot comment in `useShellBadgeCounts`; AB owns the hook that fills it and adds that single line.
* AB adds **no** Cognito role: page key `quotes`/`customers` + MANAGER/ADMIN. `/tms/rates` is **not** renamed (ABPlan notified).
* Customers page tabs (Prospects/Active/Inactive) are AB's edit inside `DirectoryPages`, not nav.

### 2.7 Badge counts (all computed from rows the shell already holds or polls; no new poll in AA)

| Key | On | Definition | Source |
|---|---|---|---|
| `quotesToReply` | Quotes, Quotes › Quotes | REQUESTED / RECEIVED_REPLY / RECEIVED_COUNTER sell quotes | existing `useQuotesToReplyCount` (self-gated on `quotes`) |
| `spotNew` | Quotes › Spot inbox | AB | AB |
| `intakeLoads` | Shipments › Intake | OPEN `IntakeLoad` rows (60 s) | existing |
| `carrierSales` | Carrier Sales | loads that **need cover** (`needsCoverCount(shipments)`, §5.2) | `shipments` argument already passed to `useShellBadgeCounts` — no new read. Carrier offers are **not** added (they need `listOpenQuotes`; the page's Offers tab shows its own count). |
| `checkCalls` | Load Tracking › Check calls | due + overdue | existing |
| `documentReview` | Load Tracking › Document review | carrier uploads pending | existing (**new on the child**; today only the legacy rail carried it) |
| `tracking` | Load Tracking › Tracking | moving loads | existing |
| `loadTracking` | Load Tracking (parent) | `checkCalls + documentReview` (moving loads are not a chore) | derived in `useShellBadgeCounts` |
| `loadReview` | Load Review | `loadReviewCount(shipments)` — queue rows (Ready + Needs fixes), only when the user holds `loadReview` or `tms` | `src/lib/loadReview.ts` over the `shipments` argument |
| `arToInvoice` | Accounts Receivable | orders at UNBILLED (existing) | existing |
| `apToReview` | Accounts Payable | bills in review (existing) | existing |
| `accounting` | Accounting (parent) | `arToInvoice + apToReview` | derived |
| `review` | Settings › Compliance | pending compliance review (existing legacy key) | existing |
| *(removed)* | Shipments parent `checkCalls` badge | moved to Load Tracking | — |

`useShellBadgeCounts.test.ts` ("answers every badgeKey the nav config declares") already enumerates declared keys from the nav defs; it keeps working once the new defs (children included) are walked — the test helper must recurse into `children` (slice A).

### 2.8 Grants (page-grant implications)

| Key | Where it appears | Change |
|---|---|---|
| `loadReview` ★ | route guard `['loadReview','tms']`; nav row Load Review; Users page checkbox "Load review" (`OFF_NAV_PERMISSION_PAGES` in `navItems.ts`, because the nav row lives in `navSections`, not `NAV_ITEMS`); `ROLE_PAGES.MANAGER`; server `page-loadReview` (§4.5) | new. `roles.test.ts` pins MANAGER's group list → updated. AR_AP/CUSTOMER_REP/CARRIER_REP do **not** get it by default. |
| `intakeReview` | unchanged key; now also the only grant that may `INTAKE_MARK_REVIEWED` (it is in `INTAKE_ACTIONS`, so the existing server rule covers it) | none |
| `tms` | still opens everything in the pinned block (incl. Load Review, Carrier Sales) | none |
| `loads` | Carrier Sales, Shipments, Load Tracking pages; **not** Load Review | none |
| `quotes` | Quotes, Lane rates, Spot inbox | none |
| `vendorAp`, `factoring`, `invoicing`, `carrierPay` | Accounting children, same keys as before | none |
| `compliance` | Settings › Compliance row (route still also admits `files`) | none |
| ADMIN-only rows | Company, Divisions, Users, Integrations, AI agents, Spot quoter, Platform health | rendered only for owner/ADMIN (`adminOnly`), exactly as the tabs and `NAV_ITEMS.adminOnly` do now; the route guards (`RequireAdmin`) are untouched |
| No new key | Carrier Sales, Accounting (group), Settings (group) | groups are visible iff a child is |

A user with **only** `page-loadReview`: sees Load Review alone in the rail, lands there, can read all shipment data (reads are `allow.authenticated()`), can run the four review actions, **cannot** open `/tms/shipments/:id` (guard `loads|tms`) — the checklist's "Open Documents tab" links render as plain text with a tooltip "Needs the Shipments grant" for that user (D-AA13).

---------------------------------------------------------------------------------------------------

## 3. Complete route-to-home table (the checklist; slice E turns it into `scripts/lib/aaRoutes.mjs`)

Kinds: **page** (renders UI; has a sidebar home) · **redirect** (`Navigate`/`ParamRedirect`; lands on the page named) · **hidden** (routable, no nav row, deliberate) · **off-nav** (reached by in-page links, own page key) · **public** (outside the shell) · **splat** (entry to a sub-router). "Old URL" = the URL as it exists today; every one keeps working with the landing shown.

### 3.1 `/tms/*` block (`App.tsx` L141-181) and `BrokeragePage` tabs

| Pattern | Kind | Home (sidebar path) | Guard | Old URL status |
|---|---|---|---|---|
| `/tms` (index) | redirect | → `/tms/dashboard` | — | unchanged |
| `/tms/dashboard` | page | Company Dashboard | `tms` | unchanged |
| `/tms/shipments` (+`?list=all`) | page | Shipments › Active / All | `loads\|tms` | unchanged |
| `/tms/shipments/view/*` | redirect | → `/tms/shipments` (`all-shipments` → `?list=all`) | — | unchanged |
| `/tms/shipments/intake` | page | Shipments › Intake | `loads\|tms\|intakeReview` | unchanged |
| `/tms/shipments/intake/:intakeId` | page | Shipments › Intake | same | unchanged |
| `/tms/shipments/:id` (+`?tab=` every `DETAIL_TAB_KEYS` key) | page | Shipments (parent) | `loads\|tms` | unchanged |
| `/tms/dispatch` | redirect | → **`/tms/carrier-sales`** | — | **retargeted** (was `/tms/shipments`) |
| `/tms/carrier-sales` ★ | page | Carrier Sales | `loads\|tms` | new |
| `/tms/tracking` | page | Load Tracking › Tracking | `loads\|tms` | unchanged |
| `/tms/tracking/links` | page | Load Tracking › Customer links | `loads\|tms` | unchanged |
| `/tms/documents/review` | page | Load Tracking › Document review | `loads\|tms` | unchanged |
| `/tms/documents/*` | redirect | → `/tms/documents/review` | — | unchanged |
| `/tms/check-calls` | page | Load Tracking › Check calls | `loads\|tms` | unchanged |
| `/tms/load-review` ★ | page | Load Review (`?shipment=<id>` opens the drawer) | `loadReview\|tms` | new |
| `/tms/rates` | page | Quotes › Quotes | `quotes\|tms` | unchanged (label "Rates"→"Quotes") |
| `/tms/rates/new` | page | Quotes › Quotes | `quotes\|tms` | unchanged |
| `/tms/rates/:id` | page | Quotes › Quotes | `quotes\|tms` | unchanged |
| `/tms/rates/lanes` | page | Quotes › Lane rates | `quotes\|tms` | unchanged |
| `/tms/rates/spot` ★(AB) | page (placeholder until AB) | Quotes › Spot inbox | `quotes\|tms` | new |
| `/tms/rates/spot/callback` ★(AB) | page, no nav | Quotes › Spot inbox | `quotes\|tms` | new |
| `/tms/invoicing` | page | Accounting › Accounts Receivable | `invoicing\|tms` | unchanged |
| `/tms/invoicing/invoices/:id` | page | Accounting › Accounts Receivable | `invoicing\|tms` | unchanged |
| `/tms/invoicing/payable` | page | Accounting › Accounts Payable | `carrierPay\|tms` | unchanged |
| `/tms/invoicing/payable/bills/:id` | page | Accounting › Accounts Payable | `carrierPay\|tms` | unchanged |
| `/tms/vendors` | page | Accounting › Vendors | `vendorAp\|tms` | unchanged |
| `/tms/factors` | page | Accounting › Factoring | `factoring\|tms` | unchanged |
| `/tms/customers` | page | Customers › Customers | `customers\|tms` | unchanged |
| `/tms/customers/follow-ups` ★(AB) | page (placeholder) | Customers › Follow-ups | `customers\|tms` | new |
| `/tms/carriers`, `/tms/carriers/:id` | page | Carriers | `carriers\|tms` | unchanged |
| `/tms/locations` | page | Locations | `locations\|tms` | unchanged |
| `/tms/workflows` | hidden | Settings (breadcrumb only) | `tms` | unchanged |
| `/tms/workflows/runs/:id` | hidden | Settings (breadcrumb only) | `tms` | unchanged |
| `/tms/academy/*` | redirect | → `/tms/dashboard` | — | unchanged |
| `/tms/brokerage/*` | splat | Settings (below) | per tab | unchanged |
| `/tms/brokerage` | page | Settings › General & automation | `settings\|tms` | unchanged (h1 "My Brokerage"→"Settings") |
| `/tms/brokerage/users` | page | Settings › Users & roles | ADMIN | unchanged |
| `/tms/brokerage/commissions` | page | Settings › Commissions | `commissions\|tms` | unchanged |
| `/tms/brokerage/reports` | page | Settings › Reports | `reports\|tms` | unchanged |
| `/tms/brokerage/audit` | page | Settings › Audit log | `audit\|tms` | unchanged |
| `/tms/brokerage/divisions` | page | Settings › Divisions & ownership | ADMIN | unchanged |
| `/tms/brokerage/integrations`, `/tms/brokerage/integrations/:provider` | page | Settings › Integrations | ADMIN | unchanged |
| `/tms/brokerage/ai-agents` | page | Settings › AI agents | ADMIN | unchanged |
| `/tms/brokerage/company/{company,billing,branding,notifications,import,aljex-import,data,account}` | page ×8 | Settings › Company | ADMIN | unchanged |
| `/tms/brokerage/demo` | page | Settings › Demo | `tms` | unchanged |
| `/tms/brokerage/spot-quoter` ★(AB) | page (placeholder) | Settings › Spot quoter & e-mail | ADMIN | new |
| `/tms/brokerage/views` | redirect | → `/tms/brokerage` (BrokeragePage `*` fallback) | — | unchanged (removed in U) |

### 3.2 Legacy shell routes (`App.tsx` L182-265)

| Pattern | Kind | Home | Guard | Old URL status |
|---|---|---|---|---|
| `/` (index) | redirect | `LandingRedirect` (§2.3 rule 5) | — | unchanged |
| `/dashboard` | page | ASSETS › Dashboard | `dashboard` | unchanged |
| `/calendar` | page | ASSETS › Calendar | `calendar` | unchanged |
| `/driver-info` | page | ASSETS › Driver info | `dispatch` | unchanged |
| `/dispatch` | page | ASSETS › Dispatch (driver texts — **not** Carrier Sales) | `dispatch` | unchanged |
| `/appts` | page | ASSETS › Appts | `appts` | unchanged |
| `/time-off` | page | ASSETS › Time Off | `timeOff` | unchanged |
| `/files` | page | ASSETS › Files | `files` | unchanged |
| `/intake` | page | ASSETS › Intake (fleet office intake) | `intake` | unchanged |
| `/pods` | page | ASSETS › PODs | `pods` | unchanged |
| `/driver-pay-box-trucks` | page | ASSETS › Box Truck Settlements | `driverPayBoxTrucks` | unchanged (+ payroll label §8) |
| `/driver-pay` | page | ASSETS › Amazon Settlements | `driverPay` | unchanged (+ payroll label) |
| `/owner-operator-pay` | page | ASSETS › Owner Operator Settlements | `ownerOperatorPay` | unchanged (+ payroll label) |
| `/driver-view/:driverId` | off-nav | ASSETS (reached from owner-operator settlements) | `ownerOperatorPay` | unchanged |
| `/ivan-driver-app` | page | ASSETS › Ivan Driver App | `ivanDriverApp` | unchanged |
| `/hours` | page | ASSETS › Employee Hours | `hours` | unchanged |
| `/disputes` | page | ASSETS › Amazon Disputes | `disputes` | unchanged |
| `/fleet-dashboard` | page | ASSETS › Fleet Manager Dashboard | `fleetManagerDashboard` | unchanged |
| `/maintenance` | page | ASSETS › Maintenance | `maintenance` | unchanged |
| `/invoices` | page | ASSETS › Invoices (maintenance invoices; feeds Vendors) | `invoices` | unchanged |
| `/truck-docs` | page | ASSETS › Asset Documents | `truckDocs` | unchanged |
| `/fuel` | page | ASSETS › Fuel | `fuel` | unchanged |
| `/expenses` | page | ASSETS › Expenses | `finances` | unchanged |
| `/trucks` | page | ASSETS › Fleet | `trucks` | unchanged |
| `/insurance` | page | ASSETS › Insurance | `insurance` | unchanged |
| `/schedule` | off-nav | ASSETS (in-page link) | `schedule` | unchanged |
| `/tasks` | off-nav | ASSETS (in-page link) | `tasks` | unchanged |
| `/vehicle-quote` | page | CAR SHIPPING › Vehicle Quote | `vehicleQuote` | unchanged |
| `/vehicle-confirmation` | page | CAR SHIPPING › Booking Confirmation | `vehicleConfirmation` | unchanged |
| `/pricing-margin` | page | CAR SHIPPING › Pricing Margin | `pricingMargin` | unchanged |
| `/financial-operations` | page | COMPANY › Financial operations | `finances` | unchanged |
| `/finances` | page | COMPANY › Finances | `finances` | unchanged |
| `/finances/review` | page | COMPANY › Profit Review | `finances` | unchanged |
| `/finance/cash-checkin` | page | COMPANY › Weekly Cash Check-in | `cashCheckIn` | unchanged |
| `/reddit-queue` | page | COMPANY › Reddit Queue | `redditQueue` | unchanged |
| `/compliance` | page | **Settings › Compliance** (was COMPANY) | `compliance\|files` | unchanged URL, new home |
| `/platform-health` | page | **Settings › Platform health** (was COMPANY) | ADMIN | unchanged URL, new home |
| `/loads`, `/grid` | redirect | → `/tms/shipments` | — | unchanged |
| `/shipments`, `/shipments/:id` | redirect | → `/tms/shipments[/:id]` | — | unchanged |
| `/check-calls` | redirect | → `/tms/check-calls` | — | unchanged |
| `/documents` | redirect | → `/tms/documents/review` | — | unchanged |
| `/drivers` | redirect | → `/files` | — | unchanged |
| `/factoring` | redirect | → `/tms/factors` | — | unchanged |
| `/ar`, `/ar/invoices/:id` | redirect | → `/tms/invoicing[/invoices/:id]` | — | unchanged |
| `/ap`, `/ap/bills/:id` | redirect | → `/tms/invoicing/payable[/bills/:id]` | — | unchanged |
| `/vendor-ap` | redirect | → `/tms/vendors` | — | unchanged |
| `/customers`, `/locations`, `/carriers`, `/carriers/:id` | redirect | → `/tms/customers`, `/tms/locations`, `/tms/carriers[/:id]` | — | unchanged |
| `/quotes`, `/quotes/new`, `/quotes/:id`, `/rates` | redirect | → `/tms/rates`, `/tms/rates/new`, `/tms/rates/:id`, `/tms/rates/lanes` | — | unchanged |
| `/commissions`, `/reports` | redirect | → `/tms/brokerage/commissions`, `/tms/brokerage/reports` | — | unchanged |
| `/settings`, `/settings/integrations`, `/settings/integrations/:provider` | redirect | → `/tms/brokerage[/integrations[/:provider]]` | — | unchanged |
| `/audit-log`, `/audit` | redirect | → `/tms/brokerage/audit` | — | unchanged |
| `/users` | redirect | → `/tms/brokerage/users` | — | unchanged |
| `/compliance/onboarding`, `/compliance/driver/:driverId`, `/compliance/truck/:truckId` | redirect | → `/files` | — | unchanged |
| `/compliance/review` | redirect | → `/compliance?tab=review` | — | unchanged |

### 3.3 Public / outside the staff shell (unchanged; listed so the gate has a row for each)

`/onboard/:token`, `/sign/rate-con/:token`, `/quote/:token`, `/amazon-disputes`, `/track/s/:token`, `/track/l/:token`, `/track/u/:token`, `/track/:code`, `/driver/*` (splat to `DriverRoutes`: login, signup, scan, loads, settlement, paperwork, timeclock, account), staff catch-all `/*`. Kind **public** / **splat**; no sidebar home.

### 3.4 Totals

The counts (pages / redirects / hidden / off-nav / public / splat) are **computed** by `node scripts/devVerifyAA.mjs --inventory` from `App.tsx`, `BrokeragePage.tsx` `TABS`, `CompanyTab.tsx` `TABS` and the Integrations provider route, and written to `BUILD_LOG.md` (§11.5). The acceptance values are: **unhomed 0, duplicate 0, orphan nav rows 0**. The table above is the human copy of `AA_HOMES`; if the two ever disagree the script wins and the table is regenerated.

---------------------------------------------------------------------------------------------------

## 4. Load Review — the pre-billing queue (`/tms/load-review`)

### 4.1 Definition (one pure function, shared by the page, the badge and the tests)

`src/lib/loadReview.ts` — **relative imports only** (the Lambda bundles it, as it does `releaseGate.ts`). Only `loadReviewExtras` and `loadReviewRefusal` run server-side; they must import nothing that is not relative and alias-free. `evaluateLoadReview` takes the customer-resolution fact as a plain boolean input (`customerUnresolved`, computed by the caller with `isCustomerUnresolved`) so the file never imports `@/lib/customerResolution`.

```ts
inLoadReviewQueue(row: LoadReviewRow): boolean =
     !row.voidedAt && !row.deletedAt && row.status !== 'CANCELED'
  && row.legacyImported !== true                     // imported Aljex history is exempt and never listed
  && !isReleasedToInvoicing(row)                     // lib/shipmentLists: readyToInvoiceAt | invoiceId | arStatus ≠ DOCS_NEEDED
  && (   row.status === 'DELIVERED' || row.deliveredAt != null || row.loadStatus === 'DELIVERED'
      || podInBeforeDelivery(row))                   // the "and/or POD received" half of Ryne's definition

podInBeforeDelivery(row) =
     ['ARRIVED_AT_DELIVERY_TERMINAL','OUT_FOR_DELIVERY','UNLOADING'].includes(row.status)
  && row.docsRequired?.includes('POD') === true && Array.isArray(row.docsMissing) && !row.docsMissing.includes('POD')
```

* "Released" = the existing rule (`isReleasedToInvoicing`); a row leaves the queue the instant `READY_TO_INVOICE` stamps `readyToInvoiceAt` and moves the order to UNBILLED. Nothing else removes a row (a load that *fails* a check stays, with its reasons — Ryne #5).
* `row.docsRequired` is the Order's cached list; `useShipments.ts` already reads the orders, so projecting it onto `ShipmentListRow` is a one-line addition (slice B owns that file). If a customer does not require POD, an early POD does not enter the queue — the load enters at delivery.
* Imported Aljex history: `legacyImported` is on `ShipmentListRow` (`ShipmentRecord`). The same flag already waives documents/references/driver in both gates; here it removes the row from the queue altogether (so a bulk-imported DELIVERED/DOCS_NEEDED history can never flood it).
* A DELIVERED shipment with **no order** (hasOrder false) stays listed with the failing detail "No order on this shipment" and cannot be selected.

### 4.2 Page design (`LoadReviewPage`, `TmsListPage` pattern like `IntakeBoard`/`VendorApPage`)

* Title "Load Review". `banner` = `TmsStatRow`: **In review** (n), **Looks ready** (n), **Needs fixes** (n), **Oldest** (days since delivery), **Value in review** (sum of customer revenue).
* `quickTabs` (counts live): **Needs fixes** (default when any exist, else Looks ready) · **Looks ready** · **All in review** · **Released (14 d)**.
* `filterChips` (kit `TmsFilterChip`): Revenue division, Sales rep, Customer; `search` over number / customer / reference (`matchesQuery` from `shipmentViews.ts`). Filters are URL-owned (`?q=&division=&rep=&tab=`) like the Intake board. `onRefresh` re-polls.
* Default sort: oldest delivery first (the queue is worked in the order it aged — same rule as `useArWorklist`). Page size 50, `page` footer from `TmsListPage`.
* Columns: ☐ select (only on **Looks ready** rows; others show the first reason as the checkbox `title`), **Shipment** (number, opens the drawer), **Customer**, **Lane** (origin → destination), **Delivered** (date), **In review** (age chip: ≥ 3 d orange, ≥ 7 d red), **Sales rep**, **Division**, **Checks** (five dots in fixed order Rep · Division · Details · Charges · Docs; green/orange with an `aria-label` per dot, e.g. "Documents: Missing document: POD"), **Revenue**, **Status** chip (`Looks ready` | `N to fix`).
* The chips on the list are **preliminary** (computed from cached row fields, §4.3) and say so in the column header tooltip. The drawer and the release are **authoritative** (server `evaluateReleaseGate`). A row the server later refuses stays in the queue with the server's sentence in a `Last attempt` line.
* Row click / `?shipment=<id>` opens the **drawer** (`TmsDrawer`, kit). Closing removes the param (`replace`). `]`/`[` (the `TmsKeyHint` shortcuts already in the list footer) step through the filtered rows.
* Batch: selecting ≥ 1 Looks-ready rows shows a sticky action bar "Move N to billing" → `TmsDialog` confirm ("These N shipments go to accounting. The server re-checks each one.") → `BATCH_SHIPMENT_TASK{task:'RELEASE_TO_BILLING', shipmentIds (≤ 100), params:{review:{source:'LOAD_REVIEW'}}}` → per-row result list (✓ moved / ✗ reason). Failures stay in the queue and keep their message. Select-all selects the Looks-ready rows of the current tab only.
* Empty states: "Nothing is waiting for review." (queue empty), "Nothing here." per tab. No hex colours; tones via `TmsBadge`.

### 4.3 The checklist (`evaluateLoadReview`) — five checks, every failing check carries reasons and a linked action

```ts
type LoadReviewCheckKey = 'salesRep' | 'revDivision' | 'details' | 'charges' | 'documents'
type LoadReviewAction =
  | { kind: 'SET_SALES_REP' } | { kind: 'SET_REV_DIVISION' }
  | { kind: 'OPEN_TAB'; tab: 'overview'|'stops'|'carrier'|'tracking'|'documents'|'financials'|'carrierPay' }
  | { kind: 'OPEN_DOC_REVIEW' }
interface LoadReviewReason { code: string; message: string; check: LoadReviewCheckKey; action: LoadReviewAction | null }
interface LoadReviewVerdict { ok: boolean; checks: Record<LoadReviewCheckKey, { ok: boolean; reasons: LoadReviewReason[] }>; warnings: string[] }
evaluateLoadReview({ row, gate? }): LoadReviewVerdict      // gate = authoritative ReleaseGateResult when the drawer has one; else derived from the row
loadReviewExtras({ shipment:{salesRepId, revDivision, legacyImported}, order:{revenueCents} }): LoadReviewReason[]   // the three checks the gate does not own
loadReviewRefusal(reasons): Error                          // message starts with RELEASE_GATE_ERROR_PREFIX so releaseGateMessages() parses it
```

| Check | Passes when | Failing reasons (sentence shown) | Linked action |
|---|---|---|---|
| **Sales rep** | `shipment.salesRepId` non-empty | `SALES_REP_MISSING` "Missing sales rep" | **Set sales rep** — inline `RepPicker` → `SET_SALES_REP` |
| **Revenue division** | `shipment.revDivision` non-empty (and active) | `REV_DIVISION_MISSING` "Missing revenue division" | **Set division** — inline division `TmsSelect` (+ subdivision) → `SET_REV_TAG` |
| **Load details** | no gate code in {`NOT_DELIVERED`, `REFERENCE_MISSING`, `CARRIER_NOT_ASSIGNED`, `DRIVER_MISSING`, `OPEN_EXCEPTIONS`}; customer resolved (`isCustomerUnresolved`); `buildState ≠ 'BUILDING'`; every stop has city + state + appointment; order exists | gate sentences verbatim ("Not delivered yet (status BOOKED)", "Missing reference: PO number", "No carrier or driver assigned", the Ivan driver sentences, "1 open exception"); `NO_CUSTOMER` "No customer linked"; `STOP_INCOMPLETE` "Stop 2 needs a city"; `NO_ORDER` | Open **Overview** / **Stops** / **Carrier/Driver** / **Tracking** tab (`/tms/shipments/:id?tab=…`) |
| **Charges** | gate has no `CARRIER_CHARGES_UNSETTLED`; customer revenue > 0 | `CARRIER_CHARGES_UNSETTLED` "Carrier charges not settled: X — record the carrier bill first"; `NO_CUSTOMER_CHARGES` "No customer charges"; **warning only**: `NEGATIVE_MARGIN` "Cost exceeds revenue by $N" (never blocks) | Open **Financials** / **Carrier pay** tab |
| **Documents** | gate has no `DOC_MISSING` (legacy waived by the gate itself) | `DOC_MISSING` "Missing document: POD" (verbatim); warning: "2 carrier uploads are still awaiting review" when `pendingDocReviewCount > 0` | Open **Documents** tab; **Review uploads** → `/tms/documents/review` |

* `VOIDED`/`CANCELED` can never reach the queue; if a server verdict carries them anyway they render under Load details.
* **Row verdict (cached)** derives a gate-equivalent from the row: `NOT_DELIVERED` from `status`, documents from `docsMissing` (`null` ⇒ "Documents not checked yet" fails Documents), `OPEN_EXCEPTIONS` from `openIncidentCount`, `CARRIER_NOT_ASSIGNED` from `assignmentType ∈ {null,'NEED_TO_COVER'}`, a **hint** for `CARRIER_CHARGES_UNSETTLED` when `assignmentType==='CARRIER'` and `apStatus` is null/`AWAITING_INVOICE`. References and the Ivan driver rule cannot be known from the row → the list says "Looks ready", never "Ready".
* **Drawer verdict (authoritative)** = `evaluateLoadReview({ row, gate: result.releaseGate })` + `result.extras` from `REVIEW_LOAD`. "Move to billing" is enabled only when the gate is `ok`, `extras` is empty and the order is `DOCS_NEEDED`.
* Exhaustiveness is pinned by a test that iterates every `ReleaseGateReasonCode` and asserts it maps to a check (a new gate code added later cannot silently vanish from the checklist).

### 4.4 Drawer layout (right-hand `TmsDrawer`, ~560 px; full-screen on phone)

Header: shipment number (link to the shipment), customer, lane, delivered date, age chip, `Looks ready/N to fix` → after load `Ready / N to fix` (authoritative). Body: five `TmsCard` sections in the fixed order. Each: ✓/✗ icon, the current value (rep name, division name, "Bill-to X · PO 123 · 2 stops · carrier Y", "Customer $1,200 · Cost $950 · Margin 20.8%", the doc strip with present/missing types), and the failing reasons as the `ReleaseGateList` pattern already used by `ReleaseGateCard` (re-exported from there, not copied). Inline fix controls for rep and division; link buttons for the rest. After a fix the drawer calls `REVIEW_LOAD` again and the list row refreshes. Footer: **Move to billing** (primary; disabled with the reasons printed above it), **Open shipment**, **Close**. Moving shows `Moved to billing` + advances to the next row. A thrown `Not ready for accounting: …` is split with `releaseGateMessages()` and rendered as the same list.

### 4.5 Backend (slice B; all in `amplify/functions/tms-shipment-actions`)

1. **Grant.** `handler.ts`: `const LOAD_REVIEW_PAGE_GROUP = 'page-loadReview'`; `LOAD_REVIEW_ACTIONS = { READY_TO_INVOICE, SET_SALES_REP, SET_REV_TAG, REVIEW_LOAD }`. In `isActionAuthorized`, **before** the final `return groups.includes(LOADS_PAGE_GROUP) || tms`: `if (LOAD_REVIEW_ACTIONS[action]) return groups.includes(LOAD_REVIEW_PAGE_GROUP) || groups.includes(LOADS_PAGE_GROUP) || tms`. The `Forbidden` message for these four lists all three groups. `BATCH_SHIPMENT_TASK` already authorizes through `BATCH_TASK_ACTIONS[task]`, so the batch inherits it with no change (`RELEASE_TO_BILLING→READY_TO_INVOICE`, `SET_REV_DIVISION→SET_REV_TAG`, `SET_SALES_REP`). Every other action (documents, carrier, driver, status, charges) still needs `page-loads`/`page-tms`: the grant is **additive for the review actions only**, which is exactly what makes it a separate role from `intakeReview` (whose actions admit *only* that group).
2. **`REVIEW_LOAD { shipmentId }`** (read-only, no writes, no audit): reads the bundle and builds the input with the **same** `loadReleaseGateInput` call as `readyToInvoice` (factor the `loadReleaseGateInput(...)` construction inside `readyToInvoice` in `documents.ts` into `computeReleaseGate(deps, order, bundle, customer, settings)`; both callers use it so they cannot drift). Returns
   `{ shipmentId, orderId, orderUpdatedAt, arStatus, releaseGate: ReleaseGateResult, extras: LoadReviewReason[], salesRepId, revDivision, revSubdivision, legacyImported }`. If the order is not `DOCS_NEEDED` it returns `releaseGate` anyway plus `arStatus` so the UI can say "Already released". New client wrapper `reviewLoad({ shipmentId })` (apiClient, slice B).
3. **`READY_TO_INVOICE` gains optional `review: { source: 'LOAD_REVIEW' }`.** When present: after the gate passes, `extras = loadReviewExtras(...)`; any extras ⇒ throw `loadReviewRefusal([...gate (empty), ...extras])` (same `Not ready for accounting:` prefix). When the gate fails *and* extras exist, one error lists both so the UI shows everything at once. Without `review` the action behaves **byte-identically** to today (the board, `ArCard`, the demo). `legacyImported` shipments skip the extras (belt and braces; they cannot be queued).
4. **`BATCH_SHIPMENT_TASK{RELEASE_TO_BILLING}`**: `batch.ts` forwards `params.review` (validated to the literal `{source:'LOAD_REVIEW'}`, else ignored) into the `releaseToBilling` input; the batch audit row records `review: true`.
5. **Audit (who/when)** — no schema change: the existing `ORDER/READY_TO_INVOICE` row (user = caller e-mail, `createdAt`) keeps its `{ missing }` payload and, when `review` is present, gains `review: { source:'LOAD_REVIEW', checks:{salesRep:true,revDivision:true,details:true,charges:true,documents:true}, warnings:[…], batch:boolean }`; **plus one `SHIPMENT/LOAD_REVIEW_RELEASED` row** with `{ orderId, checks, warnings, batch }` so the shipment's History tab (`HistorySection` reads the SHIPMENT entity) shows "Load review — moved to billing by X". `Order.readyToInvoiceAt` + `Order.updatedBy` are written exactly as today. `writeAudit` is best-effort in this router (a failed audit write does not undo the release) — noted as R-AA5, same as every other audited action.
6. Server tests (extend `handler.test.ts`, the `READY_TO_INVOICE` block at L4343): §10.

### 4.6 Counts and the sidebar

`loadReviewCount(rows)` = rows in the queue that are not `Released`; used by `useShellBadgeCounts` (key `loadReview`) and the Stat row. Shown only to users with `loadReview`/`tms`. No new poll: `TmsLayout` already holds `useShipments({kind:'all'})` (60 s).

### 4.7 Released tab

Rows with `readyToInvoiceAt` within 14 days (not legacy). "Released by / at" come from one `listAuditLogs(idsOnThisPage)` (≤ 50 ids, only while this tab is open), picking the newest `LOAD_REVIEW_RELEASED` else `READY_TO_INVOICE`. Read-only; the shipment link goes to the Invoicing tab. If the AuditLog scan proves slow at production volume the escape hatch is the additive `Order.readyToInvoiceBy` field (§0.3) — not built.

### 4.8 Demo wiring (slice B owns `demoFlow.ts`, `DemoPage.tsx`, `demo.ts`)

* P10 "Release to billing": `whatYouSee` → "The Load Review queue: the seeded delivered shipment with every check green, and Move to billing going through the Step F gate rather than around it; the POD-flagged shipment stays in the queue with its reason." The Open button targets `/tms/load-review?shipment=<id>` (add optional `route?: 'loadReview'` on `DemoStepDef`; the step-link resolver at the top of `DemoPage.tsx` maps it).
* P2 text still says "showing in My queue and in the team queue" (stale since U): corrected to "assigned to a carrier rep or team, mirrored onto the load" (U-plan §7 slice F already intended this; if it has landed, no-op).
* P5 text (Intake): "…and the Needs: list that gates Move to active **and the explicit Mark reviewed step**" (§7).
* Demo seed: the existing `shipment.readytobill` (all checks green) and `shipment.podflagged` (Documents red) cover both states; the seed must also carry a `salesRepId` on both (verify at build; add if absent) so the Rep check is green on the first and the walkthrough is clean.

---------------------------------------------------------------------------------------------------

## 5. Carrier Sales (`/tms/carrier-sales`) — small and honest

### 5.1 What composes it (all existing)

| Need | Piece that survives | Used how |
|---|---|---|
| Loads that need a carrier | `ShipmentListRow` via `useShipments`, `assignmentType`, `status`, `pickupAppt`, `datPostedAt`, `buildState` | queue rows |
| Coverage chips | `coverageStateOf` (restored from git `e207e5c^:…/workstations/coverage.ts`, 30 pure lines, plus its test) | chip: Needs cover / Covered / Rate con signed / Dispatched |
| Offers | `useQuoteWorklist().open` filtered `side === 'BUY'`; wording from `quoteViews` (`statusLabel`, `whoseMoveLabel`, `offerActions`) | Offers tab (read-only list; accept/counter/setup packet stay in `CarrierOffersSection` — **one booking path**) |
| Carrier packet invites | `sendSetupPacket` + `mcpPacketStanding` — inside `CarrierOffersSection` and the carrier profile | link to the shipment Carrier/Driver tab; the page shows the carrier's packet standing as a chip using `mcpPacketStanding(carrier)` when the row has `carrierMc` |
| Cover | `AssignCarrierDialog`/`StatusActions` on the shipment Carrier/Driver tab | link |
| Rate con | `rateConStatus/rateConSentAt/rateConSignedAt` on the row; `sendRateCon` + `buildRateConPdf` on the shipment tab | Covered tab columns; send happens on the shipment (MCP-packet gate `rateConMcpRefusal` stays server-side) |
| Postings | `datPostedAt` on the row; `PostingsSection` on the tab | "Posted" chip; **`listActivePostings` stays unused** (not wired; the row field is enough) |

### 5.2 Page

`TmsListPage` titled "Carrier Sales", `quickTabs` with counts:

1. **Needs cover** — `needsCover(row)`: `status ∈ {OPEN, BOOKED, PLANNED}`, `assignmentType ∈ {null,'NEED_TO_COVER'}`, not voided/canceled, `legacyImported !== true`, `buildState !== 'BUILDING'`. Columns: Shipment, Customer, Lane, Pickup (relative, red when < 24 h), Equipment, Customer rate, Posted chip, Offers (count from the worklist grouped by `shipmentId`), **Cover** button (link → `/tms/shipments/:id?tab=carrier`). Sorted by pickup soonest. This count is the sidebar `carrierSales` badge (`needsCoverCount`).
2. **Offers** — open BUY quotes: Offer id, Shipment (link), Carrier, Their number, Whose move, Expires chip, **Review offer** (link to the Carrier/Driver tab, where `CarrierOffersSection` accepts/counters/sends the packet). Header link "Open in Quotes › Carrier offers" (the QuotesPage tab is **kept**, D-AA6; both read the same worklist).
3. **Covered** — `coverageStateOf ∈ {COVERED, RATE_CON_SIGNED}` and not yet picked up: Carrier (MC), Rate con status (chip from `rateConStatus`), Sent at, Packet standing chip, **Open**. This is the "rate con out / not signed" follow-up list.
4. **Step T** — a single `TmsCard` (not a tab body of controls): "Distribution e-mail, threshold routing, the voice agent and a unified e-mail + call history per load are **backburnered (Step T)**. Nothing on this page sends, calls or routes automatically." No buttons, no stored state, no integration row. Rendered above the table on every tab as a collapsed alert so it is findable without pretending to be a feature.

Guards/grants: route `['loads','tms']`; all links need `loads|tms` as well (same guard). Offers tab requires `quotes` to read the worklist (`listOpenQuotes` is quotes-gated server-side); a user without it sees the tab with "Needs the Quotes grant" instead of an error toast.

### 5.3 Files (slice C)

`src/features/tms/carrierSales/{CarrierSalesPage.tsx, carrierSalesQueue.ts (+test), CarrierSalesPage.test.tsx}` — `carrierSalesQueue.ts` exports `coverageStateOf`, `needsCover`, `needsCoverCount`, `coveredRows`, `offersByShipment`. Nothing else is created or edited besides the `/tms/dispatch` redirect target (owned by A).

---------------------------------------------------------------------------------------------------

## 6. Vendors (`/tms/vendors`, Accounting › Vendors) — non-carrier payables

Today's pipeline (recon F6): `Assets › Invoices` (`/invoices`, maintenance invoices) → **Send to Vendor AP** (`manageVendorPayable SEND_MAINTENANCE`, deduped) → `VendorPayable{source:'MAINTENANCE'}`; mailbox bills → `vendor-ap-intake` Lambda → `VendorPayable{source:'EMAIL'}`; both worked on `/tms/vendors` (details, mark paid, reopen, admin delete) via `useVendorPayables` (30 s poll). The dashboard `VendorApCard` and the Expenses receipts view read the same rows.

**What the page shows after AA** (`VendorApPage.tsx` stays one file; new siblings `VendorSourceStrip.tsx`, `lib/vendorApSources.ts`; data hook, write paths, confirmations, admin-only delete **unchanged**):

1. **Stat row** (`TmsStatRow` from `vendorApTotals(items, today)`): Outstanding $ (n bills), Overdue, Due this week, Paid last 30 days, Unvalued (rows with no amount).
2. **Source filter chips**: All · Maintenance · E-mail (counts from `SOURCE_LABEL` keys); the existing `ALL / Need to pay / Done` quick tabs stay.
3. **View toggle** (`TmsSegmentedTabs`): **Bills** (today's table) · **By vendor** (group by normalised `vendor` string; columns Vendor, Open bills, Owed, Overdue, Last bill; row click sets the search to that vendor). Rows with no vendor group under "Unknown vendor".
4. **"Not in this queue" card** (`TmsAlert` tone info, links): "Carrier bills → **Accounts Payable**. Driver settlements and payroll (every Wednesday) → **Assets › settlements**. Fuel-card statements → **Assets › Fuel** (they reconcile in Expenses; they are not payable here)." Links respect the viewer's grants (plain text otherwise).

Out of scope, stated: no vendor master/directory, no manual "new vendor bill", no fuel-to-payable bridge, no driver pay (Ryne #6). The `VendorPayableSource` enum is **not** widened. If Ryne later wants a fuel/other source it is a separate additive step (new enum value + a writer), noted in §13 D-AA9.

---------------------------------------------------------------------------------------------------

## 7. Intake review gate (Ryne #5; slice D)

**Rule:** a load cannot move to Active until (a) every required field is populated and valid (today's `canMoveToActive`) **and** (b) a reviewer has performed an explicit **Mark reviewed** act on it — even if the stager auto-filled everything at high confidence. The act is recorded on the `IntakeLoad` (`reviewedBy`, `reviewedAt` — existing columns, today written only at move time) and checked server-side.

**Server (`amplify/functions/tms-shipment-actions/intake.ts`):**

* `INTAKE_ACTIONS` gains `'INTAKE_MARK_REVIEWED'` (`handler.ts` `Action` union + the `case` list at L7082 gain the same literal — slice B owns `handler.ts` and applies exactly those two lines; `INTAKE_REVIEW_ACTIONS` is derived from `INTAKE_ACTIONS`, so the new action is automatically `intakeReview`/owner/ADMIN-only).
* `intakeMarkReviewed({ intakeId, expectedVersion })`: row must be `OPEN` (CAS via `assertExpectedVersion`); runs `canMoveToActive`-without-review (`canMarkReviewed`): refuses `Cannot mark reviewed — still needs: <missing/problems/confirm …>` (an incomplete load cannot be reviewed); idempotent when already reviewed and unchanged; else `writeIntake({ reviewedBy: caller.email, reviewedAt: now, updatedBy })`; audit `INTAKE_LOAD/INTAKE_MARK_REVIEWED { reviewedBy, reviewedAt }`.
* `intakeSaveDraft`: when the patched `fields` or `confirmed` differ from the stored ones (JSON compare), also write `reviewedBy: null, reviewedAt: null` and add `reviewCleared: true` to the audit payload. A no-op save keeps the review. (An edit invalidates the review — otherwise a reviewer could be bypassed by editing afterwards.)
* `intakeMoveToActive`: after `canMoveToActive.ok`, if `!row.reviewedAt || !row.reviewedBy` throw `Not ready to move to active — still needs: review (open the load and press Mark reviewed)` (same `INTAKE_NOT_READY_PREFIX`, so the existing UI parse renders it). The PROMOTING resume path is untouched. The final `writeIntake({status:'MOVED', …})` **no longer overwrites** `reviewedBy/reviewedAt` (they hold the reviewer); the mover is recorded in the audit payload (`movedBy`). `Shipment.intakeReviewedBy/At` are the reviewer's values.

**Pure lib (`src/lib/intakeLoad.ts`, shared with the Lambda):** `canMoveToActive(row, ctx)` takes `reviewedAt/reviewedBy` in its `Pick` and returns `{ ok, missing, problems, unconfirmed, needsReview }` with `ok` false while `needsReview`; new `canMarkReviewed(row, ctx)` = the same checks without the review requirement. `intakeCounts` unchanged.

**Client:** `apiClient.markIntakeReviewed({ intakeId, expectedVersion })` beside `moveIntakeToActive` (slice B edits `apiClient.ts`; slice D supplies the exact wrapper text in its handoff — same shape as `dismissIntake` minus `reason`).

**UI (`IntakeReviewPage.tsx`, `IntakeBoard.tsx`):**

* Footer: **Mark reviewed** (primary-outline; enabled iff `canMarkReviewed` and not yet reviewed) sits left of **Move to active** (enabled iff `gate.ok` — which now includes review). A line under the buttons: "Reviewed by X · <time>" or "Needs review — check the fields, then Mark reviewed." Editing and saving a reviewed load shows "Saving clears the review." (matches the server).
* "Confirm all auto-filled" stays a bulk tick and does **not** count as a review (copy: "Confirming fields does not review the load").
* Board: a **Review** column (`Reviewed` green / `Needs review` orange) and the completeness text unchanged; the **Intake badge count is unchanged** (all OPEN rows).
* Read-only users (no `intakeReview`) see the reviewed state but no buttons.

**Fixtures/tests retargeted** (§10): `src/features/shipments/intake/testFixtures.ts` gets a `reviewed()` helper; `IntakeReviewPage.test.tsx`, `IntakeBoard.test.tsx`, `intakeLoad.test.ts`, `intake.test.ts` (the move test L210 now marks reviewed first), `handler.test.ts` intake cases, `devVerifyU.mjs` intake flow (mark reviewed before move). Demo seed `il:demo-intake` stays OPEN/unreviewed (the walkthrough shows the gate).

---------------------------------------------------------------------------------------------------

## 8. Wednesday payroll cadence label (Ryne #6; slice D) — label only, no pay math

* New pure module `src/lib/payrollCadence.ts` (+test): `PAY_WEEKDAY = 3` (Wednesday). `payCadence(now: Date)` → `{ nextPayDate: 'YYYY-MM-DD', isToday: boolean, periodStart, periodEnd, label }` in **America/Chicago** (use `chicagoDateStr` from `src/lib/date.ts`; date arithmetic on `YYYY-MM-DD` at UTC noon so DST cannot shift it). `nextPayDate` = the next Wednesday on or after today; the **period covered** = the Sun–Sat week that closed 4 days before it (D-AA10). Label: "Payroll runs every Wednesday · Next pay date Wed Nov 4 · Covers Sun Oct 25 – Sat Oct 31" (uses `formatWeekLabel` from `payPeriod.ts` for the range).
* New `src/features/payroll/PayrollCadenceBanner.tsx` (kit tokens only): one muted line; no controls.
* Mounted by **one JSX line + one import** at the top of `DriverPayPage.tsx`, `BoxTruckPayPage.tsx`, `OwnerOperatorPayPage.tsx` (slice D owns exactly those insertions).
* **Pay history stays byte-identical.** W's money rule applies: no file under `src/lib/{driverPay*,ownerOperatorTrips,payPdf*,mileagePeriods,fleetProfitability,biweekly,payPeriods,settlement}.ts`, no `driver-pay*/week.ts`, no pay hook, no driver-app-api is edited. Gate in `devVerifyAA --pay-guard` (§11.2 gate 8): `git diff --stat <base>` over those paths is empty, and the three page diffs contain only the banner import/JSX.
* **Open assumption (flagged to Ryne, D-AA10):** whether the Wednesday pay date follows the *Sun–Sat week that just ended* (assumed) or a different lag. Changing it is one constant in `payrollCadence.ts`.

---------------------------------------------------------------------------------------------------

## 9. Slices — five builders, disjoint file ownership

All five are dispatched in **one** `tasks[]` batch. Cross-slice contracts below are final (names and signatures), so nobody waits. Nobody runs typecheck/lint/tests mid-flight; Main runs them once after all land. Every task must skip formatters.

### 9.1 Contracts between slices

| Contract | Producer | Consumer |
|---|---|---|
| `export function LoadReviewPage()` in `src/features/tms/loadReview/LoadReviewPage.tsx` (no props) | B | A (`App.tsx` import) |
| `export function CarrierSalesPage()` in `src/features/tms/carrierSales/CarrierSalesPage.tsx` (no props) | C | A |
| `loadReviewCount(rows: readonly LoadReviewRow[]): number` in `src/lib/loadReview.ts` | B | A (`useShellBadgeCounts`) |
| `needsCoverCount(rows: readonly CarrierSalesRow[]): number` in `src/features/tms/carrierSales/carrierSalesQueue.ts` | C | A |
| `LoadReviewRow` / `CarrierSalesRow` are structural subsets of `ShipmentListRow` (`src/hooks/useShipments.ts`) — passing `ShipmentListRow[]` type-checks | B, C | A |
| `reviewLoad(input)`, `ReadyToInvoiceInput.review?`, `markIntakeReviewed(input)` wrappers in `apiClient.ts` | B (D supplies the `markIntakeReviewed` text: `shipmentAction<IntakeLoadRecord>('INTAKE_MARK_REVIEWED', input)` returned through the existing `intakeRow()` mapper, input `{ intakeId: string; expectedVersion: number }` — confirm the exact field name against `moveIntakeToActive` at L2507) | B (page), D (IntakeReviewPage) |
| `INTAKE_MARK_REVIEWED` literal in `Action` union + `case` list of `handler.ts` | D defines the action in `intake.ts` | B applies the two lines in `handler.ts` |
| `docsRequired?: string[] \| null` on `ShipmentListRow` | B (`useShipments.ts`) | B, C (not used by C) |
| `<Route>` element names + placeholder component paths of §2.6 | A | AB (overwrites the four files) |
| Nav literal form `to: '<path>'` (single quotes, exactly one space) for every row in `navSections.ts`, and `to: '<path>'` rows kept in `navItems.ts` | A | registries `uNavGaps`, `s4NavGaps`, `aaRoutes.mjs` grep these |

### 9.2 Slice A — shell, nav, routes, grants, badges (single owner of every shared nav file)

**Owns:** `src/lib/navSections.ts` (+`navSections.test.ts`), `src/lib/navItems.ts`, `src/lib/roles.ts` (+`roles.test.ts`), `src/features/tms/TmsShell.tsx` (+`TmsShell.test.tsx`), `shell.css`, `navActive.ts`, `TmsLayout.tsx` (+test), `src/App.tsx`, `src/components/RequirePage.tsx` (+test), `src/features/tms/brokerage/BrokeragePage.tsx` (+test), `useShellBadgeCounts.ts` (+test), the four AB placeholders (§2.6) + one trivial test.

Steps:

1. **`navSections.ts`** — new `NavItemDef`/`NavChildDef` types (§2.3); `PINNED_ITEMS` = the full tree of §2.1 with the page keys/badges/active rules listed there; one `const SHOW_RESERVED_AB = true` gating the three AB rows (flip to `false` to hide them before AB ships); delete `TMS_ITEMS`; add `flatNavDefs()`; rewrite `buildNavSections` (child gating, group `to`, `adminOnly`, skip BROKERAGE, `businesses`); replace `SHIPMENT_WORKSTATIONS`/branches by the `CRUMBS` table of §2.5; `ITEM_POOL = NAV_ITEMS.filter(i => i.section !== BROKERAGE)`; keep `companyOptions`, `sectionTitle`, `COMPANY_DIVISION`, `TMS_PAGE_KEY` exports.
2. **`navItems.ts`** — set `section: 'BROKERAGE'` on the four COMPANY rows that moved (`/compliance`, `/platform-health`, `/tms/brokerage/users`, `/tms/brokerage`) so `ITEM_POOL` stops rendering them in COMPANY while they remain permission rows; add `{ key: 'loadReview', label: 'Load review' }` to `OFF_NAV_PERMISSION_PAGES`. No other row changes. (The `S4_NAV_TARGETS` registry greps these rows — they must keep their `to:` text.)
3. **`roles.ts`** — `MANAGER` gains `'loadReview'`; update `ROLE_DESCRIPTIONS.MANAGER` only if the sentence becomes untrue (it does not). `roles.test.ts`: MANAGER group list gains `page-loadReview`.
4. **`TmsShell.tsx`/`shell.css`/`navActive.ts`** — §2.3 changes: data children, declarative `isChildActive(activePath, activeSearch, child)`, group rows, parent lit when a child is active, `activeSearch` prop; delete `childrenFor`'s Shipments branch and the `DOCUMENTS_PATH`/`INTAKE_PATH` constants. `TmsLayout.tsx`: pass `activeSearch={location.search}`, `companyOptions(businesses, divisions)`.
5. **`App.tsx`** — imports `LoadReviewPage`, `CarrierSalesPage`, the four placeholders; routes `carrier-sales` (`['loads','tms']`), `load-review` (`['loadReview','tms']`), `rates/spot` + `rates/spot/callback` (`['quotes','tms']`) before `rates/:id`, `customers/follow-ups` (`['customers','tms']`); `dispatch` → `<Navigate to="/tms/carrier-sales" replace />`; update the comment above the block. Nothing else in the file changes (legacy redirects all keep their targets — §3).
6. **`RequirePage.tsx`** — `ALL_ITEMS = [...flatNavDefs(), ...NAV_ITEMS]`.
7. **`BrokeragePage.tsx`** — `TmsPage title="Settings"`; header docblock "My Brokerage" → "Settings"; add tab `{ key:'spot-quoter', label:'Spot quoter & e-mail', path:'spot-quoter', pages: [] }` and `<Route path="spot-quoter" element={<RequireAdmin><SpotQuoterSettingsPage /></RequireAdmin>} />`. All other tabs, guards and the `*` fallback unchanged. (`scripts/devVerifyS2.requiredPatterns` parses `const TABS`/`path:` — keep that literal form.)
8. **`useShellBadgeCounts.ts`** — add `loadReview` (gated on `hasPageAccess('loadReview') || hasPageAccess('tms')`, via `loadReviewCount(shipments)`), `carrierSales` (`needsCoverCount(shipments)`, gated `loads|tms`), derived `loadTracking`, `accounting`, and the commented `spotNew` slot; `useMemo` deps updated.
9. **Placeholders** for AB — `TmsEmptyState` "Arrives with Step AB", no data, no fetch.
10. **Tests** — §10 (A's list).

Acceptance: `grep -n "TMS_ITEMS" src` empty; the rail for an owner equals §2.1 exactly; a `compliance`-only user sees Settings › Compliance only; `/tms/dispatch` lands on `/tms/carrier-sales`; no `Intake · BCAT` fallback section.

### 9.3 Slice B — Load Review (UI, lib, backend, client)

**Owns:** `src/lib/loadReview.ts` (+test), `src/features/tms/loadReview/**` (`LoadReviewPage.tsx`, `LoadReviewDrawer.tsx`, `useLoadReviewQueue.ts`, `loadReview.css` scoped under `.tms-shell`, tests), `amplify/functions/tms-shipment-actions/{handler.ts, documents.ts, batch.ts}` and their tests (`handler.test.ts` — the `READY_TO_INVOICE` block and the authorization block), `src/lib/apiClient.ts` (hunks: `reviewLoad`, `ReadyToInvoiceInput.review`, `markIntakeReviewed`, `LoadReviewResult` type), `src/hooks/useShipments.ts` (`docsRequired`), `src/lib/demoFlow.ts`, `src/features/tms/brokerage/DemoPage.tsx` (+test), `amplify/functions/tms-shipment-actions/demo.ts` (sales rep on the two seeded delivered shipments if absent), `src/features/shipments/components/ReleaseGateCard.tsx` (export `ReleaseGateList` is already public — no edit needed; listed only so nobody copies it).

Steps: lib first (§4.1/4.3), then server (§4.5: grant, `REVIEW_LOAD`, `computeReleaseGate` extraction, `review` payload, batch pass-through, audit rows; plus the two `INTAKE_MARK_REVIEWED` lines for D), wrappers, hook (`useLoadReviewQueue` = `useShipments({kind:'all'})` + `inLoadReviewQueue` + per-row `evaluateLoadReview`, 60 s via the existing hook), page + drawer (§4.2/4.4), demo wiring (§4.8). Acceptance: §4; the Load Review badge equals the **Needs fixes + Looks ready** tab counts; a legacy-imported shipment never appears.

### 9.4 Slice C — Carrier Sales, Vendors, Quotes labels

**Owns:** `src/features/tms/carrierSales/**`; `src/features/vendor-ap/VendorApPage.tsx` + new `VendorSourceStrip.tsx` + `src/lib/vendorApSources.ts` (+test); label-only edits in `src/features/quotes/{QuotesPage,LaneRatesPage,QuoteDetail}.tsx` (QuotesPage `title="Rates"` → `"Quotes"`; LaneRatesPage `Quote board` link label stays, its title unchanged; QuoteDetail back-link text `Rates` → `Quotes`; their tests updated for the strings only).

Steps: §5 and §6. `coverageStateOf` restored byte-for-byte from `git show e207e5c^:src/features/shipments/workstations/coverage.ts` (only the function and its types; **not** `suggestCarriers`/`carrierFlags`) with the matching cases of `coverage.test.ts`. Acceptance: Needs-cover tab count = sidebar badge; every action is a link to `/tms/shipments/:id?tab=carrier`; Step T card present and inert; Vendors keeps every existing behaviour (write paths untouched).

### 9.5 Slice D — Intake review gate + Wednesday payroll label

**Owns:** `src/lib/intakeLoad.ts` (+`intakeLoad.test.ts`), `amplify/functions/tms-shipment-actions/intake.ts` (+`intake.test.ts`), `src/features/shipments/intake/**` (`IntakeReviewPage.tsx`, `IntakeBoard.tsx`, `testFixtures.ts`, their tests, `intake.css`), `src/lib/payrollCadence.ts` (+test), `src/features/payroll/PayrollCadenceBanner.tsx` (+test), the three one-line mounts in `src/features/driver-pay/DriverPayPage.tsx`, `src/features/driver-pay-box-trucks/BoxTruckPayPage.tsx`, `src/features/owner-operator-pay/OwnerOperatorPayPage.tsx`.

Steps: §7 and §8. D does **not** touch `handler.ts` or `apiClient.ts` (B applies the contract lines). D must not edit any other file in those three pay features (guard §11.2 gate 8). Acceptance: an intake load with every field auto-filled at high confidence cannot move until marked reviewed; any edit un-reviews; the three settlements pages show the cadence line and their diffs contain nothing else.

### 9.6 Slice E — verification

**Owns:** `scripts/devVerifyAA.mjs`, `scripts/lib/aaRoutes.mjs`, `scripts/lib/uRoutes.mjs` (dispatch landing), `scripts/devVerifyU.mjs` (mark-reviewed step), `scripts/devVerifyS2.mjs` (new ROUTES rows, §11.4), `scripts/devVerifyS3.mjs`/`devVerifyS4.mjs` (only if their completeness gates need a row), `Docs/tms-build/BUILD_LOG.md`, `Docs/tms-build/screenshots/AA/`. E starts from §3 of this document; it reads the landed code to confirm the registry (it does not wait for pages to render to write the static gates).

### 9.7 Non-overlap check and shared-file ownership

| Shared file | Single owner | Other slices' needs |
|---|---|---|
| `src/App.tsx` | A | AB: none (placeholders). B/C: export names only. |
| `navSections.ts`, `navItems.ts`, `roles.ts`, `TmsShell.tsx`, `TmsLayout.tsx`, `RequirePage.tsx`, `BrokeragePage.tsx`, `useShellBadgeCounts.ts` | A | B/C provide pure count functions; AB fills `spotNew` via a hook A has already slotted. |
| `tms-shipment-actions/handler.ts` | B | D's two literals (§9.1). |
| `src/lib/apiClient.ts` | B | D's wrapper text (§9.1). |
| `src/hooks/useShipments.ts` | B | — |
| `amplify/data/resource.ts`, `backend.ts` | nobody | AA changes neither. |
| `scripts/devVerifyS2.mjs` | E | A's new routes listed in §11.4. |

Landing order for proof (all dispatched together): A → B/C/D in any order → E last (the walk needs the pages). No slice creates a file another owns.

---------------------------------------------------------------------------------------------------

## 10. Tests — behavioural only (each defends a plausible bug)

**Retarget/delete (existing tests the cutover breaks — fix, do not re-pin text):** `navSections.test.ts` (pinned list, TMS_ITEMS, children, S4 label expectations now look in `pinned`/children, breadcrumb trails); `TmsShell.test.tsx` L83-122 (Shipments children, Documents→Document review, Intake child) and the business-switcher case (folding now excludes the pinned block); `TmsLayout.test.tsx` (intake trail case stays; add activeSearch); `BrokeragePage.test.tsx` (title "Settings", extra admin tab `spot-quoter`); `RequirePage.test.tsx`; `roles.test.ts` (MANAGER groups); `useShellBadgeCounts.test.ts` (declared-keys enumeration recurses into children; new keys); `DemoPage.test.tsx` (P10 target); `intake.test.ts` L210 flow, `handler.test.ts` intake cases, `IntakeReviewPage.test.tsx`, `IntakeBoard.test.tsx` (review state); `QuotesPage.test.tsx`/`QuoteDetail.test.tsx` string expectations ("Rates"→"Quotes") — delete any assertion that only pins the old wording.

**New (A):**
* `navSections.test.ts` — (1) owner sees §2.1 in order, every child `to` unique; (2) a `carriers`-only user sees Carriers and nothing else pinned; (3) `compliance`-only → group "Settings" present with exactly Compliance, group `to === '/compliance'`; (4) `invoicing`-only → Accounting with Accounts Receivable only (a hidden child never leaks, group `to` = first visible); (5) ADMIN-only rows absent for a `tms`-grant user, present for ADMIN; (6) `loadReview`-only → pinned = [Load Review]; (7) no section for BROKERAGE and no `Intake · BCAT…` fallback, `businesses` still lists BROKERAGE; (8) FLATBED-style division with no pages still gets its intake link; (9) `flatNavDefs()` excludes group headers and every def's `to` has a route (exported route list in the test is derived from `App.tsx` text); (10) breadcrumbs: every row of §2.5, longest-match wins, ids hidden, group crumb has no link, nothing reads "TMS" for a known route or "My Brokerage".
* `TmsShell.test.tsx` — child active rules: Active vs All differ only by `?list=all`; Quotes child not lit on `/tms/rates/lanes`; AR child lit on `/tms/invoicing/invoices/x` and not on `/tms/invoicing/payable`; Accounting header lit on `/tms/vendors`; Tracking child shows the live list; group header link goes to the first visible child; badge shows on parent and child independently.
* `RequirePage.test.tsx` — a `loadReview`-only user lands on `/tms/load-review`; a user with no page lands on NoAccess; `carriers`-only lands on `/tms/carriers`.
* `roles.test.ts` — MANAGER ⊇ `page-loadReview`; a profile with `extraPages:['loadReview']` yields the group.
* `useShellBadgeCounts.test.ts` — `loadTracking` = checkCalls + documentReview; `accounting` = AR + AP; `loadReview` absent for a user without the grant.

**New (B):**
* `loadReview.test.ts` — queue membership truth table: delivered/not released ✔; released (`readyToInvoiceAt`, `invoiceId`, `arStatus` UNBILLED) ✘; `legacyImported` ✘; voided/canceled ✘; early-POD ✔ only when POD is required and present; DELIVERED with no order ✔ but blocked; checklist: **every `ReleaseGateReasonCode` maps to a check** (iterate the union); sales-rep/division/charges extras; negative margin is a warning and does not block; cached vs gate-supplied verdict; the refusal message round-trips through `releaseGateMessages()`.
* `handler.test.ts` — **authorization:** a caller with only `page-loadReview` can `READY_TO_INVOICE`, `SET_SALES_REP`, `SET_REV_TAG`, `REVIEW_LOAD` and `BATCH_SHIPMENT_TASK{RELEASE_TO_BILLING}`, and is refused `UPLOAD_DOCUMENT`/`ASSIGN_ASSET`/`SET_SHIPMENT_STATUS`/`BATCH{ASSIGN_DRIVER}`; a caller with only `page-intakeReview` is refused all four. **Behaviour:** with `review`, a delivered own-fleet order with no `salesRepId` is refused `Not ready for accounting: Missing sales rep`; zero revenue refused; both listed together with a gate failure; **without `review` the same order releases exactly as before** (byte-identical patch + audit); with `review` a clean order releases, writes `ORDER/READY_TO_INVOICE` with `review.checks` and `SHIPMENT/LOAD_REVIEW_RELEASED` with the caller; `REVIEW_LOAD` writes **nothing** (no order patch, no audit) and its `releaseGate.missing` equals what `READY_TO_INVOICE` then throws; legacy shipment skips the extras; batch reports one failing and one passing row, each with its own message.
* `LoadReviewPage.test.tsx` — rows listed only if in queue; checkbox only on Looks-ready rows; batch calls `batchShipmentTask` with `params.review` and the selected ids; a failed row keeps its server message and stays; drawer shows server reasons verbatim and enables Move to billing only when the gate is ok; deep link `?shipment=` opens the drawer.

**New (C):** `carrierSalesQueue.test.ts` — restored `coverageStateOf` cases; `needsCover` excludes DRAFT/TENDER_*/ON_HOLD, legacy, voided, building; `needsCoverCount` equals the tab length; `CarrierSalesPage.test.tsx` — Step T card present with no button; Offers tab without the `quotes` grant shows the grant message, not an error. `vendorApSources.test.ts` — grouping by vendor ignores case/punctuation like `findVendorApDuplicates`, "Unknown vendor" bucket, source filter, totals equal `vendorApTotals`.

**New (D):** `intake.test.ts` — **a fully populated, all-high-confidence load is refused by move until marked reviewed** (message contains `review`); `intakeMarkReviewed` refuses an incomplete load, is idempotent, requires `intakeReview` (owner/ADMIN pass; `page-loads`/`page-tms` refused); an edit that changes a field or `confirmed` clears `reviewedAt`, a no-op save does not; move keeps `reviewedBy` = the reviewer while the audit records the mover; the PROMOTING resume path still completes. `intakeLoad.test.ts` — `canMoveToActive.needsReview` / `canMarkReviewed`. `IntakeReviewPage.test.tsx` — Move disabled until Mark reviewed; Mark reviewed disabled while a required field is missing; saving after review shows the clearing notice. `payrollCadence.test.ts` — Tuesday Nov 3 2026 → Wed Nov 4, covers Sun Oct 25 – Sat Oct 31; on a Wednesday `isToday` and the same date; Thursday → following Wednesday; the 2026-11-01 DST end does not shift any date; `chicago` date at 23:30 CT on a Tuesday (already Wednesday in UTC) still says "next pay date" tomorrow, not today.

No test pins sidebar icon choice, CSS, or copy that is not part of a contract above.

---------------------------------------------------------------------------------------------------

## 11. `devVerifyAA` — `scripts/devVerifyAA.mjs` (slice E)

Pattern: same as `devVerifyU/S2/S4` (CDP browser via `scripts/lib/uiWalk.mjs` `createWalk`, shell facts, token probe, `auditInPage`; temp identities `zz-aa-…` + run stamp tracked and removed in `finally`). Flags: `--inventory` (no network, no browser: gates 1-3 only, plus gate 7 static), `--pay-guard` (gate 8 only), `--only=`, `--no-dark`.

### 11.1 Registry — `scripts/lib/aaRoutes.mjs`

* `AA_HOMES`: one row per App.tsx/BrokeragePage/CompanyTab/Integrations pattern — `{ pattern, kind: 'page'|'redirect'|'hidden'|'offnav'|'public'|'splat', home: 'Quotes › Quotes' | …, navPath, guard, landing? }` — i.e. §3 as data. `navPath` is the exact `href` of the sidebar row that owns the page (null for redirect/hidden/offnav/public).
* `AA_OLD_URLS`: `[concreteOldUrl, expectedLandingPathname[, expectedSearch]]` for **every** URL in §3 "Old URL" (placeholders `zz-x` for ids), frozen from this document. The only changed expectation is `/tms/dispatch → /tms/carrier-sales`.
* `AA_SIDEBAR`: the ordered `[label, href, depth]` list of §2.1 as an ADMIN sees it, plus persona expectations (`loadReview`-only; `compliance`-only).
* `AA_ROUTES`: walk rows `{ nn: 'AA01'…, slug, path, pattern, phone?, dark? }` for the pages AA adds or changes.
* `aaInventoryGaps(root)`, `aaMarkdown(root)` (§11.5).

### 11.2 Gates (fail first; each prints PASS/FAIL like U/S4)

1. **Every route has exactly one home.** Collect the actual pattern set: `<Route path>` literals outside and inside the `/tms` block (reuse `requiredLegacyPatterns` from `devVerifyS3`, `requiredPatterns` from `devVerifyS2`, plus the public/driver list). Assert `set(App routes) == set(AA_HOMES.pattern)` (both directions, `:id/:slug` normalised to `:p`), no duplicate pattern in `AA_HOMES`, and every `kind:'page'` has a non-empty `home` whose first segment is in `{Company Dashboard, Quotes, Shipments, Carrier Sales, Load Tracking, Load Review, Customers, Carriers, Locations, Accounting, Settings, ASSETS, CAR SHIPPING, COMPANY}`. Redirect rows must name a landing; hidden rows must be in `{/tms/workflows, /tms/workflows/runs/:id}`.
2. **Every page home is a real sidebar row.** For every `kind:'page'` row, `navPath` appears as a `to: '<navPath>'` literal in `src/lib/navSections.ts` or `src/lib/navItems.ts` (static), and — in the browser pass — as a rendered `nav a[href]` for ADMIN. Conversely every rendered sidebar href maps to ≥ 1 `AA_HOMES` row (no orphan nav row).
3. **Old URLs still land.** Every `AA_OLD_URLS` row: navigate as ADMIN, assert final `pathname` (and `search` when given), the shell present, `.tms-main` non-empty, no `No page access` panel, no console error/failed request (the S3 walker's rules). Includes all legacy redirects, `/tms/shipments/view/zz-x`, `/tms/documents/*`, `/tms/academy/*`, `/compliance/review`, `/settings/integrations/zz-x`, and the retargeted `/tms/dispatch`.
4. **Sidebar tree is exactly §2.1** (ADMIN): labels, order, hrefs, parent/child depth; group headers' hrefs; badge slots present (`aria-label`s), group expanded state follows the active path; collapsed rail and 390 px drawer both render every row.
5. **Personas** (temp Cognito users via the U helper, removed in `finally`): `page-loadReview` only → rail = [Load Review], landing `/tms/load-review`, `/tms/carriers` redirects to it, the four review calls succeed and `UPLOAD_DOCUMENT` through GraphQL is refused (`Forbidden`); `page-compliance` only → rail = Settings › Compliance, Settings header href `/compliance`; `page-tms` only → no ADMIN-only rows, Load Review visible.
6. **Load Review on dev data.** Seed is the demo (`SEED_DEMO_DATA`, dev flag): (a) `shipment.readytobill` is listed under Looks ready; `shipment.podflagged` under Needs fixes with "Missing document: POD"; (b) no `legacyImported` shipment is in the DOM (query `legacyImported:true` rows with `status DELIVERED`/DOCS_NEEDED from GraphQL and assert none of their numbers appear; if none exist on dev, assert via the lib unit and log a labelled SKIP, never a silent pass); (c) as the reviewer persona, open the drawer, assert the five sections and the server reasons, **Move to billing** on `readytobill` → order `UNBILLED`, `readyToInvoiceAt` set, `ORDER/READY_TO_INVOICE` audit with `review.checks` and `SHIPMENT/LOAD_REVIEW_RELEASED` with `user = persona email`; row leaves the queue and appears under Released (14 d) with "by"; (d) clear the sales rep on a seeded ZZ shipment, assert the Rep dot goes orange and a batch containing it reports the server refusal while the clean row moves; (e) cleanup: `RESET_DEMO_DATA` (dev-only flag) restores the seed; ZZ shipments voided.
7. **Intake gate on dev.** Create a fully populated OPEN `IntakeLoad` (all fields high confidence, `sourceKey zz-aa-…`) with the U helper: UI shows Move to active disabled and "Needs review"; direct `INTAKE_MOVE_TO_ACTIVE` returns `Not ready to move to active — still needs: review…`; **Mark reviewed** → move succeeds, `Shipment.intakeReviewedBy` = reviewer; second load: mark reviewed, edit a field, assert `reviewedAt` null and move refused again; incomplete load: mark reviewed refused. Cleanup via the U helper (dismiss/void).
8. **Pay guard** (`--pay-guard`, no network): `git diff --stat <BASE>..HEAD -- src/lib/driverPay* src/lib/ownerOperatorTrips.ts src/lib/payPdf* src/lib/mileagePeriods.ts src/lib/fleetProfitability.ts src/lib/biweekly.ts src/lib/payPeriods.ts src/lib/settlement.ts src/features/driver-pay/week.ts src/features/driver-pay-box-trucks src/features/owner-operator-pay amplify/functions/driver-app-api` shows **only** the three one-line banner mounts (added lines ≤ 3 per page file: one import, one JSX line, nothing removed); everything else empty. `BASE` = the commit before AA (recorded in the BUILD_LOG entry).
9. **Visual:** light and dark for every `AA_ROUTES` row at 1600×1000 (`auditInPage`: no legacy token, no unstyled kit class, no hex colour, no console error, no horizontal overflow except `wideOk`), plus the sidebar with every group expanded; phone 390×844 for sidebar drawer, Load Review (list + drawer), Carrier Sales, Vendors. Screenshots → `Docs/tms-build/screenshots/AA/<nn>-<slug>-<L|D|M>.png` + `index.txt`.

### 11.3 Walk rows (`AA_ROUTES`)

`AA01 sidebar` (all groups open) · `AA02 carrier-sales` (tabs Needs cover / Offers / Covered; Step T card) · `AA03 load-review` (tabs; drawer on a failing row; drawer on a ready row; batch confirm) · `AA04 vendors` (Bills, By vendor, source chips, "Not in this queue" card) · `AA05 quotes` (title Quotes; Lane rates child lit) · `AA06 accounting-ar` / `AA07 accounting-ap` (Accounting lit, correct child lit, invoice detail keeps AR lit) · `AA08 settings` (title Settings; breadcrumb `Settings › General & automation`) · `AA09 compliance-in-settings` · `AA10 intake-review` (Mark reviewed footer, reviewed state) · `AA11 settlements-banner` (×3 pages) · `AA12 spot-inbox` / `AA13 follow-ups` / `AA14 spot-quoter` (labelled placeholders).

### 11.4 Edits to the older registries (slice E; otherwise their completeness gates would fail on the new routes)

* `devVerifyS2.mjs ROUTES`: add `{nn:'35', slug:'carrier-sales', path:'/tms/carrier-sales', pattern:'/tms/carrier-sales', dark:true}`, `{nn:'36', slug:'load-review', path:'/tms/load-review', pattern:'/tms/load-review', dark:true, wideOk:true}`, `{nn:'37', slug:'spot-inbox', path:'/tms/rates/spot', pattern:'/tms/rates/spot'}`, `{nn:'37b', slug:'spot-callback', path:'/tms/rates/spot/callback', pattern:'/tms/rates/spot/callback'}`, `{nn:'38', slug:'follow-ups', path:'/tms/customers/follow-ups', pattern:'/tms/customers/follow-ups'}`, `{nn:'39', slug:'spot-quoter', path:'/tms/brokerage/spot-quoter', pattern:'/tms/brokerage/spot-quoter'}`; remove stale row `30b views` if still present (U removed that route; `requiredPatterns` only checks the required ⊆ have direction, but the walk would visit a redirect).
* `uRoutes.mjs`: `U_REDIRECTS` row `['/tms/dispatch','/tms/dispatch','/tms/shipments']` → landing `/tms/carrier-sales`; `U_GONE` `/tms/dispatch` `target` likewise (markers unchanged). `SIDEBAR_BANNED_HREFS` keeps `/tms/dispatch` (no sidebar link may point at it) — still true.
* `devVerifyU.mjs`: intake flows call `markIntakeReviewed` before `moveIntakeToActive`.
* `devVerifyS3.mjs`/`S4`: no row changes expected (`/compliance`, `/platform-health` URLs unchanged; `s4NavGaps` greps `to: '/compliance'` etc. in `navItems.ts`, which A preserves) — E confirms by running `--inventory` on all three.

### 11.5 BUILD_LOG route inventory format

`--inventory --markdown` prints the block below; E pastes it under the dated Step AA entry (newest entry first in `BUILD_LOG.md`, like the existing ones):

```
### Route inventory (Step AA) — generated by `node scripts/devVerifyAA.mjs --inventory --markdown` at <commit>
Totals: pages <n> · redirects <n> · hidden <n> · off-nav <n> · public <n> · splat <n> · unhomed 0 · duplicate 0 · orphan nav rows 0

| Pattern | Kind | Home | Guard | Old URL → landing | Shot |
|---|---|---|---|---|---|
| /tms/load-review | page | Load Review | loadReview\|tms | (new) | AA03 |
| /tms/dispatch | redirect | → /tms/carrier-sales | — | /tms/dispatch → /tms/carrier-sales | — |
| /tms/rates/:id | page | Quotes › Quotes | quotes\|tms | unchanged | 14 |
| … one row per pattern, sorted by home then pattern … |
```

The same entry records: `BASE` commit for the pay guard, the dev Amplify job id/status, gate results, and the screenshot index path.

---------------------------------------------------------------------------------------------------

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-AA1 | Registries grep source text (`to: '…'` in `navSections.ts`/`navItems.ts`, `const TABS`/`path:` in `BrokeragePage`, `<Route path="…">` per line in `App.tsx`). A tidy rewrite that changes the literal form silently disables a gate. | Contract in §9.1; `--inventory` is run by A's builder before handing off (static, 2 s). |
| R-AA2 | Largest churn is test rewrites (`navSections.test`, `TmsShell.test`). | A owns them; §10 lists what stays and what is rewritten; no new copy-pinning tests. |
| R-AA3 | Group header `to` = first visible child. A user whose only child is `/compliance` (legacy fill-mode route) clicking "Settings" lands in fill mode — fine, intended; `activePath` for lit state uses children. | tested (§10 A-3/A-4). |
| R-AA4 | **List chips are preliminary** (cached row fields can't see references, the Ivan driver rule or a settled carrier bill). A "Looks ready" row may be refused by the server. | Label says "Looks ready"; server refusals stay on the row with the sentence; drawer is authoritative; batch is per-row. |
| R-AA5 | `writeAudit` is best-effort in the router; a release could succeed with a missing audit row. Pre-existing behaviour for every audited action. | Not changed; `devVerifyAA` gate 6c asserts the rows exist on the happy path. |
| R-AA6 | Released tab reads AuditLog with an OR-filter list (scan) for ≤ 50 ids. | Only while the tab is open; escape hatch `Order.readyToInvoiceBy` documented, not built. |
| R-AA7 | Load Review overlaps AR's "Docs needed" tab (every DOCS_NEEDED order). Two lists, one action. | D-AA11: AR left alone (the biller's view); both end in the same `READY_TO_INVOICE`; labels distinguish ("Docs needed" vs Load Review). |
| R-AA8 | Concurrency: two reviewers on one row. | `REVIEW_LOAD` returns `orderUpdatedAt`; `READY_TO_INVOICE` already CASes on `expectedUpdatedAt` — loser sees the existing "changed, reload" error. |
| R-AA9 | A `loadReview`-only user cannot open shipment pages (guard `loads\|tms`). | D-AA13: links degrade to text with a tooltip; recommended grant is `loadReview` **plus** `tms`/`loads`; MANAGER already has both. |
| R-AA10 | **Dependence on the Aljex import.** If imported rows land with `arStatus: DOCS_NEEDED` and no `legacyImported`, the queue floods with history. | Ryne builds AA after the import; gate 6b counts legacy rows in the DOM; builder B counts queue size on dev after import and stops if it is not ≈ the live delivered-unreleased set. |
| R-AA11 | Intake gate affects in-flight data: every currently OPEN intake load becomes "Needs review" at deploy (none are reviewed today). Expected, not a bug. | Stated in the BUILD_LOG entry; demo seed row stays unreviewed so the walkthrough shows it. |
| R-AA12 | "Rates" → "Quotes" label may appear in e-mail templates/Academy text. | Builder C greps `\bRates\b` in `src` and `Docs/academy` for user-facing strings; changes only nav/page titles (not URLs, not `Lane Rates`). |
| R-AA13 | Payroll assumption (pay date lag). Label could be one week off until Ryne confirms. | One constant; flagged in D-AA10; label only. |
| R-AA14 | Company switcher semantics change slightly (pinned block never folds). | Documented §2.2; tested. |
| R-AA15 | Placeholders for AB are visible "Arrives with Step AB" pages in the rail until AB lands. | `SHOW_RESERVED_AB` constant in `navSections.ts` hides them in one line; routes stay so deep links never 404. |

---------------------------------------------------------------------------------------------------

## 13. Decisions (each has a default so building does not wait; Ryne can overrule any)

| ID | Question | Default | Alternative / cost |
|---|---|---|---|
| D-AA1 | Header for the freight list? | None; one flat list; BROKERAGE remains a business in the switcher | Keep a "BROKERAGE [BCAT Logistics]" header over everything below Company Dashboard (flip one branch in `buildNavSections`; Shipments then folds under Ivan/Best Care selections). |
| D-AA2 | Rename `/tms/rates` to `/tms/quotes`? | **No** — label only | New canonical path + redirect and ~40 link edits; AB would rebase. |
| D-AA3 | Where do Financial operations / Finances / Profit Review / Cash Check-in / Reddit go? | stay in COMPANY | Accounting › "Financial operations" (+ owner-only children); one def move. |
| D-AA4 | Carrier Sales page key? | none (`loads`/`tms`) | New `carrierSales` key (role matrix + server group) — only if reps must be restricted. |
| D-AA5 | Does Load Review add a new money path? | No; `READY_TO_INVOICE`/batch with an optional `review` marker | — |
| D-AA6 | Where do carrier offers live? | Offers tab on Carrier Sales **and** the existing QuotesPage tab (same worklist) | Remove the QuotesPage tab (QuotesPage edit + test churn). |
| D-AA7 | Make release reviewer-only? | No — `loads`/`tms` keep Mass Release and `ArCard` | One server line removes `loads`/`tms` from `READY_TO_INVOICE`; breaks Demo P10 and several handler tests. |
| D-AA8 | Intake review rules | Complete load required to mark reviewed; any edit clears; mover ≠ reviewer allowed | Require reviewer ≠ editor (needs an extra field) / allow marking an incomplete load reviewed. |
| D-AA9 | Vendors scope | Existing queue + stats + source chips + by-vendor + pointer card; no manual create; fuel not a payable | Add a `FUEL`/`OTHER` source (additive enum value + a writer) later. |
| D-AA10 | Wednesday pay date | next Wednesday on/after today; period = Sun–Sat week that closed 4 days earlier | Different lag → change `payrollCadence.ts` constant. |
| D-AA11 | AR "Docs needed" tab vs Load Review | AR untouched | Add a one-line info banner on that tab linking to Load Review (ArPage edit, slice C could take it). |
| D-AA12 | ASSETS `Intake` / `PODs` labels (fleet office intake vs Shipments › Intake) | unchanged | Rename to "Fleet intake" / "Fleet PODs" (nav labels only; tests pin neither). |
| D-AA13 | Links in the checklist for a `loadReview`-only user | plain text + tooltip | Admit `page-loadReview` to the shipment page guard (read-only), which needs a server read story. |
| D-AA14 | Role defaults for `loadReview` | MANAGER only; others via extra page | Add to AR_AP (billing staff are the likely reviewers) — one list entry. |
| D-AA15 | Early-POD entry (POD before DELIVERED) | enters the queue only when the customer requires POD and it is on file | Delivered-only (simpler, loses the "POD'd" half of the wording). |
| D-AA16 | Show AB placeholders in the rail before AB ships | yes (`SHOW_RESERVED_AB = true`, ABPlan request) | `false` hides the three rows; routes remain. |

Open items for Ryne (none block the build): D-AA10 (pay-date lag), D-AA14 (who gets `loadReview` by default), D-AA3 (finance pages), D-AA7 (reviewer-only release).
