# Step V — tracker assignee, the Tracking table by assignee, and tracking automation settings

Ryne's new requirements (dev only): **V1** tracking is a person's job (assignee on a shipment, default per customer); **V2** the Tracking page loses the Inbox/conversation UI and becomes the table of every shipment whose rate confirmation was sent, grouped by assignee; **V3** automation settings (auto e-mails and texts to request locations/check calls and the POD) in Settings, not in the Workflows builder. Builds on `S1`–`S4`, `RATECON-plan.md` and the Step D/P8/P9 tracking agent. **Everything stays on `dev`**: no `main`, no production tables/buckets/SSM, `invoice_*.json` untouched, one Amplify deploy at a time, `npm run typecheck && npm run lint && npm run test` green once (Main) before the single push, ideally the **same deploy as Step U** (`U-plan.md`; it was still partial — §0–§5 — when this plan was finalised; §4 holds the file-ownership contract agreed with UPlan2 by message and the reconciliation against what U had written). This document is recon + design only; nobody edits code until Main dispatches the slices in §5.

Evidence base (direct reads, not memory): `TrackingWorkstation.tsx` (521 lines), `tracking/{TrackingBoard,TrackingConversation,TrackingDetailPanel,InboxPanel,types,statusTimeline,…}.tsx`, `CustomerLinksPage.tsx`, `components/TrackingSection.tsx`, `shipmentViews.ts` (ShipmentRow, BOARD_COLUMNS), `hooks/useShipments.ts` (row projection), `lib/apiClient.ts` (field groups L1134–1290, L1735–1815, `trackingAction` L3131, wrappers L7278–7320), `lib/checkCallPlan.ts`, `lib/flowDefaults.ts`, `amplify/data/resource.ts` (Shipment L1495, Customer L853, LoadCarrier L1692, ShipmentMessage L2374, TmsSettings L1057, UserProfile L2791), `tms-shipment-actions/handler.ts` (createShipment L1727, setSalesRep L2990, assignCarrierRep L3037, assertRepProfile L793), `tms-tracking-actions/{handler,checkCallAgent,podReview,thread}.ts`, `shipment-notifier/handler.ts`, `shipment-email-intake/handler.ts`, `check-call-notifier/resource.ts`, `backend.ts` (L743–770, L3083–3110, L3255–3285, L3445–3480), `features/settings/{SettingsPage,TrackingSettingsCard,settingsKit}.tsx`, `features/tms/brokerage/BrokeragePage.tsx`, `features/directory/components/{FlowDefaultsCard,useCustomerForm}.ts*`, `scripts/{devVerifyS2,devVerifyP,devVerifyS4}.mjs`, `scripts/lib/{verifyTrackingUi,uiWalk,devIdentity}.mjs`, `Docs/TMS_BUILD_BRIEF.md`, `BUILD_LOG.md`, `S4-plan.md`. Items I could not read first-hand are marked **[INFERENCE]** and each has a named builder verification.

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F1** | **The "old Tracking-tab table" still exists and is most of V2.** `TrackingWorkstation` has two URL-owned tabs: Inbox (`?tab=inbox`) and Tracking (default). The Tracking tab is `tracking/TrackingBoard.tsx` (Chaine-style table, Active/Closed, Table/Map, favourites, recent chips, `BoardFilterPanel`). It already shows last location + age (`TrackingCell`), motion, next-stop miles + ETA (`NextStopCell`), carrier DOT/MC; it has **no** next-check-call, **no** POD state, **no** rate-con filter, **no** grouping, **no** assignee column. | `TrackingWorkstation.tsx` render (`tab==='tracking' ? <TrackingBoard/> : <InboxPanel/>`); `TrackingBoard.tsx` `COLUMNS` L48–59 | V2 = delete the Inbox, filter the table to "rate con sent", add the missing columns and the assignee grouping. No new route. |
| **F2** | **`CustomerLinksPage` is NOT inbox-only.** Reached by `TrackingBoard`'s "Manage links" button (`onManageLinks → navigate('/tms/tracking/links')`) and by the nav item "Manage Customer Links" (`navSections.ts:101`, breadcrumb L147–148); route `App.tsx:146`. Nothing in `InboxQuickActions/InboxInfoPanel/InboxChatHeader` links to it. | grep `tracking/links` | Keep untouched. Report to Ryne: **nothing is lost**. |
| **F3** | **No code outside `TrackingWorkstation` imports the Inbox panes**; the shipment-detail Tracking tab (`TrackingSection` → `TrackingDetailPanel`) imports only `TrackingDetailMap, googleMapsExtras, TrackingConversation (variant "detail"), checkCallPlanSource, DriverCard, statusTimeline`. So the thread, sending, Request POD, Run check-call, LogCheckCall, TrackingLinkDialog all survive **in the shipment**. | grep importers of `tracking/*` | Delete `InboxPanel, InboxChatHeader, InboxQuickActions, InboxInfoPanel, useInboxInfoOpen, LocationCard` (+ their two tests), strip the `variant="inbox"`/`header`/`quickActions`/`streamTail` branches from `TrackingConversation`, drop `TrackingMiniMap` (only Inbox used it). `DriverCard` keeps (its testid `inbox-driver-card` is a misnomer — rename). |
| **F4** | **Nothing deep-links to `?tab=inbox` except the test harnesses.** Notifications, ErrorsTab, CustomerLinksPage, DemoPage all link to `/tms/shipments/<id>?tab=tracking`. Inbox URLs appear only in `scripts/devVerifyS2.mjs` (L83, L481–492, L566–590, L754), `scripts/lib/verifyTrackingUi.mjs` (L37–62) and `TrackingWorkstation.test.tsx`. | grep `tab=inbox` | Old bookmarks `?tab=inbox&shipment=<id>` redirect to `/tms/shipments/<id>?tab=tracking` (one effect). |
| **F5** | **"Rate con sent" lives on `LoadCarrier`, already projected on the board row.** `LoadCarrier.rateConStatus` enum `NOT_SENT\|SENT\|OPENED\|SIGNED\|DECLINED\|VOIDED\|EXPIRED`, `rateConSentAt` (`resource.ts` ~1762–1790; written by `SEND_RATE_CON`, `BOOK_CARRIER` sets `NOT_SENT`, public `rate-con-sign-api` moves `SENT→OPENED→SIGNED`). `useShipments.ts` L710–712 projects the **active leg's** `rateConStatus/rateConSentAt/rateConSignedAt` onto `ShipmentRow`. | `shipmentViews.ts` L211–213 | "Sent" = `rateConStatus ∈ {SENT, OPENED, SIGNED}` on the active leg. No backend work for the filter. Aljex-imported rows are `NOT_SENT` and legacy loads carry only `rateConOnFile` → **excluded by default** (D-V2). Dev: only the demo seed (legs `SIGNED`) qualifies. |
| **F6** | **No tracker field exists anywhere.** grep `tracker/trackerId/trackingRep/trackingOwner` finds only comments and a `trackers` team key in a test mock. The nearest fields are `Shipment.carrierRepId/carrierTeamKey` (the *coverage* desk), `Customer.defaultCarrierRepId`, `Customer.defaultSalesRepId`. | grep | New optional fields (§2.1). Do **not** overload `carrierRepId` (it means "dispatcher assigned" on the board and gates `assertCarrierRepProfile` role = CARRIER_REP). |
| **F7** | **Customer defaults are copied at create time for only one rep field.** `createShipment` (`tms-shipment-actions/handler.ts` ~L1812) copies `customer.defaultSalesRepId` → `Shipment.salesRepId` + `Order.customerRepId`; `defaultCarrierTeamKey/defaultCarrierRepId` are **stored but never copied** (`Load.carrierRepId` hard-coded null ~L1928). Every shipment-creation path funnels through `createShipment` (UI `NewShipmentDialog`, workflow-proposal TENDER card, `FactoringPage`, demo seed) except `DUPLICATE_SHIPMENT` (L3305), `BACKFILL_SHIPMENT` (L6215) and the Aljex CSV import (`tms-aljex-import/import.ts:657`). | scout + reads | Tracker inheritance hooks `createShipment` beside `salesRepId`, `setShipmentCustomer` (~L3538, only if the shipment has none), `duplicateShipment` (copies source). U's intake "promote" action calls `createShipment` unchanged (UPlan2 confirmed), so tender-born shipments inherit for free. |
| **F8** | **The check-call "automation" exists but nothing ever runs it.** `RUN_CHECK_CALL_PLAN` (UI button only) and `SWEEP_CHECK_CALL_PLANS` (no client wrapper; only `devVerifyP.mjs:357` calls it) are implemented in `checkCallAgent.ts`; **no EventBridge rule, scheduler or Lambda invokes the sweep**. The only scheduled neighbour is `check-call-notifier` (`every 5m`, Slack DM to the carrier rep). Handler `authorize()` throws `Unauthorized: missing identity` without an AppSync identity. | `backend.ts` rules list; `handler.ts:329` | V3 needs a **scheduler** (new tiny Lambda `tracking-automation`, `schedule: 'every 5m'`) and a **system-caller path** (§3.7). |
| **F9** | **Probable latent bug: the e-mail reply intake cannot authorize.** `shipment-email-intake/handler.ts:235` invokes `tmsTrackingActions` with `identity: { sub: 'shipment-email-intake', email: 'system@bcatcorp.com' }` — no `claims`, no `username`. `getCallerEmail` (`handler.ts:305`) reads only `claims.email`, `identity.username`, `claims['cognito:username']`, then falls back to Cognito `AdminGetUser(Username=identity.sub)`, which cannot find `shipment-email-intake` → `''` → `Unauthorized: could not resolve caller email`. Result: inbound e-mail replies would 502 at the intake. **[INFERENCE — verified by reading, never exercised; dev has no inbound mail]**. | `handler.ts:305–346`, intake L222–245 | Directly threatens V3's "replies still thread". Slice B fixes it with the same explicit system-caller allow-list V3 needs (§3.7) and proves it with a unit test. |
| **F10** | **POD-on-delivery is requested by three uncoordinated paths today:** (1) `shipment-notifier` (Load stream, enabled on dev) mails the carrier an **upload link** per leg on `DELIVERED`, one per leg via `ShipmentNotice` id `pod:<loadCarrierId>`, gated by `TmsSettings.podRequestEnabled`; **not** in the shipment thread; (2) `checkCallAgent.requestPodForLoad` on the DELIVERED *milestone* tick when `plan.requestPodOnDelivery` (thread, but only if someone runs the plan); (3) `REQUEST_POD` (`podReview.requestPod`, manual and on rejected PODs; **no dedupe**, random message ids). | `shipment-notifier/handler.ts` L532–610; `checkCallAgent.ts` L329; `podReview.ts` L36 | V3(b) makes **one** automatic, idempotent, thread-recorded path (policy `podAuto`) and **removes** the plan flag `requestPodOnDelivery` (§2.3, D-V14). The notifier's link e-mail stays (D-V7). |
| **F11** | **Dev can already show "NOT_SENT with the exact message".** `thread.sendShipmentMessage` writes the row `NOT_SENT` *before* the provider is asked (claim), keeps the full signed body, and records `error` from the SES denial (`ses:SendEmail` AccessDenied via the dev guard `backend.ts:3479`) or `NOT_CONFIGURED` for Twilio (no SSM config on dev). `input.id` is honoured (`thread.ts:240`) → deterministic ids give idempotency. Every `defineFunction({schedule})` rule is created in the data stack and the dev guard (`backend.ts:3467–3468`) disables **every** `CfnRule`. | reads | Automation is exercised on dev through an explicit door `RUN_TRACKING_AUTOMATION` (§7), never via schedule. |
| **F12** | **Two settings editors for the same check-call plan already exist** (`TmsSettingsCard` L337 and `FlowDefaultsCard` L349 each carry a copy of the plan form including the `requestPodOnDelivery` toggle). | grep `requestPodOnDelivery` | Extract one `CheckCallPlanFields` component (slice E) and use it in all three places (org, division, customer). |

### 0.2 Decisions taken (defaults; Ryne can overrule any — full list in §11)

* **Tracker is a `UserProfile` id** (`Shipment.trackerId`, Cognito username, same convention as `salesRepId`); names resolved at read time (`nameOf`), never denormalized. **Any active user** may be a tracker (no new role, D-V1). Only shipments carry the assignee; **not mirrored onto Load** (deliberate difference from `carrierRepId`).
* **Customer default** `Customer.defaultTrackerId`, copied at create; changing it later does **not** rewrite open shipments (D-V3); per-shipment override anytime.
* **Tracking page** shows shipments whose active leg rate con is `SENT/OPENED/SIGNED` (D-V2), tabs **My loads · All · one per assignee · Unassigned**, default **My loads** when the signed-in user has ≥1 (else All), grouped sections under All. Lifecycle: **Active · POD due · Closed**. Client-side grouping; **no new GSI**.
* **Automation = two layers, one engine.** Cadence/channels/milestones/escalation stay in the existing `CheckCallPlan` (load → customer → **division (new)** → org → default). New **`AutomationPolicy`** (auto switches, POD channels, quiet hours, templates) layers customer → division → global with **field-level** merge. Master switches **default OFF** (D-V4).
* **Quiet hours** default 21:00–06:00 **America/Chicago** (`TZ` in `src/lib/date.ts`), applied to **SMS only**; automated sends inside the window are **deferred**, not dropped; manual actions ignore quiet hours (D-V5/D-V6).
* **POD**: one automatic ask per leg per channel, deterministic message ids, no reminders (D-V7). Milestone and escalation wording stay built-in (D-V8). Own-fleet legs excluded from automation (D-V9).
* **Where**: a "Tracking automation" card in **My Brokerage → Settings** (`SettingsPage`), with Defaults / Divisions / Customers sub-tabs; the **customer** editor is also mounted on the Customer profile. Nothing in the Workflows builder.
* **Single owner per shared file, U first then V** (§4).

