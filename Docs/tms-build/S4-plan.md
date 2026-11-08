# Step S4 — the six added features (Compliance, Users, Financial operations, Expenses, Platform health, Notifications)

Spec: `REDESIGN_UI_REFERENCE.md` §5 (items 1–6) plus the §7 items that need **new data**. Builds on `S1-plan.md` (tokens, shell, bell D5), `S2-plan.md` (kit contracts §3.1, devVerify §9), `S3-plan.md` (one shell, `fill` mode, harness). S1–S3 + rate-con are deployed on `dev` (Amplify jobs 133/134; local commit `7898a43` unpushed). **Everything stays on `dev`**: no push to `main`, no merge prep, one Amplify deploy at a time, `npm run typecheck && npm run lint && npm run test` green once (Main) before the single push (`TMS_BUILD_BRIEF.md` hard rules). This plan is recon + design only; nobody edits code until Main dispatches the slices in §6.

Evidence base: direct reads of `amplify/data/resource.ts` (every model named below), `amplify/backend.ts` (driver pool L203–305, signup-gate block L375–395, mcp-sync L2126–2147, dev-stack guard L3410–3470), `driver-signup-gate/handler.ts`, `userManagement/handler.ts`, `mcp-sync/handler.ts`, `src/lib/{documentReview,fileHub,truckDocs,complianceDocStore,navItems,navSections,roles,dashboardCharts,fleetProfitability,timeClock,carrierEligibility,reportsClient}.ts`, `src/hooks/{useReviewQueue,useCheckCallWorklist,useDocumentReviewQueue,useTruckDocAlerts,useIntegrations,useWorkflowExceptions,useAppUpdate,useFleetProfitability}.ts`, `src/features/tms/{TmsShell,TmsLayout,useShellBadgeCounts}.ts(x)`, the whole kit barrel, `ErrorsTab`, `UsersPage`, `FilesPage`, `EntityFilePanel`, `FuelPage`, `scripts/devVerifyS3.mjs`/`devVerifyS2.mjs`/`lib/devIdentity.mjs`. Anything not confirmed from the repo is marked **[INFERENCE]** with the check that settles it.

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Seven findings that change the brief (read these first)

| # | Finding | Evidence | Consequence in this plan |
|---|---|---|---|
| **F1** | **The Cognito pre-sign-up gate has no queue.** It scans `Driver`/`DriverPaySetting`, and on a miss `throw new Error(REJECTION_MESSAGE)`. Cognito then creates **no user**, and the gate writes **nothing** — a refused sign-up is invisible. REDESIGN §5.2 assumed a queue exists. | `driver-signup-gate/handler.ts` (`throw` on every refusal path, no write; IAM is `dynamodb:Scan` only, `backend.ts` L380–385); `DriverSignupPage.test` "swallowing it would let anyone in" | "New registrations" is assembled from **four real sources** (§3.2). The only way to show *refused* attempts is a small, additive, best-effort log written by the gate into the **existing `AuditLog` table** — **no schema change** (decision **D-S4-2**). |
| **F2** | **On the dev stack every EventBridge schedule is disabled and SES is denied.** `compliance-scanner`, `mcp-sync`, `motive-*-sync`, `fuel-import`, OTR/Paychex sync never run on dev; data is whatever `copy-data` copied. Outbound mail (`sendOnboardingEmail` on Reject) cannot send. | `backend.ts` L3410–3470 (`CfnRule` → `DISABLED`, `ses:*` deny) | The expiring-soon queue is **computed client-side from documents** (never from `ComplianceAlert`, which only the scanner writes). Platform-health "last sync" reads **stale on dev by construction**: the page says so (build-info `branch === 'dev'`) instead of painting red. Approve/Reject is safe to exercise on dev (no external effect). |
| **F3** | **Carrier documents have no review state; MCP sync leaves no sync stamp.** `CarrierDocument` = `{type, name, s3Key, expiresAt, source, uploadedBy}` (writes only via `tmsCarrierActions`); `mcp-sync` Puts `mcpStatus/mcpRiskScore/insurancePolicies` (+ two attributes the schema does not declare) onto `Carrier` and `updatedAt`, nothing else. | `resource.ts` L3086–3105, L2948–3036; `mcp-sync/handler.ts` | Approve/Reject applies to **driver and truck** `ComplianceDocument`s (which already have `status/verifiedBy/rejectionReason`). Carrier paperwork appears **read-only** with expiry + MCP standing (**D-S4-3**). MCP "last sync" comes from a one-line **heartbeat on the existing `Integration` row** written by `mcp-sync` (no schema change). |
| **F4** | **Approve/Reject for driver/truck documents already exists** and is the only correct implementation (task settlement, audit row, rejection e-mail): `approveDocument`/`rejectDocument` in `lib/documentReview.ts`, driven by `useReviewQueue` and `EntityFilePanel.review()`. `/compliance*` routes are retired redirects to `/files`. | `documentReview.ts` header; `App.tsx` L233–237 | The Document overview **reuses those functions verbatim**, replaces `window.prompt` with a reason dialog, and takes over `/compliance` + `/compliance/review`. No second approve implementation. |
| **F5** | **Four numbers the reference shows have no source today:** revenue **target**, **deploy/version**, **salary** (no wage/hourly field anywhere; "driver pay" is a % settlement), and **receipt images** (only e-mailed vendor invoices carry attachments; EFS fuel lines and driver-pay charges have none). | `TmsSettings` fields (no target); no `__APP_VERSION__`/`version.json` in `src/`, `vite.config.ts`, `amplify.yml`; `MaintenanceInvoice` has no key; `VendorPayable.attachments` | Target = trailing-3-month average (no schema) — **D-S4-1**; version = Vite `define` from Amplify build env — §3.5; Salary = **driver pay (settlement cost)** from `useFleetProfitability` — **D-S4-4**; Receipt modal shows an image **only where an attachment exists**, with an explicit empty state otherwise — **D-S4-8**. |
| **F6** | **An exceptions collector already exists** (`lib/workflows/exceptions.collectExceptions`: AI runs, unknown customers, silent tracking, accounting, Parade, EDI, integrations) and every other notification input is already in memory in the shell (`useShipments` rows carry `creditHold`, `legDocsMissing`, `cargoInsuranceExpiresAt`; `useCheckCallWorklist`; `useAllComplianceDocuments`; `useDocumentReviewQueue`). | `ErrorsTab.tsx`, `useShipments.ts` L193–260, `TmsLayout.tsx` | The bell is **pure derivation over data the shell already holds** plus one sparse query (`useWorkflowExceptions`). No new model, no new poll of a big table. |
| **F7** | **The S3 harness cannot be reused as-is.** `scripts/lib/uiWalk.mjs` (promised in S3 §9.1) **does not exist**; `devVerifyS3.mjs` keeps `audit/waitLoaded/setTheme/conclude/shot` and its `SHOTS`/`report` state **module-private**; its completeness gate (`requiredLegacyPatterns` vs `coveredPatterns`) **fails on any new `App.tsx` route**, and `REDIRECTS` lists `/compliance`, `/compliance/review`, `/expenses` as redirects (S4 turns two of them into pages). | `devVerifyS3.mjs` L50–170, L245–300 | Slice V extracts a `createWalk()` factory into `scripts/lib/uiWalk.mjs` (moved, not rewritten) and edits three registries in `devVerifyS3.mjs` (§7.1). |

### 0.2 Decisions (each has a default so work does not wait; Ryne can overrule any)