### 0.3 Schema and deploy impact — stated plainly

* **Schema changes (all additive optional fields, no new model, no new index, no GSI):**
  * `Shipment.trackerId: a.string()`
  * `Customer.defaultTrackerId: a.string()`, `Customer.trackingAutomation: a.json()`
  * `TmsSettings.trackingAutomation: a.json()`
* **This forces an AppSync/DynamoDB data deploy** (the same single Amplify job that carries U's own additive fields: `OwnershipDivision.intakeEmail`, model `IntakeLoad`, `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt`, `WorkflowRun.toAddresses`). No `copy-data`, no backfill: absent = unassigned / inherit. Frontend carries the repo's field-group self-heal (`SHIPMENT_TRACKER_FIELDS`/`CUSTOMER_V6_FIELDS`/`TMS_SETTINGS_V15_FIELDS` + retry flags) per convention, so a pre-deploy backend degrades instead of emptying the board.
* **New infra (backend.ts, additive):** one scheduled Lambda `tracking-automation` (`schedule: 'every 5m'`) + `lambda:InvokeFunction` on `tmsTrackingActions` + env var; `tmsTrackingActions` gains `dynamodb:GetItem` on `UserProfile` (+ env `USER_PROFILE_TABLE_NAME`) and `dynamodb:Query` on `Shipment/index/*` if not already granted **[builder verifies the existing grant at `backend.ts` ~2519–2620]**. No new secret, no new SES/Twilio permission. On dev every rule is `DISABLED` by the existing guard (F11) — see §9 for the dev door.
* **Dependencies:** none added.

### 0.4 Slice map (6 builders; file ownership disjoint, §5; shared files with U in §4)

| Slice | Owns | Size |
|---|---|---|
| **A** Assignee backend + schema + wire types | `amplify/data/resource.ts` (V hunks), `tms-shipment-actions/{handler.ts (V hunks),demo.ts}`, `tms-directory-actions/handler.ts`, `src/types/tms.ts`, `src/lib/apiClient.ts` (all V hunks), `shipmentViews.ts` + `hooks/useShipments.ts` (row fields + "Tracker" column) | M |
| **B** Automation engine | `src/lib/{trackingAutomation,checkCallPlan,flowDefaults}.ts`, `tracking/checkCallPlanSource.ts`, `tms-tracking-actions/{automation,checkCallAgent,podReview,thread,handler}.ts`, `functions/tracking-automation/**`, `shipment-email-intake/handler.ts`, `backend.ts` (V hunks) | L |
| **C** Tracking page (delete Inbox, table by assignee) | `TrackingWorkstation.tsx(+test)`, `tracking/**` (rest), `styles/tracking.css` | L |
| **D** Assignee UI (shipment + customer) | `components/TrackerPicker.tsx`, `shipments/components/TrackerCard.tsx`, `ShipmentDetail.tsx` (one mount), `directory/components/{FlowDefaultsCard,useCustomerForm}.ts*`, `CustomerProfile.tsx`, `RepPicker.tsx` (only if needed) | M |
| **E** Settings → Tracking automation | `features/settings/{TrackingAutomationCard,automation/**,TmsSettingsCard,SettingsPage}.tsx` + tests | L |
| **F** Verification wave 2 | `scripts/devVerifyV.mjs`, `scripts/devVerifyS2.mjs` (tracking rows), `scripts/devVerifyP.mjs` (1 line), `scripts/lib/verifyTrackingUi.mjs`, screenshots | M |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (what exists, what survives, what dies)

### 1.1 Tracking front end

| File (`src/features/shipments/workstations/…`) | Today | After V |
|---|---|---|
| `TrackingWorkstation.tsx` (521 ln) | Tabs Inbox/Tracking (`?tab=inbox`, `?shipment=`), inbox message reads (`MESSAGE_READS=6`, `mapLimit`), conversation bundle, `handleSendMessage`, `openTrackingLinkDialog`, `useInboxInfoOpen`, saved board views (`useShipmentViews`, `viewsVisibleTo`), `CreateShipmentDialog`, `CustomerLinkDialog` | **Rewritten** (~200 ln): no tabs, no message state, no `TrackingLinkDialog`, no saved views (the assignee tabs replace them; U removes the Shipment-views surfaces — UPlan2 confirmed the Tracking workstation keeps its `useShipmentViews` import until V rewrites it, so V drops it). Keeps `useBoardFilters` + `BoardFilterPanel` (post-U signature), Active/POD-due/Closed, favourites, recents, Create Shipment, Customer URL, Manage links. Adds `?assignee=` URL param and the legacy `?shipment=` redirect. |
| `tracking/TrackingBoard.tsx` (594 ln) | The table (`COLUMNS`: shipment, origin, destination, status, tracking, motion, nextStop, team, carrier, actions) | **Reworked** (columns §2.2); `TeamCell`/`team` column replaced by Tracker; `ViewsDropdown` + "Save view" removed; `RowMenu` gains Request check call / Request POD / Assign tracker. |
| `tracking/InboxPanel, InboxChatHeader, InboxQuickActions(+test), InboxInfoPanel(+test), useInboxInfoOpen, LocationCard` | Inbox-only (importer: `TrackingWorkstation`) | **Deleted.** |
| `tracking/TrackingConversation.tsx` | Powers detail **and** inbox variant | Keep; remove `variant`, `header`, `quickActions`, `streamTail` props and the `inbox-conversation`/`inbox-composer` testids (rootTestId always `tracking-thread`, composer `thread-composer`). |
| `tracking/TrackingDetailPanel.tsx`, `TrackingDetailMap.tsx`, `googleMapsExtras.ts`, `DriverCard.tsx`, `statusTimeline.ts`, `checkCallPlanSource.ts`, `nextEventText.ts`, `useTrackingFavorites.ts`, `useRecentlyViewed.ts` | Shared with shipment detail or the table | Keep. `TrackingMiniMap` (in `TrackingDetailMap.tsx`) deleted (Inbox-only). `statusTimeline.isFreshPing` loses its only caller (`InboxChatHeader`) — delete it and its test case. `DriverCard` testid `inbox-driver-card` → `driver-card`. `TrackingDetailPanel` header gains the tracker chip (reads `TrackerPicker`, D's component). |
| `tracking/types.ts` | `TrackingBoardProps`, `InboxPanelProps` | Delete `InboxPanelProps` and its imports; extend `TrackingBoardProps` (§3.5). |
| `CustomerLinksPage.tsx` | Standalone page `/tms/tracking/links` | **Unchanged.** |
| `components/TrackingSection.tsx` → `TrackingDetailPanel` | Shipment Tracking tab (thread, cadence card, Request POD, Run check-call, LogCheckCall, TrackingLinkDialog) | Unchanged except the tracker chip. Every Inbox quick action has a home here already. |
| CSS `src/features/tms/styles/tracking.css` | `.tms-inbox*`, `.tms-chat-header*`, `.tms-quick-chip`, `.tms-location-card*`, `.tms-inbox-info*` from ~L300 | Delete those rules; `.tms-driver-card*` stays; add `.tms-tracking-group*`, `.tms-tracking-assignee-tabs`. Selectors stay under `.tms-shell` (guard: `src/features/tms/theme.scope.test.ts`); tokens only (hex-literal ESLint guard). |

Deep links that must keep working: `/tms/tracking` (nav `navSections.ts:115`, `TmsShell.tsx:113`), `/tms/tracking/links`, `/tms/shipments/<id>?tab=tracking` (notifications `collectNotifications.ts:198`, `ErrorsTab.tsx:283`, `CustomerLinksPage.tsx:182`, `DemoPage.test.tsx:151`). **V adds no route and changes no nav entry** (so `devVerifyS3`'s completeness gate and `s4Routes.mjs` need no edit).

### 1.2 Tracking-table data sources (all already on `ShipmentRow`)

| Column need | Source (field on `ShipmentRow`, projected by `useShipments.ts`) | Computation |
|---|---|---|
| Rate con sent | `rateConStatus`, `rateConSentAt` (active leg) | `isRateConSent()` (§3.1) |
| Last location + age | `lastUpdatePlace ?? lastKnownCity`, `lastUpdateAt ?? lastKnownAt` | existing `TrackingCell`, `relativeTime` (`workstations/motion.ts`) |
| ETA | `deliveryEtaAt` (LoadCarrier, set by `SET_ETA`/dispatch) else computed `nextStopEta()` (`lib/trackingEta.trackingEtaEstimate` from `lastKnownLat/Lng` + next stop) | new `etaOf(row, nowMs)` in `trackingTable.ts` (carrier-reported wins, estimate labelled "est.") |
| Next check call | `nextCheckCallAt`, `lastCheckCallAt`, `checkCallOpen`, `nextCheckCallNote` | new `nextCheckCallCell`: due/overdue vs `nowMs`, "—" when none |
| POD state | `docsMissing` (`null` = never checked), `podRequestedAt`, `pendingDocReviewCount`, board status | new `podStateOf(row)` → `NOT_DUE\|NEEDED\|REQUESTED\|IN_REVIEW\|RECEIVED\|UNKNOWN` (pure; **[INFERENCE]** `pendingDocReviewCount` counts any pending carrier upload, not only PODs; accepted as a proxy, builder C may refine from `docsMissing` + review rows if `ShipmentRow` exposes a POD-specific count) |
| Status | `boardStatusOf(row)`, `nextEventText`, `trackingFlaggedAt` | existing `StatusCell` |
| Carrier / customer | `carrierName/carrierDot/carrierMc`, `customerName` | existing `CarrierCell`; customer gets its own column |
| Assignee | `trackerId` → `trackerName` (new, A) | `nameOf(trackerId)` in `useShipments.ts` next to `salesRepName` |

Volumes: dev has ~939–979 shipments (BUILD_LOG: 979 incl. 50 voided; 907 on the board view) and "tens" of `UserProfile` rows. Production counts are not recorded; the Aljex planning assumption (BUILD_LOG ~L23) was 50k shipments / 5k customers — **an assumption, not a measurement**. `useShipments` already loads the whole shipment set client-side for every board, so grouping by assignee costs one `Array.reduce` over rows the page already holds. **No GSI** (Shipment has `number`, `status+pickupAppt`, `customerId+pickupAppt`, `pickupMonth+pickupAppt`; none by owner). If a future volume makes the full load untenable, the escape hatch is a sparse `trackerId + pickupAppt` GSI — not built.

### 1.3 Assignee modelling recon

* `UserProfile` (`resource.ts:2791`): `id` = Cognito username, `email`, `name`, `role` enum `ADMIN|MANAGER|CUSTOMER_REP|CARRIER_REP|AR_AP|COMPLIANCE|NONE`, `teamKeys[]`, `divisions[]`, `status PENDING|ACTIVE|INACTIVE`. **No TRACKER role**; `roles.ts` is U's file, so V does not add one (D-V1). Teams are JSON on `TmsSettings.teams` (free-string keys; a `trackers` key is used only in a test mock).
* `RepPicker` (`src/components/RepPicker.tsx`): props `{value,onChange,role?,placeholder,allowUnknown,disabled,multiple?}`; lists `useStaff()` (`listUserProfiles`); stores profile id only; "not a user" badge for unknown ids. Builder D verifies it hides `status==='INACTIVE'`; if not, add an `activeOnly` prop (default true) — the only permitted `RepPicker.tsx` edit.
* Server rep validation: `assertRepProfile` (profile must exist) — the tracker check is the same plus `status !== 'INACTIVE'`.
* Permission to assign reps today: `isActionAuthorized` (`tms-shipment-actions/handler.ts:728`) lets owner/ADMIN/`page-tms`/`page-loads` run `SET_SALES_REP`/`ASSIGN_CARRIER_REP`; client gate `canTag = isAdmin||isOwner||hasPageAccess('tms')` (`ShipmentDetail.tsx:93`). **`ASSIGN_TRACKER` uses the same gate** (trackers must be able to hand loads to each other). Settings writes stay owner/ADMIN only (`SAVE_TRACKING_*` pattern).
* Audit: `writeAudit('SHIPMENT', id, action, caller, changes)` → `AuditLog` (best-effort), rendered by `HistorySection.tsx`. `ASSIGN_TRACKER` writes one row per shipment `{from, to, batch}`.

### 1.4 Automation recon (summary; details in the F-table)

* Router: custom mutation `tmsTrackingActions(action,input)` (`resource.ts:4333`), client `trackingAction<T>()` (`apiClient.ts:3131`), wrappers `runCheckCallPlan` (L7294), `saveCheckCallPlan` (~L7305), `requestPod` (L7314), `sendShipmentMessage` (L7278). Gate: owner/ADMIN/`page-loads`/`page-tms`; `SAVE_TRACKING_SETTINGS`/`SAVE_DOCUMENT_SETTINGS` owner/ADMIN only.
* Plan: JSON on `Load.checkCallPlan` / `Customer.checkCallPlan` / `TmsSettings.defaultCheckCallPlan`; `resolveCheckCallPlan(settings, customer, load)` (`flowDefaults.ts:190`, whole-plan override, load → customer → org → `DEFAULT_CHECK_CALL_PLAN` = 4 h, SMS+EMAIL, escalate 30 min). `nextCheckCallAction` is the pure ladder (MILESTONE / CADENCE / ESCALATE_DISPATCHER / ESCALATE_EXCEPTION / NONE).
* Sweep: Load GSI `checkCallOpen='OPEN'` sorted by `nextCheckCallAt` (sparse), dedupe to shipments, `runCheckCallPlan` each, per-shipment try/catch → `{checked,acted,escalated,skipped,errors}`. Cadence message ids are random; milestone ids are deterministic `msg:<loadId>:<MILESTONE>[:email]`; a leg must have `Shipment.threadKey` or the send throws `Shipment thread has not been opened`.
* Send path: `thread.sendShipmentMessage` — NOT_SENT claim row first, then SES raw MIME (Reply-To `ai4bcat+tracking.<shipmentId>@gmail.com`, threadKey `tracking+<shipmentId>` from `lib/shipmentThread.ts`) or Twilio via the dispatch loop; signature `— BCAT Tracking Assistant` appended; row then updated `SENT|NOT_SENT|FAILED` with `error`.
* Inbound: `shipment-email-intake` Function URL (Gmail Apps Script bridge) → `INGEST_SHIPMENT_MESSAGE` → route by explicit id → plus-address in To/Cc → RFC `messageId` prefix, dedupe via `shipmentMessagesByMessageId`, writes `direction IN / RECEIVED`, clears `Load.checkCallAwaitingSince`, geocodes the body into a `LOCATION_UPDATE`. Driver SMS replies arrive via `dispatch-twilio-webhook`; whether they land in `ShipmentMessage` was **not verified** (R2).
* Settings page: `SettingsPage.tsx` is a stack of cards, all admin-gated by `useAuth().isAdmin`; `settingsKit` exports `SettingsCard, Stack, CheckRow, Hint, ErrorText, GroupLabel, Panel, Loading`; inputs from `@/features/tms/kit` (`TmsButton, TmsField, TmsInput, TmsSelect, TmsTextarea`). `TrackingSettingsCard` pattern: local `useState` per field, `getTmsSettings` in an effect (state set only inside the promise chain — `react-hooks/set-state-in-effect`), `parseWhole` validation, save with `settings.updatedAt` CAS, toast. `TmsSettings` field generations: `TMS_SETTINGS_V2…V14_FIELDS` + `settingsHaveVn` retry flags + `TMS_SETTINGS_JSON_FIELDS` (apiClient L1186–1290); next free group is **V15**.
* Override precedent to mirror: org default in `TmsSettings` → customer override (`Customer.*`, `null` = inherit, placeholder "— inherit from org —" in `FlowDefaultsCard`) → load override. There is **no per-division settings precedent** (legacy `Division` = billing entity; `OwnershipDivision` = taxonomy `owners/flows` JSON). V stores division overrides inside the one `TmsSettings.trackingAutomation` JSON keyed by division **code** (≈7 rows) rather than adding a field to `OwnershipDivision` (U's model; avoids a second shared-model edit).

---------------------------------------------------------------------------------------------------

## 2. Design

### 2.1 V1 — the tracker assignee

**Fields (additive):** `Shipment.trackerId` (string, nullable, not an index key — so `null` is legal, unlike `customerId`/`pickupMonth`), `Customer.defaultTrackerId`.

**Inheritance (server, `tms-shipment-actions/handler.ts`, slice A):**

| Path | Rule |
|---|---|
| `createShipment` (~L1812, beside `salesRepId`) | `trackerId = activeProfileIdOrNull(customer?.defaultTrackerId)`; an INACTIVE/missing profile silently yields `null` (never fail a create on a stale default). Written on the Shipment row only. |
| `setShipmentCustomer` (~L3538) | copy `customer.defaultTrackerId` only if `shipment.trackerId` is empty (same shape as the `takesRep` rule for `salesRepId`). |
| `duplicateShipment` (~L3305) | copy `source.trackerId` (mirrors `salesRepId`); if the source has none, fall back to the customer default. |
| `BACKFILL_SHIPMENT`, Aljex import | leave `null` (historical rows; they surface in "Unassigned" only if a rate con is later sent). |
| Tender/intake (U) | via `createShipment` → inherits automatically. |

**Assignment action** `ASSIGN_TRACKER` (new case in `tmsShipmentActions`; `Action` union + `isActionAuthorized` entry): input `{ shipmentIds: string[] (1–100), trackerId: string | null }`; for each id: skip with reason if missing / voided (`assertNotVoided`) / target profile missing or `INACTIVE`; otherwise `updateItemTx(SHIPMENT, id, {trackerId, updatedBy, updatedAt, version+1}, null)` (same shape and same CAS-free behaviour as `setSalesRep`) and `writeAudit('SHIPMENT', id, 'ASSIGN_TRACKER', caller, {from, to, batch: ids.length>1})`. Returns `{ updated: string[], skipped: { shipmentId: string, reason: string }[] }`. One shape for single and bulk (single UI passes `[id]` then refreshes). The `version`/`updatedAt` bump matches `SET_SALES_REP`; other editors already tolerate it.

**Customer default** is edited through the existing `UPSERT_CUSTOMER` path (`tms-directory-actions/handler.ts` whitelist beside `defaultCarrierRepId`, L1162, `optionalString(input.defaultTrackerId, 100)`); the same file's customer `trackingAutomation` accepts the policy **patch** shape and validates it with `normalizeAutomationPatch()` (§3.1). Permission = whatever `UPSERT_CUSTOMER` requires today.

**UI:** `TrackerPicker` (thin `RepPicker` wrapper, no role filter; members of the `trackers` team, if that team exists, sort first) used in (a) `TrackerCard` on the shipment detail overview, (b) the tracker chip in `TrackingDetailPanel`, (c) the Tracking table row menu + bulk "Reassign selected", (d) `FlowDefaultsCard` "Default tracker" beside "Default carrier rep" on the Customer profile, (e) `CustomerForm` create dialog (optional field, same hook `useCustomerForm`). The board gets a read-only "Tracker" column (`BOARD_COLUMNS` entry, group "Shipment") — **no new board filter key** (that would reach into `BoardDetailKey`/`useBoardFilters`/`BoardFilterPanel`, U's blast radius); filtering by tracker exists on the Tracking page via the tabs.

### 2.2 V2 — the Tracking page

**Scope:** `rows = shipments.filter(isRateConSent)`, then lifecycle: **Active** (not DELIVERED/VOIDED), **POD due** (DELIVERED and `podStateOf !== 'RECEIVED'`), **Closed** (DELIVERED/VOIDED). A toggle chip "Include loads without a TMS rate con" (default off, D-V2) widens `rows` to the whole lifecycle set so a tracker can still find a Aljex-era or own-fleet load.

**Assignee navigation** (`TmsSegmentedTabs`, URL `?assignee=`):

* `me` — **My loads** (count) — default when `myCount > 0`, else `all`.
* `all` — **All** — renders one `BoardGrid` section per assignee (header = name + count + "Reassign selected"), "Unassigned" section first when non-empty (amber `TmsBadge`), then assignees A→Z.
* `<userId>` — one tab per assignee that has ≥1 row in the current lifecycle (overflow beyond 8 tabs → a `TmsSelect` "More assignees").
* `unassigned` — **Unassigned** (count, `tone` warn when >0).

Pure grouping lives in `tracking/trackingTable.ts` (`groupByAssignee(rows, nameOf) → {key, label, rows}[]`, `assigneeTabs(...)`, `defaultAssignee(rows, myId)`, `isRateConSent` re-export, `etaOf`, `podStateOf`, `nextCheckCallStateOf`) with tests. `BoardGrid` is **not** modified (it is shared with `ShipmentsBoard`, U's); sections are separate `BoardGrid` instances. Sorting inside a section keeps the existing default `{motion, asc}` plus sortable ETA / next check call.

**Columns** (`COLUMNS`, in order): `shipment` (PRO + favourite), `customer` (new), `lane` (origin → destination + appts, replaces the two columns), `status` (existing cell), `lastLocation` (place + age + motion badge — folds `motion`), `eta` (new), `nextCheckCall` (new: "in 1 h 20 m" / red "overdue 35 m" / "—"), `pod` (new badge), `carrier` (existing), `tracker` (new, replaces `team`), `actions`. Row attrs unchanged (`data-testid="tracking-row"`, `data-status`, `data-shipment-id`) plus `data-tracker-id`.

**Row menu:** Open shipment · Create customer URL · **Request check call** (`runCheckCallPlan({shipmentId})`, MANUAL — what `InboxQuickActions` did) · **Request POD** (`requestPod({shipmentId})`, enabled only when DELIVERED) · **Assign tracker…** (popover with `TrackerPicker`, calls `assignTracker`). Toasts/disabled reasons copied from `InboxQuickActions` (`'This shipment is voided.'`, `'No active leg on this shipment.'`) before it is deleted.

**Removed from the page:** Inbox tab, conversation list, composer, Info panel, saved views dropdown/dialog. The thread lives where it already lives for every shipment: the shipment's Tracking tab. Row click still opens `/tms/shipments/<id>?tab=tracking`.

**Legacy URLs:** an effect redirects (`replace`) `?shipment=<id>` (with or without `tab=inbox`) to `/tms/shipments/<id>?tab=tracking`; unknown `tab` is ignored.

### 2.3 V3 — automation settings and engine

#### 2.3.1 Model (two layers, no duplicated cadence)

```
CheckCallPlan  (existing; cadence, channels, milestones, escalation)
  resolve:  load.checkCallPlan → customer.checkCallPlan → DIVISION plan (new) → settings.defaultCheckCallPlan → DEFAULT_CHECK_CALL_PLAN     (whole-plan override, as today)

AutomationPolicy (new; may we send automatically, to whom, when, with what text)
  resolve:  DEFAULT_AUTOMATION_POLICY ← global ← division (revSubdivision, then revDivision) ← customer      (FIELD-level merge; absent key = inherit)
```

* **Storage:** `TmsSettings.trackingAutomation` = `{ global: AutomationPolicyPatch, divisions: { [divisionCode]: { policy?: AutomationPolicyPatch, plan?: CheckCallPlan } } }`; `Customer.trackingAutomation` = `AutomationPolicyPatch`. The global plan is the **existing** `TmsSettings.defaultCheckCallPlan`; the customer plan is the existing `Customer.checkCallPlan`. The Settings card writes `defaultCheckCallPlan` + `trackingAutomation` in **one** `SAVE_TRACKING_AUTOMATION` (same row, one CAS on `updatedAt`) so it is atomic.
* **Division key:** the shipment's `revSubdivision` first, then `revDivision` (the two codes a Shipment stores; avoids reading `OwnershipDivision.parentId` in the Lambda). Divisions with no entry inherit.
* **`requestPodOnDelivery` is removed from `CheckCallPlan`** (type, `DEFAULT_CHECK_CALL_PLAN`, `normalizeCheckCallPlan`, the three form copies, `tms-directory-actions/handler.ts:707`, tests). Stored JSON that still carries the key is ignored by `normalizeCheckCallPlan` (it already drops unknown keys). Its job is done by `policy.podAuto` (D-V14).

#### 2.3.2 What each knob means

| Knob | Where | Semantics |
|---|---|---|
| Automatic check calls | `policy.checkCallsAuto` | Default **false**. Gate for **AUTO** runs only. A manual "Request check call"/"Run now" ignores it. |
| Check-call channels, cadence, milestones, escalate-after, e-mail dispatcher | `CheckCallPlan` | Unchanged semantics: SMS → `LoadCarrier.driverPhone`, EMAIL → `LoadCarrier.dispatcherEmail`; due when `now ≥ lastCheckCallAt + intervalHours` (immediately if never); VOICE stays disabled. |
| Automatic POD request on Delivered | `policy.podAuto` + `policy.podChannels` | Default **false**, channels `['SMS','EMAIL']`. One ask per leg per channel: id `auto:pod:<loadCarrierId>:<SMS\|EMAIL>`. Fires when the sweep sees a DELIVERED shipment whose leg has no such claim. |
| Quiet hours | `policy.quietHours` | `{enabled, start:'HH:mm', end:'HH:mm', timezone (IANA), channels}`, default `{true,'21:00','06:00','America/Chicago',['SMS']}`; may cross midnight; DST-safe. AUTO sends on a quiet channel are **deferred** (no row written, `lastCheckCallAt` not stamped, so the next sweep after the window ends sends). Escalation e-mails are not quiet by default (channels `['SMS']`). MANUAL ignores quiet hours. |
| Templates | `policy.templates` | Six strings: `checkCallSms`, `checkCallEmailSubject`, `checkCallEmailBody`, `podSms`, `podEmailSubject`, `podEmailBody`. `''`/absent = built-in text (today's wording). Apply to **CADENCE check calls and POD requests only**; milestone ("are you loaded?") and escalation wording stay built-in (D-V8). Placeholders: `{proNumber} {loadNumber} {origin} {destination} {pickupDate} {deliveryDate} {customer} {carrier} {driverName} {lastLocation} {trackerName} {trackerPhone} {trackingUrl}`. Unknown placeholders are **rejected at save** (client validation + server `normalizeAutomationPatch`). If an SMS template has no `{trackingUrl}` and an ACTIVE CARRIER_PING link exists, the link is appended (same rule as `trackingSmsTemplate`'s `{url}`). SMS body ≤ the existing `MAX_SMS_BODY` (1,600, `src/lib/dispatch.ts`; the editor also shows the 160-character segment count). |
| Eligibility (hard guards, not settings) | engine | AUTO touches only legs with `kind === 'CARRIER'`, `status === 'ACTIVE'`, `isRateConSent(leg)`, shipment not VOIDED; **own-fleet legs are skipped** (the driver app/ELD covers them; D-V9). |

#### 2.3.3 Engine — one function, two doors

`amplify/functions/tms-tracking-actions/automation.ts` → `runTrackingAutomation(deps, input, caller)`; action **`RUN_TRACKING_AUTOMATION`** replaces `SWEEP_CHECK_CALL_PLANS` (clean cutover; the only caller, `devVerifyP.mjs:357`, is retargeted in F).

Input `{ mode?: 'AUTO' | 'MANUAL' (default 'AUTO'), shipmentIds?: string[] (≤200) }`. `MANUAL` is admin-only, ignores `auto` switches and quiet hours and the rate-con guard (exactly what the old sweep did, so `devVerifyP` keeps its meaning); with `shipmentIds` it is scoped to those shipments. `AUTO` + `shipmentIds` is allowed for any authorized caller and is the dev test door (§7). Unscoped `AUTO` is what the schedule runs.

Per run:

1. Read `TmsSettings` once; resolve `now = deps.now()`.
2. **Check-call pass.** Candidate shipments = scoped `shipmentIds`, else the existing sparse query (Load GSI `checkCallOpen='OPEN'`, `nextCheckCallAt ≤ now`, dedupe by shipment). Per shipment (try/catch → `errors++`, audit `TRACKING_AUTOMATION_ERROR`): `openShipmentThread` (idempotent) → `runCheckCallPlan(deps, {shipmentId}, caller, {mode, resolve: resolveAutomation})`. In AUTO the agent resolves `resolveAutomation({settings, customer, load, revDivision, revSubdivision})`, skips if `!policy.checkCallsAuto` or the eligibility guard fails, strips quiet channels from the tick's channels (all stripped → `DEFERRED`), renders templates for CADENCE ticks.
3. **POD pass** (skipped unless some scope can have `podAuto`): candidate shipments = scoped ids, else Shipment GSI `status = 'DELIVERED'` with `pickupAppt ≥ now − 21 days` (bounded range on the existing `status+pickupAppt` index; ≈ the delivered set of three weeks). For each: skip if a leg already has the `auto:pod:` claim for all enabled channels; resolve policy; skip unless `podAuto`; eligibility guard; quiet hours (SMS) → deferred; send through the **shared helper** `requestPodForLeg()` extracted from `podReview.requestPod` (same recipients, same default body `Please upload the signed POD for load … Reply with photos or use your upload link.`, subject `Load <PRO> — POD needed`), with `id = auto:pod:<loadCarrierId>:<CHANNEL>`, `authorKind 'AGENT'`, template override, stamps `LoadCarrier.podRequestedAt`. The claim is idempotent: a second sweep (or a concurrent one) hits the existing id and is treated as already-requested, never a duplicate and never an error (builder B must read `thread.ts` L171–300 and make the id collision a no-op — `Transact` put with `attribute_not_exists(id)` and catch `TransactionCanceledException` for that reason only). Manual `REQUEST_POD` keeps random ids (re-asks after a rejected POD must still work) and now also calls `requestPodForLeg()`.
4. Result `{ mode, checked, acted, deferred, escalated, skipped, errors, pod: { checked, requested, skipped, deferred }, reasons: string[] }` (reasons capped at 50).

Threading: every automatic message is a `ShipmentMessage` through `sendShipmentMessage`, so it carries `threadKey = tracking+<shipmentId>` and the Reply-To plus-address; replies come back through `shipment-email-intake` → `INGEST_SHIPMENT_MESSAGE` into the **same** thread, unchanged. The one reuse requirement is that nothing here invents a second thread key (`threadKeyFor` only).

#### 2.3.4 Settings UI (slice E)

A new card **Tracking automation** in `SettingsPage` (placed right after `TrackingSettingsCard`), `SettingsCard` with three sub-tabs (`TmsSegmentedTabs`):

* **Defaults** — "Automatic check calls" switch · cadence/channels/milestones/escalation (`CheckCallPlanFields`, extracted) · "Request the POD automatically once a load is Delivered" switch + channel checkboxes · quiet hours (enable, start, end, timezone select defaulting to America/Chicago, applies-to SMS/E-mail) · six template textareas with placeholder chips (click inserts at cursor), live preview rendered from `sampleVars()`, SMS segment counter · **Save** (one `saveTrackingAutomation`) · **Run automation now** (`runTrackingAutomation({mode:'AUTO'})`, shows the result counts; on `branch === 'dev'` an `TmsAlert` says nothing is delivered and rows are recorded NOT_SENT in each shipment's thread).
* **Divisions** — one row per `OwnershipDivision` (`useOwnershipDivisions`, fallback `SEED_DIVISIONS`) with "Inherits defaults" / "Overridden · n fields"; edit opens the same `TrackingAutomationEditor` with per-field "inherit" toggles and an optional division plan.
* **Customers** — table of customers that have a `trackingAutomation` or `checkCallPlan` override (derived from `useDirectory().customers`), search, link to the Customer profile section; "Add override" picks a customer and opens the editor inline (saved through `updateCustomer`/`UPSERT_CUSTOMER`).

The **customer** editor is the same component mounted by slice D inside `CustomerProfile` under `FlowDefaultsCard` (contract §3.6). `TmsSettingsCard`'s copy of the plan form is removed with a one-line pointer to the new card.

---------------------------------------------------------------------------------------------------

## 3. Shared interfaces and types (final; slices code against these)

Types are defined once in `src/lib/trackingAutomation.ts` (pure, no React, no AWS; imported by the Lambda via the relative path `../../../src/lib/trackingAutomation` exactly like `checkCallPlan`) and referenced from `src/types/tms.ts` (`import type`). Slice B publishes the file with **types + signatures + stub bodies first**, real bodies second; slices C/D/E/F may import from the first push.

### 3.1 `src/lib/trackingAutomation.ts` (slice B)

```ts
import type { CheckCallPlan, CheckCallPlanSource } from './checkCallPlan' // CheckCallPlanSource moves here from flowDefaults if not exported; gains 'DIVISION'
import type { RateConStatus } from '@/types/tms'

export type AutomationChannel = 'SMS' | 'EMAIL'
export const AUTOMATION_CHANNELS: readonly AutomationChannel[] = ['SMS', 'EMAIL']

export interface QuietHours {
  enabled: boolean
  start: string            // 'HH:mm' 24h, local to `timezone`
  end: string              // 'HH:mm'; end <= start means the window crosses midnight
  timezone: string         // IANA; default TZ from src/lib/date.ts ('America/Chicago')
  channels: AutomationChannel[]   // which channels the window silences; default ['SMS']
}

export const TEMPLATE_KEYS = [
  'checkCallSms', 'checkCallEmailSubject', 'checkCallEmailBody',
  'podSms', 'podEmailSubject', 'podEmailBody',
] as const
export type TemplateKey = (typeof TEMPLATE_KEYS)[number]
export type AutomationTemplates = Record<TemplateKey, string>      // '' = built-in text

export const TEMPLATE_PLACEHOLDERS = [
  'proNumber', 'loadNumber', 'origin', 'destination', 'pickupDate', 'deliveryDate',
  'customer', 'carrier', 'driverName', 'lastLocation', 'trackerName', 'trackerPhone', 'trackingUrl',
] as const
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number]

export interface AutomationPolicy {
  checkCallsAuto: boolean                // default false
  podAuto: boolean                       // default false
  podChannels: AutomationChannel[]       // default ['SMS','EMAIL']
  quietHours: QuietHours
  templates: AutomationTemplates         // default all ''
}
/** A layer: any subset of keys. Absent key = inherit. `templates` merges per key, `quietHours` as a whole. */
export type AutomationPolicyPatch = Partial<Omit<AutomationPolicy, 'templates'>> & { templates?: Partial<AutomationTemplates> }

export interface DivisionAutomation { policy?: AutomationPolicyPatch; plan?: CheckCallPlan | null }
export interface TrackingAutomationSettings {
  global: AutomationPolicyPatch
  divisions: Record<string, DivisionAutomation>   // key = OwnershipDivision.code
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy
export const EMPTY_TRACKING_AUTOMATION: TrackingAutomationSettings   // { global: {}, divisions: {} }

/** Read stored JSON/object; drop unknown keys; clamp; never throws (returns {} on junk). */
export function normalizeAutomationPatch(raw: unknown): AutomationPolicyPatch
/** Same for the settings blob; division codes trimmed, ≤64 chars, ≤200 divisions. */
export function normalizeTrackingAutomation(raw: unknown): TrackingAutomationSettings
/** Strict variant for WRITES: throws Error with a user-readable message (unknown placeholder, bad HH:mm, bad IANA zone, SMS > MAX_SMS_BODY, no channel selected for an enabled purpose). */
export function validateAutomationPatch(raw: unknown): AutomationPolicyPatch

export interface AutomationContext {
  settings: { defaultCheckCallPlan?: unknown; trackingAutomation?: unknown } | null
  customer: { checkCallPlan?: unknown; trackingAutomation?: unknown } | null
  load: { checkCallPlan?: unknown } | null
  revDivision?: string | null
  revSubdivision?: string | null
}
export type PolicySource = 'DEFAULT' | 'GLOBAL' | 'DIVISION' | 'CUSTOMER'
export interface ResolvedAutomation {
  plan: CheckCallPlan
  planSource: CheckCallPlanSource            // 'load' | 'customer' | 'division' | 'org' | 'default' (lowercase, as built; type lives in checkCallPlan.ts, re-exported by tracking/checkCallPlanSource.ts)
  policy: AutomationPolicy
  policySource: { [K in keyof AutomationPolicy]: PolicySource }   // templates reported per whole object by highest contributing layer
}
export function resolveAutomation(ctx: AutomationContext): ResolvedAutomation

/** Quiet-hours helpers; DST-safe (Intl parts, 15-minute forward scan ≤ 24 h). */
export function isQuietNow(q: QuietHours, channel: AutomationChannel, nowMs: number): boolean
export function quietEndsAtMs(q: QuietHours, nowMs: number): number | null   // null when not currently quiet

/** `{name}` substitution for the allow-listed placeholders; unknown names are left verbatim (validate() rejects them at save). */
export function renderTemplate(text: string, vars: Partial<Record<TemplatePlaceholder, string | null | undefined>>): string
export function templateProblem(text: string, key: TemplateKey): string | null   // null = ok
export function sampleVars(): Record<TemplatePlaceholder, string>               // for the preview pane

/** The one definition of "a rate confirmation was sent": SENT, OPENED or SIGNED on the active leg. Used by the Tracking table AND the engine. */
export function isRateConSent(leg: { rateConStatus?: RateConStatus | string | null; rateConSentAt?: string | null }): boolean
```

`flowDefaults.resolveCheckCallPlan(settings, customer, load, divisionPlan?: CheckCallPlan | null)` gains the optional 4th argument (division sits between customer and org) and `CheckCallPlanSource` gains `'DIVISION'`; `tracking/checkCallPlanSource.ts` (slice B) adds its label ("Division default — <code>"). `normalizeCheckCallPlan` drops `requestPodOnDelivery`.

### 3.2 Wire types (`src/types/tms.ts`, slice A)

```ts
// ShipmentRecord / ShipmentBundle.shipment
trackerId?: string | null
// CustomerRecord
defaultTrackerId?: string | null
trackingAutomation?: AutomationPolicyPatch | null
// TmsSettings
trackingAutomation?: TrackingAutomationSettings | null
// ShipmentRow (shipmentViews.ts, slice A)
trackerId?: string | null
trackerName?: string | null
```

### 3.3 `apiClient.ts` wrappers (slice A writes them all; signatures final)

```ts
export interface AssignTrackerResult { updated: string[]; skipped: { shipmentId: string; reason: string }[] }
export async function assignTracker(input: { shipmentIds: string[]; trackerId: string | null }): Promise<AssignTrackerResult>
  // shipmentAction('ASSIGN_TRACKER', input)

export async function saveTrackingAutomation(input: {
  expectedUpdatedAt: string
  trackingAutomation?: TrackingAutomationSettings | null   // omitted = keep, null = clear
  defaultCheckCallPlan?: CheckCallPlan | null              // omitted = keep, null = clear
}): Promise<TmsSettings>
  // trackingAction('SAVE_TRACKING_AUTOMATION', input) – owner/ADMIN; CAS on TmsSettings.updatedAt

export interface AutomationRunResult {
  mode: 'AUTO' | 'MANUAL'
  checked: number; acted: number; deferred: number; escalated: number; skipped: number; errors: number
  pod: { checked: number; requested: number; skipped: number; deferred: number }
  reasons: string[]
}
export async function runTrackingAutomation(input?: { mode?: 'AUTO' | 'MANUAL'; shipmentIds?: string[] }): Promise<AutomationRunResult>
  // trackingAction('RUN_TRACKING_AUTOMATION', input)
```
Field groups (same file): `SHIPMENT_TRACKER_FIELDS = ['trackerId']` + `shipmentsHaveTracker` retry in `readShipments`; `CUSTOMER_V6_FIELDS = ['defaultTrackerId','trackingAutomation']` + `customersHaveV6`, `trackingAutomation` appended to `CUSTOMER_JSON_FIELDS`; `TMS_SETTINGS_V15_FIELDS = ['trackingAutomation']` + `settingsHaveV15` + `TMS_SETTINGS_JSON_FIELDS`. `saveTmsSettings`'s generic path does **not** carry `trackingAutomation` (it goes through `saveTrackingAutomation`, like the other domain savers).

### 3.4 Server entry points

* `tmsShipmentActions`: new action `ASSIGN_TRACKER` (A). U adds its own `PROMOTE_INTAKE_LOAD`-style case; the two hunks are disjoint (§4).
* `tmsTrackingActions`: `RUN_TRACKING_AUTOMATION` (replaces `SWEEP_CHECK_CALL_PLANS`), `SAVE_TRACKING_AUTOMATION` (owner/ADMIN; `saveSettings(input, caller, action, patch)` like `SAVE_TRACKING_SETTINGS`, `patch.trackingAutomation = validated`, `patch.defaultCheckCallPlan = normalized`), both in the `Action` union (`handler.ts` L246–265) and the switch (~L2324–2378) (B).
* `runCheckCallPlan(deps, input, caller, opts?: { mode?: 'AUTO' | 'MANUAL' })` — default MANUAL keeps every existing caller (`RUN_CHECK_CALL_PLAN`, the cadence-card button) byte-for-byte.
* `requestPodForLeg(deps, { shipment, load, carrier, reason?, idPrefix?, channels?, templates?, authorKind, caller })` exported from `podReview.ts`; used by `requestPod`, the automation POD pass; `checkCallAgent.requestPodForLoad` is **deleted** (its DELIVERED-milestone trigger goes with `requestPodOnDelivery`).

### 3.5 `TrackingBoardProps` (slice C; replaces the current interface)

```ts
export interface TrackingBoardProps {
  groups: TrackingGroup[]                   // from trackingTable.groupByAssignee(); a single group when a specific tab is selected
  assigneeTabs: TrackingAssigneeTab[]       // [{key:'me'|'all'|'unassigned'|<userId>, label, count, tone?}]
  activeAssignee: string
  onSelectAssignee: (key: string) => void
  lifecycle: 'active' | 'pod' | 'closed'
  onLifecycle: (v: 'active' | 'pod' | 'closed') => void
  includeUnsent: boolean
  onIncludeUnsent: (v: boolean) => void
  loading: boolean; error: string | null; nowMs: number
  mapsKey?: string; mapsMapId?: string
  query: string; setQuery: (v: string) => void
  favorites: Set<string>; onToggleFavorite: (id: string) => void
  onOpenShipment: (id: string) => void
  onCreateShipment: () => void
  onManageLinks: () => void
  onCreateCustomerUrl: (row: ShipmentRow) => void
  onRequestCheckCall: (row: ShipmentRow) => Promise<void>
  onRequestPod: (row: ShipmentRow) => Promise<void>
  onAssignTracker: (shipmentIds: string[], trackerId: string | null) => Promise<void>
  panelProps: BoardFilterPanelProps
  recent: RecentShipment[]; onOpenRecent: (id: string) => void; onRemoveRecent: (id: string) => void
}
export interface TrackingGroup { key: string; label: string; trackerId: string | null; rows: ShipmentRow[] }
export interface TrackingAssigneeTab { key: string; label: string; count: number; tone?: 'warn' }
```

### 3.6 UI component contracts

```ts
// src/components/TrackerPicker.tsx (D)  — publishes a stub first so C/E compile
export interface TrackerPickerProps {
  value: string | null; onChange: (id: string | null) => void
  allowClear?: boolean            // default true ("Unassigned")
  disabled?: boolean; placeholder?: string; 'aria-label'?: string; className?: string
}
export function TrackerPicker(p: TrackerPickerProps): JSX.Element

// src/features/shipments/components/TrackerCard.tsx (D)
export function TrackerCard(p: { shipment: ShipmentRecord; canEdit: boolean; onChanged: () => void | Promise<void> }): JSX.Element
// shows name (or "Unassigned") + inherited-from-customer hint when equal to the customer default; edit → assignTracker([id], v)

// src/features/settings/automation/CheckCallPlanFields.tsx (E)  — publishes first; D consumes in FlowDefaultsCard
export function CheckCallPlanFields(p: { value: CheckCallPlan; onChange: (patch: Partial<CheckCallPlan>) => void; disabled?: boolean }): JSX.Element

// src/features/settings/automation/TrackingAutomationEditor.tsx (E) — mounted by D in CustomerProfile
export interface TrackingAutomationEditorProps {
  scope: 'GLOBAL' | 'DIVISION' | 'CUSTOMER'
  value: AutomationPolicyPatch
  inherited: AutomationPolicy             // resolved from the layers ABOVE this scope (placeholder values, "inherit" labels)
  onChange: (next: AutomationPolicyPatch) => void
  disabled?: boolean
}
export function TrackingAutomationEditor(p: TrackingAutomationEditorProps): JSX.Element
```
`inherited` for a customer = `resolveAutomation({settings, customer: null, load: null, revDivision: null}).policy` (the customer profile does not know a division; a note says "division overrides apply per shipment").

### 3.7 System-caller path (slice B) — fixes F9, serves the scheduler

```ts
interface AppSyncEvent { arguments: {...}; identity?: AppSyncIdentity | null; systemCaller?: string }
const SYSTEM_CALLERS: Record<string, readonly Action[]> = {
  'tracking-automation':   ['RUN_TRACKING_AUTOMATION'],
  'shipment-email-intake': ['INGEST_SHIPMENT_MESSAGE', 'INGEST_ATTACHMENT'],
}
// authorize(action, identity, systemCaller): if systemCaller is a key AND the action is in its list →
//   return { email: 'system@bcatcorp.com', sub: systemCaller, groups: [], isAdmin: false }
// otherwise fall through to today's identity path unchanged.
```
Why this is safe: AppSync resolvers cannot set a top-level `systemCaller` key (the event envelope is fixed by AppSync; only `arguments` carries client data), so only a principal holding `lambda:InvokeFunction` on `tmsTrackingActions` can produce it; the allow-list limits what such a principal may do. `shipment-email-intake/handler.ts` switches its payload from the unusable `identity: {sub,email}` to `systemCaller: 'shipment-email-intake'` (one line + its test). Unit tests: allowed pair accepted; right caller wrong action refused; unknown `systemCaller` ignored and falls to the identity gate (still `Unauthorized: missing identity`); `MANUAL` mode refused for system callers (`isAdmin:false`).

---------------------------------------------------------------------------------------------------

## 4. Coordination with Step U (agreed by message with UPlan2; reconcile against `U-plan.md` when it exists)

UPlan2's stated shared-file plan: U owns `App.tsx`, `navSections.ts`, `navItems.ts`, `roles.ts`, `TmsShell.tsx`, `TmsLayout.tsx`, `ShipmentsBoard`, `BrokeragePage.tsx`; U does **not** touch `TrackingWorkstation`/`tracking/*`/`CustomerLinksPage`; U adds **no** `TmsSettings`/`Customer` fields; U adds to `resource.ts` (`OwnershipDivision.intakeEmail`, model `IntakeLoad`, optional `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt`, `WorkflowRun.toAddresses`), `backend.ts` (IntakeLoad env/IAM), `apiClient.ts` (intake wrappers + ownership-division field), `tms-directory-actions` (`SAVE_OWNERSHIP_DIVISION` only), `workflow-agent/*`, and `tms-shipment-actions` (new `intake.ts` + ONE switch case, Action-union entry and authorize entry in `handler.ts`); U lists `devVerifyS2.mjs` rows nn09/nn10 (tracking-inbox/links) as **V-owned**.

### 4.1 Single owner per shared file, and landing order

Landing order: **U lands first, V second, one push, one Amplify job.** Where both touch a file, hunks are disjoint but two builders must never hold the same file at once, so the later one starts after the earlier one's slice is reported done (Main sequences it).

| Shared file | First editor (U) | Second editor (V) | V hunk |
|---|---|---|---|
| `amplify/data/resource.ts` | U (intake models/fields) | **A** | `Shipment.trackerId`, `Customer.defaultTrackerId/trackingAutomation`, `TmsSettings.trackingAutomation` — beside `salesRepId` (L1560), `defaultCarrierRepId` (~L955), `defaultCheckCallPlan` (L1232) |
| `amplify/backend.ts` | U (IntakeLoad grants) | **B** | add `trackingAutomation` to the `defineBackend({...})` list (next to `checkCallNotifier`, L161), a `// ── trackingAutomation Lambda` block after the checkCallNotifier block (L3083–3110) with `addPermission('TrackingAutomationInvoke', …lambda:InvokeFunction…)` modelled on L757–761 + env `TMS_TRACKING_ACTIONS_FUNCTION_NAME`, `tmsTrackingActions` `GetItem` on UserProfile + env, Shipment index Query if missing |
| `src/lib/apiClient.ts` | U (intake wrappers, ownership field) | **A** | the three field groups, `readShipments`/`getTmsSettings`/customer retries, `assignTracker`, `saveTrackingAutomation`, `runTrackingAutomation` |
| `tms-shipment-actions/handler.ts` | U (1 switch case near L6735 + Action union + authorize set near L674–760) | **A** | `createShipment` (~L1812), `setShipmentCustomer` (~L3538), `duplicateShipment` (~L3488), new `assignTracker()` next to `setSalesRep`, 1 switch case + 1 authorize entry |
| `src/types/tms.ts` | U (intake types) | **A** | fields in §3.2 |
| `src/features/shipments/shipmentViews.ts`, `hooks/useShipments.ts` | U (**UB owns `shipmentViews.ts`** per U-plan §8; VA/VD ask UB by `hub` to add `ShipmentRow.trackerId/trackerName` and the 'tracker' column, or VA edits after UB reports done) | **A** | `ShipmentRow.trackerId/trackerName`, `BOARD_COLUMNS` 'tracker', projection `trackerName: nameOf(s.trackerId)` |
| `src/features/shipments/components/ShipmentDetail.tsx` | U (intake review banner/step, **[INFERENCE]**) | **D** | one import + one `<TrackerCard …/>` mount beside `DivisionCard` |
| `scripts/devVerifyS2.mjs` | U (routes for removed pages, Workflows/Academy rows) | **F** | rows nn08/09/10 (L82–84), `INBOX_TESTIDS/inboxAsserts` L481–492, `inboxPanelPersistence` L566–590 + call L754 |
| `src/features/tms/TmsShell.tsx`, `navSections.ts`, `App.tsx`, `BrokeragePage.tsx` | U (sole owner) | — | **V edits none**: Tracking keeps `/tms/tracking` and "Manage Customer Links"; the Automation card lives inside the existing Settings tab, so `BrokeragePage` TABS are untouched. |
| `TrackingWorkstation.tsx`, `tracking/TrackingBoard.tsx`, `tracking/types.ts`, `TrackingWorkstation.test.tsx` | U slice B, **mechanical only, at U's landing step 1** (`U-plan.md` §1.1: drops `useShipmentViews`/`viewSlug`/view props from `TrackingWorkstation`; I asked UPlan2 to extend it to the `BoardFilterPanel` filter-set props that `TrackingBoard` consumes, §4.2) | **C** (sole owner afterwards) | whole rewrite on top of U's compiling base |
| `tracking/**` (the rest), `CustomerLinksPage.tsx`, `styles/tracking.css` | — | **C** (sole owner) | deletes + edits per §1.1 |
| `Dispatch/Documents workstations`, `useShipmentViews.ts`, `useBoardFilters.ts`, `BoardFilterPanel.tsx`, `shipmentViewDefs.ts`, `ShipmentViewsPage` | U | — | V edits none. **C codes against the post-U `useBoardFilters`/`BoardFilterPanelProps`** (U-plan §1.3: filters become plain local state; the View section and `filterSets/activeFilterSetId/onSelectFilterSet/onCreateFilterSet/onUpdateFilterSet/onRevertFilterSet/onDeleteFilterSet` props are deleted; `@me/@myteam` sentinels and `viewer` become dead). C's first step is to read the landed signatures and delete every leftover use (`viewer`, `teamRepIdsFor`, `createView`, the Save-view dialog) — V's Tracking page never offers saved views (D-V13). |

Handoff questions for `U-plan.md` (Main reconciles when both exist): (1) does U edit `shipmentViews.ts`/`useShipments.ts`/`ShipmentDetail.tsx`? (2) final `useBoardFilters` signature; (3) does the intake "review" step touch `TrackingSection`/Tracking tab? (V assumes no); (4) U's own `devVerifyU.mjs` must not assert the Tracking page's Inbox.

One more U/V dependency: **hiding Workflows** (U) must not hide the Settings automation card — it is in `SettingsPage`, which U does not touch. The `RUN_TRACKING_AUTOMATION`/`SAVE_TRACKING_AUTOMATION` actions are on `tmsTrackingActions`, unrelated to the `workflow-agent`.

### 4.2 Reconciliation with `U-plan.md` (read after it appeared; it was partial — §0–§5 only, slices/landing steps not yet written)

1. **Tracking workstation:** `U-plan.md` §1.1 says U's slice B edits `TrackingWorkstation` (≤10 lines, landing step 1) and leaves `tracking/*` untouched. **Gap found:** U deletes the View section and the filter-set props from `BoardFilterPanel`/`useBoardFilters`, but `tracking/TrackingBoard.tsx` still consumes them (`ViewsDropdown` reads `panelProps.filterSets/activeFilterSetId/onSelectFilterSet`; the toolbar's "Save view" calls `panelProps.onCreateFilterSet()`; `types.ts` has `onSaveView`), so typecheck would be red between U's step 1 and V. Proposed to UPlan2 (message): U's mechanical edit also deletes `ViewsDropdown`, the Save-view button, `onSaveView` and the save-view dialog/state. If U declines, V slice C lands **in the same integration step** as U's slice B (Main merges them together before typecheck). **Resolved:** UB reported the mechanical removal landed in `TrackingWorkstation.tsx`, `tracking/TrackingBoard.tsx` and `tracking/types.ts` (no `useShipmentViews`/`viewCallerOf`/`viewer`/`createView`/`onSaveView`/`ViewsDropdown`/save dialog left; `TrackingBoardProps.onSaveView` gone); `useBoardFilters` options are now `{rows, customers, staffNameOf, storageKey, baseFilters?, query?, onQueryChange?}` and `BoardFilterPanelProps` lost all view props. Slice C builds on that; the "remove Save view / ViewsDropdown / viewer" parts of §1.1 and §5-C step 4 are already done, and C only adds the new behaviour. UB is still fixing stale view mocks in `TrackingWorkstation.test.tsx` (C owns that file afterwards).
2. **"Keep Tracking inbox"** in U's spec header is superseded by Ryne's V2 (Inbox UI removed). Nothing in U depends on the Inbox; U's `devVerifyU` must not assert it; U's `TmsShell` "Tracking" child (`/tms/tracking`, `badgeKey 'tracking'`) and "Manage Customer Links" are unchanged and are all V needs.
3. **`useOwnershipDivisions`** is exported from `src/features/tms/useShipmentViews.ts` (L118). U-plan §1.3 deletes the views hook; U must keep or relocate this export (also used by `TmsLayout`, `DivisionsPage`, `ShipmentViewsPage`). Slice E imports it from wherever U leaves it (builder greps).
4. **Shared schema deploy:** U's additions (`IntakeLoad`, `OwnershipDivision.intakeEmail`, `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt`) and V's (`Shipment.trackerId`, `Customer.defaultTrackerId/trackingAutomation`, `TmsSettings.trackingAutomation`) are all optional/additive → one data deploy, no ordering constraint between them. `createShipment` is called unchanged by U's `INTAKE_MOVE_TO_ACTIVE` (U-plan §5.6 step 4), so a tender-born shipment inherits the customer's default tracker with no U change; V adds one test for it.
5. **`devVerifyS2.mjs`:** U-plan §1.5 removes rows 03/07/11/11b/24/24a, the `02a-filterset` state and resolvers `view/docview/academy`, and adds `02b/02i/02j`; V (slice F) edits only rows 08–10 and the Inbox functions. Two sequential editors of one file: U's slice first.
6. **Page grants:** U adds the `intakeReview` grant in `navItems.ts` (`OFF_NAV_PERMISSION_PAGES`). V adds **no** grant and edits neither `navItems.ts` nor `roles.ts`.
7. **`shipment-notifier` / `check-call-notifier` / `workflow-agent`:** U's `workflow-agent` edits (`inbox.ts`, `run.ts`, `model.ts`, new `intakeStage.ts`) and V's `tms-tracking-actions` edits touch no common file. `backend.ts` hunks are in different blocks (U: IntakeLoad env/IAM for `workflow-agent`/`tmsShipmentActions`; V: `trackingAutomation` function + invoke permission + `tmsTrackingActions` UserProfile read).

---------------------------------------------------------------------------------------------------

## 5. Slices (up to 6 builders; Sonnet-class `task` agents; disjoint file ownership; no builder runs lint/build/full tests — Main does once)

Dispatch order: **A and B start first** (A after U's slices have released `resource.ts`/`apiClient.ts`/`tms-shipment-actions/handler.ts`/`types/tms.ts`; B needs `backend.ts` after U's IntakeLoad block, otherwise only its own files). **C starts after U's mechanical Tracking edit (§4.2 item 1) has landed.** Within ~10 minutes A publishes types + wrapper signatures and B publishes `trackingAutomation.ts` types/stubs; **C, D, E start then**, in parallel. **F** (wave 2) after A–E report. Cross-slice asks go through `hub`.

### Slice A — assignee backend, schema, wire types, row projection
Owns: `amplify/data/resource.ts` (V hunks), `tms-shipment-actions/{handler.ts (V hunks),demo.ts,handler.test.ts}`, `tms-directory-actions/{handler.ts,handler.test.ts}`, `src/types/tms.ts`, `src/lib/apiClient.ts` (all V hunks), `src/features/shipments/shipmentViews.ts`, `src/hooks/useShipments.ts`.
1. **First push (≤10 min):** `resource.ts` fields, `tms.ts` types (§3.2), `apiClient.ts` field groups + the three wrappers (§3.3) with real GraphQL plumbing, `ShipmentRow.trackerId/trackerName`. Message C/D/E "types live".
2. `ASSIGN_TRACKER` (`assignTracker()` beside `setSalesRep`): validation per §2.1, `writeAudit`, bulk ≤100, skipped reasons: `Shipment not found`, `Shipment is voided`, `Tracker is not an active user profile`. Action union + `isActionAuthorized` entry (non-admin TMS users allowed).
3. Inheritance in `createShipment`, `setShipmentCustomer`, `duplicateShipment`; add `trackerId` to the shipment read selection used by `readBundle` if it is projected rather than `SELECT *` **[builder verifies]**.
4. `tms-directory-actions`: customer whitelist `defaultTrackerId` + `trackingAutomation` (validated with `validateAutomationPatch`; reject on error with the message), **delete `requestPodOnDelivery` normalization (L707) and update `handler.test.ts` fixtures** (L677, L734, L742, L1287). Import from `../../../src/lib/trackingAutomation` (B's first push).
5. `useShipments.ts`: `trackerName: nameOf(s.trackerId)` beside `salesRepName` (L618); `BOARD_COLUMNS` entry `{ key:'tracker', label:'Tracker', group:'Shipment', value: r => r.trackerName ?? '', width:140 }`.
6. `demo.ts`: seeded in-transit shipments get `trackerId`: first two demo staff alternately, the fourth left unassigned; bump `demoSeedVersion` so `RESET_DEMO_DATA`/`SEED_DEMO_DATA` re-seed; check `devVerifyP.mjs` seed-contract assumptions (`shipment.intransit(.n)` keys, `facts` counts) still hold.
Acceptance: handler tests below pass; `npx vitest run amplify/functions/tms-shipment-actions amplify/functions/tms-directory-actions` (scoped) green.

### Slice B — automation engine, scheduler, system caller
Owns: `src/lib/{trackingAutomation(+test),checkCallPlan(+test),flowDefaults(+test)}.ts`, `tracking/checkCallPlanSource.ts`, `tms-tracking-actions/{automation(+test),checkCallAgent(+test),podReview(+test),thread(+test),handler(+test)}.ts`, `functions/tracking-automation/{resource.ts,handler.ts,handler.test.ts}`, `shipment-email-intake/{handler.ts,handler.test.ts}`, `amplify/backend.ts` (V hunks).
1. **First push:** `trackingAutomation.ts` per §3.1 (types, constants, real `isRateConSent`, stubs for the rest), `CheckCallPlan` minus `requestPodOnDelivery`, `CheckCallPlanSource += 'DIVISION'`. Message A/C/D/E.
2. Real bodies: normalize/validate/resolve/quiet-hours/render with tests (§6).
3. `automation.ts` + agent changes (§2.3.3): `opts.mode`, policy gate, eligibility guard, quiet-hour stripping/deferral, template rendering for CADENCE, `DEFERRED` outcome, shared `requestPodForLeg()` with deterministic ids; delete `requestPodForLoad` and the `requestPodOnDelivery` branch (L329); `thread.sendShipmentMessage` id collision → no-op for ids starting `auto:`.
4. `handler.ts`: `RUN_TRACKING_AUTOMATION`, `SAVE_TRACKING_AUTOMATION`, `systemCaller` (§3.7); remove `SWEEP_CHECK_CALL_PLANS`.
5. `functions/tracking-automation`: `defineFunction({ name:'tracking-automation', entry:'./handler.ts', resourceGroupName:'data', schedule:'every 5m', timeoutSeconds:60, memoryMB:256 })`; handler builds `{ arguments:{action:'RUN_TRACKING_AUTOMATION', input: JSON.stringify({mode:'AUTO'})}, systemCaller:'tracking-automation' }`, `InvokeCommand` `RequestResponse` on `TMS_TRACKING_ACTIONS_FUNCTION_NAME`, logs the result, surfaces `FunctionError` as a thrown error (so CloudWatch alarms/EventBridge retries see it). No-op log if the env var is unset (same posture as the intake).
6. `backend.ts` hunks (§4.1). Re-read the `BCAT_ISOLATED_PREVIEW`/`BCAT_DEV_STACK` guards: the new rule lives in the data stack so it is disabled on dev automatically, and the preview guard zeroes the Lambda (not in `previewCallable`) — **no guard edit needed**, but B states this in the commit message after reading L3255–3285 and L3461–3470.
7. `shipment-email-intake`: swap the payload identity for `systemCaller` (F9).
Acceptance: scoped vitest on the touched folders green; `npx tsc --noEmit -p amplify/tsconfig.json` clean for these files.

### Slice C — Tracking page
Owns: `TrackingWorkstation.tsx(+test)`, `tracking/**` (except `checkCallPlanSource.ts`), `src/features/tms/styles/tracking.css`.
1. Delete files per §1.1; strip `TrackingConversation` inbox branches; delete `TrackingMiniMap`, `isFreshPing` (+ test case), `InboxPanelProps`; rename `inbox-driver-card` → `driver-card` (and the `devVerify*` selectors, via F).
2. `tracking/trackingTable.ts` (+test): `groupByAssignee`, `assigneeTabs`, `defaultAssignee`, `lifecycleOf`, `etaOf`, `podStateOf`, `nextCheckCallStateOf`, re-export `isRateConSent`.
3. Rewrite `TrackingWorkstation.tsx` per §2.2 (rows → `isRateConSent` unless `includeUnsent` → lifecycle → assignee → `useBoardFilters`/query; `assignTracker`, `runCheckCallPlan`, `requestPod` handlers with `toast`; legacy-URL redirect effect; `?assignee=` read/write with `replace`).
4. `TrackingBoard.tsx`: new columns/cells, grouped sections (one `BoardGrid` per group, `selectable` with per-section "Reassign selected" using `TrackerPicker`), row menu items, tab strip, empty states ("No shipments with a sent rate confirmation yet" / "Nothing assigned to you — pick All"), remove `ViewsDropdown`/Save view/`TeamCell`.
5. `TrackingDetailPanel.tsx`: tracker chip in the header (D's `TrackerPicker`; read-only when `!canEdit`).
6. Retarget/delete tests (§6). CSS: delete Inbox rules, add group/tab rules under `.tms-shell`, tokens only.
Acceptance: `npx vitest run src/features/shipments/workstations` green; no remaining reference to deleted symbols (`grep -r "Inbox" src/features/shipments` finds nothing outside comments that say it was removed).

### Slice D — assignee UI on shipment and customer
Owns: `src/components/TrackerPicker.tsx(+test)`, `src/features/shipments/components/TrackerCard.tsx(+test)`, `ShipmentDetail.tsx` (one hunk), `src/features/directory/components/{FlowDefaultsCard.tsx(+test),useCustomerForm.ts,CustomerProfile.tsx,CustomerForm.tsx}`, `src/components/RepPicker.tsx` (only an `activeOnly` prop if needed).
1. **First push:** `TrackerPicker` (stub that already renders `RepPicker`).
2. `TrackerCard` + mount in `ShipmentDetail` next to `DivisionCard` (`canEdit = canTag`, same gate; voided ⇒ read-only); shows "inherited from <customer>" when `trackerId === customer.defaultTrackerId`.
3. `FlowDefaultsCard`: "Default tracker" `TrackerPicker` beside "Default carrier rep"; `FlowDefaultsValue.defaultTrackerId`; `useCustomerForm` (initial/toRecord, L112/L187/L317 pattern); replace the plan form copy with `<CheckCallPlanFields>` (E's) and drop the `requestPodOnDelivery` toggle (L349) + fixture field in `FlowDefaultsCard.test.tsx` (L66); mount `<TrackingAutomationEditor scope="CUSTOMER">` in `CustomerProfile` under the flow defaults (saved with the same `onSave` as the rest of the profile, field `trackingAutomation`).
Acceptance: `npx vitest run src/features/directory src/features/shipments/components src/components/RepPicker.test.tsx` green.

### Slice E — Settings → Tracking automation
Owns: `src/features/settings/{TrackingAutomationCard.tsx,automation/**,TmsSettingsCard.tsx,SettingsPage.tsx,SettingsPage.render.test.tsx}`.
1. **First push:** `CheckCallPlanFields` and `TrackingAutomationEditor` as typed shells so D compiles.
2. Extract `CheckCallPlanFields` from `TmsSettingsCard` (L≈300–345) — **remove** `requestPodOnDelivery`; replace the card's plan section with a `Hint` pointing to the new card.
3. `TrackingAutomationEditor` (all knobs of §2.3.2, per-field "inherit" toggles for non-GLOBAL scopes, placeholder chips, live preview via `renderTemplate(..., sampleVars())`, SMS counter, inline `templateProblem` errors) and `TrackingAutomationCard` (sub-tabs, Save via `saveTrackingAutomation` with `settings.updatedAt` CAS and the `TrackingSettingsCard` state/effect pattern, Run-now button, dev notice from `src/lib/buildInfo` **[builder verifies the S4 module name/export]**).
4. `SettingsPage`: mount `<TrackingAutomationCard />` after `TrackingSettingsCard`; update `SettingsPage.render.test.tsx` expectations.
Acceptance: `npx vitest run src/features/settings` green; Save button disabled while any `templateProblem` exists.

### Slice F — verification harness (wave 2; sole editor of `scripts/**` for V)
Owns: `scripts/devVerifyV.mjs`, `scripts/devVerifyS2.mjs` (tracking rows only), `scripts/devVerifyP.mjs` (L357: `SWEEP_CHECK_CALL_PLANS` → `RUN_TRACKING_AUTOMATION {mode:'MANUAL'}`), `scripts/lib/verifyTrackingUi.mjs`, `Docs/tms-build/screenshots/V/**`.
1. `devVerifyS2.mjs`: row `09 tracking-inbox` → `09 tracking-by-assignee` (`/tms/tracking`, dark:true; screenshot `S2/09-tracking-by-assignee-{light,dark}.png`); replace `inboxAsserts` with assertions for `tracking-assignee-tabs` + ≥1 `tracking-row`; delete `INBOX_TESTIDS`, `inboxPanelPersistence` and its call (L754); keep rows 08 (`?tab=tracking`→ `/tms/tracking`) and 10 (`/tms/tracking/links`).
2. `verifyTrackingUi.mjs`: delete L37–62 (inbox list/conversation/deep-link), keep L11–36 and L63–69, change the returned object (drop `inboxDeepLinkReload`), keep `P8-UI-*` screenshot names except the inbox one (delete `P8-UI-inbox-conversation.png` from the committed set). It still asserts "no Booking tab".
3. `devVerifyV.mjs` per §7.

---------------------------------------------------------------------------------------------------

## 6. Tests (behavioural only; each earns its place by failing on a plausible bug)

**Delete** (they pin the removed UI): `tracking/InboxQuickActions.test.tsx`, `tracking/InboxInfoPanel.test.tsx`; in `TrackingWorkstation.test.tsx` the helper `inboxRow` (L199–203), the tab test `'keeps Inbox · Tracking tabs and drops Booking'` (L221–227), the inbox half of `'opens the Inbox from ?tab=inbox …'` (L229–236) and the whole `'TrackingWorkstation inbox'` describe (L332–378). `statusTimeline.test.ts`: drop the `isFreshPing` case only.
**Retarget** (keep the behaviour, new assertions): `TrackingWorkstation.test.tsx` table describe (L239–330: columns/attrs, Active/Closed, motion, next event, tracking flag, next-stop ETA, sort, row click → `/tms/shipments/<id>?tab=tracking`, Manage links → `/tms/tracking/links`) now seeds rows with `rateConStatus: 'SENT'`/`rateConSentAt` (otherwise the new filter hides them) and replaces the "team + carrier" assertion by "tracker + carrier"; board-filter-viewer describe (L380–410) unchanged. `components/TrackingSection.test.tsx` and `shipments/TrackingSection.test.tsx` unchanged (Run check-call / Request POD / LogCheckCall still in the detail panel).

**New (frontend):**
* `tracking/trackingTable.test.ts` — `groupByAssignee` puts `trackerId:null` in "Unassigned" first, others A→Z by `trackerName` with stable ties; `defaultAssignee` = `me` only when the user owns ≥1 visible row; `lifecycleOf`/`podStateOf` truth table (not delivered, delivered+`docsMissing` includes POD with/without `podRequestedAt`, `pendingDocReviewCount>0`, `docsMissing:null` → UNKNOWN, POD absent from `docsMissing` → RECEIVED); `etaOf` prefers `deliveryEtaAt` over the estimate and labels the estimate.
* `TrackingWorkstation.test.tsx` — rows without a sent rate con are hidden, shown when "Include loads without a TMS rate con" is on; a `DECLINED`/`VOIDED`/`EXPIRED` rate con is **not** "sent"; My loads is the default for a user with assigned rows and the page opens All otherwise; `?assignee=<id>` filters; the Unassigned tab count; **legacy `?tab=inbox&shipment=S1` navigates to `/tms/shipments/S1?tab=tracking`**; "Reassign selected" calls `assignTracker(ids, trackerId)` with exactly the selected ids; Request POD is disabled with a reason unless DELIVERED.
* `TrackerCard.test.tsx` — shows "Unassigned" and "inherited" hint; changing calls `assignTracker([id], v)` and then `onChanged`; read-only when `canEdit=false` or voided.
* `FlowDefaultsCard.test.tsx` — default tracker round-trips through `onChange`; plan form has no POD toggle.
* `settings/automation/*.test.tsx` — Save disabled while a template contains `{unknown}`; per-field "inherit" toggle removes the key from the emitted patch; SMS counter turns invalid past MAX_SMS_BODY (1600) and shows segments of 160; quiet-hours overnight window accepted.
* `SettingsPage.render.test.tsx` — the Automation card renders for admins only.

**New (pure lib, `trackingAutomation.test.ts`):** field-level precedence (customer > division > global > default) incl. `templates` per key and `quietHours` whole-object; subdivision patch beats its division's; `''` template means built-in, absent means inherit; `resolveAutomation` plan source labels (`load/customer/division/org/default`); `isQuietNow`/`quietEndsAtMs` across midnight (21:00–06:00 at 23:30 and 05:59 quiet, 06:00 not), at the spring-forward and fall-back Sundays in `America/Chicago`, with a non-default zone, and for a channel not in `channels`; `renderTemplate` substitutes allow-listed names only and leaves `{foo}` verbatim; `templateProblem` rejects unknown placeholders and >320-char SMS; `validateAutomationPatch` rejects bad `HH:mm`/IANA zone/enabled-with-no-channel; `isRateConSent` for each enum value and `rateConSentAt` without a status; `normalizeCheckCallPlan` ignores a stored `requestPodOnDelivery`.

**New (Lambda):**
* `automation.test.ts` (in-memory store, as `checkCallAgent.test.ts`): AUTO with everything default → zero sends (master switch off); customer `checkCallsAuto:true` → a cadence message to SMS+EMAIL, recorded NOT_SENT when the sender stubs say so; **AUTO skips a leg whose rate con is `NOT_SENT`**, an `OWN_ASSET` leg and a voided shipment; quiet hours (SMS) with EMAIL allowed → e-mail only and no `lastCheckCallAt` stamp for SMS, all channels quiet → `deferred` with no rows and `nextCheckCallAt` unchanged; the next sweep after the window sends; division plan applies when the customer has none; MANUAL ignores switches/quiet/guard; scoped `shipmentIds` touches only those shipments; **POD pass fires once**: DELIVERED shipment → `auto:pod:<leg>:EMAIL` + `:SMS`, second run → no new rows and no error, a new leg after re-booking gets its own ask, `podChannels:['EMAIL']` sends only e-mail, template placeholders rendered, `podRequestedAt` stamped; replies: an `INGEST_SHIPMENT_MESSAGE` addressed to the automation message's Reply-To plus-address lands on the same `threadKey` (`tracking+<id>`).
* `handler.test.ts` (tracking): `systemCaller` matrix (§3.7); `SAVE_TRACKING_AUTOMATION` owner/ADMIN only, CAS conflict, rejects unknown placeholder; `RUN_TRACKING_AUTOMATION` MANUAL refused for non-admin.
* `shipment-actions handler.test.ts`: `createShipment` copies the customer's tracker, yields `null` for an INACTIVE/missing profile and for a customer with none (and **never fails the create**); `setShipmentCustomer` fills an empty tracker but never overwrites; `duplicateShipment` copies the source tracker; `ASSIGN_TRACKER` writes one audit row per shipment with `{from,to}`, bulk partially succeeds with reasons for voided/missing ids, rejects an inactive tracker, `null` clears; non-TMS caller refused.
* `directory handler.test.ts`: `UPSERT_CUSTOMER` round-trips `defaultTrackerId` and a valid `trackingAutomation`, rejects an invalid one; plan normalization no longer emits `requestPodOnDelivery`.
* `tracking-automation/handler.test.ts`: builds the exact invoke payload (`systemCaller`, `RUN_TRACKING_AUTOMATION`, `mode:'AUTO'`), throws on `FunctionError`, no-ops when the env var is unset. `shipment-email-intake/handler.test.ts`: payload carries `systemCaller:'shipment-email-intake'` (F9 regression).

**Not tested (deliberately):** CSS, column widths, recharts-style geometry, the wiring of props, mock echoes.

---------------------------------------------------------------------------------------------------

## 7. `devVerifyV.mjs` (slice F) — how automation and assignment are exercised on dev

Conventions copied from `devVerifyS4.mjs`: shebang + header, `createWalk` from `scripts/lib/uiWalk.mjs`, `mintIdentity('zz-v-admin-<ts>@example.invalid', ['ADMIN','page-tms'])` in the dev pool `us-east-1_UKhMNVAG1`, refuses non-dev AppSync/pool/origin and any table or bucket not carrying the dev suffix or carrying `5ucwdyvwivelbo4k4jomvrwel4-NONE`, flags `--inventory --only=<substr> --no-dark`, `process.exitCode = 1` on any FAIL or non-allowed SKIP, prints `summary: {pass, fail, skipped, skippedNotAllowed}`. Run: `DEV_VERIFY_UI_URL=https://dev.d3dejqzs77khq6.amplifyapp.com node scripts/devVerifyV.mjs` (never concurrently with `devVerifyP`, which voids shared demo shipments — BUILD_LOG L261–264).

**Fixtures (all `ZZ V …`, tracked in sets, removed in `finally`, each removal re-read):** two `UserProfile` rows `zz-v-trk-a`, `zz-v-trk-b` (status ACTIVE; written with the S4-style guarded SDK `PutItem`, deleted after) and one INACTIVE `zz-v-trk-x`; customers `ZZ V Customer A` (`defaultTrackerId zz-v-trk-a`, `trackingAutomation {checkCallsAuto:true, podAuto:true, quietHours:{enabled:false}, templates:{checkCallSms:'ZZ {proNumber} {origin}→{destination} ETA? {trackingUrl}', podSms:'ZZ POD {proNumber}'}}`), `ZZ V Customer B` (no default, no automation); shipments created through `CREATE_SHIPMENT`; for the engine tests the harness patches the ZZ shipment's Load/LoadCarrier through the guarded SDK to a `kind CARRIER, ACTIVE, rateConStatus SENT, dispatcherEmail zz-v@example.invalid, driverPhone +15555550100` leg (the full SEND_RATE_CON chain needs a completed MCP packet and is not what is under test) and opens the thread with `OPEN_SHIPMENT_THREAD`. Shipments are **never deleted**: `VOID_SHIPMENT` with reason `step V verification fixture`; customers archived; ZZ leg/message rows stay with their voided shipment (history); only the three ZZ profiles are deleted. Residue check: no active (unvoided) ZZ V shipment, no ZZ profile.

| Id | Proves |
|---|---|
| **V01** inherit | create on Customer A → `trackerId = zz-v-trk-a`; Customer B → `null`; inactive default (`zz-v-trk-x`) → `null` and the create still succeeds |
| **V02** override | `ASSIGN_TRACKER` → `zz-v-trk-b`; audit row `ASSIGN_TRACKER {from:a,to:b}` readable via history; `SET_SHIPMENT_CUSTOMER` to B does **not** overwrite; `null` clears; voided/inactive rejected with reasons; bulk of 3 ids with 1 voided → `updated:2, skipped:1` |
| **V03** table scope & grouping (UI + data) | with demo seed present (`GET_DEMO_STATE`, else `SEED_DEMO_DATA` first — an allowed prerequisite) the Tracking page lists only rate-con-sent rows; a ZZ shipment without a sent leg is absent; tabs `My loads` (as the ZZ admin who is assigned one demo load via `ASSIGN_TRACKER`), `All`, `ZZ…` assignee tabs with counts equal to the API grouping, `Unassigned`; `?assignee=` deep link; legacy `?tab=inbox&shipment=<id>` lands on the shipment's Tracking tab |
| **V04** automation off by default | scoped `RUN_TRACKING_AUTOMATION {mode:'AUTO', shipmentIds:[B-shipment]}` on Customer B → `acted 0`, no new `ShipmentMessage` |
| **V05** quiet hours defer | window computed from the current Chicago time (now−1h … now+1h) on Customer A → `deferred ≥ 1`, zero new rows, `nextCheckCallAt` unchanged |
| **V06** check-call send is NOT_SENT with the exact text | quiet hours disabled → rows `kind CHECK_CALL, direction OUT, status NOT_SENT` for SMS and EMAIL, `error` non-empty (Twilio not configured / SES denied), `body` equals `renderTemplate(customerSmsTemplate, vars) + signature` (+ link line), `threadKey === 'tracking+<id>'`; an immediate second run adds no row (cadence not due) |
| **V07** POD once | `SET_LOAD_STATUS` DELIVERED → run → exactly two `POD_REQUEST` rows with ids `auto:pod:<leg>:SMS/EMAIL`, NOT_SENT, template text; rerun → still two; `LoadCarrier.podRequestedAt` set; `podChannels:['EMAIL']` override on a second fixture → one row |
| **V08** reply threads | `INGEST_SHIPMENT_MESSAGE` with `to: ai4bcat+tracking.<id>@gmail.com` and no `shipmentId` → `routed true`, row `IN/RECEIVED` on the same `threadKey`; **system caller**: SDK `InvokeCommand` on `tmsTrackingActions` with `systemCaller:'shipment-email-intake'` ingests; with an unlisted action it is refused (SKIP-allowed `V08b` if the function name cannot be discovered — reason recorded in `SKIP_ALLOWED`) |
| **V09** settings round-trip | `SAVE_TRACKING_AUTOMATION` stores a division override for `BROKERAGE` + global patch; `GET` returns it; a shipment tagged BROKERAGE resolves the division value (checked through a scoped AUTO run on a fixture with no customer override); unknown placeholder → rejected; restores the original `trackingAutomation`/`defaultCheckCallPlan` in `finally` (CAS) |
| **V10** UI walk, light + dark | Tracking page by assignee; shipment overview with the Tracker card; Customer profile default tracker; Settings → Tracking automation (each sub-tab); the shipment Tracking tab showing the NOT_SENT automation messages — all through `createWalk` `audit`/`conclude` (token probe, hook-class assertions, no horizontal overflow at 1600×1000 and the 390×844 phone pass as S4 does) |

`SKIP_ALLOWED` lists only V03's seed prerequisite and V08b. Gate 1/2 inventory (`--inventory`) asserts no `inbox-*` testid is referenced by any script (`grep` in the harness) and that every `V` id is registered.

## 8. Screenshot plan (`Docs/tms-build/screenshots/V/<id>-<slug>-<theme>.png`, light + dark, 1600×1000, `clipToContent` cap 2400; folder is **not** git-ignored, like `S4/`)

| File stem | Content |
|---|---|
| `V03-tracking-by-assignee-all` | All tab: Unassigned section first (amber count), two assignee sections, new columns visible (ETA, next check call, POD badge, Tracker) |
| `V03-tracking-my-loads` | My loads default for the ZZ tracker; assignee tab strip |
| `V03-tracking-row-menu` | Row menu: Request check call / Request POD / Assign tracker |
| `V10-shipment-tracker-card` | Shipment overview with the Tracker card ("inherited from <customer>") |
| `V10-customer-default-tracker` | Customer profile flow defaults with Default tracker + the customer automation editor |
| `V10-settings-automation-defaults` / `-divisions` / `-customers` | Settings → Tracking automation, three sub-tabs; Defaults shows switches, cadence, quiet hours, six templates with live preview and the dev NOT_SENT notice |
| `V10-shipment-thread-automation` | Shipment Tracking tab: automated check-call and POD rows with the **NOT_SENT** badge and error text |
| `V10-mobile-tracking` | 390×844 Tracking page (tabs overflow handled) |
Also refresh the committed review set (`screenshots/review/S2-09-tracking-inbox-*.png` → `S2-09-tracking-by-assignee-*.png`) and delete `screenshots/P8-UI-inbox-conversation.png`.

## 9. Deploy, IAM, EventBridge, and running automation on dev

* **One push** after U and V are both green (Main: typecheck + lint + test once); wait for `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` not RUNNING/PENDING first. The job includes the data deploy (§0.3), the new Lambda, two IAM statements and the frontend. Then `devVerifyV` (and `devVerifyS2`, `devVerifyP`, `devVerifyS3`/`S4` regression), then a BUILD_LOG ledger entry (Main).
* **EventBridge:** exactly one new rule (created by `defineFunction({schedule:'every 5m'})` in the data stack): `tracking-automation` every 5 minutes. Production: it will run the AUTO sweep; with every master switch OFF by default it **sends nothing** until Ryne enables it, and a first sweep after enabling touches only open (`checkCallOpen`) loads and the last 21 days of DELIVERED shipments. Dev: the existing guard (`backend.ts:3461–3470`) sets every `CfnRule` to `DISABLED` — nothing runs on a timer.
* **IAM (additive):** `tracking-automation`: `lambda:InvokeFunction` on `tmsTrackingActions` (resource-based `addPermission`, as the intake). `tmsTrackingActions`: `dynamodb:GetItem` on the `UserProfile` table (+ `USER_PROFILE_TABLE_NAME`), and `dynamodb:Query` on `Shipment/index/*` if absent. SES/Twilio permissions unchanged (SES is already granted to `tmsTrackingActions`; denied on dev by the guard; Twilio config absent on dev).
* **Exercising automation on dev (the explicit door):** (1) Settings → Tracking automation → **Run automation now** (`RUN_TRACKING_AUTOMATION {mode:'AUTO'}`; unscoped but harmless while defaults are off, and reports counts); (2) scripts call `RUN_TRACKING_AUTOMATION` **scoped by `shipmentIds`** (AUTO to test gating, MANUAL for the old sweep semantics); (3) the Tracking page row menu "Request check call"/"Request POD" (MANUAL per shipment). Outputs are `ShipmentMessage` rows `NOT_SENT` with the full body and the provider error, shown in the shipment's Tracking-tab thread exactly as today. To avoid writing NOT_SENT rows across the ~900 copied dev shipments, **never enable the global switches on dev**; enable on a ZZ customer only (what `devVerifyV` does).

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | F9 may be wrong (e.g. the Cognito lookup succeeds for that sub). | Builder B writes the failing test first against current `authorize()`; if it passes, drop only the intake edit and keep the explicit allow-list. |
| R2 | Driver SMS replies may not reach `ShipmentMessage` (webhook `dispatch-twilio-webhook` not verified), so "replies thread" is only guaranteed for e-mail. | B reads the webhook and reports; if it does not ingest, file it as a Decision for Ryne — out of V's scope unless a one-line ingest call suffices. |
| R3 | Enabling auto-POD while `shipment-notifier` also mails an upload link → the carrier gets two POD asks (link e-mail + thread SMS/e-mail). | D-V7: kept deliberately (the thread message is the one a tracker sees and replies to; the link e-mail carries the upload URL). One toggle exists to silence the notifier's: `TmsSettings.podRequestEnabled` (Documents settings), unchanged. |
| R4 | POD pass queries the DELIVERED partition of the `status+pickupAppt` index each 5 min; at 50k+ shipments a 21-day range may be large. | Range-bounded; read cost is per sweep, not per user; if it grows, run the POD pass every 3rd tick (`minute % 15`) — a one-line change. [INFERENCE: volumes unmeasured.] |
| R5 | `useShipments` loads all shipments client-side; Tracking inherits the board's scale limit. | Same as every board today; the sparse-GSI escape hatch is described in §1.2. |
| R6 | Quiet-hours timezone is the company's, not the driver's; a driver in Pacific time is texted at 8 pm local. | D-V6; the model already carries `timezone` per policy so a later "stop-local" mode is additive. |
| R7 | Removing `requestPodOnDelivery` changes behaviour for anyone who relied on the DELIVERED-milestone POD from a manual run. | The manual "Request POD" button stays; a run-now no longer double-asks. Stated in the commit. |
| R8 | `ShipmentRow.pendingDocReviewCount` as POD "in review" proxy may mislabel. | Contained to one pure function with a test; refine later. |
| R9 | Two builders editing one file. | §4.1 serialization; every V hunk located by symbol, not line number (line numbers above are advisory and drift after U lands). |
| R10 | Tracker default silently stale (user deactivated). | Create ignores inactive defaults; Customer profile shows "inactive user" via `RepPicker`'s existing unknown-user badge. |

## 11. Decisions for Ryne (each has a default; work does not wait)

| # | Decision | Default taken |
|---|---|---|
| **D-V1** | Who can be a tracker | Any **active user**; no new role/team required (a `trackers` team, if you create one, is just listed first). Alternative: a TRACKER role (touches `roles.ts`, U's file). |
| **D-V2** | What counts as "rate confirmation sent" | `SENT`, `OPENED` or `SIGNED` on the active leg. Excludes `NOT_SENT/DECLINED/VOIDED/EXPIRED`, Aljex-era loads with only a PDF on file, and own-fleet loads — one toggle ("Include loads without a TMS rate con") widens it. On dev only the demo seed qualifies. |
| **D-V3** | Customer default tracker vs existing shipments | Applied at **create** (and when an empty shipment gets its customer). Changing the customer's default does not rewrite open shipments; reassign from the Tracking table (bulk). |
| **D-V4** | Automation master switches | **Off** everywhere until you turn them on (global, per division, or per customer). Turning on the global switch starts texting/e-mailing carriers on every rate-con-sent load in production. |
| **D-V5** | Quiet hours | 21:00–06:00, silences **SMS only**, defers rather than drops; manual actions ignore it. |
| **D-V6** | Quiet-hours timezone | Company time, **America/Chicago**; per-policy zone selectable. Recipient-local ("the driver's next stop") not built. |
| **D-V7** | POD automation | One automatic ask per leg per channel (no reminders); the notifier's upload-link e-mail is **kept**. Reminder cadence and suppressing the notifier mail are follow-ups. |
| **D-V8** | Templates | Apply to cadence check calls and POD asks; milestone ("are you loaded?") and escalation wording stay built-in. |
| **D-V9** | Own-fleet (Ivan Cartage) legs | Excluded from automation (driver app/ELD already reports). |
| **D-V10** | Notifying the tracker | Not in V: `check-call-notifier` still Slack-DMs the carrier rep and the bell is unchanged. Making the tracker the recipient is a small follow-up (notifier needs a `Shipment` read). |
| **D-V11** | Org-wide default tracker | None (customer default only). |
| **D-V12** | Tracking page default view | **My loads** when you have any, else All; lifecycle **Active / POD due / Closed**. |
| **D-V13** | Saved views on Tracking | Dropped (U removes shipment views/queues; assignee tabs replace them). |
| **D-V14** | Plan flag `requestPodOnDelivery` | **Removed**; the POD switch lives in the automation policy (default off). Existing stored plans keep working. |
| **D-V15** | Who may do what | Assign trackers: owner/ADMIN/`page-tms`/`page-loads` (same as sales rep). Automation settings: owner/ADMIN. Run automation now (AUTO): any TMS user; MANUAL: owner/ADMIN. |

## 12. Definition of done (Main, after A–F report)

1. `npm run typecheck && npm run lint && npm run test` green once, with U's work in the tree; hex-literal guard and `theme.scope.test.ts` clean; `grep -rn "inbox-\|InboxPanel\|tab=inbox" src scripts` returns only the legacy-redirect test/effect.
2. One commit (message: what changed and why; "additive schema; forces data deploy; new scheduled Lambda; no new dependency"), one push, Amplify job green.
3. `devVerifyV` all PASS (SKIPs only the allowed ones), `devVerifyS2/S3/S4/P` regression-green, screenshots written, BUILD_LOG ledger entry (Main).
4. No temp artifacts committed; no `invoice_*.json`; ZZ residue check passes; `main` untouched.