| # | Decision | Default taken | Why it needs a human |
|---|---|---|---|
| **D-S4-1** | Revenue **target** for the Total-revenue gauge | **Trailing 3 completed months' average revenue** (labelled "3-month average", no schema change). The gauge takes `target` as a prop, so an explicit owner-set target is a later one-field change. | A real target is a business number. The optional additive field would be `TmsSettings.monthlyRevenueTargetCents` (+ `TMS_SETTINGS_V15_FIELDS`, `tmsDirectoryActions` save validation, a Settings card) — a schema change, so not taken unprompted. |
| **D-S4-2** | Log **refused driver sign-ups** from the gate | **Yes**: on each refusal the gate best-effort writes one `AuditLog` row (`entityType 'DRIVER_SIGNUP'`, deterministic id per email/day, conditional put) and still throws the identical message. Staff see them as "Blocked sign-up" cards with Open roster / Dismiss. | It touches a public, unauthenticated trigger and stores the email of someone who is not on the roster. Mitigations in §3.2 (deterministic id caps writes to 1 per email per day; failure/timeout never changes the outcome; staff-only read). If declined, drop that card type and `driver-signup-gate` is untouched. |
| **D-S4-3** | Approve/Reject on **carrier** documents | **Not in S4** (read-only + MCP standing + expiry). | Needs additive optional fields on `CarrierDocument` (`reviewStatus, reviewedBy, reviewedAt, rejectionReason`) and a `REVIEW_DOCUMENT` action in `tmsCarrierActions` — a schema change plus a booking-gate rethink (does a rejected COI block booking?). |
| **D-S4-4** | What "Salary" means on Expenses | **Driver pay** = `rollup.driverCost` from `useFleetProfitability` (settlement cost). Labelled "Salary (driver pay)". "Hours driven" = **time-clock hours** per Ivan employee. | No payroll wage exists; Paychex is neutered on dev. A true payroll figure needs the Paychex feed. |
| **D-S4-5** | The bell | **Replaces** the S1 link to `/tms/check-calls` with a drawer; badge = all visible exceptions. The Check-calls rail badge and page are unchanged. | Behaviour change to a control Ryne already saw. |
| **D-S4-6** | Nav placement / paths | `/compliance` (company), `/financial-operations` (company), `/expenses` (Ivan Cartage = `ASSETS`), `/platform-health` (company, admin-only). The retired `/compliance` + `/compliance/review` + `/expenses` redirects are **repurposed**; `/compliance/onboarding\|driver\|truck` stay redirects. | `/expenses` used to land on Fuel; bookmarks now land on the new page (Fuel is one click away and cross-linked). |
| **D-S4-7** | REDESIGN §7 items | **Excluded** — see §9 (none needs new data except "Miles per state", which needs per-state mileage the system does not store). | Ryne may want the Trucks/Assets layout rebuild as its own step. |
| **D-S4-8** | Receipt image preview | Only for e-mailed vendor invoices (`VendorPayable.attachments`); other receipts show data + an explicit "no image on file" state. | Fuel/driver-pay rows have no image anywhere. |
| **D-S4-9** | New page grants | `compliance` (new, added to the `COMPLIANCE` role), `platformHealth` (admin-only). Finance pages reuse `finances`. Approve/Reject is allowed to owner/ADMIN **or** `compliance` **or** `files` (exactly today's reach). Existing `COMPLIANCE`-role users get the new group only when their role is next saved (the Lambda reconciles groups on `setRole`). | Grant model. |

### 0.3 Schema and deploy impact — stated plainly

* **Schema changes: none.** No new model, no new field, no new index. (`TmsSettings.monthlyRevenueTargetCents` and the `CarrierDocument` review fields are *offered* in D-S4-1/-3 and **not** built.) Therefore **no AppSync/DynamoDB data deploy and no `copy-data`**: the single Amplify job ships frontend + three additive Lambda/IAM changes.
* **Backend (additive, all in `amplify/backend.ts`, applied by slice K as one pass):** **B1** `driverSignupGate`: `dynamodb:PutItem` on the `AuditLog` table + env `AUDIT_LOG_TABLE_NAME` (D-S4-2). **B2** `userManagement`: `cognito-idp:ListUsers` on the driver pool ARN + env `DRIVER_USER_POOL_ID` (new read-only `listDriverPool` action). **B3** `mcpSync`: env `INTEGRATION_TABLE_NAME` + `dynamodb:UpdateItem` on the `Integration` table (heartbeat).
* **Build:** `vite.config.ts` `define` for build info (§3.5). **No new dependency** (recharts, lucide, date-fns already present).
* The deploy is the usual `git push origin dev` → wait for the Amplify job → `devVerifyS4` against the deployed URL (§7).

### 0.4 Slice map (6 feature slices + kit/registries + harness; file ownership is disjoint, §6)

| Slice | Owns | Size |
|---|---|---|
| **K** Kit + shared registries | `TmsGauge`, `TmsPillBarChart`, `TmsPeriodToggle`, `TmsDocumentFrame`, `TmsKpiCard`/`TmsChartCard` additions, `kit/index.ts`; `navItems.ts`, `navSections.ts`, `roles.ts`, `App.tsx`, `vite.config.ts`, `amplify/backend.ts` (B1–B3) | S–M |
| **C** Compliance → Document overview (feature 1) | `src/features/compliance/overview/**`, `lib/complianceOverview.ts`, `useReviewQueue.ts` (return value), `mcp-sync` heartbeat | M |
| **U** User management (feature 2) | `src/features/users/overview/**`, `UsersPage.tsx` (one mount), `lib/registrations*.ts`, `driver-signup-gate`, `userManagement` (`listDriverPool`) | M |
| **F** Financial operations (feature 3) | `src/features/financial-ops/**`, `lib/financeOps.ts`, `lib/paymentsClient.ts` | M |
| **X** Expenses (feature 4) | `src/features/expenses/overview/**`, `lib/expenseOverview.ts` | M |
| **H** Platform health (feature 5) | `src/features/platform-health/**`, `lib/platformHealth.ts`, `lib/buildInfo.ts` | S–M |
| **N** Notifications (feature 6) | `src/features/tms/notifications/**`, `TmsShell.tsx`, `TmsLayout.tsx` | M |
| **V** Verification harness (wave 2) | `scripts/lib/uiWalk.mjs`, `scripts/devVerifyS3.mjs`, `scripts/devVerifyS4.mjs`, `scripts/lib/s4Routes.mjs` | M |

---------------------------------------------------------------------------------------------------

## 1. Recon — what already exists, per feature (the "read EXISTING data first" ledger)

| Feature | Existing data / code reused (path) | What is genuinely new |
|---|---|---|
| **1 Documents** | `ComplianceDocument` (DRIVER/TRUCK; `status` PENDING_REVIEW·VALID·EXPIRING_SOON·EXPIRED·REJECTED·MISSING·WAIVED; `expirationDate`, `verifiedBy/At`, `rejectionReason`, `uploadedBy` DRIVER_PORTAL·INTERNAL) via the shared store `complianceDocStore` / `useAllComplianceDocuments` (`indexLatest` = "current doc" rule); state rules `fileHub.slotState/truckSlotState/driverExpiry`; `approveDocument/rejectDocument/maybeCompleteOnboarding` (`lib/documentReview.ts`); queue `useReviewQueue` (60 s poll, already mounted by the shell badge); `CarrierDocument` (`listCarrierDocuments`, `getCarrierDocumentUrl`); `Carrier.insurancePolicies[].expiresAt` (+ `insuranceState`), `authorityExpiresAt`, `mcpStatus/mcpRiskScore` (`mcpPacketStanding`); preview logic in `files/DocumentPreviewModal`; private-doc rule `visibleDocs(docs, isAdmin)`. | One page, one pure row builder, the `TmsDocumentFrame` kit piece, an MCP heartbeat. |
| **2 Users** | `manageUsers` Lambda (`list` joins Cognito ⋈ `UserProfile`: role, status PENDING·ACTIVE·INACTIVE, teams, claims; `reinvite`); `UsersPage` cards; `ROLES/ROLE_LABELS/ROLE_DESCRIPTIONS/ROLE_PAGES` (`lib/roles.ts`); `DriverApplication` SUBMITTED + `useReviewQueue.approveApplication/rejectApplication`; `DriverApplicationView({driverId})`; `Driver.active/onboardingStatus/email`; `AuditLog` (`createAuditLog` allowed to any signed-in user). | Gate refusal log (F1), `listDriverPool` read action, overview components. |
| **3 Finance** | `useBrokerageDashboard(filters)` → `DashboardData` (shipments, orders, `LaneRateSample` revenue/profit/division, open invoices/bills, divisions); `buildBusinessStrips` (revenue/profit/margin/AR/AP **per top-level division**), `buildCompanyTotals`, `applyFilters`, `sampleRow`, `pricedSamples`; `ArPayment` (kind PAYMENT·CREDIT_MEMO·WRITE_OFF·REVERSAL; `receivedAt`, `method`, `unappliedCents`), `ApPayment` (PAYMENT·CREDIT_MEMO·REVERSAL; `paidAt`, `pdfKey`, `remittanceSentAt`); `loadReportBundle`/`reportsClient` month cache; CSV pattern (`saveBlob` in `ReportsPage`). | Weekly-by-division bucketing, payments reader, target rule, page. |
| **4 Expenses** | `useFleetProfitability(range, group)` → `rollup{fuel,insurance,loan,otherExpenses,driverCost,net}` + `computeForRange` (prev-period deltas) + `fuelTxs`; `TimeClockEntry` + `listTimeClockEntries` + `lib/timeClock` (`summarizeWeek`, `payPeriodStartOf`, `decimalHours`); `MaintenanceInvoice` (store `maintenanceInvoices`; `status` PENDING·POSTED·ARCHIVED, `paymentDate`, `amount` cents); `VendorPayable` (`status` NEED_TO_PAY·DONE, `sourceInvoiceId`, `attachments`) + `useVendorPayables().getAttachmentUrl`; `FuelTransaction`; `DriverPayDeduction/Credit`. FuelPage already owns range/prev-range helpers (`getRange/getPrevRange`). | Period toggle, hours bars, receipt union + modal, page. |
| **5 Health** | `useIntegrations` (admin; 5-min poll) → `Integration` rows (`status, health, healthReason, lastCheckAt, lastOkAt, lastWebhookAt, lastStubAt, mode`); `badgeOf`, `modeLabelOf`, `PROVIDERS` registry, `routeForProvider`; `useWorkflowExceptions` (sparse `exceptionOpen` index); `useAppUpdate` (bundle fingerprint); `TruckLocation.updatedAt`, `FactoringItem.otrStatusSyncedAt`. | Build info, heartbeat consumer, freshness grading, page. |
| **6 Bell** | `TmsShell` bell (`notificationCount` → Link), `TmsLayout` (`useCheckCallWorklist().dueCount`), `ShipmentListRow` (`creditHold`, `legDocsMissing`, `cargoInsuranceExpiresAt`, `status`), `useCheckCallWorklist.rows[].state`, `useDocumentReviewQueue`, `useAllComplianceDocuments`, `collectExceptions`, `TmsDrawer`, `TmsSegmentedTabs`, `TmsCountBadge`. | Derivation lib, hook, drawer. |

---------------------------------------------------------------------------------------------------

## 2. Shared kit additions (slice K) — contracts every feature slice codes against

All new files in `src/features/tms/kit/`, classes under `.tms-shell/.tms-portal`, **tokens only** (S3 T1: no colour literal), exported from `kit/index.ts`, rules in `kit/kit.css`, kit files import each other **directly, never the barrel**. A slice that needs a change in a kit file sends `hub` to K. Names and signatures below are final; K publishes stubs of the exports first (types compile), real bodies second.

```ts
// kit/TmsPeriodToggle.tsx — the D / W / M chips (reference "user-overview stat cards")
export type TmsPeriod = 'D' | 'W' | 'M'
export interface TmsPeriodToggleProps {
  value: TmsPeriod
  onChange: (next: TmsPeriod) => void
  options?: readonly TmsPeriod[]            // default ['D','W','M']
  'aria-label'?: string                     // default 'Period'
}
export function TmsPeriodToggle(p: TmsPeriodToggleProps): JSX.Element
// <div role="group" class="tms-period-toggle"> one <button aria-pressed> per option; Left/Right arrows move selection.

// kit/TmsKpiCard.tsx — EXTEND (existing props unchanged)
//   period?: Pick<TmsPeriodToggleProps, 'value' | 'onChange' | 'options'>   // renders the toggle top-right of the card
// kit/TmsStatRow.tsx: TmsStat gains the same optional `period` (passes through) — K edits TmsStatRow.tsx too.

// kit/TmsGauge.tsx — arc of ticks, green filled share, big number inside (reference §3 "Gauge")
export interface TmsGaugeProps {
  value: number | null                      // 0..1; clamped; null = empty arc and centre "—"
  label: string                             // centre text, preformatted ("$412k")
  sub?: string                              // muted line under it ("of $500k · 3-month average")
  ticks?: number                            // default 36; the arc spans 240°
  tone?: 'default' | 'good' | 'warn' | 'bad' // filled ticks: default = --tms-chart-1; others = --tms-badge-*
  size?: number                             // px, default 220
  ariaLabel: string                         // role="img"
  className?: string
}
export function TmsGauge(p: TmsGaugeProps): JSX.Element
// Filled tick count = Math.round(clamp(value,0,1) * ticks); unfilled ticks use --tms-border. The number may exceed 100% in `label` while the arc caps full.

// kit/TmsPillBarChart.tsx — weekly stacked rounded "pill" bars + dark tooltip (reference §3 "PillBarChart")
export interface PillBarSeries { key: string; label: string }          // colour = --tms-chart-{index+1}
export interface PillBarDatum  { label: string; values: Record<string, number> }
export interface TmsPillBarChartProps {
  data: PillBarDatum[]                      // oldest → newest
  series: PillBarSeries[]
  format?: (value: number) => string        // tooltip, axis ticks and the sr-only table; default String
  height?: number                           // default 260
  highlightIndex?: number | null            // that bar full strength, the rest at reduced opacity
  ariaLabel: string
  emptyText?: string                        // when every value is 0 / data empty
  className?: string
}
export function TmsPillBarChart(p: TmsPillBarChartProps): JSX.Element
// recharts BarChart, one <Bar stackId> per series, custom `shape` rounds the TOP-most non-zero segment as a pill; tooltip = the existing `.tms-chart-tip` markup.
// ALWAYS renders a visually-hidden <table> (caption = ariaLabel; rows = data, columns = series, cells = format(value)) — the accessible fallback AND what tests read, because recharts' ResponsiveContainer measures 0×0 in jsdom [INFERENCE: matches how DashboardPage tests avoid asserting SVG geometry].

// kit/TmsChartCard.tsx — EXTEND: `action?: ReactNode` rendered right-aligned in the head (the card-level "Download" button).

// kit/TmsDocumentFrame.tsx — the framed page preview (DetailSplit left column). The inline body of files/DocumentPreviewModal, extracted.
export interface TmsDocumentFrameProps {
  url: string | null                        // null = loading
  fileKey: string | null                    // null/'' = "This item has no file attached."
  title: string
  error?: string | null
  height?: number | string                  // default 520
  onDownload?: () => void                   // renders a Download icon button in the frame corner when given
  className?: string
}
export function TmsDocumentFrame(p: TmsDocumentFrameProps): JSX.Element
// Same type rules as today's modal (isPdfKey → <iframe data-tms-paper>, isImageKey → <img data-tms-paper>, isUnembeddableKey (HEIC) → plain message, else "can't be previewed"); paper stays matte via --tms-paper.
// files/DocumentPreviewModal.tsx's body becomes <TmsDocumentFrame …/> (behaviour identical; K owns that file).
// Out of scope and said so: the reference's "‹ 1 of 12 ›" page nav and "100%" badge — an <iframe> PDF has no page API; the browser's own viewer provides it.
```

`kit/index.ts` gains exactly these export lines (K): `TmsPeriodToggle`/`TmsPeriod`/`TmsPeriodToggleProps`, `TmsGauge`/`TmsGaugeProps`, `TmsPillBarChart`/`PillBarSeries`/`PillBarDatum`/`TmsPillBarChartProps`, `TmsDocumentFrame`/`TmsDocumentFrameProps`.

**Reused unchanged (do not rebuild):** `TmsKpiCard`, `TmsStatRow` (columns 2–5), `TmsSegmentedBar` (revenue by division), `TmsApprovalCard`, `TmsDetailSplit` (`ratio '7/5'`), `TmsMetaList`, `TmsDrawer`/`TmsDialog`, `TmsSegmentedTabs`, `TmsListPage` (quickTabs + `banner` slot for the KPI strip), `TmsTable`, `TmsBadge`+`statusTone`, `TmsEmptyState`, `TmsAlert`, `TmsChartCard`, `TmsCountBadge`, `TmsScrollPage`, `useTmsTokens`.

---------------------------------------------------------------------------------------------------

## 3. The six features

Conventions for every page: `TmsScrollPage` (title = the h1, `actions` = right-hand buttons, green primary, approval pairs = `TmsApprovalCard`/`TmsButton` Approve green-outline + Reject red-outline), KPI strip = `TmsStatRow columns={4}`, no colour literal, `null`/unknown renders `—` (never `$0.00`/`0` for "no data"), a read that fails is **named** (`TmsAlert`), never an empty page. Money is integer cents formatted with `formatCents` from `@/lib/invoiceBuild` (the app's one formatter). Every component takes data from a hook/lib and does no arithmetic of its own (the `ReportsPage` rule).

### 3.1 Feature 1 — Compliance → Document overview

| | |
|---|---|
| **Route** | `/compliance` (legacy-path style, rendered by `TmsLayout`'s `fill` host like `/files`), deep link `/compliance?doc=<kind>:<id>` (`kind` = `cd` ComplianceDocument · `carrier` CarrierDocument · `policy` carrier insurance policy `<carrierId>:<policyId>` · `rec` record-date row `<entityType>:<entityId>:<docType>`) and `?tab=review\|expiring\|expired\|all`. `/compliance/review` redirects to `/compliance?tab=review`; `/compliance/onboarding\|driver/:id\|truck/:id` stay redirects to `/files`. |
| **Nav** | `NAV_ITEMS`: `{ to:'/compliance', label:'Compliance', icon: ShieldCheck, pageKey:'compliance', section:'COMPANY', badgeKey:'review' }` — placed after "Weekly Cash Check-in". `badgeKey 'review'` is already answered by `useShellBadgeCounts` (pending docs + submitted applications), so the rail badge is the review queue with no resolver change. Breadcrumb: `LEGACY_CRUMBS` `{ path:'/compliance', crumbs:[{label:'Compliance', to:'/compliance'},{label:'Document overview'}] }`. |
| **Guard** | `<RequirePage page={['compliance','files']}>` (either grant). |
| **Permissions** | View: the guard. **Approve / Reject:** owner/ADMIN, or `hasPageAccess('compliance')`, or `hasPageAccess('files')` — identical to today's reach in `EntityFilePanel` (no one gains or loses the ability). **Private documents** (`isPrivateDoc`: employment/lease agreements) are filtered with `visibleDocs(docs, isAdmin)` for everyone else — same rule as the Files hub. Carrier documents: never Approve/Reject (D-S4-3). |
| **Data** | (a) Driver/truck documents: `useAllComplianceDocuments()` → latest-per-slot (`indexLatest`, so a replaced document never double-counts), state via `slotState`/`truckSlotState`/`driverExpiry` — **the same functions the Files hub and the rail badge use**, so the three can never disagree. Names from `useAppStore` (`drivers`, `equipment`). (b) **Record-date rows** for fields with no document: `Driver.cdlExpiration`/`medCardExpiration`, `Equipment.dotInspectionDate` (so an expiring CDL with only a date still queues). (c) Carrier paperwork: `listCarrierDocuments()` (+ `useCarriers({kind:'all'})` for names) and **one row per `Carrier.insurancePolicies` entry** (`insuranceState(policy, now, warnDays)`; `warnDays` from `TmsSettings.insuranceWarnDays`, default 30), `authorityExpiresAt`, plus the carrier's MCP standing chip (`mcpPacketStanding`). (d) Review queue + actions: `useReviewQueue()` (documents PENDING_REVIEW). (e) Header sub-line "MyCarrierPackets last synced <age>" from the `MYCARRIERPACKETS` `Integration` row (`lastOkAt`) — **admin only** (the list action is owner/ADMIN); on dev the line reads "Scheduled sync is off on the dev stack". "Missing required documents" are **not** rows here (that is the Files hub readiness dots); the KPI sub-line links to `/files`. Shipment/carrier-upload review stays in `/tms/documents` (linked, not duplicated). |
| **Pure lib** | `src/lib/complianceOverview.ts`: `buildOverviewRows(input): OverviewRow[]` (`{ key, kind:'cd'\|'carrier'\|'policy'\|'rec', entityType:'DRIVER'\|'TRUCK'\|'CARRIER', entityId, entityName, docType, title, expiry:string\|null, daysLeft:number\|null, state:'PENDING_REVIEW'\|'VALID'\|'EXPIRING_SOON'\|'EXPIRED'\|'REJECTED'\|'WAIVED', source:'DRIVER_APP'\|'OFFICE'\|'CARRIER_UPLOAD'\|'MCP'\|'ENTERED', createdAt, verifiedBy, verifiedAt, rejectionReason, doc?: ComplianceDocument, carrierDoc?: CarrierDocumentRecord }`), `expiringQueue(rows, {windowDays=30})` (expired first, then soonest), `overviewCounts(rows)`. Date maths via the existing `daysUntil`/`EXPIRING_SOON_DAYS`; "today" is a parameter (no clock reads). |
| **Components** | `ComplianceOverviewPage` (`src/features/compliance/overview/`): `TmsListPage` with `quickTabs` All · Needs review · Expiring soon · Expired (counts), a second `TmsSegmentedTabs` for entity (All · Drivers · Trucks · Carriers), `search`, `banner` = KPI strip: **Documents on file** (sub "drivers n · trucks n · carriers n"), **Needs review** (tone `warn`), **Expiring ≤ 30 d** (tone `warn`), **Expired** (tone `bad`). Table columns: Entity (name + type `TmsBadge tone gray`), Document, Expiry (date + "in 12 d"/"3 d ago"), Source, Status (`TmsBadge`: PENDING_REVIEW→orange, VALID→green, EXPIRING_SOON→orange, EXPIRED/REJECTED→red, WAIVED→gray), trailing eye. Beside the table (≥1100 px) a **Expiring-soon queue** `TmsCard`: next 8 rows from `expiringQueue`, each a link that opens the detail; "View all" sets `?tab=expiring`. `DocumentDetail`: `TmsDrawer size="xl"` titled with the document, `headerExtra` = date added · title; `TmsDetailSplit ratio="7/5"` — primary = `TmsDocumentFrame` (URL via `getComplianceDocUrl(s3Key)` / `getCarrierDocumentUrl(s3Key)`), aside = `TmsMetaList` in hairline groups: **Folder** (entity name), **File type**, **Entity type** · **Date added**, **Expiry**, **Verification** ("Approved by x · date" / "Rejected: reason" / "Not verified") · **Uploaded by** (Driver app / Office), **Linked truck** (`driver.assignedTruckId` → unit), **Status** pill. Footer actions for a `PENDING_REVIEW` driver/truck document (and a permitted user): **Approve** (green outline) and **Reject** (red outline) → `RejectDialog` (`TmsDialog` + required `TmsTextarea`; button disabled until non-empty; replaces `window.prompt`). Carrier rows get "Open carrier" → `/tms/carriers/<id>` instead. File size is **not** shown (not stored; no HEAD request is made to invent it). |
| **Mutations** | Exactly `approveDocument(doc, email)` / `rejectDocument(doc, reason, email)` through `useReviewQueue().approveDocument/rejectDocument` (which also run `maybeCompleteOnboarding` and the audit row). `useReviewQueue.ts` (slice C) changes only its return: both now **resolve with the saved `ComplianceDocument`** so the page can `applyDoc(saved)` into the shared store (the row flips without a refetch). No behaviour change for `useShellBadgeCounts`. |
| **MCP heartbeat (backend)** | `mcp-sync/handler.ts` (slice C): after the scan loop, if `results.length > 0` and at least one `ok`, `UpdateItem` on the `Integration` row `id='MYCARRIERPACKETS'` setting `lastCheckAt = now`, `lastOkAt = now`, `healthDetail = 'Synced ok/total carriers'` (redacted counts only). If there are no credentials or zero carriers: **no write** (a no-op run must not look like a successful sync). Pure builder `heartbeatUpdate(results, now)` in `mcp-sync/heartbeat.ts` (tested). Table/IAM via B3. |

### 3.2 Feature 2 — User management (overview on the Users tab)

| | |
|---|---|
| **Route / nav** | No new route: the overview mounts at the top of `UsersPage` (`/tms/brokerage/users`, already `RequireAdmin`, My Brokerage tab "Users"; the COMPANY nav item "Users" `adminOnly` already points there). Slice U adds **one JSX line** to `UsersPage.tsx` (`<UserOverview users={users} onReinvite={…} />` above the cards list) and passes what it already holds. |
| **Permissions** | Owner/ADMIN only (the tab's guard). Application Approve/Reject, Dismiss and Resend invite are owner/ADMIN actions here. Role *changes* stay exactly where they are (the cards; owner-only ADMIN grant untouched). |
| **KPI strip (4)** | **Total users** = staff profiles (non-deleted) + active drivers. **Verified drivers** = active `Driver` rows whose driver-pool login is `CONFIRMED` with a verified e-mail (from `listDriverPool`; shows `—` with a note if the action is unavailable on an older deploy). **Active staff** = profiles `status === 'ACTIVE'`. **Pending registrations** = open items in the cards below (sub-line breaks down by source). |
| **New registrations (cards, horizontally scrolling `TmsApprovalCard`s)** | Four sources — none of them invented: **(1) Driver applications** — `DriverApplication.status==='SUBMITTED'` (`listApplicationsByStatus`): title driver name, subtitle submitted date, chip fleet/driver type, eye → `DriverApplicationView` in a `TmsDrawer`; **Approve** → `useReviewQueue().approveApplication(app)`, **Reject** → reason dialog → `rejectApplication(app, reason)` (existing implementations). **(2) Blocked sign-ups** (the gate, F1/D-S4-2) — `AuditLog` `DRIVER_SIGNUP` `refused` rows with no later `driver_signup_dismissed` for the same email: title the e-mail, subtitle "Tried to sign up <date> · not on the roster" (reason code → plain words), actions **Open roster** (`/files`) and **Dismiss** (writes one `AuditLog` `driver_signup_dismissed` row; nothing is deleted). `approveLabel/rejectLabel` carry those words. **(3) Awaiting verification** — driver-pool users in `UNCONFIRMED` (gate passed, e-mail not yet verified) matched to a `Driver` row: read-only card ("Awaiting e-mail verification since <date>"). **(4) Pending staff invites** — `UserProfile.status==='PENDING'` (Cognito `FORCE_CHANGE_PASSWORD`): read-only card with **Resend invite** (`reinvite` action already wired in the cards). Empty → `TmsEmptyState` "No registrations waiting." |
| **Roles table** | `TmsTable` over `ROLES` (`lib/roles`): Role chip (`ROLE_LABELS`), description (`ROLE_DESCRIPTIONS`), users in role, status pills (Active / Pending / Inactive counts, `STATUS_TONES` from the page), pages granted (`ROLE_PAGES[role].length`, ADMIN = "All"). Read-only; it is a lens over the profiles the page already loaded (no extra fetch). |
| **Pure lib** | `src/lib/registrations.ts`: `openSignupRefusals(entries, {limit=50})` (latest per e-mail; hidden when a dismissal is newer; newest first), `pendingRegistrationCounts(...)`, `roleRows(profiles)`, `refusalReasonText(code)`. `src/lib/registrationsClient.ts` (own local `gql`, the `complianceClient` pattern — **not** `apiClient.ts`): `listDriverSignupAudit()` (AppSync `listAuditLogs` with `filter:{ entityType:{ eq:'DRIVER_SIGNUP' } }`, paged by `nextToken` to exhaustion — a filter applies *after* the scan page, so a single page would miss rows), `dismissDriverSignup(email, by)`, `listDriverPoolUsers()` (`manageUsers` action `listDriverPool`). Read once on mount + on Refresh — **not** polled. |
| **Gate logging (backend)** | `driver-signup-gate/handler.ts`: every refusal path calls `recordRefusal(email, reasonCode)` **before** its `throw`. Reason codes: `NO_DRIVER_RECORD`, `DRIVER_INACTIVE`, `INELIGIBLE_PAY_GROUP`, `NO_EMAIL` (the last writes nothing). `recordRefusal`: `PutItem` `AuditLog` `{ id:'dsg:'+sha256(email).slice(0,20)+':'+YYYY-MM-DD, __typename:'AuditLog', entityType:'DRIVER_SIGNUP', entityId:email, action:'refused', user:'cognito-presignup', changes: JSON.stringify({ reason, at }), createdAt, updatedAt }` with `ConditionExpression attribute_not_exists(id)` (one row per e-mail per day — bounds an unauthenticated flood), wrapped so it **never throws and never waits more than 1.5 s** (`Promise.race`); the function then throws the **unchanged** `REJECTION_MESSAGE`. The success path writes nothing. Shape copies `userManagement.writeAudit` (same table, same fields). B1 grants `PutItem` only (no read/delete). |
| **`listDriverPool` (backend)** | `userManagement/handler.ts`: new `case 'listDriverPool'` — owner/ADMIN only (same gate as `list`); `ListUsersCommand` against `DRIVER_USER_POOL_ID` (paged), returns **only** `{ email, status, enabled, emailVerified, createdAt, lastModifiedAt }` — no attributes beyond that whitelist, no tokens. A missing env var returns `[]` with a reason string rather than throwing (older/partial deploys). |

### 3.3 Feature 3 — Financial operations

| | |
|---|---|
| **Route / nav** | `/financial-operations`; `NAV_ITEMS` `{ to:'/financial-operations', label:'Financial operations', icon: CircleDollarSign, pageKey:'finances', section:'COMPANY' }` placed **before** "Finances" (own-fleet P&L; the page header links to it: "Own-fleet profit → /finances"). Guard `RequirePage page="finances"`. |
| **Permissions** | Page grant `finances` (owner/ADMIN implicit). Read-only page: no mutation anywhere. |
| **Window** | `TmsSegmentedTabs`: **This month** (default) · **Last month** · **Last 3 months**. The hook loads one window from `min(selected.from, 8 weeks ago)` to today (the weekly chart needs 8 weeks regardless) and filters in memory with `applyFilters`; a second `useBrokerageDashboard` call for the previous equal-length window feeds the deltas (both are 5-minute-memoised per window). `failedMonths` non-empty → `TmsAlert` naming the months (the dashboard's honesty rule). |
| **KPI strip (4 cards)** | **Avg margin per shipment** = Σ profit ÷ priced-sample count (`$` value), sub "`18.4%` margin" — `—` when no priced sample (own-fleet loads carry revenue but no cost and are excluded from margin, with the `ownFleetNote` wording `ReportsPage` already uses). **Shipments completed** = shipments in the window at a delivered-or-later status, using the **same predicate** the dashboard's delivered series uses (`SHIPMENT_STATUS_LABELS`/`dashboardCharts`; the builder reads it, does not re-derive). **Pending payouts** = Σ `balanceCents` of `openBills` (`CarrierBill` TO_BE_PAID·PARTIAL; sub "n bills"), `positiveIsGood={false}`. **Refunds & credits** = Σ AR `CREDIT_MEMO` `amountCents` in the window, net of reversed rows (sub "write-offs $x"); `positiveIsGood={false}`. Deltas on the first, second and fourth against the previous window (`null` — no chip — when the previous value is 0/absent; never ∞). |
| **Revenue by division** | `TmsSegmentedBar` (segments = top-level divisions from `buildBusinessStrips`, value = `revenueCents`, plus an **Untagged** segment so the bar sums to company revenue — the same "dropped untagged shipment" trap `buildCompanyTotals` documents). Caption states the source: priced brokerage + own-fleet samples; **Best Care Auto Transport vehicle quotes are not shipments and are not in this figure.** |
| **Total revenue gauge** | `TmsGauge value = revenue ÷ target` (cap 1), `label` = revenue (`$412k`), `sub` "78% of $528k · 3-month average" (D-S4-1). Target = mean of the 3 **completed** calendar months' revenue before the window; `null` (gauge empty, sub "No prior months to compare") if fewer than 1 prior month has data. |
| **Weekly revenue trend** | `TmsChartCard` (icon, **action = Download** CSV of the series) containing `TmsPillBarChart`: 8 weeks, Monday-start in the Chicago day (`chicagoDateStr`), one series per top-level division (+ Untagged), values = revenue cents, `format` = compact dollars, `highlightIndex` = current week. |
| **Payment transactions** | `TmsListPage embedded`-style table in a `TmsCard`: AR receipts (`ArPayment` kind PAYMENT) and AP payments (`ApPayment` kind PAYMENT) in the window, newest first. Columns: Date, Type (AR receipt / AP payment, `TmsBadge`), Counterparty (customer / carrier name from `useDirectory`), Reference · method, Amount (AR `+` green, AP `−` red text token), Status pill (AR: Applied · Partly applied · Unapplied from `unappliedCents`; AP: Remitted when `remittanceSentAt` else Recorded; **Reversed** when `reversedByPaymentId`), trailing download icon **only** for AP rows with `pdfKey` (existing remittance getter; AR has no document). Card "Download" = CSV via `saveBlob`. |
| **Data layer** | `src/lib/financeOps.ts` (pure): `windowFor(period, todayChicago)`, `kpis(data, filters, prevData)`, `revenueByDivision`, `weeklyRevenueByDivision(data, filters, divisions, weeks=8)` (uses `sampleRow` + `topLevelOf`, the exact bucketing `buildBusinessStrips` uses; a week with no sales is present with zeros), `revenueTarget(monthlyRevenue, window)`, `paymentRows(ar, ap, names)`, `paymentsCsv(rows)`. `src/lib/paymentsClient.ts` (own `gql`): `listArPaymentsInWindow(from,to)` and `listApPaymentsInWindow(from,to)` — AppSync model lists (`listArPayments`/`listApPayments`) with `filter:{ receivedAt\|paidAt:{ between:[from,to] } }`, paged to exhaustion; neither model has an all-rows time index, so this is a filtered scan (sizes: low hundreds per month today **[INFERENCE — `scripts` count on dev settles it]**; if it grows, the fix is an additive `receivedMonth`/`paidMonth` index, noted in §8). Page hook `useFinancialOps(period)` composes the three reads. |

### 3.4 Feature 4 — Expenses (Ivan Cartage)

| | |
|---|---|
| **Route / nav** | `/expenses` (was a redirect to `/fuel`); `NAV_ITEMS` `{ to:'/expenses', label:'Expenses', icon: WalletCards, pageKey:'finances', section:'ASSETS' }` after "Fuel". Guard `RequirePage page="finances"` (it shows driver cost). The header has "Fuel imports & expense types → /fuel" (the manage view stays on Fuel). |
| **Permissions** | `finances` page grant; read-only (no mutations). |
| **Scope selector** | `TmsSegmentedTabs`: **Local** (default, `fleetGroup 'LOCAL'`) · **Box trucks** · **Amazon** — one `useFleetProfitability(range, group)` instance at a time (the hook re-assembles loads/fuel/expenses/mileage/pay; three at once would triple the reads). Owner-operators are excluded (they carry their own costs). |
| **Cards** | `TmsStatRow columns={3}`: **Total expenses** (`fuel + insurance + loan + otherExpenses + driverCost`), **Fuel** (`rollup.fuel`), **Salary (driver pay)** (`rollup.driverCost`, D-S4-4). Each carries the **D / W / M `TmsPeriodToggle`** (range = last day / last 7 days / month-to-date ending today; one shared state so the three move together) and a delta vs the previous equal range from `computeForRange(prevRange)` with `positiveIsGood={false}` (cost up = red). Delta chip omitted when the previous period is 0. |
| **Hours driven per driver** | `TmsChartCard` + a horizontal bar list (recharts `BarChart layout="vertical"`, bars `--tms-chart-1`, current pay period highlighted): per **Ivan employee driver** (`Driver.timeClock === true`, active) the sum of `rowMinutes` over the current 14-day pay period (`payPeriodStartOf/payPeriodDays`, `summarizeWeek`-style day sums — several rows a day are summed, never one span), label "Hours worked (time clock)". Source `listTimeClockEntries({from,to})`. Sorted desc; sr-only table like the pill chart. Motive HOS driving time is **not** mixed in (HoursPage keeps that cross-check). |
| **Receipts** | `TmsCard` "Recent receipts" (`TmsTable`, newest 25, search): union from `buildReceipts(...)` in `lib/expenseOverview.ts`: **Maintenance invoices** (`store.maintenanceInvoices`: vendor, amount cents, truck unit, `date`), **Fuel** (`fuelTxs` of the selected group: merchant `locationName`, amount dollars→cents, truck, driver), **Driver-pay charges** (`DriverPayDeduction` + `DriverPayCredit` DEBIT within the window). Status pill **only where the data carries it**: maintenance `paymentDate` set → **PAID** (green), else **PENDING** (amber); a linked `VendorPayable` overrides (`DONE`→PAID, `NEED_TO_PAY`→PENDING); fuel and driver-pay rows show a neutral gray "Card charge"/"Settlement" chip (no invented PAID). Click → `ReceiptDetailDialog`. |
| **Receipt detail modal** | `TmsDialog` (`tms-dialog-xl`): `TmsDetailSplit ratio="6/6"` — left `TmsDocumentFrame` of the first attachment of the linked `VendorPayable` (`attachments[0].key` → `useVendorPayables().getAttachmentUrl`), and **when none exists** the frame's explicit message "No image on file for this receipt" (D-S4-8); right `TmsMetaList`: Driver, Date, Truck, Category, **Amount** (red `--tms-badge-red` text), Status pill, Location (city/state for fuel; vendor for maintenance). Maintenance↔payable link: `VendorPayable.sourceInvoiceId === invoice.id` (read once via the payables hook already used by Vendor AP). |
| **Pure lib** | `src/lib/expenseOverview.ts`: `periodRange(period, todayIso)`, `previousRange(range)`, `expenseCards(result, prevResult)`, `hoursPerDriver(entries, drivers, periodStart)`, `buildReceipts({invoices, fuel, deductions, credits, payables, trucks, drivers, range})`, `receiptStatus(receipt)`. |

### 3.5 Feature 5 — Platform health

| | |
|---|---|
| **Route / nav** | `/platform-health`; `NAV_ITEMS` `{ to:'/platform-health', label:'Platform health', icon: Activity, pageKey:'platformHealth', section:'COMPANY', adminOnly:true }` before "Users" (`adminOnly` ⇒ not in `PERMISSION_PAGES`, same as Users). Guard `<RequireAdmin>` (owner/ADMIN; it lists integrations, which `LIST_INTEGRATIONS` refuses to anyone else). |
| **Permissions** | Owner/ADMIN. The only action is per-row **Re-check** = the existing `validateIntegration` call (owner/ADMIN today, performs the provider's live credential check). `devVerifyS4` never presses it (external effect). |
| **KPI strip (4)** | **Integrations connected** "n of m" (applicable providers only: `badgeOf(...).label === 'Connected'` over `PROVIDERS` ∪ rows; `NOT_APPLICABLE` out of the denominator); **Needs attention** (INVALID_CREDENTIALS + UNABLE_TO_VERIFY **excluding** `NEUTERED_ON_DEV`, which is counted in its own sub-line "n neutered on dev" — a dev stack's deliberately dead secrets are not failures); **Open workflow errors** (`useWorkflowExceptions().runs.length`; links to `/tms/workflows?tab=errors`); **Deployed** (relative time of `BUILD.builtAt`, sub `job <id> · <sha7> · <branch>`). |
| **Sections** | (1) **Integrations** `TmsTable`: provider, category, mode (`modeLabelOf`), status badge (`badgeOf` — never a second opinion), last check, last OK, last webhook; row → `routeForProvider(provider)`; Re-check button per row. (2) **Workflow errors** card: open exception runs grouped by agent with the newest 5 (title, age) + "Open Errors tab" — it deliberately does *not* rebuild `ErrorsTab`'s six-source collector. (3) **Last sync times** `TmsTable` of jobs with an **honest timestamp**: MyCarrierPackets (`Integration MYCARRIERPACKETS.lastOkAt`, written by the B3 heartbeat), Motive truck locations (max `TruckLocation.updatedAt`), OTR factoring status (max `FactoringItem.otrStatusSyncedAt`), and each LIVE integration's `lastOkAt`/`lastWebhookAt`. Columns: source, last at, age, cadence, state (Fresh / Late / No data). Jobs with no timestamp anywhere (compliance scanner, fuel import) are listed as "No heartbeat recorded" rather than guessed. On the dev build (`BUILD.branch === 'dev'`) a `TmsAlert` says schedules are disabled there and Late renders as gray "Paused on dev". (4) **Deploy & version** card: commit (short + link-less text), Amplify job id, branch, built-at, the running bundle fingerprint, and "A newer build is available" from `useAppUpdate().available`. The backend Lambda version is not available to the browser and is not shown. |
| **Build info** | `vite.config.ts` (K): `define: { __BCAT_BUILD__: JSON.stringify({ commit, jobId, branch, builtAt }) }` with `commit = process.env.AWS_COMMIT_ID ?? git rev-parse HEAD (try/catch) ?? null`, `jobId = process.env.AWS_JOB_ID ?? null`, `branch = process.env.AWS_BRANCH ?? null`, `builtAt = new Date().toISOString()`; ambient `declare const __BCAT_BUILD__` in `src/vite-env.d.ts`. `src/lib/buildInfo.ts` (H) wraps it (`typeof __BCAT_BUILD__ === 'undefined'` ⇒ all null, so tests and Storybook-like contexts never throw). **[INFERENCE]** that Amplify exposes `AWS_COMMIT_ID`/`AWS_JOB_ID`/`AWS_BRANCH` to the frontend `npm run build` (Amplify's documented build env; the first deploy's card settles it; the git fallback covers `commit`, and `branch` has no fallback so the dev banner would be absent — H also treats `location.hostname` starting `dev.` as dev). |
| **Pure lib** | `src/lib/platformHealth.ts`: `summarizeIntegrations(rows, descriptors)`, `freshness(latestIso, cadenceMin, nowMs, {devPaused})` → `'FRESH'\|'LATE'\|'NO_DATA'\|'PAUSED'` (late once age > 2× cadence), `syncRows(inputs)`. `now` is a parameter. |

### 3.6 Feature 6 — Notifications (bell + drawer)

| | |
|---|---|
| **Entry point** | The existing bell in `TmsShell`'s top bar. Today (`TmsShell.tsx` L631) it is a `<Link to="/tms/check-calls">` with `notificationCount`. S4: it becomes a `<button aria-haspopup="dialog" aria-expanded aria-label="Notifications: N">` that opens the drawer; `TmsShellProps` gains `onOpenNotifications?: () => void` (the bell renders only when provided — every rendered control works, S1 D6). `notificationCount` keeps its meaning (the amber `TmsCountBadge`, 99+ cap). |
| **Owner of wiring** | Slice N edits `TmsShell.tsx` (bell block + prop + `TmsShell.test.tsx`) and `TmsLayout.tsx` (replaces `useCheckCallWorklist({enabled…}).dueCount` with `useNotifications()`, holds `open` state, renders `<NotificationsDrawer>` as a sibling of `<Outlet/>`, updates `TmsLayout.test.tsx`). Nobody else touches those two files in S4. |
| **Kinds (exceptions)** | One group each; count = Σ items the *user may see*. **(1) Check calls** — `useCheckCallWorklist().rows` where `state` is DUE (warn) or OVERDUE (critical); link `/tms/shipments/<shipmentId>?tab=tracking`; group link "Open worklist → /tms/check-calls". **(2) PODs missing** — `ShipmentListRow` delivered-or-later, not voided, `docsMissing`/`legDocsMissing` includes `'POD'` (the same predicate as `podMissing()` in `businessStrips.ts`; the builder imports or moves it to `lib/` so there is one); link `?tab=documents`. **(3) Documents expiring** — driver/truck documents `EXPIRING_SOON` or `EXPIRED` (from `complianceOverview.buildOverviewRows`, so the bell equals the Document overview's "Expiring + Expired" exactly) plus carrier insurance on carriers used by **open** shipments (`cargoInsuranceExpiresAt`/`liabilityInsuranceExpiresAt` already on the row); link `/compliance?doc=<key>` (carrier policy → `/tms/shipments/<id>?tab=carrier`). **(4) Credit holds** — customers with `creditHold === true` that have open (not delivered/voided) shipments, **one item per customer** ("ACME — on credit hold · 3 open shipments"); link `/tms/shipments?q=<customer name>` (the shell search deep link; a Customers deep link is **[INFERENCE]**-unavailable, builder checks `CustomersPage` first). **(5) Documents to review** — `useDocumentReviewQueue().documents` (carrier uploads), link `/tms/documents`; and driver/truck docs PENDING_REVIEW → `/compliance?tab=review` (one item "n documents waiting for review"). **(6) Workflow errors** — `useWorkflowExceptions().runs`, link `/tms/workflows?tab=errors`. |
| **Gating** | A group is computed only if the user could open its destination: (1)(2)(4) `loads`·`tms`·owner/admin; (3) `compliance`·`files`·owner/admin (carrier part: `carriers`); (5) `loads`/`compliance`/`files`; (6) `tms`·owner/admin. Gating is in `collectNotifications`'s `access` argument (testable), not in the hooks. |
| **Pure lib** | `src/features/tms/notifications/collectNotifications.ts`: `collectNotifications(input): NotificationGroup[]` with `NotificationItem { id, kind, severity:'critical'\|'warn'\|'info', title, detail, at:string\|null, to:string }`, `NotificationGroup { kind, label, total, items }` — items sorted critical → warn → info then oldest-first, **capped at 10 per group while `total` counts all** (the badge never under-counts). `useNotifications()` composes the existing hooks (no new fetch except `useWorkflowExceptions`, 60 s sparse) and returns `{ groups, count, loading }`. |
| **Drawer** | `NotificationsDrawer`: `TmsDrawer size="md"` titled "Notifications"; `TmsSegmentedTabs` (All + only the kinds that have items, with counts); rows = `Link` (icon by kind, severity dot using badge tokens, title, one-line detail, relative age) that closes the drawer on click; per-group footer link to the owning page when `total > items.length`; empty → `TmsEmptyState` "You're all caught up." |
| **Out of scope** | No new notification *delivery* (Slack/e-mail/webhook subscriptions live in `TmsSettings.notificationSubscriptions` and are untouched); no read/unread state (these are *conditions*, not events — they clear when the underlying record is fixed). The rail's own badges (Check calls, Documents…) are unchanged. |

---------------------------------------------------------------------------------------------------

## 4. Shared files that get a small addition — exactly what, and who owns each

Rule from S2/S3 kept: **every shared file has exactly one S4 owner**; other slices that need a change `hub`-message the owner. Page components are named and located **now** (named exports) so K can write the registries before the pages exist; Main runs typecheck once at the end.

| Shared file | Addition (exact) | Owner |
|---|---|---|
| `src/features/tms/kit/index.ts` | + `export { TmsPeriodToggle }` (+`TmsPeriod`, `TmsPeriodToggleProps`), `export { TmsGauge }` (+`TmsGaugeProps`), `export { TmsPillBarChart }` (+`PillBarSeries`, `PillBarDatum`, `TmsPillBarChartProps`), `export { TmsDocumentFrame }` (+`TmsDocumentFrameProps`) | **K** |
| `kit/TmsKpiCard.tsx`, `kit/TmsStatRow.tsx`, `kit/TmsChartCard.tsx`, `kit/kit.css` | optional `period` (KpiCard + StatRow `TmsStat`), optional `action` (ChartCard); `.tms-period-toggle`, `.tms-gauge*`, `.tms-pillbar*`, `.tms-docframe*` rules | **K** |
| `src/features/files/DocumentPreviewModal.tsx` | body → `<TmsDocumentFrame>` (behaviour identical) | **K** |
| `src/lib/navItems.ts` | 4 `NAV_ITEMS` rows: `Expenses` (after `/fuel`, `ASSETS`, `finances`), `Financial operations` (before `/finances`, `COMPANY`, `finances`), `Compliance` (after cash check-in, `COMPANY`, `compliance`, `badgeKey:'review'`), `Platform health` (before Users, `COMPANY`, `platformHealth`, `adminOnly:true`); + lucide imports `ShieldCheck, CircleDollarSign, WalletCards, Activity` | **K** |
| `src/lib/navSections.ts` (+`navSections.test.ts`) | 1 `LEGACY_CRUMBS` row for `/compliance` (§3.1). The other three new paths resolve through `ITEM_POOL` to their own label with no change. | **K** |
| `src/lib/roles.ts` (+`roles.test.ts`) | `ROLE_PAGES.COMPLIANCE` gains `'compliance'` | **K** |
| `src/App.tsx` | 4 imports (`ComplianceOverviewPage` ← `@/features/compliance/overview/ComplianceOverviewPage`; `FinancialOperationsPage` ← `@/features/financial-ops/FinancialOperationsPage`; `ExpensesOverviewPage` ← `@/features/expenses/overview/ExpensesOverviewPage`; `PlatformHealthPage` ← `@/features/platform-health/PlatformHealthPage`); routes `/compliance` (`RequirePage page={['compliance','files']}`), `/financial-operations` (`RequirePage page="finances"`), `/expenses` (`RequirePage page="finances"`), `/platform-health` (`RequireAdmin`); **replaces** the redirect lines for `/compliance` and `/expenses`; `/compliance/review` → `<Navigate to="/compliance?tab=review" replace />`; the "Retired" comment is rewritten to name only the three that remain redirects | **K** |
| `vite.config.ts` + new `src/buildInfo.d.ts` | `define.__BCAT_BUILD__` (§3.5); ambient `declare const __BCAT_BUILD__: { commit: string \| null; jobId: string \| null; branch: string \| null; builtAt: string }` (no `vite-env.d.ts` exists; `tsconfig.app.json` includes `src`) | **K** |
| `amplify/backend.ts` | **B1** after the signup-gate `addToRolePolicy` (L380): `PutItem` on `backend.data.resources.tables['AuditLog'].tableArn` + `addEnvironment('AUDIT_LOG_TABLE_NAME', …)`. **B2** in the `userManagement` policy block (L320–340): add `'cognito-idp:ListUsers'` resource `driverPool.userPoolArn` (the existing statement targets the staff pool ARN; this is a **separate statement**, staff grant unchanged) + `addEnvironment('DRIVER_USER_POOL_ID', driverPool.userPoolId)` — `driverPool` is declared at L203, above. **B3** beside `mcpSyncFn` (L2126–2147): `addEnvironment('INTEGRATION_TABLE_NAME', backend.data.resources.tables['Integration'].tableName)` + `UpdateItem` on its ARN. No other line moves. | **K** |
| `src/features/users/UsersPage.tsx` | import `UserOverview` + one JSX element above the cards list (props: the already-loaded `users`, `reinvite` handler) | **U** |
| `src/features/tms/TmsShell.tsx`, `TmsLayout.tsx`, `TmsShell.test.tsx`, `TmsLayout.test.tsx` | bell → button + `onOpenNotifications`; `useNotifications` + drawer mount (§3.6) | **N** |
| `src/hooks/useReviewQueue.ts` | `approveDocument`/`rejectDocument` return the saved document (§3.1) | **C** |
| `scripts/devVerifyS3.mjs` | delete `REDIRECTS` rows `/compliance`, `/compliance/review`, `/expenses`; `coveredPatterns()` also unions `S4_PATTERNS` from `scripts/lib/s4Routes.mjs`; helpers move to `uiWalk.mjs` (§7.1) | **V** |

**Files nobody in S4 touches:** `src/lib/apiClient.ts` (new domain clients are siblings: `registrationsClient.ts`, `paymentsClient.ts`, each with its own local `gql` — the `complianceClient.ts`/`cashCheckInClient.ts` precedent), `useShellBadgeCounts.ts`, `BrokeragePage.tsx`, `FilesPage.tsx`, `EntityFilePanel.tsx`, `FuelPage.tsx`, `ErrorsTab.tsx`, `src/types/*`, `amplify/data/resource.ts` (**no schema change**), `theme.css`/`shell.css`.

---------------------------------------------------------------------------------------------------

## 5. Cross-slice interface contracts (besides the kit in §2)

| # | Contract | Provider → consumers |
|---|---|---|
| **X1** | `complianceOverview.buildOverviewRows(input)` / `expiringQueue(rows,{windowDays})` / `overviewCounts(rows)` (signatures in §3.1). The bell's "Documents expiring" group calls **the same functions**, so bell count ≡ Document-overview Expiring+Expired. `input = { docs, drivers, equipment, carriers, carrierDocs, settings, canSeePrivate, todayIso }` (all already-loaded arrays; no fetch inside). | **C → N** |
| **X2** | `podMissing`-style predicate for "delivered, POD not on file" lives in one place. Today it is private in `tms/dashboard/businessStrips.ts`. C/F/N all need it: **F** (owner of `lib/financeOps.ts`) **creates `src/lib/podState.ts`** exporting `isPodMissing(shipmentStatus, docsMissing, sampleHasPod)` by moving the existing logic **verbatim** and pointing `businessStrips.ts` at it (a 3-line edit in a file nobody else touches in S4); **N** imports it. Until F lands N codes against the signature. | **F → N** |
| **X3** | `NotificationItem`/`NotificationGroup`/`collectNotifications` (§3.6). Only N + its tests. | **N** |
| **X4** | `Integration` row `MYCARRIERPACKETS` carries `lastCheckAt`/`lastOkAt` after a successful `mcp-sync` run (B3). C writes it, C reads it (header line), H reads it (Last sync times). Absence ⇒ "No data", never an error. | **C → H** |
| **X5** | `BUILD = readBuildInfo()` from `src/lib/buildInfo.ts` (`{commit, jobId, branch, builtAt, isDev}`); H owns it; nobody else reads `__BCAT_BUILD__` directly. | **H** |
| **X6** | `registrations.openSignupRefusals` entry shape = the `AuditLog` row (`entityType 'DRIVER_SIGNUP'`, `entityId` e-mail, `action 'refused'\|'driver_signup_dismissed'`, `changes` JSON string `{reason?, at?}`) — the gate writes it, U's client reads and writes it, V seeds it. Frozen here. | **U (gate + client) → V** |
| **X7** | `AuditLog.changes` is a **JSON string** on write and read (existing `createAuditLog` convention, `apiClient` L303) — U's client `JSON.stringify`s/`parse`s; V seeds with a string. | **U, V** |

---------------------------------------------------------------------------------------------------

## 6. Slices — non-overlapping file ownership

Every builder: the look rules of S2 §5 / S3 §5.3 (T1: **no colour literal in any `.ts/.tsx/.css` you own** — lint enforces; `var(--tms-*)`, semantic utilities, `TmsBadge tone`, `TmsAlert`), reuse before create, behavioural tests only, **no formatter/linter/project-wide test run** (Main runs them once), yield with the list of files touched, states not exercised, and any `[INFERENCE]` they settled. A test file belongs to the slice that owns its component.

### Slice K — Kit additions, shared registries, backend wiring, build info
**Owns:** `src/features/tms/kit/{TmsPeriodToggle,TmsGauge,TmsPillBarChart,TmsDocumentFrame}.tsx` (+`.test.tsx` each), `kit/{index.ts,TmsKpiCard.tsx,TmsKpiCard.test.tsx,TmsStatRow.tsx,TmsStatRow.test.tsx,TmsChartCard.tsx,kit.css}`; `src/features/files/DocumentPreviewModal.tsx`; `src/lib/{navItems,navSections,roles}.ts` + `navSections.test.ts`, `roles.test.ts`; `src/App.tsx`; `vite.config.ts`; `src/buildInfo.d.ts`; `amplify/backend.ts` (B1–B3 only).
**Order:** (1) publish type-only stubs of §2 exports + `index.ts` lines (everyone compiles against them) → (2) real components + tests → (3) registries/`App.tsx`/`backend.ts`/`vite.config.ts` in one pass → (4) `hub` "K done".
**Acceptance:** `kit/*` tests green; `navSections.test` asserts the four new items appear for ADMIN, `Platform health` is absent for a non-admin with every page grant, `Compliance` appears for a `COMPLIANCE`-role user and for a `files`-only user via the route guard (nav only for `compliance`); `/compliance` breadcrumb reads `Compliance › Document overview`.

### Slice C — Compliance → Document overview
**Owns:** `src/features/compliance/overview/{ComplianceOverviewPage,DocumentDetail,ExpiringQueue,RejectDialog,useComplianceOverview}.tsx|ts` (+tests); `src/lib/complianceOverview.ts` (+test); `src/hooks/useReviewQueue.ts`; `amplify/functions/mcp-sync/{handler.ts,heartbeat.ts,heartbeat.test.ts}`.
**Not owned (reuse as-is):** `lib/documentReview.ts`, `complianceDocStore.ts`, `fileHub.ts`, `files/*` (except K's one file), `carrierEligibility.ts`.
**Acceptance:** §3.1 in full; deep link `?doc=` opens the drawer; Approve/Reject exist only per §3.1 permissions; reject cannot submit an empty reason.

### Slice U — User management
**Owns:** `src/features/users/overview/{UserOverview,RegistrationCards,RolesTable,useRegistrations}.tsx|ts` (+tests); `UsersPage.tsx` (the one mount only); `src/lib/{registrations,registrationsClient}.ts` (+test); `amplify/functions/driver-signup-gate/{handler.ts,handler.test.ts}`; `amplify/functions/userManagement/{handler.ts,handler.test.ts}` (`listDriverPool` only).
**Acceptance:** §3.2; the gate's refusal message and success path are byte-identical to today (existing `handler.test.ts` cases still pass unchanged); `listDriverPool` refuses non-admin.

### Slice F — Financial operations
**Owns:** `src/features/financial-ops/{FinancialOperationsPage,PaymentsTable,useFinancialOps}.tsx|ts` (+tests); `src/lib/{financeOps,paymentsClient,podState}.ts` (+tests); the 3-line `businessStrips.ts` re-point (X2) and its existing test stays green.
**Acceptance:** §3.3; every figure comes from a lib; `failedMonths` surfaced; no mutation.

### Slice X — Expenses
**Owns:** `src/features/expenses/overview/{ExpensesOverviewPage,ReceiptDetailDialog,HoursBars,useReceipts}.tsx|ts` (+tests); `src/lib/expenseOverview.ts` (+test).
**Not owned:** the rest of `src/features/expenses/` (`ExpensesPage`, `ExpenseManageView`, `FuelUploadModal`), `FuelPage`, `useFleetProfitability` (consumed unchanged).
**Acceptance:** §3.4; D/W/M moves all three cards; PAID/PENDING only where data carries it.

### Slice H — Platform health
**Owns:** `src/features/platform-health/{PlatformHealthPage,IntegrationsPanel,SyncTable,DeployCard,usePlatformHealth}.tsx|ts` (+tests); `src/lib/{platformHealth,buildInfo}.ts` (+tests).
**Acceptance:** §3.5; `NEUTERED_ON_DEV` never counted as "needs attention"; dev banner when `isDev`.

### Slice N — Notifications
**Owns:** `src/features/tms/notifications/{collectNotifications,useNotifications,NotificationsDrawer}.ts(x)` (+tests); `src/features/tms/{TmsShell,TmsLayout}.tsx` + `TmsShell.test.tsx`, `TmsLayout.test.tsx`.
**Acceptance:** §3.6; bell is a working button; every item link resolves; count = Σ visible items; no new poll of a large table.

### Slice V — Verification harness (wave 2; starts when K's registries and any two pages exist; may overlap the rest)
**Owns:** **new** `scripts/lib/uiWalk.mjs`, `scripts/lib/s4Routes.mjs`, `scripts/devVerifyS4.mjs`; `scripts/devVerifyS3.mjs`. Details §7.

### 6.1 Non-overlap check (file → exactly one owner)
`kit/*` new+edited, `DocumentPreviewModal`, `navItems`, `navSections`, `roles`, `App.tsx`, `vite.config.ts`, `buildInfo.d.ts`, `backend.ts` → **K** · `compliance/overview/*`, `complianceOverview.ts`, `useReviewQueue.ts`, `mcp-sync/*` → **C** · `users/overview/*`, `UsersPage.tsx`, `registrations*.ts`, `driver-signup-gate/*`, `userManagement/*` → **U** · `financial-ops/*`, `financeOps.ts`, `paymentsClient.ts`, `podState.ts`, `businessStrips.ts` → **F** · `expenses/overview/*`, `expenseOverview.ts` → **X** · `platform-health/*`, `platformHealth.ts`, `buildInfo.ts` → **H** · `tms/notifications/*`, `TmsShell.tsx`, `TmsLayout.tsx` (+their tests) → **N** · `scripts/*` listed → **V**. No path appears twice; `backend.ts` is deliberately single-owner (K) even though B1/B2 serve U and B3 serves C, because one file can't take three concurrent editors.

---------------------------------------------------------------------------------------------------

## 7. Tests — behavioural only (each defends a plausible bug)

| Slice | File | Asserts |
|---|---|---|
| K | `TmsGauge.test.tsx` | filled ticks = `round(value·ticks)`; `value > 1` caps at full, `< 0` at none; `null` renders "—" and zero filled; `tone` changes the filled colour token without changing the count; `role="img"` carries `ariaLabel`. |
| K | `TmsPillBarChart.test.tsx` | sr-only table lists every datum in input order with `format`ted cells and one column per series; all-zero/empty data shows `emptyText`, not a blank chart; `highlightIndex` marks exactly one row. |
| K | `TmsPeriodToggle.test.tsx`, `TmsKpiCard.test.tsx`, `TmsStatRow.test.tsx` | exactly one option `aria-pressed`; click calls `onChange` with that option; arrow keys move; `period` on a KpiCard/StatRow tile renders the toggle and omitted `period` renders none (no regression of the 8 existing KpiCard cases). |
| K | `TmsDocumentFrame.test.tsx` | PDF key→iframe, image key→img, HEIC key→the plain "can't display" text, no key→"no file attached", `error`→message, `url null`→loading; `data-tms-paper` on the paper elements. |
| K | `navSections.test.ts`, `roles.test.ts` | the four items' visibility matrix (above); `COMPLIANCE` role includes `compliance`; every non-admin NAV_ITEMS `pageKey` is in `PERMISSION_PAGES`. |
| C | `complianceOverview.test.ts` | a replaced document counts once (latest wins); boundaries: expiry today → EXPIRING_SOON, yesterday → EXPIRED, +30 d inclusive → EXPIRING_SOON, +31 d → VALID, no expiry never expiring; private doc types absent for non-admin; carrier policy rows from `insurancePolicies` incl. one with no `expiresAt` (never expiring); `expiringQueue` puts expired before soonest; **state parity** — for the same docs `buildOverviewRows` states equal `fileHub.slotState`/`truckSlotState`. |
| C | `ComplianceOverviewPage.test.tsx` | Approve/Reject rendered only for a PENDING_REVIEW driver/truck doc **and** a permitted user (not for VALID, not for carrier rows, not for a user with neither grant); Reject disabled until the reason is non-blank and then calls `rejectDocument(doc, reason, email)`; Approve calls `approveDocument` once and the row's status flips; `?doc=` opens the drawer on that document; a failed carrier read shows a named `TmsAlert`, not an empty table. |
| C | `heartbeat.test.ts` | `heartbeatUpdate` returns null for zero results and for all-failed; counts `ok/total` into `healthDetail`; timestamps equal the passed `now`. |
| U | `registrations.test.ts` | refused + later dismissed → hidden; refused after a dismissal → shown again; one card per e-mail (latest); newest first; capped; `roleRows` counts equal profile counts and sum to total. |
| U | `driver-signup-gate/handler.test.ts` (extend) | each refusal path writes **exactly one** `AuditLog` item with the frozen shape and still throws the **identical** message; a failing/slow write (mock rejects / never resolves) still throws the identical message within the timeout; the success path writes nothing; no table env var ⇒ no write, same outcomes; same e-mail twice the same day ⇒ conditional-put conflict swallowed. |
| U | `userManagement/handler.test.ts` (extend) | `listDriverPool` refuses a non-admin; returns only the whitelisted fields; missing `DRIVER_USER_POOL_ID` returns `[]` + reason. |
| U | `RegistrationCards.test.tsx` | Approve application calls `approveApplication`; Reject needs a reason; Dismiss writes the dismissal and the card leaves; unconfirmed-user and pending-invite cards have no Approve/Reject; empty → empty state. |
| F | `financeOps.test.ts` | avg margin = profit ÷ priced count and `null` (not 0) with none; Untagged segment makes division revenue sum to company revenue; weekly buckets: 8 weeks, Monday start, empty week present with zeros, stack sums equal week total; target = mean of 3 completed months, `null` with no prior month; gauge value `null` ⇒ no chip; refunds = CREDIT_MEMO net of reversed only; `paymentRows` merges AR+AP newest first, AP negative, reversed flagged, `unappliedCents` → status; CSV quotes commas/quotes. |
| F | `FinancialOperationsPage.test.tsx` | `failedMonths` renders the naming alert; changing the period tab re-windows KPIs; no priced samples ⇒ KPI shows "—" not "$0.00". |
| X | `expenseOverview.test.ts` | total = Σ lines; delta `null` when the previous period is 0; `periodRange` D/W/M boundaries; `hoursPerDriver` sums several rows per day, excludes non-timeclock drivers, sorts desc; `receiptStatus`: `paymentDate`→PAID, none→PENDING, payable `DONE`→PAID, `NEED_TO_PAY`→PENDING, fuel/pay rows → no PAID/PENDING; receipts newest first; invoice↔payable join by `sourceInvoiceId`. |
| X | `ReceiptDetailDialog.test.tsx` | amount rendered with the red token class; PAID/PENDING pill matches; attachment ⇒ frame fetches `getAttachmentUrl(key)`; no attachment ⇒ "No image on file" text. |
| H | `platformHealth.test.ts` | `NOT_APPLICABLE` leaves the denominator; `NEUTERED_ON_DEV` is not "needs attention"; `freshness`: fresh ≤ 2× cadence, late beyond, `NO_DATA` for null (not Late), `PAUSED` when dev; `buildInfo` with `__BCAT_BUILD__` undefined returns nulls without throwing. |
| N | `collectNotifications.test.ts` | OVERDUE = critical, DUE = warn; POD item only for delivered+not voided+`POD` in docsMissing; credit-hold = one item per customer with its open-shipment count, none when all shipments are delivered/voided; docs group equals `buildOverviewRows` Expiring+Expired for the same input; **access gating drops groups** (a user without `loads` sees no check-call/POD/credit items); `total` counts items beyond the 10-item cap; ordering critical → warn → info. |
| N | `TmsShell.test.tsx` (retarget) / `NotificationsDrawer.test.tsx` | bell is a `button` named `Notifications: N` (and `Notifications` at 0); click calls `onOpenNotifications`; no handler ⇒ no bell; drawer tabs show only kinds with items; clicking an item navigates to its `to` and closes the drawer; zero items ⇒ "all caught up". |

Existing tests that change: `TmsShell.test.tsx` (bell was a Link to check-calls), `TmsLayout.test.tsx` (dueCount → `useNotifications` mock), `navSections.test.ts`, `roles.test.ts`, `driver-signup-gate/handler.test.ts` (extended, not loosened), `devVerifyS3`'s own `REDIRECTS` rows. Any existing test that only pins wording/structure of the replaced bell link is deleted, not re-pinned.

**Gates (Main, once, after K–N and V):** `npm run typecheck && npm run lint && npm run test` green; then the deploy.

---------------------------------------------------------------------------------------------------

## 8. devVerify plan — `scripts/devVerifyS4.mjs` (slice V)

Goal: one command proves, against the **deployed dev site** (and `npm run dev` on localhost before the push), that **each new page and the bell drawer render with no legacy token, no `NaN`/`Infinity`/`undefined` text, no console/network error, in light and dark**, that the **Approve/Reject (and Dismiss) mutations work end to end against temp seeded records only**, that the **real pre-sign-up gate now logs a refusal**, and that **every record it created is gone** afterwards.

### 8.1 Structure (extends the S2/S3 harness; no second CDP stack)
* **`scripts/lib/uiWalk.mjs`** (new; the extraction S3 §9.1 intended but did not ship — F7): `createWalk({ shots, allowProblems, hookClasses, skipAllowed, only })` returning `{ line, report, written, skipLine, problemList, audit, waitLoaded, waitBody, setTheme, shot, conclude, SHELL_FACTS, TOKEN_PROBE, EXTRA_BANNED, EXTRA_SURFACE }`. **Moved, not rewritten**: the bodies are `devVerifyS3.mjs` L172–335 verbatim (`extraAuditInPage` through `TOKEN_PROBE`), parameterised by the factory instead of module constants. `devVerifyS3.mjs` imports it with `shots = Docs/tms-build/screenshots/S3`. Proof of no regression: `node scripts/devVerifyS3.mjs --inventory` and a full S3 run **before and after** the move produce the same PASS lines.
* **`scripts/lib/s4Routes.mjs`**: `S4_ROUTES` (rendered table, same shape as S3 `ROUTES`: `{ nn, slug, path, pattern, wideOk?, fill? }`), `S4_PATTERNS` (normalised patterns for S3's completeness gate: `/compliance`, `/financial-operations`, `/expenses`, `/platform-health`), `S4_REDIRECTS` (`['/compliance/review', '/compliance/review', '/compliance']`).
* **`scripts/devVerifyS3.mjs`** edits (V): remove the three `REDIRECTS` rows that stop being redirects (`/compliance`, `/compliance/review`, `/expenses`); `coveredPatterns()` also unions `S4_PATTERNS` and the S4 redirect row — otherwise S3's own gate would fail on every new `App.tsx` route (F7). `devVerifyS2.mjs` exports are unchanged.
* **Refusals (dev only):** any AppSync URL but the dev one, any staff pool but `us-east-1_UKhMNVAG1`, any driver pool but `us-east-1_nnJzcFvTY`, any origin outside `ALLOWED_ORIGINS`; DynamoDB table names must carry the discovered dev suffix (the `devStack.mjs` `Load-<suffix>` discovery) and are refused if they contain the production suffix `5ucwdyvwivelbo4k4jomvrwel4-NONE`. Passwords/tokens never printed.

### 8.2 Identities and seeds (every name `zz-s4-…` + run stamp; everything is tracked and removed in `finally`)
| Kind | What | Used for |
|---|---|---|
| Staff | `zz-s4-admin-<ts>@example.invalid` groups `['ADMIN','page-tms']`; `zz-s4-comp-<ts>` groups `['page-compliance']`; `zz-s4-none-<ts>` groups `[]` (all via `mintIdentity`/`deleteIdentity`) | admin walk · permission checks · no-access |
| Driver rows | `ZZ S4 Driver` (active, e-mail, `fleetGroup 'LOCAL'`, `timeClock true`) and `ZZ S4 Applicant` (via `createDriver`) | documents, hours, application |
| Documents | 3–4 `ComplianceDocument`s for `ZZ S4 Driver` on **three distinct driver types read from `DRIVER_REQUIREMENTS` at run time** (so a catalog edit cannot break the script): **A** PENDING_REVIEW (to Approve), **B** PENDING_REVIEW (to Reject), **C** VALID with `expirationDate = today + 5 d` (expiring queue + bell), **E** PENDING_REVIEW (for the `page-compliance` identity). `s3Key` null — the frame's "no file attached" state is asserted; the file-rendering branches are unit-tested (K). | feature 1, 6 |
| Application | one `DriverApplication` `SUBMITTED` for `ZZ S4 Applicant` | feature 2 Approve |
| Gate rows | two `AuditLog` rows `{entityType:'DRIVER_SIGNUP', entityId:'zz-s4-blocked-a\|b-<ts>@example.invalid', action:'refused', changes:'{"reason":"NO_DRIVER_RECORD",…}'}` (X6/X7 shape) | Dismiss test |
| Hours | 2 `TimeClockEntry` rows for `ZZ S4 Driver` inside the current pay period (known minutes) | hours bars |
| Receipts | 2 `MaintenanceInvoice` (`vendor 'ZZ S4 Vendor'`, 12 345 ¢ unpaid and 6 789 ¢ with `paymentDate`; `equipmentId` = an existing truck id used only as a foreign key) | receipt modal PENDING / PAID |
| Image (optional) | tiny PNG put to the dev bucket `intake-pdfs/vendor-ap/zz-s4-<ts>.png` + a `VendorPayable` (`sourceInvoiceId` = invoice 1, `attachments:[{key,name}]`). If the machine's AWS credentials cannot write the dev bucket: **SKIPPED (allowed: no dev-bucket write)** and the image branch rests on the unit test | D-S4-8 |
| Real gate | Cognito `SignUp` on the dev **driver** client with `zz-s4-unknown-<ts>@example.invalid` → must fail with the roster message; poll the filtered `AuditLog` list ≤ 15 s for the refusal row; then `AdminGetUser` must say `UserNotFound` (a created user is deleted and the run FAILS) | proves F1/D-S4-2 on the real trigger |

### 8.3 The walk (viewport 1600×1000; light, then dark for the read-only audits; mutations run once, in light)
Every page: `navigate` → `waitLoaded` (no "Loading…") → `mark()` → `problemList` → `audit` (S2 `auditInPage` + S3 `extraAuditInPage`) → S3 shell facts (sidebar/topbar rects equal `/tms/dashboard`'s, one `aside.tms-sidebar`, no legacy nodes, no page overflow) → **S4 audit** (`s4AuditInPage`, serialised into the page): (1) no visible text in `.tms-main`/open drawer/dialog matching `\b(NaN|Infinity|undefined|\[object Object\])\b` and no bare `null`; (2) every `.tms-gauge svg` has width and height > 0 and ≥ 1 filled tick unless its `aria-label` says no data; (3) every `.tms-pillbar` sr-only table has as many body rows as its `data-points`; (4) every `.tms-docframe` paper element carries `data-tms-paper`.
| Id | Route / flow | Assertions beyond the audits |
|---|---|---|
| **S01** `/compliance` | list; `?tab=review`; open A (`?doc=cd:<id>`) | seeded A, B, E in Needs review; drawer shows Approve + Reject and the "no file attached" frame; **Approve A** → poll `getComplianceDocument(A)` = `VALID`, `verifiedBy` = admin e-mail, row badge flips without reload. **Reject B** → button disabled while the reason is empty → type `zz-s4 wrong page` → `REJECTED` and the stored `rejectionReason` equals the typed text. C is in the Expiring tab and the queue card ("in 5 d"). A fresh navigation to `/compliance?doc=cd:<C>` opens the drawer (deep link). |
| **S01p** permissions | as `zz-s4-comp` | `/compliance` renders and E shows Approve (D-S4-9); `/platform-health` and `/financial-operations` do **not** render their page (redirect/NoAccess). As `zz-s4-none`: `/compliance` does not render. |
| **S02** `/tms/brokerage/users` | overview | KPIs numeric; seeded application card → **Approve** → `DriverApplication.status = 'APPROVED'`; refusal rows a, b visible → **Dismiss a** → a `driver_signup_dismissed` row exists for a, card gone after reload, b remains; the **real-gate** refusal card appears after reload; roles table has `ROLES.length` rows and counts sum to the profile total. *Resend invite is never pressed* (it mails/invites). |
| **S03** `/financial-operations` | This month, Last month, Last 3 months | gauge/pill/payments present or their empty states; period tabs change the KPI `data-window`; CSV button enabled; no `$0.00` where the KPI is "no data". |
| **S04** `/expenses` | Local / Box trucks / Amazon; D→W→M | three cards share the toggle; seeded hours = expected (sum of the two seeded rows) in the bars' sr-table; receipt modal for invoice 1 shows **PENDING** and an amount whose computed `color` equals `--tms-badge-red`; invoice 2 shows **PAID**; image branch per 8.2; Esc closes. |
| **S05** `/platform-health` | admin | KPIs numeric; integrations rows ≥ registry providers; "Needs attention" equals the count recomputed from the same GraphQL list **excluding** `NEUTERED_ON_DEV`; dev banner present on the deployed dev site (on localhost, "local build" is the allowed alternative); **Re-check is never pressed** (external call). |
| **S06** bell | `/tms/dashboard` | bell is a `button` named `Notifications: N`; N = Σ drawer tab counts; seeded C appears under Documents expiring; click → URL `/compliance?doc=cd:<C>` with the drawer open; the first item of every non-empty group is visited (`to` resolves: not NoAccess, no console error); Esc closes. |
| **Phone** | 390×844 @2× | `/compliance`, `/expenses`, the bell drawer: audit + no horizontal overflow. |

### 8.4 Completeness gates (fail first)
(1) S3's `requiredLegacyPatterns` vs `coveredPatterns` (now including `S4_PATTERNS`) — a route added later without coverage fails. (2) Every `NAV_ITEMS` `to:` added by S4 has a `<Route path>` in `App.tsx` **and** an `S4_ROUTES` row. (3) `/compliance/review` lands on `/compliance`.

### 8.5 Cleanup (proof, not hope)
`finally`, reverse order: delete + **re-read** each seeded row by GraphQL (`VendorPayable`, `MaintenanceInvoice`, `TimeClockEntry`, `DriverApplication`, `ComplianceDocument`s, `Driver`s) and the S3 object; then **`AuditLog` residue** — the app's Approve/Reject/Dismiss and the gate write rows the client **cannot** delete (the model grants create/read only), so the script deletes, via the AWS SDK against the discovered dev `AuditLog-<suffix>` table, every row whose `entityId` is in the tracked seed-id/e-mail set **and** `createdAt ≥ run start`, then re-scans to prove zero. If AWS credentials are missing it prints `AuditLog residue: N rows (ids …) NOT deleted` and exits non-zero — residue is a failure, never a note. Last: delete + re-read the three staff identities, and assert the unknown driver-pool e-mail does not exist.

### 8.6 How it is used
Local before the push: `hub start` the Vite server on the same temporary dev-outputs alias recipe as S3 §9.4 (`/tmp/s2dev/amplify_outputs.json`; `jq .auth.user_pool_id` must print `us-east-1_UKhMNVAG1`; **never the checked-in production outputs**) → `DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyS4.mjs` until green (this also produces the screenshots). **The gate step (8.2 "Real gate") only passes after the deploy** — localhost talks to the dev backend, which has the *old* gate until B1 ships — so locally it is reported `SKIPPED (allowed: gate logging ships with the deploy)`. After the deploy: `DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyS4.mjs`, then `devVerifyS3.mjs`, `devVerifyS2.mjs` and `devVerifyP.mjs` (**48/48 must still pass**). Deploy gate: 0 failed, 0 skipped unless in the allow-list above (image upload; local gate step).

---------------------------------------------------------------------------------------------------

## 9. Screenshot plan

Output `Docs/tms-build/screenshots/S4/<id>-<slug>-<theme>.png` (+ `index.txt`), 1600×1000, `deviceScaleFactor` 1 (one 2× of the receipt modal), theme set by the real toggle once per pass, tall pages clipped to content (cap 2400 px). **L** light · **D** dark · **M** phone 390×844 @2×.
| id | Capture | L | D | M |
|---|---|:-:|:-:|:-:|
| S01 | `/compliance` all documents + expiring-soon queue + KPI strip | ✓ | ✓ | ✓ |
| S02 | `/compliance?tab=review` (seeded A/B/E) | ✓ | | |
| S03 | document drawer, pending, Approve/Reject visible (DetailSplit + MetaList) | ✓ | ✓ | |
| S04 | Reject dialog with reason typed | ✓ | | |
| S05 | Expiring tab (C "in 5 d") | ✓ | | |
| S06 | Users tab overview: KPIs + registration cards + roles table | ✓ | ✓ | |
| S07 | registration cards close-up (application · blocked sign-up · awaiting verification · pending invite) | ✓ | | |
| S08 | `/financial-operations` this month: KPIs, division bar, gauge, weekly pills, payments | ✓ | ✓ | |
| S09 | same, Last 3 months | ✓ | | |
| S10 | `/expenses` Local, D/W/M = M | ✓ | ✓ | ✓ |
| S11 | `/expenses` W selected (deltas) | ✓ | | |
| S12 | receipt modal PENDING (2×) and PAID/with image | ✓ | ✓ | |
| S13 | `/platform-health` incl. dev banner, integrations, last-sync, deploy card | ✓ | ✓ | |
| S14 | top bar with bell + amber count (clip) | ✓ | ✓ | |
| S15 | notifications drawer All; filtered to Documents expiring | ✓ | ✓ | ✓ |
| S16 | `/tms/brokerage/users` as a non-owner admin (permission sanity) | ✓ | | |

Ryne's review set: **S01, S03, S06, S08, S10, S12, S13, S15** (L + D).

---------------------------------------------------------------------------------------------------

## 10. REDESIGN §7 items — considered and why they are (not) in S4

Rule applied: include a §7 item **only if it needs new data and was not delivered in S2/S3**.
| §7 item | Needs new data? | Disposition |
|---|---|---|
| **Trucks page**: truck cards (photo, Active/Off-duty, miles/fuel/jobs), **Miles driven** monthly bars, Info card, four KPI tiles, Job history | **No.** `TruckMileage` (DAY rows → monthly sums), `TruckOdometerDay`, `TruckConfig`, `Equipment` (+ photo documents in `ComplianceDocument`), `MaintenanceTask/Invoice` (last maintenance), loads by assigned driver/truck all exist and are already read by `useFleetProfitability`/`TrucksPage` (S3 slice C re-tokened the page; it has the fleet `TmsStatRow` only). | **Excluded from S4** — a layout rebuild of `TrucksPage.tsx` (76 KB), not a feature. Offered as an optional follow-up "S4b" built on `TmsPillBarChart` (monthly miles, current month highlighted) and `TmsDetailSplit`; no schema or backend change. |
| **Overview drawer** (right-hand quick-look: image, cargo/pickup/drop-off grid, timer) | No | **Delivered** — `ShipmentDrawer` (S2, `TmsDrawer`) and the OfferQueue coverage cards. |
| **Dashboard, Assets view**: Fleet-efficiency donut, Vehicles on the road, Incoming-communications feed | No (Motive `TruckLocation`, `MaintenanceTask`, `DispatchConversation`, and this plan's `collectNotifications`) | **Excluded** — a dashboard variant, not new data. `collectNotifications` is written so the feed can reuse it later. |
| **Dashboard, Miles per state** choropleth | **Yes** — no per-state miles are stored (`TruckMileage` has none; `FuelTransaction.state` is where fuel was bought, not miles driven). Needs a Motive IFTA/state-miles feed or reverse-geocoding `TruckLocationHistory`. | **Not built; question for Ryne** — which source he wants. |
| Chat / Tracking-primary-order cues | — | **Delivered** in S2 slice C. |

---------------------------------------------------------------------------------------------------

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Gate logging runs on a public, unauthenticated trigger** and stores the e-mail of a non-roster person (flood, PII). | Deterministic id per e-mail per day + conditional put (≤ 1 row/e-mail/day); write is best-effort, `Promise.race` 1.5 s, never changes the thrown message; read is staff-only; `PutItem`-only grant; UI shows the latest 50. One switch (D-S4-2) removes the whole thing. |
| R2 | Cognito invokes PreSignUp with a hard timeout **[INFERENCE: 5 s]**; the gate already does two scans. | The write happens after the decision and costs ≤ 1.5 s worst case; if the first deploy shows timeouts, drop to fire-and-forget (the test already proves outcome independence). |
| R3 | **Dev data is frozen** (F2): the expiring queue, sync ages and compliance alerts reflect the last `copy-data`. | Queue is derived live from documents; health page says schedules are paused on dev; devVerify seeds its own expiring doc rather than relying on dev data. |
| R4 | Existing `COMPLIANCE`-role users do not hold the new `page-compliance` group until their role is re-saved. | Documented (D-S4-9); `files` holders still reach the route; owner re-saves roles once, or the lead runs the role reconcile. |
| R5 | `ArPayment`/`ApPayment` have no all-rows time index; the payments reader is a filtered scan. | Sizes checked on dev during build **[INFERENCE]**; if large, add additive `receivedMonth`/`paidMonth` indexes later (a schema change, deliberately not taken now). |
| R6 | Duplicate polling: `useReviewQueue` is mounted by the rail badge and the Compliance page; `useCheckCallWorklist` by `useShellBadgeCounts` and `useNotifications`. | Pre-existing pattern (60 s, visible-tab only); not worsened materially; lifting both into the shell is a clean follow-up, out of scope. |
| R7 | Bell number grows (all exceptions, not just check calls) and may startle. | D-S4-5; the drawer's tabs show the split; the rail's Check-calls badge is unchanged. |
| R8 | Old bookmarks: `/expenses` used to land on Fuel, `/compliance` on Files. | Header links to Fuel / Files hub; recorded in D-S4-6. |
| R9 | recharts measures 0×0 in jsdom, so SVG geometry cannot be unit-tested. | Tests read the sr-only table; geometry/colour is asserted by `devVerifyS4` in a real browser (audit (2),(3)). |
| R10 | Harness extraction touches the S3 gate itself. | Moved verbatim, S3 run before/after, `--inventory` flag. |
| R11 | `AWS_COMMIT_ID`/`AWS_JOB_ID`/`AWS_BRANCH` may not reach the Vite build **[INFERENCE]**. | git fallback for `commit`; hostname fallback for dev; the first deploy's card is the check; worst case the card says "unknown" honestly. |
| R12 | KPI definitions (Verified drivers, Shipments completed, Salary, Hours driven) are mine, not Ryne's. | Each card's sub-line states its definition (D-S4-4 etc.); changing one is a pure-lib edit. |
| R13 | `AuditLog` rows written by Approve/Reject/Dismiss cannot be deleted by the client. | 8.5: AWS-SDK cleanup with proof; non-zero exit on residue. |
| R14 | Approving an application updates the driver record and (in prod) e-mails; Reject e-mails the driver. | On dev SES is denied and `portalEmailsPaused` defaults to paused; the script only ever touches `zz-s4-` drivers; it refuses any non-dev endpoint. |
| R15 | Avg margin excludes own-fleet loads (revenue, no cost) and revenue excludes Best Care Auto Transport vehicle quotes. | Footnotes on the cards (`ownFleetNote` wording); same honesty rule as Reports. |
| R16 | Two similar names: "Finances" (own-fleet P&L) vs "Financial operations". | Cross-links in both headers; labels kept distinct. |
| R17 | `collectNotifications` runs over every shipment row each poll tick. | `useMemo` keyed on the inputs; O(n) with n ≈ board size; same order as `useShellBadgeCounts`. |

---------------------------------------------------------------------------------------------------

## 12. Delivery order and cleanup

1. **Main dispatches K, C, U, F, X, H, N in one batch** (one `tasks[]`, contracts §2/§5/§6 in the batch `context`). K publishes the type stubs first. **V** starts when K's registries and any two pages exist.
2. Main: `npm run typecheck && npm run lint && npm run test` once; fix-forward through the owning slice.
3. V runs `devVerifyS4` locally (alias outputs, §8.6); iterate; screenshots land in `Docs/tms-build/screenshots/S4/`.
4. Commit on `dev` (message: what + why, incl. "no schema change; backend: gate audit write, driver-pool list, mcp heartbeat; build define"); `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` must not be RUNNING/PENDING; `git push origin dev` once; wait for the job.
5. Post-deploy: `devVerifyS4` (incl. the real-gate step), `devVerifyS3`, `devVerifyS2`, `devVerifyP` (48/48). Append the S4 ledger to `BUILD_LOG.md` (Main). Send Ryne the review set and the nine decisions in §0.2.
6. **Cleanup after the proof:** delete the temporary dev-outputs alias config and `/tmp/s2dev`; no throwaway scripts or scratch notes committed; `screenshots/S4/` stays with the plan.

Nothing in S4 touches `main`, production tables/buckets/SSM, `amplify_outputs.json`, `invoice_*.json`, or any secret.
