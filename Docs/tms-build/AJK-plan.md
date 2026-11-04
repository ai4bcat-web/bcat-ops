# Steps AJ + AK — Load Tracking simplification (AJ) and per-truck driver work phones (AK)

Status: PLAN (recon complete, **dev only**). Built later by `task` agents (≤ 6 builders, one deploy). Nothing here touches `main`, production, SSM, `invoice_*.json` or the Aljex export; neither the plan nor the builders commit, push or deploy. No PII is printed anywhere (harness output carries ids, counts and masked numbers only).
Author: AJKPlan, 2026-11-04. Sources: Ryne's brief (verbatim intent in the assignment), `Docs/tms-build/mvmnt-ui/tracking-submenus-remove.png` (read as an image), and a read of the working tree on `dev` at `a8e320e` (clean except that PNG). Conventions inherited from `S1…AH-plan.md`: kit + `var(--tms-*)` tokens only, `data-testid` for the harness, one owner per shared file, **additive** backend only, behavioural tests only, `scripts/devVerify*.mjs` pattern, clean cutover (migrate every caller, no shims).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **The screenshot is the current rail, not a mock.** Load Tracking is expanded: parent badge `2` (= `loadTracking` composite = check calls due + documents awaiting review), child **Tracking** with badge `26` (= `tracking`, the moving-loads count) **and a 6-row live list of shipment links** (`99261 Fastener Plus` … `99271 Hawthorne Auto`), then **Check calls** (badge 2), **Document review**, **Customer links**. Nothing in the image is marked for removal; "remove ALL submenus" is Ryne's text. | PNG; `navSections.ts` L144-158 (`PINNED_ITEMS`); `TmsLayout.tsx` L77-85 (`trackedLoads`, `slice(0, 6)`); `TmsShell.tsx` L161-165 (`childrenFor` adds `live` to the `TRACKING_PATH` child), `NavChildRow` L167-215; `useShellBadgeCounts.ts` L94/L104/L122 | Delete **four children and the live list** (not just four children): `children` array, `live`/`TmsLiveChild`/`trackedLoads`/`TRACKING_PATH`/`.tms-nav-live*`, the `tracking` badge key, `movingShipments` (only `TmsLayout` + its own test use it). The parent keeps the composite `loadTracking` badge (due check calls + docs to review) so the numbers Ryne sees today do not vanish. |
| F2 | **The grid (Step AC) already carries most of what the old pages show.** `ShipmentRow` has `nextCheckCallAt`, `lastCheckCallAt`, `lastCheckCallType`, `checkCallOpen`, `openIncidentCount`, `pendingDocReviewCount`, `docsMissing`, `podRequestedAt`; `trackingColumns.ts` already has `nextCheck` and `pod`. The old worklists are *filters* of the same rows, so they become a **Focus** control on the board plus two columns and row actions. | `shipmentViews.ts` L73-87; `useShipments.ts` L41-46/L414-474; `trackingColumns.ts` L102-205; `trackingTable.ts` `podStateOf` L25-32, `nextCheckCallStateOf` L147-155 | No new read path. Check-call work (log, snooze, resolve) and document review (accept/reject) are **moved**, not rewritten: `CheckCallsPage.tsx` / `DocumentReviewPage.tsx` are deleted after their working parts are extracted (§3.4). |
| F3 | **Row click today navigates away** (`openShipment` → `/tms/shipments/:id?tab=tracking`), and `?shipment=<id>` is a *legacy redirect to that page*. There is no drawer on the grid. The reusable right-docked drawer is `TmsDrawer` (`size="xl"` = `max-width: min(1040px,100vw)`, `kit.css` L449) and `useShipmentContext(shipmentId, options, onChanged)` gives bundle + actions (`ShipmentDrawer.tsx` L64-65). | `TrackingWorkstation.tsx` L81-88/L104-111; `TrackingWorkstation.test.tsx` L189-196/L259-262 | New `TrackingDrawer` (URL-driven by `?shipment=<id>`) built on `TmsDrawer` + `useShipmentContext`; its body is the **same component** the full-page Tracking tab mounts (`ShipmentTrackingView`), so drawer, page and deep link never drift. The old "`?shipment=` → shipment page" redirect is repurposed to "opens the drawer" (a bookmark still lands somewhere sensible). |
| F4 | **The shipment thread is one mixed stream with a channel select**, not two panes: `TrackingConversation` (746 lines) holds recipient (`driver`/`dispatcher`) + channel (`SMS`/`EMAIL`/`VOICE` disabled) selects, kind pills, cards, attachments (e-mail only) and the server-signed composer; it is mounted inside `TrackingDetailPanel.DetailSession` as `TmsCard title="Thread — <PRO>"`, which `TrackingSection` mounts on the Tracking tab. `NOT_SENT` already renders "Would have sent:" (`ThreadRow`). Recipient addresses come from the **client** (`driver.phone`/`dispatcher.email` from `LoadCarrier`), and `SEND_SHIPMENT_MESSAGE` uses `to` as given (`thread.ts` L297-303). | `TrackingConversation.tsx` L379-440, L460-560; `TrackingDetailPanel.tsx` L180-196; `thread.ts` L171-312 | Add a **single-channel mode** to `TrackingConversation` (`lockChannel: 'SMS' \| 'EMAIL'`) instead of writing a second composer; two instances = the two panes. SMS pane sends `party:'DRIVER', to:null` and the **server** picks the number (AK rule below), so a stale client can never text the wrong phone. |
| F5 | **There is no "Settings > Trucks".** The Trucks UI is the Fleet page `/trucks` (`TrucksPage.tsx`, nav label "Fleet", section ASSETS, `pageKey 'trucks'`), table columns Equipment · Plate · Compliance · Assignment · Open Tasks · Repair Spend. `TruckConfig` is held in that page's **local state** (`truckConfigs` Map, L1016, `listTruckConfigs()` L1025) and written **client-side straight over AppSync** by `upsertTruckConfig` (update-then-create) — no Lambda. Settings has no truck card. | `TrucksPage.tsx` L1004-1060, L1270-1330; `apiClient.ts` L5555-5599; `navItems.ts` L72 | Phone column + inline editor go on **Fleet** (the real Trucks UI). "Settings" gets a read-only-plus-quick-fix card **"Truck work phones"** (the "Trucks without a phone" report) on `SettingsPage`. Both use one shared editor (`TruckPhoneEditor`). D-AK1. |
| F6 | **`TruckConfig` already has `assignedPhone` (free text, unused in `src/`)** and **`CompanyPhone`** exists ("Ivan Cartage #1…", keyed by device label, `assignedDriverId`; UI `IvanPhones.tsx` on the Files hub; helper `src/lib/companyPhones.ts`). `CompanyPhone` is the existing driver-keyed "work phone" precedent. Ryne's AK rule is truck-keyed. | `resource.ts` L3947, L3963-3975; `IvanPhones.tsx`; `FilesPage.tsx` L455 | Add the new `TruckConfig.phone` / `phoneLabel` exactly as specified; **leave `assignedPhone` and `CompanyPhone` untouched** (different meaning: DOT-onboarding inventory / driver-assigned devices). Surfaces say "Work (truck 12)", never "Company phone". D-AK2 flags the overlap for Ryne. |
| F7 | **Driver→truck is `Driver.assignedTruckId`** (Equipment.id), not `Driver.truckId`; `TruckConfig.truckId` is also Equipment.id; an own-fleet leg carries `LoadCarrier.truckId`/`truckNumber`/`driverId`/`driverPhone` (the phone is a **snapshot of `Driver.phone` written once by `assignAssetCore`**, `tms-shipment-actions/handler.ts` L4562-4563 → L4641-4642). Every SMS-to-driver path reads that snapshot. | `resource.ts` L274 (Driver), L2095-2101 (LoadCarrier); `checkCallAgent.ts` L437/L464; `podReview.ts` L93/L105; `automation.ts` L156; `tms-tracking-actions/handler.ts` L819 (SEND_TRACKING_LINK), L1267 (TEXT_DRIVER); `thread.ts` | Resolve the number **at send time on the server** from `TruckConfig.phone` (load's truck, else the driver's assigned truck) with the snapshot as the personal fallback. **No change to `assignAssetCore` and no backfill of `LoadCarrier.driverPhone`**: the snapshot stays "personal", brokered legs (no `truckId`) behave exactly as today. |
| F8 | **The auto agent and POD pass only act on brokered carrier legs** (`carrier.kind !== 'CARRIER'` → "Not a brokered carrier leg", `checkCallAgent.ts` L228-231; `automation.ts` ~L137). Own-fleet (Ivan) legs are reached only by a person ("Request check call", the composer, `TEXT_DRIVER`, SEND_TRACKING_LINK). | same | AJ's mode/method gate applies to **both** paths (AUTO and manual run); AK's phone routing applies wherever an own-fleet driver is texted. Widening the AUTO gate to own-fleet legs is a *behaviour change nobody asked for* → not done; D-AJ6 asks Ryne. John Brittich's seeded truck phone is therefore exercised on dev by the manual paths. |
| F9 | **Customer already carries the Step V fields** (`defaultTrackerId`, `trackingAutomation` JSON, `checkCallPlan` JSON); writes go through `tms-directory-actions` `UPSERT_CUSTOMER` with a field-by-field item literal where "absent key keeps stored value" (`'x' in input ? … : existing?.x ?? null`). The frontend hides fields the stack does not yet have behind `CUSTOMER_V6_FIELDS`. `Shipment` has **no JSON bag** for tracking config. | `resource.ts` L861-980; `tms-directory-actions/handler.ts` ~L1085-1150, case L3274; `apiClient.ts` L1298-1303, L1572-1576; `TrackerCard.tsx` L31 | Customer gets three nullable enum fields; Shipment gets **one** nullable JSON `trackingPrefs` (override only). "New shipments inherit" is implemented as **resolve-at-read** (override ?? customer), not copy-at-create — a customer change then applies to its open shipments and pre-AJ shipments need no backfill. |
| F10 | **Step V's precedence has no shipment layer** and `resolveAutomation` returns `policy`/`plan` only; the Customer sits on top of global/division. `checkCallsAuto`/`podAuto` remain the *master switches*. | `src/lib/trackingAutomation.ts` L234-310 | `trackingMode` is a separate, stricter gate: `MANUAL` blocks every automatic request; `AGENT` does **not** override a switch that is off (it means "the agent may track this customer", not "turn automation on"). `trackingMethod` *intersects* the plan's channels; it never adds one. D-AJ2/D-AJ3. |
| F11 | **Tracking texts go through Dispatch** (`textInto(phone, body, sentBy, label)` creates/uses the driver's Dispatch conversation keyed by the **number** so replies surface in Dispatch and the shipment thread). Dev has **Twilio unset** → SMS rows land `NOT_SENT` with "Would have sent". Dev driver rows were copied from prod (`refreshDevFromProd.mjs` copies the roster), so **a configured Twilio on dev would text real drivers' personal numbers**. | `tms-tracking-actions/handler.ts` L769-780, L2318-2323; `devDemoY`/BUILD_LOG ("NOT_SENT on dev") | Truck-phone routing makes a dev test safe (John's truck → Ryne). Reply routing for a text sent to a *truck* number is verified by the harness (§9, step 6) and listed in risks (R3). |
| F12 | **Nothing writes an inbound SMS into `ShipmentMessage` today.** The only inbound writer is `shipment-email-intake` (e-mail). The Twilio webhook (`dispatch-twilio-webhook/handler.ts` `inboundSms` L~125-220) stores the text in the driver's **Dispatch** conversation and matches a sender to a driver **only by `Driver.phone`** (`matchDriverByPhone`, `src/lib/dispatch.ts` L220-226, fed by the roster loader `drivers(store, nowMs)`); a text from a truck work phone that has never been texted first would open an unlinked "not a driver on file" conversation. | `dispatch-twilio-webhook/handler.ts` L125-220/L248-250; `thread.ts` `ingestShipmentMessage` L332 (already accepts `channel:'SMS'`, `shipmentId`, `party`); `tms-tracking-actions/handler.ts` L346-348 (`SYSTEM_CALLERS`: `'tracking-automation'`, `'shipment-email-intake'`) | Without a bridge the SMS pane (left) would show only what *we* sent. §4.6 adds a conservative bridge (webhook → `INGEST_SHIPMENT_MESSAGE` as a new system caller) and teaches the roster match about work phones. This is **required for the two-pane conversation to be a conversation**; D-AJ9. |

### 0.2 Decisions

Consolidated with defaults in §12 (D-AJ1…D-AJ8, D-AK1…D-AK7). Needing Ryne's eyes: **D-AJ6** (own-fleet legs in the auto agent), **D-AK1** (where "Trucks" lives), **D-AK2** (`assignedPhone`/`CompanyPhone` overlap).

### 0.3 Schema and deploy impact — stated plainly

* **GraphQL schema: additive only, 6 nullable fields, no new model/index** (`amplify/data/resource.ts`): `Customer.trackingMode` (enum `AGENT|MANUAL`), `Customer.trackingMethod` (enum `EMAIL|SMS|BOTH`), `Customer.driverSmsTarget` (enum `WORK_THEN_PERSONAL|WORK_ONLY|PERSONAL`), `Shipment.trackingPrefs` (`a.json()`), `TruckConfig.phone` (`a.string()`, E.164), `TruckConfig.phoneLabel` (`a.string()`).
* **Lambdas (code, additive, one deploy):** `tms-directory-actions` (allow-list), `tms-shipment-actions` (new `SET_TRACKING_PREFS`), `tms-tracking-actions` (gate + phone routing; **new env `TRUCK_CONFIG_TABLE_NAME`, `DRIVER_TABLE_NAME` + `dynamodb:GetItem` grants** in `backend.ts`), `driver-app-api` (`/me` gains work-phone fields; **new env `TRUCK_CONFIG_TABLE_NAME` + `GetItem`**), `dispatch-twilio-webhook` (work-phone sender match + SMS→shipment-thread bridge; **new env `TMS_TRACKING_ACTIONS_FUNCTION_NAME`, `TRUCK_CONFIG_TABLE_NAME`, `lambda:InvokeFunction` grant** in `backend.ts`).
* **Client:** one nav row, redirects, a Focus control + two columns on the board, `TrackingDrawer` / `ShipmentTrackingView`, customer/truck/driver surfaces, deletions listed in §10.
* **Production:** see §11 — additive fields, **no backfill**, behaviour unchanged until someone sets a value.

### 0.4 Slice map (6 builders, disjoint files — details §10)

| Slice | Owns | Landing |
|---|---|---|
| **S1 CONTRACT** | `resource.ts` (all 6 fields), `types/tms.ts`, `src/lib/{trackingPrefs,workPhone}.ts`(+tests), `apiClient.ts` (append block + field lists + wrappers), `tms-directory-actions` allow-list, `tms-shipment-actions` `SET_TRACKING_PREFS`, `useTruckConfigs`, `DriverPhones` component | **first** |
| **S2 LAMBDAS** | `tms-tracking-actions/*` (gate + routing), `dispatch-twilio-webhook` + `src/lib/dispatch.ts` (inbound bridge), `backend.ts`, `driver-app-api` | parallel after S1 |
| **S3 NAV + GRID** | nav/shell/layout/badges/routes/redirects, board Focus + columns + row actions, extracted review/log-call pieces, notification links, Settings › Tracking link | parallel after S1 |
| **S4 TRACKING VIEW** | `ShipmentTrackingView`, `TrackingDrawer`, summary strip, two panes (`TrackingConversation` single-channel mode), recent check calls, per-shipment override popover, `TrackingSection`/`TrackingDetailPanel`/`DriverCard` edits | parallel after S1 |
| **S5 CUSTOMER + TRUCKS UI** | customer create/profile tracking fields, Fleet phone column + editor, Settings "Truck work phones" card | parallel after S1 |
| **S6 DRIVER SURFACES + INTEGRATION** | driver profile/drawer, Files hub row, Dispatch, Schedule, driver-app header, seed script, route registries, `devVerifyAJ.mjs`, merge checklist, screenshots | last; **integration owner** |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (what exists; anchors the builders start from)

### 1.1 AJ — navigation, routes, pages

| Area | Anchor | Fact |
|---|---|---|
| Nav definition | `src/lib/navSections.ts` L144-158: `PINNED_ITEMS` entry `{ to:'/tms/tracking', label:'Load Tracking', icon: Activity, pageKey:'loads', badgeKey:'loadTracking', children:[Tracking(badgeKey 'tracking', exclude ['/tms/tracking/links']), Check calls('checkCalls'), Document review('documentReview'), Customer links] }` | pageKey for all four is `loads` (+`tms`); permissions need no change. |
| Breadcrumbs | `navSections.ts` L223/L243-246: `LOAD_TRACKING` crumb + rules for `/tms/tracking`, `/tms/tracking/links`, `/tms/check-calls`, `/tms/documents/review` | `/tms/tracking/links` rule stays (route stays); the two removed paths lose their rules. |
| Shell rows | `TmsShell.tsx` L28-45 (`TmsLiveChild`, `live`), L127 `TRACKING_PATH`, L161-165 `childrenFor`, L167-215 `NavChildRow` (caret + `.tms-nav-live`), L222-240 `NavRow` (`trackedLoads` prop), `TmsShellProps.trackedLoads` L105, default `[]` L458, `rowProps` L527 | `live` machinery exists only for this one child. |
| Layout | `TmsLayout.tsx` L20 (`movingShipments` import), L23 `DENSE_PATHS` (already contains `/tms/tracking`), L77-85 `trackedLoads`, L112 prop | `/tms/tracking/links` is deliberately **not** dense (test L145). |
| Badges | `useShellBadgeCounts.ts` L35-40 `movingShipments`, L74-76 `useCheckCallWorklist`/`useDocumentReviewQueue`, L94 `tracking`, L104 `tracking`, L114-115 `checkCalls`/`documentReview`, L122 `loadTracking: checkCallsDue + documentReviewCount` | Keep the composite and its two inputs; drop `tracking`. `navItems.ts` L78/L81 (legacy permission rows) still name `checkCalls`/`documentReview` — leave. |
| Routes | `App.tsx` L29/33/34/37 imports; L164 `tracking`→`TrackingWorkstation`, L165 `tracking/links`→`CustomerLinksPage`, L166 `documents/review`→`DocumentReviewPage`, L167 `documents/*`→`Navigate /tms/documents/review`, L168 `check-calls`→`CheckCallsPage`; legacy L208 `/check-calls`→`ParamRedirect /tms/check-calls`, L209 `/documents`→`Navigate /tms/documents/review` | All guarded `RequirePage page={['loads','tms']}`. |
| Check calls page | `src/features/tracking/CheckCallsPage.tsx` (264 lines): `useCheckCallWorklist`, `useOpenIncidents`, tabs Overdue/Due/Scheduled/Exceptions, per-row `LogCheckCallDialog` (same dialog + CAS token as the Tracking tab), snooze 1 h (`setNextCheckCall({loadId, expectedUpdatedAt, nextCheckCallAt})`), `resolveIncident`, `textDriver` | The three *actions* survive on the grid/drawer; the page goes. `useCheckCallWorklist` stays (badge + notifications). |
| Document review page | `src/features/documents/DocumentReviewPage.tsx` (338 lines): `useDocumentReviewQueue`, shipment context fetch (`getShipmentBundle`), `DocumentPreview`, accept (type pick) / reject (note) → `reviewDocument({documentId, decision, type|note})`; tests pin the exact payloads | Extract `DocumentReviewPanel` (queue-agnostic: takes `documents`, `onDecided`); page deleted. |
| Customer links page | `src/features/shipments/workstations/CustomerLinksPage.tsx` (410 lines, `data-testid="customer-links-page"`, back button "Back to Tracking"); drawer-side equivalent already exists: `TrackingSection` buttons "Customer link" + `CustomerLinkDialog` + `listTrackingLinksByShipment`; the grid row menu "Create customer URL" (`openCustomerLinkDialog`) | Page **stays as an off-nav route** (revoke/extend across shipments is its job); reached from the drawer ("Manage all links") and a small link in Settings › Tracking. D-AJ5. |
| Board | `TrackingBoard.tsx` (676 lines): `PAGE_SIZE`, `LIFECYCLE_TABS` (Active · POD due · Closed), `VIEW_TABS` (Table/Map), `GROUP_OPTIONS`, `useDenseGridPrefs({gridId:'tracking', defaultColumns: TRACKING_DEFAULT_COLUMNS, defaultSort lastLocation, defaultGroupBy 'assignee'})`, `renderCell` switch (L196-250), `kpis`, `RowMenu` (Open · Create customer URL · Request check call · Request POD · Assign tracker). `TrackingBoardProps` in `tracking/types.ts` (callbacks `onOpenShipment`, `onManageLinks`, `onCreateCustomerUrl`, `onRequestCheckCall`, `onRequestPod`, `onAssignTracker`) | Focus control, 2 columns, 3 row actions are additive to this component. |
| Workstation | `TrackingWorkstation.tsx` L55-234: lifecycle/assignee/search state, `?assignee=`, legacy `?shipment=` redirect effect (L72-76), `openShipment` (L104-111 → navigate), `openCustomerLinkDialog`, `handleRequestCheckCall` (`runCheckCallPlan({shipmentId})`), `handleRequestPod`, `handleAssignTracker` | Owner of URL state (`assignee`, new `focus`, new `shipment`). |

### 1.2 AJ — thread, summary data, customer, automation

| Area | Anchor | Fact |
|---|---|---|
| ShipmentMessage | `resource.ts` L2758-2815: `channel EMAIL\|SMS\|VOICE`, `kind`, `party DRIVER\|DISPATCHER\|CARRIER\|CUSTOMER\|INTERNAL`, `to/from/subject/body`, `status SENT\|NOT_SENT\|FAILED\|RECEIVED`, `authorKind AGENT\|PERSON`, `loadCarrierId`, `at`; index `shipmentId+at`. Read: `listShipmentMessages(shipmentId)` (`apiClient.ts` L7945, sorted by `at`). Write: `sendShipmentMessage` (L7952 → `trackingAction('SEND_SHIPMENT_MESSAGE')`). | Pane filter = `channel`; SMS pane party = DRIVER, e-mail pane party = DISPATCHER (inbound rows carry `party`, default DRIVER). |
| Composer/Lambda | `thread.ts` `sendShipmentMessage` L171-312 (signs server-side, `NOT_SENT` on dev, e-mail requires subject/body, SMS requires `to`); `handler.ts` L2459 `SEND_SHIPMENT_MESSAGE`; `ThreadDeps.tables` (`message, shipment, order, load, loadCarrier, customer, settings, document, checkCall, trackingLink`) | New optional dep `resolveDriverSms` (§4.3). |
| Recent check calls | `useLoadTracking` (`hooks/useLoadTracking.ts`) returns `events` (LoadCheckCallRecord[]: `at, type, city, state, source, createdBy, personName, statusAfter, incidentOpen`), `links`, `lastKnown`, `timeline`, `nowMs`, `refresh` | "Recent check calls" = `events` sorted desc, first 5. |
| Summary inputs | `legGeometry(bundle, id)` (`statusTimeline.ts`), `checkCallState(load, now, grace)` (`lib/checkCalls`), `podStateOf(row)` (`trackingTable.ts`), `etaOf(row, nowMs)`, `loadCarrier.deliveryEtaAt`, `carrier.dispatcherName/Phone/Email`, `carrier.driverName/driverPhone/truckId/truckNumber` | `summaryOf()` pure fn in §3.5. |
| Customer | `resource.ts` L861-980 (last field L975 `trackingAutomation`; auth `authenticated().to(['read'])`), `CustomerRecord` `types/tms.ts` L288-291, form `directory/components/{CustomerForm.tsx (tabbed; Settings tab has Default tracker L146), useCustomerForm.ts (CustomerFormValue L119-122, emptyCustomerForm ~L197, toRecord ~L329), CustomerProfile.tsx (FlowDefaultsCard L431, 'Tracking automation' TmsCard L445-452)}`, modal `DirectoryPages.tsx` `CustomerModal` L436-444 (new → `dir.addCustomer`, edit → `dir.saveCustomer`) | Add a `TrackingPrefsFields` group, not a new tab. |
| Step V code | `src/lib/trackingAutomation.ts` `resolveAutomation` L234, `isQuietNow` L318; `checkCallAgent.ts` `runCheckCallPlan` L191 (customer already loaded L205-211; `enabled = resolved.plan.channels.filter(isChannelEnabled)` L225; AUTO `blocked` chain L227-232; quiet filter L308-316; `hasSms`/`hasEmail` L436-438; SMS send L453-470 `to: carrier!.driverPhone`; EMAIL send L472-488; escalation e-mail L361-383); `automation.ts` `runTrackingAutomation` L66 (check-call pass calls `runCheckCallPlan(…,{mode})`; POD pass L137-215 with `recipients` filter L156, `policy.podChannels`, `requestPodForLeg`); `podReview.ts` `requestPodForLeg` L73-110 (`carrier.driverPhone` L93/L105) | Insert points in §4. |
| Settings › Tracking | `SettingsPage.tsx` L56-57 `<TrackingSettingsCard/>` then `<TrackingAutomationCard/>` (`SettingsCard` + `Stack` from `settingsKit`) | Small `Link` to `/tms/tracking/links` added to `TrackingSettingsCard`. |

### 1.3 AK — truck, driver, phone surfaces

| Area | Anchor | Fact |
|---|---|---|
| TruckConfig | `resource.ts` L3933-3956 (PK `truckId`; `unitNumber` required; `assignedPhone` L3947; `disableOperations(['subscriptions'])`; `allow.authenticated()` full CRUD); TS `TruckConfig` interface + `TRUCK_CONFIG_FIELDS` + `listTruckConfigs` (limit 100, **no pagination**) + `upsertTruckConfig` (update, falls back to create on *any* error) `apiClient.ts` L5555-5599; Lambdas write it directly (motive sync, compliance-scanner) | New fields are additive; `upsertTruckConfig` input type grows. |
| Fleet page | `TrucksPage.tsx`: `truckConfigs` state L1016, load L1025, `handleOwnershipChange` L1033-1046 (optimistic), table header L1288-1310 (`['Equipment','equipment'] … ['Repair Spend','repairSpend']`), `<EquipRow … colSpan={7} ownershipType onOwnershipChange>` L1329-1343, mobile card list L1255+, `driverForTruck(e.id, drivers)` (`files/entityPacket`) | Phone column inserted after Assignment; `colSpan` 7→8; sort key `phone`. |
| Driver | `resource.ts` L265-346 (`phone` required L268, `assignedTruckId` L274); `DriverDrawer.tsx` (Phone field L298-301 `normalizePhone` L43-47, Assigned Truck select ~L354, save L172-195 → `assignTruckToDriver`); store `useAppStore` (`drivers`, `equipment`, `assignTruckToDriver` L475/748 keeps `Equipment.assignedDriverId` in step) | Drawer gets a read-only "Work phone" line under Phone. |
| Driver profile (staff) | Files hub: `FilesPage.tsx` driver row L381 (`formatPhone(d.phone)`), `EntityFilePanel.tsx` header (`onEditDriver` L305) | Both show Work/Personal. |
| Dispatch | `DispatchPage.tsx` L239-300 header of the selected conversation: `prettyPhone(selected.phone)` + Call/Text (`selected.phone` is the **conversation's** number), `selectedDriver`, `selectedUnits` ("🚛 truck / trailer" from the driver file), `TruckAssignSelect`; `ConversationList.tsx` L70/78 (phone per row); `DispatchDialogs.tsx` L35/62/125 (pick-a-driver lists) | Header shows Work/Personal when the conversation is a driver; list rows unchanged. |
| Schedule | `calendar/SchedulerView.tsx` L214-263 resource label: `{formatPhone(driver.phone)} · {loadCount}`; `schedule/SchedulePage.tsx` + `schedule/sms.ts` build copy-paste schedule text (no phone) | Calendar label gets two lines; schedule text unchanged (it is *to* the driver — see D-AK6). |
| Ivan driver app | `features/driver-app/DispatchBar.tsx` (pinned header strip: dispatcher/dispatch lines with Call/Text), `driverApi.ts` `DriverProfile` L86-110 (`dispatchPhone`, `dispatcher`, `truck`), `useDriverProgram.ts` (`useDriverProfile`, `refreshDriverProfile`), server `driver-app-api/handler.ts` `/me` ~L2480-2504 (`truck: await truckForDriver(driver)` L1821, `dispatchPhone`, `dispatcher`) | Header gains a "Your work phone · truck 12" line (display-only, `tel:` link). Staff view `/driver-view/:driverId` renders the same component. |
| SMS destination | see F7 | one resolver (§4.3). |
| Seed/harness patterns | `scripts/seedDemo.mjs` (dry-run default, hard-coded dev API guard), `scripts/backfillOwnAssetDrivers.mjs` (direct DynamoDB, `DEV_TABLE_SUFFIX 'nc3jsnxdmjhkpequimypiatkma-NONE'`, refuses prod suffix `5ucwdyvwivelbo4k4jomvrwel4`), `scripts/lib/devIdentity.mjs` (`DEV_API`, `DEV_POOL`, `mintIdentity`, `deleteIdentity`, `gql`, `routerAs`), `scripts/devVerifyV.mjs`/`devVerifyAH.mjs` (inventory flag, ZZ fixtures, `finally` cleanup, screenshots to `Docs/tms-build/screenshots/<step>`) | §8, §9 follow these. |
| Merge checklist | `Docs/tms-build/BUILD_LOG.md` `### MERGE-TO-MAIN CHECKLIST` (L672-720, "Before the merge" / "After the merge" lists) | §11 adds bullets there. |

---------------------------------------------------------------------------------------------------

## 2. Data model (additive only)

### 2.1 `amplify/data/resource.ts`

```ts
// Customer — after `trackingAutomation` (L975), before the closing `})`
trackingMode:    a.enum(['AGENT', 'MANUAL']),                          // null = legacy: Step V switches decide
trackingMethod:  a.enum(['EMAIL', 'SMS', 'BOTH']),                     // null = plan channels as configured
driverSmsTarget: a.enum(['WORK_THEN_PERSONAL', 'WORK_ONLY', 'PERSONAL']), // null = WORK_THEN_PERSONAL

// Shipment — after `trackingFlagReason` (L1979); override only, null/absent = inherit the customer
trackingPrefs:   a.json(),   // { mode?, method?, driverSms? }  (same enums; unknown keys dropped on read and write)

// TruckConfig — after `assignedPhone`
phone:           a.string(), // the work phone physically in this truck, E.164 (+1XXXXXXXXXX); null = none
phoneLabel:      a.string(), // free label, e.g. "Cab phone"; shown beside the number
```

Notes: no index; `Customer`/`Shipment` writes stay Lambda-only, `TruckConfig` stays client-writable like today (validation is client-side + `toE164Strict` at send time — R4). The three Customer enums are `a.enum` like the neighbouring `invoiceFrequency`-style fields; the Shipment override is JSON because it is sparse and three-keyed (`SET_TRACKING_PREFS` is its only writer). Data-stack size: six scalar attributes — Main re-runs `scripts/measureDataTemplate.mjs` once (checklist, §11).

### 2.2 TypeScript surface (`src/types/tms.ts`, `src/lib/apiClient.ts`)

* `CustomerRecord`: `trackingMode?: TrackingMode | null`, `trackingMethod?: TrackingMethod | null`, `driverSmsTarget?: DriverSmsTarget | null` (types re-exported from `lib/trackingPrefs.ts`, the way `AutomationPolicyPatch` is at L13-17).
* `ShipmentRecord` (L1822 neighbourhood): `trackingPrefs?: TrackingPrefsOverride | null`.
* `apiClient.ts`: `CUSTOMER_V6_FIELDS` (L1299) gains the three Customer names (the legacy-stack strip list; enums are not in `CUSTOMER_JSON_FIELDS`); new `SHIPMENT_TRACKING_PREFS_FIELDS = ['trackingPrefs']` + `shipmentsHaveTrackingPrefs` flag beside `SHIPMENT_TRACKER_FIELDS` (L2080-2082) and `'trackingPrefs'` in the shipment JSON-parse list; `TruckConfig` interface (+`phone?`, `phoneLabel?`), `TRUCK_CONFIG_FIELDS` (+`phone phoneLabel`), `upsertTruckConfig` input (+`phone`, `phoneLabel`; send `null` to clear); wrapper `setTrackingPrefs(input: { shipmentId: string; prefs: TrackingPrefsOverride | null }): Promise<{ shipment: ShipmentRecord }>` → `shipmentAction('SET_TRACKING_PREFS', …)`.
* `DriverProfile` (`driver-app/driverApi.ts` L86-110): `workPhone?: { number: string; label: string | null; truckNumber: string | null } | null` (optional: older API).

### 2.3 Where it is read/written

| Field | Written by | Read by |
|---|---|---|
| `Customer.trackingMode/Method/driverSmsTarget` | `UPSERT_CUSTOMER` (allow-list, S1) from create dialog + profile (S5); optional bulk via existing `CustomersPanel`? **no** (D-AJ8) | `effectiveTrackingPrefs` (lib) ← `runCheckCallPlan`, `runTrackingAutomation` POD pass, `requestPodForLeg`, `textDriver`, composer, UI badges |
| `Shipment.trackingPrefs` | `SET_TRACKING_PREFS` (S1 Lambda, page `loads`/`tms`, same guard as `ASSIGN_TRACKER`) from the drawer popover (S4) | same readers |
| `TruckConfig.phone/phoneLabel` | Fleet editor / Settings card (`upsertTruckConfig`, S5), seed script (S6) | `workPhoneFor` ← server routing (S2), `useTruckConfigs` ← every display surface |

---------------------------------------------------------------------------------------------------

## 3. AJ design

### 3.1 Navigation — one item

`navSections.ts` `PINNED_ITEMS` entry becomes:

```ts
{ to: '/tms/tracking', label: 'Load Tracking', icon: Activity, pageKey: 'loads', section: BROKERAGE, tms: true, badgeKey: 'loadTracking' }
```

* No `children`. `TmsShell.NavRow` already renders a plain `NavLink` + badge when `items`/`groups` are empty; row is active for `/tms/tracking` and anything under it (so `/tms/tracking/links` still lights it).
* Delete from `TmsShell.tsx`: `TmsLiveChild`, `live?` on `TmsNavChild`, `TRACKING_PATH`, the `childrenFor` special case (becomes `{ items: item.children ?? [], groups: item.childGroups ?? [] }`), the `live`/`open`/`override` caret logic in `NavChildRow`, the `trackedLoads` prop on `TmsShellProps`/`NavRow`/`NavSectionBlock`/`rowProps`; matching `.tms-nav-live*` rules (grep the shell CSS). `TmsLayout.tsx`: remove `trackedLoads` memo + import of `movingShipments` + the prop. `useShellBadgeCounts.ts`: remove `tracking` (memo, counts key, deps) and `movingShipments` (+ its `MOVEMENT_STATUSES` import if otherwise unused; builder greps).
* `badgeCounts.loadTracking = checkCallsDue + documentReviewCount` stays — it is the number the single row shows (Ryne's screenshot header badge `2`).
* Breadcrumbs: delete the `/tms/check-calls` and `/tms/documents/review` rules (their paths now redirect); keep `/tms/tracking` (`[LOAD_TRACKING, {label:'Tracking'}]` → collapse to `[{ label: 'Load Tracking' }]`, since the row *is* the page) and `/tms/tracking/links` (`[{label:'Load Tracking', to:'/tms/tracking'}, {label:'Customer links'}]` — give `LOAD_TRACKING` a `to`).

### 3.2 Routes and redirects (old URLs keep working)

New module `src/features/shipments/workstations/tracking/legacyRoutes.ts` (pure data + `legacyTrackingTarget(pathname: string): string | null`) used by `App.tsx` so the table is unit-testable and the route registries (§9) read the same constants.

| Old URL | Behaviour | New landing |
|---|---|---|
| `/tms/check-calls` | `<Navigate replace>` | `/tms/tracking?assignee=all&focus=checkcalls` |
| `/check-calls` (legacy shell) | `<Navigate replace>` (was `ParamRedirect → /tms/check-calls`; no double hop) | same |
| `/tms/documents/review`, `/tms/documents/*` (incl. `/tms/documents/view/zz-x`), `/documents` | `<Navigate replace>` | `/tms/tracking?assignee=all&focus=docs` |
| `/tms/tracking/links` | **stays a page** (off-nav) | unchanged (`CustomerLinksPage`, `RequirePage ['loads','tms']`); its "Back to Tracking" keeps working |
| `/tms/tracking?shipment=<id>` and legacy `?tab=inbox&shipment=<id>` | was: redirect to `/tms/shipments/<id>?tab=tracking` | stays on the grid and **opens the drawer** (`shipment` is now real URL state) |
| `/tms/shipments/<id>?tab=tracking` | unchanged | full page; Tracking tab renders `ShipmentTrackingView` |
| notification/links in-app | `collectNotifications.ts` L198/L201 (`'/tms/check-calls'`), L306 (`'/tms/documents'`), `LoadReviewDrawer.tsx` L99 (`'/tms/documents/review'`) | canonical new URLs (above); tests updated |

`assignee=all` is explicit because the old worklists were not tracker-scoped while the grid defaults to `me` (`defaultAssignee`). Lifecycle for the redirects is `active` (docs focus also needs delivered loads: `focus=docs` forces the Active+POD-due union — see §3.3).

### 3.3 The grid — Focus control, 2 columns, 3 row actions

URL state (owned by `TrackingWorkstation`, passed down): `assignee` (existing), `focus` ∈ `checkcalls | docs | exceptions | (absent = all)`, `shipment` (drawer).

* **Focus control** in `TrackingBoard` bar (a `TmsSegmentedTabs`-style group next to Table/Map, 12 px): `All · Check calls due (n) · Documents to review (n) · Exceptions (n)`. Counts computed from the already-assignee/search-scoped `rows` with pure predicates in `trackingTable.ts`:
  * `isCheckCallDue(row, nowMs, graceMinutes)` — `['DUE','OVERDUE'].includes(checkCallState(row, nowMs, graceMinutes))` (`src/lib/checkCalls.ts` L225; a `ShipmentRow` already satisfies `CheckCallScheduleLike`, so this is the **same clock** the sidebar badge, the notifier and the old worklist use; `graceMinutes` = `settings.checkCallGraceMinutes` from `getTmsSettings()`, which `TrackingWorkstation` fetches once).
  * `hasDocsToReview(row)` — `(row.pendingDocReviewCount ?? 0) > 0`.
  * `hasException(row)` — `(row.openIncidentCount ?? 0) > 0` (`checkCallOpen === 'OPEN'` means "cadence running", not an exception).
  * `focus=docs` also unions the lifecycles (a delivered shipment with an upload in review is lifecycle `pod`): `TrackingWorkstation` reads `lifecycle` as before but when `focus` is set it feeds `trackingLifecycleRows` with the union of `active` and `pod` rows (no Closed fetch).
* **Columns** (added to `trackingColumns.ts`, keys appended to the *available* set; **default visible set gains `checkCalls` and `docs`** in `TRACKING_DEFAULT_COLUMNS` after `pod`; users' saved layouts keep their own list because `useDenseGridPrefs` validates against `validKeys`):
  * `checkCalls` — header "Check calls" (group Tracking): text `"<last type> <relative time> · due <nextCheckText>"`, `filter: 'number'` on overdue minutes, cell renders a red "overdue 35 m" chip (existing tone) plus `lastCheckCallType` label; "exceptions n" badge when `openIncidentCount > 0`.
  * `docs` — header "Docs" (group Tracking): `"<n> to review"` when `pendingDocReviewCount > 0`, else `"Missing: POD"` from `docsMissing` when present, else blank; `filter: 'multi'` with fixed options `To review / Missing / OK`.
  * `mode` (optional, not default-visible) — header "Tracking" `Agent · Email+SMS` / `Manual` from `effectiveTrackingPrefs` (needs `prefsOf` added to `TrackingColumnContext`; `TrackingWorkstation` already loads `customers`).
* **Row menu** (`RowMenu` in `TrackingBoard.tsx`) gains: **Log check call…** (fetch bundle → open the existing `LogCheckCallDialog` with `load`, `loadCarrier`, `catalog`; submit = `logCheckCall` through a small hook, same CAS token the Tracking tab uses), **Snooze 1 h** (`getShipmentBundle` → `setNextCheckCall({loadId, expectedUpdatedAt: load.updatedAt, nextCheckCallAt: now+1h})`, then `refreshShipments()`), **Review documents…** (opens `DocumentReviewDialog` = `TmsDialog` around the extracted `DocumentReviewPanel` filtered to that shipment's pending docs; disabled when `pendingDocReviewCount` is 0). "Request check call" / "Request POD" / "Create customer URL" / "Assign tracker…" remain. Handlers live in `TrackingWorkstation` next to `handleRequestCheckCall` (same try/toast/`refreshShipments` shape). The toolbar **Manage links** button is removed (D-AJ5); `TrackingBoardProps.onManageLinks` deleted.
* **Row click** → `setSearchParams({shipment: id})` (keeps `assignee`/`focus`); `pushRecent` as today. Checkbox clicks still do not open it (existing behaviour, `TrackingWorkstation.test` L189-196).
* The `kpis` strip already has "Check calls overdue" / "POD needed"; add "Docs to review" (same pattern, `tone: warn`).

### 3.4 Extractions (move, don't rewrite)

Order inside S3: copy the working handlers out of the two pages (`CheckCallsPage.tsx` L54-130: snooze/resolve/log with `logCheckCall`, `setNextCheckCall`, `resolveIncident`, `textDriver`; `DocumentReviewPage.tsx` L124-135 `decide`) into their new homes and migrate their tests **first**, then delete the pages.


| Source | Becomes | Notes |
|---|---|---|
| `documents/DocumentReviewPage.tsx` (queue table + preview + accept/reject dialogs, L67-338) | `documents/DocumentReviewPanel.tsx` (props `{ documents: ShipmentDocumentRecord[]; onDecided: () => void }`; keeps `DocumentPreview`, `CARRIER_UPLOADABLE_TYPES`, `reviewDocument` payloads **byte-for-byte**) + `documents/DocumentReviewDialog.tsx` (`{ shipmentId, onClose, onDecided }`, reads `useDocumentReviewQueue().documents.filter(d => d.shipmentId === id)`) | `DocumentReviewPage.tsx` + `.test.tsx` deleted; test migrated to `DocumentReviewPanel.test.tsx` (same two behaviours: accept payload `{documentId, decision:'ACCEPT', type}`, reject payload `{documentId, decision:'REJECT', note}`). |
| `tracking/CheckCallsPage.tsx` snooze/resolve/log wiring (L54-130) | row actions in `TrackingWorkstation` (log/snooze) + "Resolve" on OPEN-incident rows of `RecentCheckCalls` (S4) | `CheckCallsPage.tsx` + `.test.tsx` deleted; tests migrated to `TrackingWorkstation.test.tsx` (log call → `logCheckCall` called; snooze → `setNextCheckCall` with `expectedUpdatedAt`) and `RecentCheckCalls.test.tsx` (resolve → `resolveIncident(checkCallId, …)`). |

### 3.5 Shipment tracking view (`ShipmentTrackingView`)

One component, `src/features/shipments/workstations/tracking/ShipmentTrackingView.tsx`, props `{ bundle: ShipmentBundle; customer: CustomerRecord | null; actions: ShipmentActions; row?: ShipmentRow | null; compact?: boolean }`. Mounted by (a) `TrackingDrawer`, (b) `TrackingSection` (full page tab; replaces the Last-known card, check-call banner card and the Thread card; ETAs card, map/plan/timeline cards stay below it on the page — the drawer is the concise surface, the page is the full one). Data: `useLoadTracking`, `listShipmentMessages`, `useTruckConfigs`, `useAppStore(drivers)`, `getTmsSettings` (as `TrackingSection` does today), `useShipments({kind:'working'})` for the `row` fallback.

Layout (12–13 px, no cards inside cards, everything above the fold at 1440×900; drawer `size="xl"` = 1040 px wide):

```
┌ drawer head: "<PRO> · <customer>"  [Tracking: Agent·Both ▾] [Customer link] [Open full page ↗] [×] ┐
│ SUMMARY STRIP (one line, nowrap, each segment truncates with title=):                              │
│  Driver J. Brittich · Truck 12 │ Work (312) 555-01yy / Personal (312) 555-01xx │ Last: Joliet, IL · 14 min │ ETA …  │
│  Next check: in 22 m │ POD: needed │ Carrier: <name> · <dispatcher> <phone>                       │
├──────────────── Conversations (flex:1, min-height 280px, 2 columns, gap 8) ───────────────────────┤
│ SMS · driver (work phone)           │ E-mail · dispatcher (<name> <email>)                          │
│ ┌ stream (overflow:auto) ─────────┐ │ ┌ stream (overflow:auto) ──────────────────┐                  │
│ │ bubbles; NOT_SENT = "Would have │ │ │ subject + bubbles; NOT_SENT shown the same│                  │
│ │ sent: …"                        │ │ │                                          │                  │
│ └─────────────────────────────────┘ │ └──────────────────────────────────────────┘                  │
│ composer (2 rows) [Send]            │ subject + composer (2 rows) [Attach] [Send]                    │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Recent check calls (last 5, one line each): time · location · status · by            [Log check call]│
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Panes**: two `TrackingConversation` instances with `lockChannel="SMS"` / `"EMAIL"`. In locked mode the component (a) filters `sortedMessages` by `channel`, (b) hides the Recipient/Channel selects and the formatting toolbar row (single-line header instead: channel icon + counterpart + resolved address), (c) fixes `recipient` (`driver` for SMS, `dispatcher` for EMAIL) and `rows={2}`, (d) SMS pane sends `{ channel:'SMS', to:null, party:'DRIVER' }` (server resolves, §4.3) and shows the **resolved number** read-only (`driverSmsTarget(workPhoneFor(...), effectivePrefs.driverSms)` — same pure fn the server uses), (e) E-mail pane keeps subject + attachments. Each stream is its own scroll container (`.tms-convo-stream { overflow-y:auto; min-height:0 }` inside a `flex-direction:column; height:100%` pane) so the panes scroll independently. Kind pills/cards stay (compact CSS). `conversation.css` gets a `.tms-convo-compact` modifier (denser paddings, 12 px).
* **Summary strip** (`TrackingSummaryStrip.tsx`, pure `summaryOf` below): driver + truck, work/personal phones (`DriverPhones variant="inline"`), last known location + age (`lastKnown`/`load.lastKnown*`, `relativeTime`), ETA (`loadCarrier.deliveryEtaAt` → else `etaOf(row)` when `row` is known → else delivery appt), next check call due (`checkCallState` tone: SCHEDULED gray / DUE orange / OVERDUE red + "in 22 m"/"overdue 35 m"), POD state (`podStateOf(row)` chip via `POD_LABELS`; `—` when `row` unknown), carrier contact (carrier name · dispatcher name · phone/e-mail with `tel:`/`mailto:`). Own-fleet: carrier segment reads "Own fleet".
* **Recent check calls** (`RecentCheckCalls.tsx`): `events` sorted desc, 5 rows, columns *time (formatBoardDateTime) · location (`city, state` or "—") · status (`CHECK_CALL_TYPE_LABELS[type]` + `statusAfter` move + OPEN-exception badge) · by (`personName ?? createdBy`, source icon)*; row action **Resolve** on `incidentOpen === 'OPEN'` (calls `actions.tracking.resolveIncident`). "Log check call" opens `LogCheckCallDialog` (existing).
* **Per-shipment override** (`TrackingPrefsPopover.tsx` in the drawer head): three selects (Mode · Method · Driver SMS to) each with a first option "Inherit (<customer value or 'not set'>)"; Save → `setTrackingPrefs({shipmentId, prefs})` (all-inherit saves `null`); a small "customised" dot when an override exists.
* **Customer links**: drawer head button opens the existing `CustomerLinkDialog` (link status from `listTrackingLinksByShipment`, as `TrackingSection` does now) + "Manage all links" → `/tms/tracking/links`.

`summaryOf` (pure, `trackingSummary.ts`):

```ts
export interface TrackingSummary {
  driver: { name: string | null; truckNumber: string | null }
  phones: DriverPhones                       // workPhoneFor(...)
  lastKnown: { place: string; ageMinutes: number | null; source: string | null } | null
  eta: { at: string; estimated: boolean; lateMinutes: number | null } | null
  nextCheck: { state: CheckCallState; minutes: number | null }
  pod: PodState | null
  carrier: { label: string; contactName: string | null; phone: string | null; email: string | null }
}
export function summaryOf(i: { bundle: ShipmentBundle; row: ShipmentRow | null; phones: DriverPhones; lastKnown: LastKnownFix | null; nowMs: number; graceMinutes?: number | null }): TrackingSummary
```

### 3.6 Customer setup

* **Create dialog** (`CustomerModal` → `CustomerForm`): new group "Tracking" (`TrackingPrefsFields.tsx`, in `directory/components/`) placed on the **first tab visible on create** so it is asked, not hidden: *Tracking mode* radio **AI agent tracking / Manual**; *Tracking method* radio **E-mail thread (dispatcher) / SMS to driver / Both**; *Driver SMS goes to* select (Truck work phone, personal as fallback · Truck work phone only · Personal phone) under a "More" disclosure (AK override). On create the form preselects **AGENT / BOTH / WORK_THEN_PERSONAL** and the values are always written (never left null for a new customer). On edit of a legacy customer whose fields are null the controls show "Not set — follows Settings › Tracking automation" until a choice is made.
* **Profile** (`CustomerProfile.tsx`): a "Tracking" `TmsCard` directly above the existing 'Tracking automation' card (L445) with the same three controls and the inherited-from hint; save = `setPartial` + `onSave` (the existing pattern), sending **only** the three keys (allow-list keeps the rest).
* `useCustomerForm.ts`: `CustomerFormValue` + `emptyCustomerForm` + `toRecord` carry `trackingMode/trackingMethod/driverSmsTarget` (strings; `''` → `null`).
* Server allow-list `tms-directory-actions/handler.ts` (near the Step V lines ~L1143-1146): `trackingMode: 'trackingMode' in input ? optionalEnumStrict(input.trackingMode, ['AGENT','MANUAL'], 'trackingMode') : existing?.trackingMode ?? null` (same for the other two; `optionalEnumStrict` pattern as `invoiceFrequency` L~1123).
* `effectiveTrackingPrefs` (resolve-at-read) — new shipments need no copy step (`createShipment` untouched), duplicate/repoint untouched. `TrackerCard.tsx`-style "inherited" markers are the popover's "Inherit (…)" option.

### 3.7 Automation / agent behaviour (what "respect them" means)

Pure rules in `src/lib/trackingPrefs.ts` (shared by Lambda and UI):

| Rule | Where applied |
|---|---|
| `mode === 'MANUAL'` ⇒ **no automatic request of any kind**: `runCheckCallPlan` with `opts.mode === 'AUTO'` sets `blocked = 'Customer tracking is manual'` (new first branch of the `blocked` chain, `checkCallAgent.ts` L227-232, using `effectiveTrackingPrefs({shipment, customer})`; both already in scope); `runTrackingAutomation` POD pass skips the leg with `result.pod.skipped += 1` and a note (`automation.ts` after L136, before `recipients`). A **person's** action (Request check call, Request POD, composer, TEXT_DRIVER, Log check call) is never blocked by mode — "manual" means no *auto* requests, not "no tools". | `checkCallAgent.ts`, `automation.ts` |
| `mode === 'AGENT'` / null ⇒ Step V decides (`policy.checkCallsAuto`, `podAuto`, quiet hours, templates) exactly as today. | unchanged |
| `method` ⇒ intersect: `enabled = resolved.plan.channels.filter(isChannelEnabled)` becomes `channelsAllowedBy(prefs.method, …)` (`EMAIL` keeps only EMAIL, `SMS` only SMS, `BOTH`/null unchanged). Applies to AUTO **and** manual runs, to cadence/milestone sends, the dispatcher escalation e-mail (needs EMAIL), the POD pass (`policy.podChannels ∩ method`) and `requestPodForLeg` when called by the sweep. If the intersection is empty the existing "No enabled channel" tick is returned (reason text becomes "Tracking method excludes every enabled channel"). | `checkCallAgent.ts` L225, `automation.ts` L156/L175-188 |
| `driverSms` ⇒ §4.2. | `driverPhone.ts` |

---------------------------------------------------------------------------------------------------

## 4. AK design

### 4.1 `workPhoneFor` — the one pure function (`src/lib/workPhone.ts`)

```ts
import { toE164Strict } from './dispatch'                       // US-only, refuses to guess (L175-179)
import type { DriverSmsTarget } from './trackingPrefs'

export interface TruckPhoneRecord  { truckId: string; unitNumber?: string | null; phone?: string | null; phoneLabel?: string | null }
export interface DriverPhoneRecord { phone?: string | null; assignedTruckId?: string | null }

export interface DriverPhones {
  truckId: string | null          // the truck the work phone was read from (or would have been)
  truckNumber: string | null      // TruckConfig.unitNumber ?? the caller-supplied unit ("12")
  work: { number: string; label: string | null } | null     // E.164; null = no truck, or the truck has no (valid) phone
  personal: string | null         // E.164 when valid, else null
  personalRaw: string | null      // as stored (legacy non-E.164 display)
}

/** The truck is the load's truck when the caller knows one (LoadCarrier.truckId, else Load.truckId), otherwise the driver's assigned truck. */
export function workPhoneFor(i: {
  driver?: DriverPhoneRecord | null
  loadTruckId?: string | null
  /** Snapshot `LoadCarrier.driverPhone` — the personal fallback for legs with no Driver row (brokered legs). */
  legDriverPhone?: string | null
  truck: (truckId: string) => TruckPhoneRecord | null | undefined
  /** Display unit when TruckConfig has none (LoadCarrier.truckNumber / Equipment.unitNumber). */
  unitNumber?: string | null
}): DriverPhones

export interface SmsTarget {
  to: string | null
  source: 'WORK' | 'PERSONAL' | 'NONE'
  /** Why a preferred number was not used / nothing can be sent — shown in the UI and returned as `smsError`. */
  reason: string | null
  phones: DriverPhones
}
export function driverSmsTarget(phones: DriverPhones, pref: DriverSmsTarget | null): SmsTarget

/** Trucks (not trailers, not parked/inactive) with no valid `TruckConfig.phone`; a truck with no TruckConfig row counts. */
export function trucksWithoutPhone(i: {
  equipment: ReadonlyArray<{ id: string; unitNumber: string; type: string; assignedDriverId?: string | null /* + the inactive marker `truckInactive.ts` reads */ }>
  configs: ReadonlyMap<string, TruckPhoneRecord>
}): Array<{ truckId: string; unitNumber: string; assignedDriverId: string | null }>

/** E.164 for storage, or null (and an error string for the form). Same acceptance as `toE164Strict`. */
export function normalizeTruckPhone(raw: string): { ok: true; value: string } | { ok: false; error: string }
```

Resolution order (truck): `loadTruckId` (if given) → `driver.assignedTruckId` → none. One truck is chosen and used consistently (a load's truck without a phone does **not** borrow another truck's phone). Personal: `driver.phone` → `legDriverPhone`. An invalid stored number (not US 10-digit) is treated as absent for sending but kept in `personalRaw` for display.

### 4.2 SMS routing rule and override precedence

`driverSmsTarget(phones, pref)`:

| pref | work phone present | work phone absent |
|---|---|---|
| `WORK_THEN_PERSONAL` (**default**) | `to = work`, `source 'WORK'` | `to = personal`, `source 'PERSONAL'`, `reason "Truck 12 has no work phone — used the driver's personal number"`; neither → `source 'NONE'`, `reason "No phone for this driver"` |
| `WORK_ONLY` | `to = work` | `to = null`, `source 'NONE'`, `reason "Truck 12 has no work phone"` (never falls back) |
| `PERSONAL` | `to = personal` (work ignored) | `to = personal` |

**Precedence of `pref`** (in `effectiveTrackingPrefs`, per key independently): `Shipment.trackingPrefs.driverSms` → `Customer.driverSmsTarget` → `WORK_THEN_PERSONAL`. Same order for `mode` and `method` (shipment → customer → `null`). An explicit `to` typed by staff (SEND_TRACKING_LINK `input.to`, composer address edit if ever added) always wins over routing. Dispatch "Text" `sms:` links and the Schedule copy-paste text are *staff-initiated from their own phone* and are not routed (D-AK6).

### 4.3 Server wiring (S2) — one resolver, every send path

New `amplify/functions/tms-tracking-actions/driverPhone.ts`:

```ts
export interface DriverPhoneDeps {
  getById(table: string, id: string): Promise<Row | null>
  tables: { truckConfig?: string; driver?: string; customer: string }
}
export async function resolveDriverSms(deps: DriverPhoneDeps, i: { carrier: Row | null; shipment: Row; customer: Row | null }): Promise<SmsTarget>
```

It reads `carrier.truckId` (leg) → `TruckConfig` (GetItem, `unitNumber` fallback `carrier.truckNumber`), `carrier.driverId` → `Driver` (`phone`, `assignedTruckId`), snapshot `carrier.driverPhone`, then `workPhoneFor` + `driverSmsTarget(…, effectiveTrackingPrefs({shipment, customer}).driverSms)`. A missing table name (unit tests, legacy env) ⇒ behaves exactly as today (snapshot only). Brokered legs have no `truckId`/`driverId` ⇒ `work` is null ⇒ `personal` = snapshot ⇒ **identical to today**.

Call sites (every one currently reads `carrier.driverPhone`):

| File | Anchor | Change |
|---|---|---|
| `checkCallAgent.ts` | `hasSms` L437, SMS send L463-464, `runCheckCallPlan` start (resolve once per load after `carrier`) | `const sms = await resolveDriverSms(deps, {carrier, shipment, customer})`; `hasSms = Boolean(sms.to && tick.channels.includes('SMS'))`; `to: sms.to`; `label` unchanged. When `sms.to` is null and SMS was wanted, push a `processed` reason `sms.reason` (surfaces as the toast "…: No driver phone"). |
| `podReview.ts` | `requestPodForLeg` L93/L104-105 | accept an optional precomputed `sms: SmsTarget` in its input (automation passes it); default resolves itself via the same function. |
| `automation.ts` | POD `recipients` L156 | `(c === 'EMAIL' ? carrier.dispatcherEmail : (await resolveDriverSms(...)).to)`; mode/method gates (§3.7) inserted before `pending` is built. |
| `handler.ts` | `textDriver` L1267 (`toE164Strict(loadCarrier.driverPhone)`) | resolve via `resolveDriverSms` (load shipment + customer by `loadCarrier.shipmentId`); failure text becomes `sms.reason`. Audit row gains `source`. |
| `handler.ts` | SEND_TRACKING_LINK L819 | `toE164Strict(input.to ?? (await resolveDriverSms(…)).to)`; explicit `input.to` still wins. |
| `thread.ts` | `sendShipmentMessage` SMS branch L297-303 | new optional `ThreadDeps.resolveDriverSms?(shipment, loadCarrierId)`; when `channel==='SMS' && !to && replyParty==='DRIVER'` use it; otherwise unchanged (explicit `to` honored). `handler.ts` wires `threadDeps.resolveDriverSms`. Message row keeps `to` = the number actually used, so the thread shows it. |
| `backend.ts` | tracking fn block ~L2660-2700 | `trackingActionsFn.addEnvironment('TRUCK_CONFIG_TABLE_NAME', truckConfigTable.tableName)` and `DRIVER_TABLE_NAME` (`backend.data.resources.tables['TruckConfig'|'Driver']`) + `PolicyStatement(['dynamodb:GetItem'], [arn])`; same two env + `GetItem` for `driverApiFn`. |
| `driver-app-api/handler.ts` | `/me` L2491-2504 | add `workPhone` = `{ number, label, truckNumber }` from `TruckConfig` of `truckForDriver(driver).id` (null when none); shape declared in `DriverProfile`. |

### 4.4 Display rule (`DriverPhones` component, S1; used by S4/S6)

`src/components/DriverPhones.tsx` — props `{ phones: DriverPhones; variant: 'inline' | 'stacked' | 'compact' }`. Text contract (tests pin it):

* with work phone: `Work (truck 12): (312) 555-0100` and `Personal: (312) 555-0199` (stacked = two lines; inline = `Work (truck 12) … · Personal …`; compact = work only with the personal number in `title`);
* truck has no phone: `Work (truck 12): none` in muted/orange `--tms-badge-orange`, personal shown;
* no truck: only `Personal: …`.
Numbers render through `formatPhone`/`prettyPhone`; each is a `tel:` link in `inline`/`stacked`. `useTruckConfigs()` (S1, `src/hooks/useTruckConfigs.ts`) = `cachedList('truckConfigs', listTruckConfigs, {ttlMs: 60_000})` → `{ byId: ReadonlyMap<string, TruckPhoneRecord>, refresh, loading, upsert }` where `upsert(input)` wraps `upsertTruckConfig` and merges the saved row into the cache (optimistic, rolled back on error) so Fleet, the Settings card and every display surface see a change at once; `useDriverPhones(driver, loadTruckId?)` wraps `workPhoneFor`.

### 4.5 "Trucks without a phone" report

* Source: `trucksWithoutPhone({ equipment, configs })` (pure, §4.1) with `useAppStore.equipment` (already loaded) + `useTruckConfigs`.
* Surfaces: (1) **Fleet** chip "No phone (n)" next to the type filter on `TrucksPage` (filters the table); (2) **Settings** card `TruckPhonesCard` ("Truck work phones") on `SettingsPage` (admin block, after `TrackingAutomationCard`): headline count, a compact table *Truck · Driver · Phone · [Add phone]* of the missing trucks (uses `TruckPhoneEditor`), and an "all trucks have a phone" empty state. No new route, no nav row.

### 4.6 Inbound SMS bridge (makes the SMS pane a two-way thread)

* **Roster match includes work phones.** `DispatchDriver` (`src/lib/dispatch.ts`) gains optional `workPhone?: string | null`; `matchDriverByPhone` matches `phoneDigits(d.phone) === want || phoneDigits(d.workPhone) === want` (ambiguity rule unchanged: >1 hit ⇒ `null`). The webhook's roster loader (`drivers(store, nowMs)`) fills `workPhone` from `TruckConfig.phone` via each driver's `assignedTruckId` (one `Scan`/`BatchGet` of TruckConfig, cached for the roster's lifetime). The client Dispatch UI keeps matching by `conversation.driverId`; no client change needed.
* **Bridge.** In `inboundSms`, after the message is stored and `touchConversation` ran, a best-effort `deps.bridgeToShipment?.({ driverId, from, body, sid, at })` (wrapped in `try/catch` like `autoPod`, never fails the webhook):
  1. only when the conversation/roster resolved a **driver** (brokered drivers have no roster row → not bridged; they still reply in Dispatch as today);
  2. candidates = the driver's live loads (`loadsForDriver`, already wired for POD auto-file) whose shipment is not closed/voided; pick the one shipment with `checkCallAwaitingSince` set (latest wins); if there is exactly one candidate shipment with a live leg use it; **otherwise do not bridge** (no guessing across shipments);
  3. invoke the tracking router with `{ action:'INGEST_SHIPMENT_MESSAGE', systemCaller:'dispatch-twilio-webhook', input:{ shipmentId, loadId, channel:'SMS', party:'DRIVER', from, to: dispatchNumber, body, messageId: 'sms:' + MessageSid } }` (same envelope as `shipment-email-intake` `invokeInput`, handler L203-227). `ingestShipmentMessage` already dedupes on `messageId` (Twilio retries), clears `checkCallAwaitingSince`, and turns a location-looking body into a `LoadCheckCall` + `lastKnown*`.
* Wiring: `SYSTEM_CALLERS['dispatch-twilio-webhook'] = ['INGEST_SHIPMENT_MESSAGE']` (tracking `handler.ts` L346-348); `backend.ts`: `dispatchWebhookFn` gets `TMS_TRACKING_ACTIONS_FUNCTION_NAME` and `lambda:InvokeFunction` on the tracking function (copy the `shipment-email-intake` pattern in the same file), plus `TRUCK_CONFIG_TABLE_NAME` and `dynamodb:Scan|BatchGetItem` on TruckConfig; unset env on dev ⇒ log "parsed inbound" like the e-mail intake and continue.
* What it does **not** do: attach MMS pictures to the thread (POD auto-file stays the only consumer of pictures), reply on the driver's behalf, or bridge outbound Dispatch-page messages.

---------------------------------------------------------------------------------------------------

## 5. Exact change list per file

Legend: **N** new, **E** edit, **D** delete. Line numbers are anchors from the recon (builders re-read before editing; other agents are changing code on `dev` now).

### 5.1 S1 CONTRACT (lands first)

| File | Change |
|---|---|
| E `amplify/data/resource.ts` | §2.1: Customer ×3 (after L975), Shipment ×1 (after L1979), TruckConfig ×2 (after L3947). Nothing else. **Single owner of this file.** |
| E `src/types/tms.ts` | `CustomerRecord` (L288-291 area), `ShipmentRecord` (L1822 area), re-export `TrackingMode/Method/DriverSmsTarget/TrackingPrefsOverride`. |
| N `src/lib/trackingPrefs.ts` + `trackingPrefs.test.ts` | types, `parseTrackingPrefs(raw)`, `effectiveTrackingPrefs({shipment, customer})` → `{ mode, method, driverSms, source: {mode, method, driverSms: 'SHIPMENT'\|'CUSTOMER'\|'DEFAULT'} }`, `allowsAutoRequests(p)`, `channelsAllowedBy(method, channels)`, `TRACKING_MODE_LABELS`, `TRACKING_METHOD_LABELS`, `DRIVER_SMS_TARGET_LABELS`, `validateTrackingPrefsOverride(raw)` (throws on unknown enum values; used by the Lambda). Imported by Lambdas the way `../../../src/lib/trackingAutomation` already is. |
| N `src/lib/workPhone.ts` + `workPhone.test.ts` | §4.1 (`workPhoneFor`, `driverSmsTarget`, `trucksWithoutPhone`, `normalizeTruckPhone`). |
| N `src/hooks/useTruckConfigs.ts` (+ `useDriverPhones`) | §4.4. |
| N `src/components/DriverPhones.tsx` + `.test.tsx` | §4.4. |
| E `src/lib/apiClient.ts` | §2.2 (field lists, flag, `TruckConfig` iface/fields/upsert, `setTrackingPrefs`, shipment JSON parse). Append-only block + the three small in-place list edits. |
| E `amplify/functions/tms-directory-actions/handler.ts` (+ `handler.test.ts`) | allow-list ×3 (§3.6). |
| E `amplify/functions/tms-shipment-actions/handler.ts` (+ `handler.test.ts`) | new action `SET_TRACKING_PREFS` `{ shipmentId, prefs: object\|null, expectedUpdatedAt? }`: guard = same as `ASSIGN_TRACKER` (`page-loads`/`page-tms`, `isActionAuthorized`), `liveShipment` check (voided refused), `validateTrackingPrefsOverride`, write `trackingPrefs` (all-null → remove), `writeAudit('SHIPMENT', id, 'SET_TRACKING_PREFS', caller, {from, to})`, returns `{ shipment }`; add to the `Action` union (L574 area) and the dispatch switch (L7666 area). |

### 5.2 S2 LAMBDAS (tracking · dispatch webhook · driver app API)

| File | Change |
|---|---|
| N `amplify/functions/tms-tracking-actions/driverPhone.ts` + `.test.ts` | §4.3. |
| E `checkCallAgent.ts` (+ `checkCallAgent.test.ts`) | mode gate (L227-232), method filter (L225), routing (L437/L464), `CheckCallDeps` gains optional `tables.truckConfig?/driver?`. |
| E `automation.ts` (+ `automation.test.ts`) | POD pass: mode skip, method∩`podChannels`, routing (L156). |
| E `podReview.ts` (+ `podReview.test.ts`) | routing (L93/L104-105). |
| E `thread.ts` (+ `thread.test.ts`) | optional `resolveDriverSms`. |
| E `handler.ts` (+ `handler.test.ts`) | `textDriver`, SEND_TRACKING_LINK, `threadDeps`/`checkCallDeps` table names (`TRUCK_CONFIG_TABLE_NAME`, `DRIVER_TABLE_NAME`), `STEP_P_TABLES` (+`truckConfig`, `driver`). |
| E `amplify/functions/tms-tracking-actions/testSupport.ts` | add `TruckConfig`/`Driver` to the in-memory `INDEXES`/tables map (GetItem only). |
| E `amplify/backend.ts` | env + `GetItem` grants for `trackingActionsFn` and `driverApiFn` (§4.3). **Single owner.** |
| E `amplify/functions/driver-app-api/handler.ts` (+ test) | `/me` `workPhone`; env var read `TRUCK_CONFIG_TABLE_NAME` (empty ⇒ `workPhone: null`). |
| E `amplify/functions/dispatch-twilio-webhook/handler.ts` (+ its test) | §4.6: roster `workPhone`, `bridgeToShipment` dep + call in `inboundSms`, env wiring. |
| E `src/lib/dispatch.ts` (+ `dispatch.test.ts`) | `DispatchDriver.workPhone?`, `matchDriverByPhone` both numbers. Client callers are unaffected (field optional). |
| E `tms-tracking-actions/handler.ts` `SYSTEM_CALLERS` (L346-348) | `'dispatch-twilio-webhook': ['INGEST_SHIPMENT_MESSAGE']` (already within the `handler.ts` edit above). |

### 5.3 S3 NAV + ROUTES + GRID

| File | Change |
|---|---|
| E `src/lib/navSections.ts` (+ `navSections.test.ts` L263-268) | §3.1: one row, crumbs. Test becomes: `PINNED_ITEMS` Load Tracking has **no children**; `labels('/tms/tracking') === ['Load Tracking']`; `labels('/tms/tracking/links') === ['Load Tracking','Customer links']`; removed paths fall back to no rule. |
| E `src/features/tms/TmsShell.tsx` (+ `TmsShell.test.tsx` L39-48 fixture, L197-201 parent-vs-child badge → parent-only, L349-361 live list test **deleted**) | delete `live`/`trackedLoads` machinery (§3.1); keep generic child rows (other parents use them). Replace the deleted test with: "a parent with no children renders a single link with its badge and no caret". |
| E `src/features/tms/TmsLayout.tsx` (+ `TmsLayout.test.tsx` L86-87/L145) | drop `trackedLoads`; `DENSE_PATHS` unchanged (adds nothing; `/tms/tracking` already dense). |
| E `src/features/tms/useShellBadgeCounts.ts` (+ test L94-96 removed with `movingShipments`) | drop `tracking`; keep `loadTracking`. |
| N `src/features/shipments/workstations/tracking/legacyRoutes.ts` + `.test.ts` | §3.2 table; test asserts each old URL maps to the exact landing, unknown paths → `null`, and `/tms/tracking/links` is **not** redirected. |
| E `src/App.tsx` | remove imports/routes of `CheckCallsPage` (L29, L168) and `DocumentReviewPage` (L33, L166-167); add `<Route path="check-calls" element={<Navigate to={…} replace/>}/>`, `documents/*`; legacy L208/L209 retargeted; keep L165 `tracking/links`. |
| D `src/features/tracking/CheckCallsPage.tsx` + `.test.tsx`; D `src/features/documents/DocumentReviewPage.tsx` + `.test.tsx` | after §3.4 extractions; `useCheckCallWorklist`, `useOpenIncidents`, `useDocumentReviewQueue`, `LogCheckCallDialog` stay. |
| N `src/features/documents/DocumentReviewPanel.tsx` + `.test.tsx`, N `DocumentReviewDialog.tsx` | §3.4. |
| E `tracking/trackingTable.ts` (+ `trackingTable.test.ts`) | `isCheckCallDue`, `hasDocsToReview`, `hasException`, `focusRows(rows, focus, nowMs, graceMin)`. |
| E `tracking/trackingColumns.ts` | `checkCalls`, `docs`, `mode` columns; `TRACKING_DEFAULT_COLUMNS` (+`checkCalls`,`docs` after `pod`); `TrackingColumnContext` (+`prefsOf?: (row) => EffectiveTrackingPrefs`). |
| E `tracking/TrackingBoard.tsx` + `tracking/types.ts` | Focus control, cells, row menu items, KPI, remove Manage links. New props: `focus`, `onFocus`, `onLogCheckCall`, `onSnooze`, `onReviewDocs`; removed: `onManageLinks`. |
| E `workstations/TrackingWorkstation.tsx` (+ `TrackingWorkstation.test.tsx`) | URL state `focus` & `shipment`, drawer mount (`<TrackingDrawer shipmentId={…} onClose onChanged={refreshShipments}/>` — contract below), handlers for log/snooze/review, lifecycle union for `focus=docs`, remove legacy redirect effect (L72-76) and `onManageLinks`. Tests rewritten to the new contract (see §7). |
| E `src/features/tms/notifications/collectNotifications.ts` (+ `collectNotifications.test.ts`, `NotificationsDrawer.test.tsx` L11/L45) | canonical new URLs. |
| E `src/features/tms/loadReview/LoadReviewDrawer.tsx` L99 (+ `LoadReviewPage.test.tsx` L230) | link → `/tms/tracking?assignee=all&focus=docs`. |
| E `src/features/settings/TrackingSettingsCard.tsx` | small `Link` "Manage customer links" → `/tms/tracking/links` (tests already wrap in `MemoryRouter`). |
| E `src/features/shipments/workstations/CustomerLinksPage.tsx` L305-312 | unchanged behaviour; "Back to Tracking" stays. (No edit unless a test needs it.) |

Contract S3 consumes from S4: `export function TrackingDrawer(props: { shipmentId: string | null; onClose: () => void; onChanged: () => void }): JSX.Element` in `workstations/tracking/TrackingDrawer.tsx`. S3 may land first with a one-line placeholder import guarded by the type; the integration owner (S6) runs the combined typecheck.

### 5.4 S4 TRACKING VIEW

| File | Change |
|---|---|
| N `tracking/ShipmentTrackingView.tsx` + `.test.tsx` | §3.5. |
| N `tracking/TrackingSummaryStrip.tsx`, `tracking/trackingSummary.ts` + `.test.ts` | §3.5 `summaryOf`. |
| N `tracking/RecentCheckCalls.tsx` + `.test.tsx` | §3.5. |
| N `tracking/TrackingPrefsPopover.tsx` + `.test.tsx` | §3.5. |
| N `tracking/TrackingDrawer.tsx` | `TmsDrawer open={shipmentId != null} size="xl" className="tms-tracking-drawer"`, `useShipmentContext(shipmentId, {}, onChanged)`, title `PRO … · customer`, `headerExtra` = prefs popover + Customer link + Open full page. |
| E `tracking/TrackingConversation.tsx` (+ add cases to its existing tests if any) | `lockChannel` prop (§3.5); behaviour without it unchanged (no other caller changes). |
| E `src/features/tms/styles/conversation.css` | `.tms-convo-compact`, two-pane flex rules, independent scroll. |
| E `shipments/components/TrackingSection.tsx` (+ `.test.tsx` L25-60 mocks) | mount `ShipmentTrackingView` first; remove "Last known" card, check-call banner (its Edit/Snooze/No-reminder controls move into the strip's next-check segment menu), keep ETAs card, Timeline, dialogs. |
| E `tracking/TrackingDetailPanel.tsx` (+ `TrackingWorkstation`-side tests that query `detail-thread`) | remove the `Thread — <PRO>` card (L190-196) — the thread now lives in `ShipmentTrackingView`; keep header/map/ETA/driver/plan cards. `DriverCard` receives `phones`. |
| E `tracking/DriverCard.tsx` | `driver.phone` line → `<DriverPhones variant="stacked">`; the Call icon links to the **work** number when present. |

### 5.5 S5 CUSTOMER + TRUCKS UI

| File | Change |
|---|---|
| N `src/features/directory/components/TrackingPrefsFields.tsx` + `.test.tsx` | §3.6 controls (controlled; `value`, `onChange`, `legacyHint`). |
| E `useCustomerForm.ts`, `CustomerForm.tsx`, `CustomerProfile.tsx` (+ their tests) | wiring; create-time defaults. |
| N `src/features/trucks/TruckPhoneEditor.tsx` + `.test.tsx` | inline editor: phone input (masks as typed, `normalizeTruckPhone`), label input, Save → `upsertTruckConfig({ truckId, unitNumber, phone, phoneLabel })`, Clear → nulls; error text from `normalizeTruckPhone`; used by Fleet and Settings. |
| E `src/features/trucks/TrucksPage.tsx` (+ its test) | `useTruckConfigs` replaces the local load (keeps the optimistic ownership write by routing it through the hook's `upsert`); Phone column after Assignment (`'Phone','phone'` in the sortable header list, sort by presence then number, `colSpan` 8, `<col style={{width: 150}}>`), mobile card line, "No phone (n)" chip. |
| N `src/features/settings/TruckPhonesCard.tsx` + `.test.tsx`; E `SettingsPage.tsx` (+ `SettingsPage.render.test.tsx`) | §4.5. |

### 5.6 S6 DRIVER SURFACES + INTEGRATION

| File | Change |
|---|---|
| E `src/features/drivers/DriverDrawer.tsx` | under Phone: read-only `Work (truck N): …` via `DriverPhones variant="stacked"` for the *form's* currently selected `assignedTruckId` (live as the select changes). Phone field stays "Personal" (label text "Phone *" → "Personal phone *"; validation unchanged). |
| E `src/features/files/FilesPage.tsx` L381, `EntityFilePanel.tsx` (driver header) | row: personal line + work line; panel header: `DriverPhones variant="stacked"`. |
| E `src/features/dispatch/DispatchPage.tsx` L268-271 | when `selectedDriver`: `DriverPhones variant="inline"` beside the conversation number (the Call/Text links on the **conversation** number stay — that is who the thread is with). |
| E `src/features/calendar/SchedulerView.tsx` L234 (+ `SchedulerView.duplicate.test.tsx` mocks `useTruckConfigs`) | two-line label: `W (T12) (312) …` / `P (312) …`; tooltip with both. |
| E `src/features/driver-app/DispatchBar.tsx`, `driverApi.ts`, `useDriverProgram.ts` (+ test) | "Your work phone · truck 12" line from `profile.workPhone` (display + `tel:`), shown above the dispatcher lines; absent ⇒ unchanged. |
| N `scripts/seedTruckPhoneAJK.mjs` + `scripts/seedTruckPhoneAJK.test.mjs` | §8. |
| E `scripts/lib/aaRoutes.mjs`, `scripts/lib/uRoutes.mjs`, `scripts/devVerifyS2.mjs`, `scripts/devVerifyS3.mjs`, `scripts/devDemoY.mjs`, `scripts/verifyTrackingUi.mjs`, `Docs/tms-build/AA_ROUTE_INVENTORY.md` | old-path registries: `/tms/check-calls`, `/tms/documents/review` become `redirect(...)` rows with the new landings; nav assertions (`aaRoutes.mjs` L303-306: the four child rows) become the single "Load Tracking" row with 0 children; `devVerifyS2` ROUTES rows 10/11a/12 + L146 `12-tabs` + L577 stay valid only for `tracking/links`, others retargeted to the grid focus URLs; `devDemoY` steps 17/20 screenshot the grid focus URLs. |
| N `scripts/devVerifyAJ.mjs` | §9. |
| E `Docs/tms-build/BUILD_LOG.md` | §11 checklist bullets + an AJ/AK entry after the verified deploy. |
| E `Docs/academy/*` | none required (no end-user doc covers the removed pages; builder greps `Docs/academy` for "Check calls" / "Document review" and updates any hit). |

---------------------------------------------------------------------------------------------------

## 6. Data flow summary (so reviewers can trace one path end to end)

1. Staff creates customer "X" → dialog saves `trackingMode=AGENT, trackingMethod=SMS, driverSmsTarget=null` via `UPSERT_CUSTOMER`.
2. A shipment for X is created (no copy). Grid row Customer column "X"; `mode` column: `Agent · SMS`.
3. Staff opens the row → `?shipment=<id>` → `TrackingDrawer` → `ShipmentTrackingView`; strip shows driver, truck, work/personal; SMS pane's To = `driverSmsTarget(...)`.
4. Staff clicks Request check call → `RUN_CHECK_CALL_PLAN` (manual): `method=SMS` ⇒ channels `['SMS']`; `resolveDriverSms` ⇒ truck phone (or personal fallback); `sendShipmentMessage` writes a `ShipmentMessage` (`NOT_SENT` on dev) with `to` = that number; the SMS pane shows "Would have sent".
5. Same customer flipped to `MANUAL`: the 5-minute sweep (`runTrackingAutomation` AUTO) writes nothing for X's shipments and reports "Customer tracking is manual"; step 4 by a person still works.

---------------------------------------------------------------------------------------------------

## 7. Tests (behavioural; each defends an observable contract)

Existing tests that **must change** because the contract changed (never re-pinned to new wording where they pinned wording): `navSections.test.ts` L263-268; `TmsShell.test.tsx` (fixture L39-48, L197-201, L349-361); `TmsLayout.test.tsx` L86-87; `useShellBadgeCounts.test.ts` L94-96; `TrackingWorkstation.test.tsx` L189-196 (row click navigates → opens drawer), L259-262 (`?tab=inbox&shipment=` redirect → opens drawer), L272-277 (**Manage links** removed); `NotificationsDrawer.test.tsx` L11/L45; `LoadReviewPage.test.tsx` L230; `TrackingSection.test.tsx` (mocks for the new hooks); `SchedulerView.duplicate.test.tsx` (mock `useTruckConfigs`); `FilesPage.render.test.tsx` (mock). Deleted with their pages: `CheckCallsPage.test.tsx`, `DocumentReviewPage.test.tsx` (behaviours migrated, not dropped).

New / extended:

| Test | Asserts |
|---|---|
| `workPhone.test.ts` | truck precedence (load truck beats driver's assigned); a load truck without a phone does **not** borrow the assigned truck's; no truck ⇒ personal only; `WORK_THEN_PERSONAL` falls back **only** when the truck has none and says so in `reason`; `WORK_ONLY` + none ⇒ `to:null` with the truck named; `PERSONAL` ignores the work phone; invalid/non-US stored number treated as absent for `to` but kept in `personalRaw`; `trucksWithoutPhone` excludes trailers and parked trucks, includes a truck with no `TruckConfig` row; `normalizeTruckPhone` accepts `(312) 555-0142`, `312-555-0142`, `+13125550142`, `1 312 555 0142`, rejects 9 digits/letters/non-US with a message. |
| `trackingPrefs.test.ts` | shipment override beats customer per key independently; unknown/garbage JSON ignored; `null` customer ⇒ legacy (`allowsAutoRequests` true); `MANUAL` ⇒ false; `channelsAllowedBy`: `EMAIL` drops SMS, `SMS` drops EMAIL, `BOTH`/null unchanged, empty result possible; `validateTrackingPrefsOverride` throws on a bad enum. |
| `checkCallAgent.test.ts` (+) | customer `MANUAL`: AUTO run sends nothing, `processed[0].reason === 'Customer tracking is manual'`; the **same shipment** via a person's run (`mode` not AUTO) still sends; `method SMS` ⇒ no EMAIL row and no dispatcher escalation e-mail; `method EMAIL` ⇒ no SMS row; own-fleet leg with `truckId` whose TruckConfig has a phone ⇒ SMS `to` = truck phone; truck without phone ⇒ `to` = personal snapshot; shipment override `PERSONAL` ⇒ personal even when the truck has a phone; brokered leg ⇒ `to` = `carrier.driverPhone` (regression pin); a second run in the same slot writes no duplicate (existing claim ids). |
| `automation.test.ts` / `podReview.test.ts` (+) | `MANUAL` customer ⇒ POD pass skips with a note and writes no `auto:pod:*`; `method EMAIL` ⇒ only e-mail asked; SMS POD request goes to the resolved number. |
| `handler.test.ts` (tracking) (+) | `TEXT_DRIVER` result `smsError` names the truck for `WORK_ONLY`; `SEND_TRACKING_LINK` explicit `to` beats routing; `SEND_SHIPMENT_MESSAGE {channel:'SMS', party:'DRIVER'}` with no `to` stores the resolved number. |
| `tms-shipment-actions/handler.test.ts` (+) | `SET_TRACKING_PREFS`: outsider refused (`/page-loads/`), voided shipment refused, bad enum refused, all-null clears the field, audit row written, other shipments untouched. |
| `tms-directory-actions/handler.test.ts` (+) | `UPSERT_CUSTOMER` stores the three enums, rejects a bad value, **keeps stored values when the keys are absent** (profile save of another field must not wipe them). |
| `driver-app-api` test (+) | `/me.workPhone` = truck phone + label + unit for a driver with `assignedTruckId`; null when truck has none/driver has no truck; never contains another truck's number. |
| `dispatch-twilio-webhook` test (+) / `dispatch.test.ts` (+) | `matchDriverByPhone` matches a driver by work phone and still returns `null` on an ambiguous number; an inbound text from a truck work phone is filed under the driver's conversation; with exactly one live shipment awaiting a reply the bridge calls the router once with `messageId 'sms:<sid>'`; with two candidate shipments **no** bridge call; a Twilio retry (same sid) bridges once; a router failure does not fail the webhook (still `EMPTY_TWIML`). |
| `thread.test.ts` (+) | `INGEST_SHIPMENT_MESSAGE` with `channel:'SMS', party:'DRIVER', shipmentId` stores a `RECEIVED` SMS row, clears `checkCallAwaitingSince`, is idempotent on `messageId`. |
| `legacyRoutes.test.ts` | table in §3.2, including that `/tms/tracking/links` is not mapped. |
| `TrackingWorkstation.test.tsx` (rewritten parts) | row click sets `?shipment=<id>` and renders the drawer (location stays `/tms/tracking`); checkbox click does not; `?assignee=all&focus=checkcalls` lists only rows that are due/overdue; `focus=docs` lists only rows with `pendingDocReviewCount>0` including a delivered one; `focus=exceptions` only `openIncidentCount>0`; Log check call from the row menu calls `logCheckCall` once with the load's CAS token; Snooze calls `setNextCheckCall` with `expectedUpdatedAt` and +1 h; Review documents disabled at 0; no Manage-links button; `?tab=inbox&shipment=` opens the drawer. |
| `ShipmentTrackingView.test.tsx` | SMS pane shows only SMS rows, e-mail pane only e-mail rows; an SMS `NOT_SENT` row shows "Would have sent"; SMS composer sends `{channel:'SMS', party:'DRIVER', to:null}`; e-mail composer requires subject and sends `party:'DISPATCHER'`; with no phone the SMS composer is disabled and says why (`SmsTarget.reason`); strip shows driver + truck + work/personal text, last-location age, next-check tone, POD label, carrier contact; "Recent check calls" lists at most 5, newest first; Resolve on an OPEN exception calls `resolveIncident`; override popover "Inherit" saves `prefs:null`. |
| `trackingSummary.test.ts` | pure: DUE/OVERDUE/SCHEDULED/NONE next-check states, ETA fallback order, POD `null` when no row, own-fleet carrier label. |
| `TrackingPrefsFields.test.tsx` / `CustomerForm` test | create mode preselects AGENT/BOTH and the saved record carries all three keys; legacy customer shows "Not set" and saving an unrelated field sends no tracking keys; profile card saves only the three keys. |
| `TruckPhoneEditor.test.tsx` / `TrucksPage` test | typing `(312) 555-0142` saves `+13125550142`; invalid shows the error and does not call `upsertTruckConfig`; Clear sends nulls; "No phone (n)" chip filters; sort by phone puts missing last. |
| `TruckPhonesCard.test.tsx` | lists exactly the trucks `trucksWithoutPhone` returns; saving a phone removes the row. |
| `DriverPhones.test.tsx` | the three text contracts in §4.4 (work+personal, truck-without-phone, no truck). |
| `DispatchBar` test | with `workPhone` shows "Work phone · truck 12" and a `tel:` link; without it renders as before. |
| `seedTruckPhoneAJK.test.mjs` | pure planner: refuses a production table suffix; refuses when no/ambiguous driver; plan for an existing TruckConfig is an update; `--revert` plans a null write; output masks the number. |

No test asserts pixel layout, class names or prose that is not a user-visible contract.

---------------------------------------------------------------------------------------------------

## 8. Dev seed — John Brittich's truck phone

`scripts/seedTruckPhoneAJK.mjs` (dev only; dry-run by default; modelled on `backfillOwnAssetDrivers.mjs` + `devIdentity.mjs`):

* Guards: hard-coded dev AppSync/pool from `scripts/lib/devIdentity.mjs`; refuses if the resolved endpoint or table suffix contains the prod fragment `5ucwdyvwivelbo4k4jomvrwel4`; `--apply` required to write; never reads or prints SSM.
* Flow: `mintIdentity('zz-ajk-seed-<ts>@…', ['ADMIN'])` → `gql` list drivers, find the one with exact `name === 'John Brittich'` (0 or ≥2 matches ⇒ exit 2 and list the candidate *names/ids only*) → `driver.assignedTruckId` (missing ⇒ exit 2 with the message "John Brittich has no assigned truck on dev; assign one in Files › Edit or pass --truck=<unit>"; with `--truck=<unitNumber>` it resolves `Equipment` by unit and **does not** assign the truck to the driver) → read `TruckConfig` by `truckId` → `updateTruckConfig`/`createTruckConfig({ truckId, unitNumber, phone, phoneLabel: 'Dev test phone (Ryne)' })` where `phone` is **Ryne's own test number, deliberately not written in this repo document**: Main passes it to S6 in the task text and the script takes it only from `--phone=` / `AJK_SEED_PHONE` (no default; refuses to run without it; validated by `normalizeTruckPhone`) and **only ever logs it masked to the last four digits** → re-read to verify → `finally` `deleteIdentity` (re-reads to confirm).
* `--revert`: writes `phone: null, phoneLabel: null` on that truck's `TruckConfig` (restores the pre-seed state because the field did not exist).
* Idempotent: second run reports "already set". Output: ids + masked number only.
* Not part of the harness' default path; `devVerifyAJ.mjs` step 9 *reads* the result (masked) and never sends anything.

---------------------------------------------------------------------------------------------------

## 9. Verification harness — `scripts/devVerifyAJ.mjs`

Pattern of `devVerifyV.mjs` / `devVerifyAH.mjs`: flags `--inventory` (offline: route registry + nav shape + redirect table + file-existence checks, **no network**), `--only=<step>`, `--no-dark`; guards `DEV_APPSYNC` regex, prod-suffix refusal, `ALLOWED_ORIGINS`; two throwaway identities (`zz-aj-admin-<ts>`, `zz-aj-tms-<ts>`, passwords never printed); fixtures named `ZZ AJ …`; screenshots to `Docs/tms-build/screenshots/aj/`; `finally` voids shipments / archives customers / restores `TruckConfig.phone` as found / deletes + verifies identities. Output: ids, counts, masked numbers. Registered in an exported `AJ_STEPS` list like `V_STEPS`.

| Step | Does | Passes when |
|---|---|---|
| 0 `inventory` | offline | `navSections` Load Tracking has no children; `legacyRoutes` table complete; route registries (`aaRoutes`, `uRoutes`, `devVerifyS2`) contain no `page(...)` for the two removed paths; every file the plan creates exists. |
| 1 `schema` | create customer via `createCustomer` with `trackingMode=MANUAL, trackingMethod=SMS`; re-read | values persisted; an `UPSERT_CUSTOMER` of only `name` leaves them intact. |
| 2 `override` | create shipment; `setTrackingPrefs({mode:'AGENT'})`; read | shipment row `trackingPrefs` = `{mode:'AGENT'}`; customer unchanged; `setTrackingPrefs(null)` clears. |
| 3 `manual-gate` | customer `MANUAL`; own-fleet/brokered fixture with rate con sent; `routerAs` `RUN_TRACKING_AUTOMATION` mode AUTO scoped to the shipment | **zero** `ShipmentMessage` rows created for it and the result notes "Customer tracking is manual"; flip customer to `AGENT` + switches on ⇒ rows appear. |
| 4 `method` | `trackingMethod=EMAIL` then `SMS`; manual `RUN_CHECK_CALL_PLAN` | EMAIL ⇒ only `channel EMAIL` rows; SMS ⇒ only `SMS` rows. |
| 5 `truck-phone` | ZZ own-fleet driver (fictional personal `+1312555 01xx`), ZZ truck + `TruckConfig.phone` = a different fictional `+1312555 01yy`; assign asset; manual check call | SMS row `to` == truck phone (`NOT_SENT` on dev); clear the truck phone ⇒ next send `to` == personal; shipment `driverSms:'PERSONAL'` ⇒ personal even with a truck phone; `WORK_ONLY` + no truck phone ⇒ `TEXT_DRIVER` returns `smsError` naming the truck. |
| 6 `reply` | the webhook itself cannot be driven without Twilio signing, so the harness calls `routerAs(…,'INGEST_SHIPMENT_MESSAGE')` with the exact envelope the bridge sends (`channel SMS`, `party DRIVER`, `messageId sms:zz-…`) | row stored `RECEIVED`/`SMS`, appears in `listShipmentMessages`, clears `checkCallAwaitingSince`, a repeat with the same `messageId` adds nothing. The webhook-side sender match and bridge are covered by the Lambda unit tests above (R3). |
| 7 `ui-nav` | CDP browser 1440×900 as the TMS identity | sidebar has one "Load Tracking" row, `[aria-expanded]` caret absent, no `.tms-nav-live`; navigating to `/tms/check-calls`, `/check-calls`, `/tms/documents/review`, `/documents`, `/tms/documents/view/zz-x` ends at the exact §3.2 URL with the grid rendered; `/tms/tracking/links` still renders `customer-links-page`. |
| 8 `ui-grid` | grid with fixtures | Focus chips counts match the data; clicking a row adds `?shipment=` and shows `[data-testid="tracking-drawer"]`; reload keeps it; Esc closes. |
| 9 `ui-drawer` | open the fixture shipment at 1440×900 | summary strip, both panes, composer and "Recent check calls" all have `getBoundingClientRect().bottom <= innerHeight` (above the fold, light and dark); each stream `scrollHeight > clientHeight` after seeding 40 rows and scrolling one does not move the other; NOT_SENT text visible in the SMS pane. |
| 10 `ui-customer` | open create-customer dialog | Tracking group visible without switching tabs, defaults AGENT/BOTH; save; profile card shows them. |
| 11 `ui-trucks` | `/trucks` and Settings | Phone column; "No phone (n)" equals the Settings card count; edit a ZZ truck's phone → row gone from the card. |
| 12 `john` | read-only | `TruckConfig` of John Brittich's assigned truck has a valid `phone` whose last four digits equal `--expect-last4=<nnnn>` (Main supplies; masked in logs) — `SKIPPED (allowed: not seeded yet)` otherwise. **Never sends.** |
| 13 `driver-app` | not automatable (driver pool) | `SKIPPED (allowed: …)` + vitest render coverage; manual 10-minute phone pass listed in the report (header shows work phone). |

Verification of S1–S6 before the harness: Main's single typecheck (`tsc --noEmit -p tsconfig.app.json` and `-p amplify/tsconfig.json`), eslint and `vitest run` after all slices land; one push; wait for the Amplify job to SUCCEED; then run the harness against the dev site (`DEV_VERIFY_UI_URL`).

### Screenshots (`Docs/tms-build/screenshots/aj/`, light + dark where noted, 1440×900)

`AJ01-nav-collapsed` (L+D, one row with badge), `AJ02-grid-default` (L+D), `AJ03-grid-focus-checkcalls`, `AJ04-grid-focus-docs`, `AJ05-grid-row-menu` (new actions), `AJ06-drawer` (L+D, above-the-fold proof), `AJ07-drawer-notsent` (SMS "Would have sent"), `AJ08-drawer-override-popover`, `AJ09-customer-create-tracking`, `AJ10-customer-profile-tracking`, `AJ11-settings-tracking-link`, `AK01-fleet-phone-column`, `AK02-fleet-phone-edit`, `AK03-settings-truck-phones-report`, `AK04-driver-drawer-both-phones`, `AK05-files-driver-row`, `AK06-dispatch-header`, `AK07-scheduler-label`, `AK08-driver-app-header` (jsdom render image or manual phone capture, labelled as such), `AK09-strip-work-phone` (closeup).

---------------------------------------------------------------------------------------------------

## 10. Slices, ownership, landing order

Six builders (`task` agents, one `tasks[]` batch after S1 lands). **Disjoint file ownership**: a file appears in exactly one slice; shared contracts are the exported names below. Builders run **no** formatter/linter/typecheck/project test run (Main runs them once, §9); they may run their own single test file. Cross-slice needs go through `hub` to the owner, never an edit.

| Slice | Owns (create / edit / delete) | Depends on | Notes |
|---|---|---|---|
| **S1 CONTRACT** | `amplify/data/resource.ts`; `src/types/tms.ts`; `src/lib/trackingPrefs.ts(+test)`; `src/lib/workPhone.ts(+test)`; `src/hooks/useTruckConfigs.ts`; `src/components/DriverPhones.tsx(+test)`; `src/lib/apiClient.ts`; `amplify/functions/tms-directory-actions/handler.ts(+test)`; `amplify/functions/tms-shipment-actions/handler.ts(+test)` | — | Lands **first**, alone. After it lands Main (or S1 itself) runs the typecheck once so S2–S5 build on a compiling contract. |
| **S2 LAMBDAS** | `amplify/functions/tms-tracking-actions/{driverPhone,checkCallAgent,automation,podReview,thread,handler,testSupport}.ts` + tests; `amplify/functions/dispatch-twilio-webhook/*` + tests; `src/lib/dispatch.ts(+test)`; `amplify/backend.ts`; `amplify/functions/driver-app-api/handler.ts(+test)` | S1 | `backend.ts` single owner (shared with every other step — see "other steps" below). |
| **S3 NAV + GRID** | `src/lib/navSections.ts(+test)`; `src/features/tms/{TmsShell.tsx,TmsLayout.tsx,useShellBadgeCounts.ts}` + tests; `src/App.tsx`; `tracking/{legacyRoutes,trackingTable,trackingColumns,types}.ts`, `TrackingBoard.tsx`, `workstations/TrackingWorkstation.tsx` + tests; `documents/{DocumentReviewPanel,DocumentReviewDialog}.tsx`; deletions of `CheckCallsPage*`, `DocumentReviewPage*`; `tms/notifications/collectNotifications.ts` + tests; `loadReview/LoadReviewDrawer.tsx` + `LoadReviewPage.test.tsx`; `settings/TrackingSettingsCard.tsx` | S1 | Imports `TrackingDrawer` (contract in §5.3). |
| **S4 TRACKING VIEW** | `tracking/{ShipmentTrackingView,TrackingSummaryStrip,RecentCheckCalls,TrackingPrefsPopover,TrackingDrawer,TrackingConversation,TrackingDetailPanel,DriverCard}.tsx`, `tracking/trackingSummary.ts` + tests; `tms/styles/conversation.css`; `shipments/components/TrackingSection.tsx(+test)` | S1 | Exports `TrackingDrawer`, `ShipmentTrackingView`. Uses `DriverPhones`, `useTruckConfigs`, `effectiveTrackingPrefs`, `driverSmsTarget` from S1. |
| **S5 CUSTOMER + TRUCKS UI** | `directory/components/{TrackingPrefsFields,useCustomerForm,CustomerForm,CustomerProfile}.*` + tests; `trucks/{TruckPhoneEditor,TrucksPage}.tsx` + tests; `settings/{TruckPhonesCard,SettingsPage}.tsx` + tests | S1 | `DirectoryPages.tsx` needs no edit (form-driven); if it does, S5 owns it. |
| **S6 DRIVER SURFACES + INTEGRATION** | `drivers/DriverDrawer.tsx`; `files/{FilesPage,EntityFilePanel}.tsx` (+ `FilesPage.render.test.tsx` mock); `dispatch/DispatchPage.tsx`; `calendar/SchedulerView.tsx` (+ test mock); `driver-app/{DispatchBar,driverApi,useDriverProgram}.ts*` + test; `scripts/seedTruckPhoneAJK.mjs(+test)`; `scripts/devVerifyAJ.mjs`; route registries listed in §5.6; `Docs/tms-build/{BUILD_LOG.md,AA_ROUTE_INVENTORY.md}` | S1 (S2–S5 for the harness) | **Integration owner**: after S2–S5 land, S6 runs only its own tests, then reports to Main; Main runs the single global validation. |

**Landing order:** S1 → { S2, S3, S4, S5 in parallel } → S6. Main then: typecheck (app + amplify), eslint, full vitest, `scripts/measureDataTemplate.mjs`, **one** commit/push on `dev` (done by Main, not by builders), wait for the Amplify dev job, run `seedTruckPhoneAJK.mjs --apply` once, then `devVerifyAJ.mjs`.

**Files other steps touch (collision list).** The tree is clean at `a8e320e` (AF, AH, AC2 committed), but deploy-verification agents are editing code now and any future step will too. Highest-risk shared files: `amplify/data/resource.ts` (every schema step; S1 edits only the three anchor points above and re-reads first), `amplify/backend.ts` (tracking block ~L2660-2700, driver-app block — S2 appends env/grants, never reorders), `src/lib/apiClient.ts` (append-only block + three list edits), `src/types/tms.ts`, `src/App.tsx` (route block L148-168 was last edited by AH: `shipments/new`, `shipments/:id/edit`), `src/lib/navSections.ts`, `src/features/tms/TmsLayout.tsx` (`DENSE_PATHS` edited by AC/AH), `TrackingBoard.tsx` / `trackingColumns.ts` (AC/AC2: dense grid prefs, columns dialog, measured widths — **do not** touch `src/features/tms/grid/*`), `tms-shipment-actions/handler.ts` (AH added actions; S1 adds one case), `tms-tracking-actions/checkCallAgent.ts` (Step V). Steps AG/AI do not exist in the tree; if they appear, their owners must be told these files are in flight.

---------------------------------------------------------------------------------------------------

## 11. Production migration note and merge-to-main checklist

* **What ships to prod when `dev` merges:** six nullable attributes (§2.1) and the code above. **Additive; no backfill; no migration script; no data change.** Until someone sets a value: `Customer.trackingMode/Method/driverSmsTarget = null` ⇒ Step V behaves exactly as today; `Shipment.trackingPrefs = null` ⇒ inherit; `TruckConfig.phone = null` ⇒ every SMS goes to the personal number exactly as today (brokered legs are never affected).
* **Operational step after the prod deploy (people, not scripts):** open Fleet and enter each truck's work phone (the Settings › "Truck work phones" card lists exactly the trucks still missing one). Optionally set customers' tracking mode/method in their profile. Nothing else.
* **The checklist already exists:** `Docs/tms-build/BUILD_LOG.md`, section `### MERGE-TO-MAIN CHECKLIST` (L672+). S6 adds to **Before the merge**: `- [ ] **Steps AJ/AK additive fields.** Customer.trackingMode / trackingMethod / driverSmsTarget, Shipment.trackingPrefs, TruckConfig.phone / phoneLabel — all nullable, no backfill; verify against the production table suffix (5ucwdyvwivelbo4k4jomvrwel4-NONE); confirm tms-tracking-actions and driver-app-api have TRUCK_CONFIG_TABLE_NAME (and DRIVER_TABLE_NAME for tracking) after the deploy.` and to **After the merge**: `- [ ] Enter truck work phones on Fleet (Settings › Truck work phones lists the gaps). Do NOT run scripts/seedTruckPhoneAJK.mjs on production (it refuses a production suffix).` Also add the six fields to the "extends ~10 existing models" sentence's model list (`Customer`, `Shipment`, `TruckConfig`) and re-measure the data-stack template (`scripts/measureDataTemplate.mjs`).
* Old bookmarks: the redirects (§3.2) ship with the code; no server-side redirect/DNS work.

---------------------------------------------------------------------------------------------------

## 12. Decisions (defaults are what the builders implement; Ryne can flip any in one place)

| ID | Question | Default | Alternative / how to flip |
|---|---|---|---|
| D-AJ1 | Drawer or full page for a grid row click? | **Right-side drawer** (`TmsDrawer xl`, URL `?shipment=`), with "Open full page ↗" to `/tms/shipments/:id?tab=tracking`; the full page mounts the same `ShipmentTrackingView`. | Navigate to the full page as today: change `openShipment` in `TrackingWorkstation` to `navigate(...)`; drawer stays reachable by URL. |
| D-AJ2 | Does `AGENT` force automation on? | **No** — `AGENT`/null defers to Step V switches/quiet hours; only `MANUAL` is an override (it blocks). | Make `AGENT` imply `checkCallsAuto`/`podAuto` true for that customer: one branch in `resolveAutomation` call sites. |
| D-AJ3 | What does `trackingMethod` do? | Intersects the plan/POD channels (never adds); applies to AUTO **and** manual runs; `BOTH`/null = no change. | AUTO-only filtering: pass `mode` into `channelsAllowedBy` call. |
| D-AJ4 | Inheritance model | **Resolve-at-read** (shipment override ?? customer ?? legacy null). No copy at create, no backfill. | Copy-at-create (stale-prone): add two fields to the `createShipment` literal (`handler.ts` L2031+). |
| D-AJ5 | Customer links | Page stays as an **off-nav** route `/tms/tracking/links`; drawer head has the per-shipment dialog; Settings › Tracking has a small link; the board's toolbar "Manage links" button is **removed**. | Keep the toolbar button: restore `onManageLinks`. |
| D-AJ6 | Should the AUTO agent/POD sweep also act on **own-fleet (Ivan)** legs? | **No** (unchanged gate `carrier.kind === 'CARRIER'`); own-fleet is reached by manual paths, which AK routes to the truck phone. **Ryne to confirm** — "AI agent tracking" for an Ivan customer currently never auto-fires. | Widen the gate in `checkCallAgent.ts` L229 / `automation.ts` ~L137 to `OWN_ASSET` with a driver; needs its own rate-con/“sent” notion (own-fleet has no rate con), so it is a separate step. |
| D-AJ7 | Defaults on **new** customers | Mode **AGENT**, method **BOTH**, driver SMS **WORK_THEN_PERSONAL**, always written. Existing customers stay `null` ("Not set"). | Default to MANUAL for safety: change `emptyCustomerForm`. |
| D-AJ8 | Bulk edit mode/method for many customers | **Not built** (profile + create only, as asked); `settings/automation/CustomersPanel.tsx` untouched. | Add two columns there later. |
| D-AJ9 | Build the inbound SMS bridge (F12 / §4.6)? | **Yes**, conservative (only a resolved driver with one unambiguous live shipment). Required for the left pane to show the driver's replies. | Skip: the SMS pane then shows outbound only and says "Replies are in Dispatch" with a link to the conversation (S4 renders that note when no IN rows exist and the bridge flag is off). |
| D-AK1 | "Settings > Trucks" does not exist | Phone column + editor on **Fleet** (`/trucks`); Settings gets the **Truck work phones** report/quick-fix card. | Create a Settings child "Trucks" (`/tms/brokerage/trucks`) hosting the table: new `SETTINGS_CHILDREN` row + route; reuse `TruckPhoneEditor`. |
| D-AK2 | `TruckConfig.assignedPhone` and `CompanyPhone` already exist | New `phone`/`phoneLabel` as specified; **`assignedPhone` and `CompanyPhone` untouched**; no migration between them. **Ryne to say** whether `assignedPhone` values on prod (if any were typed) should seed `phone` — none are read/written by the app today. | One-off copy script after Ryne confirms; the app never reads `assignedPhone`. |
| D-AK3 | Which truck defines the work number | Load's truck (`LoadCarrier.truckId`, else `Load.truckId`) → else `Driver.assignedTruckId`. One truck, no cross-borrowing. | Prefer the driver's assigned truck over the load's: swap two lines in `workPhoneFor`. |
| D-AK4 | Phone format | **US E.164 only** (`toE164Strict`; Twilio setup is US-only); other formats rejected in the editor. | Allow international: replace the normalizer in one place. |
| D-AK5 | Per-customer / per-shipment SMS override | `driverSmsTarget` enum (`WORK_THEN_PERSONAL` default · `WORK_ONLY` · `PERSONAL`); precedence shipment → customer → default. | A literal per-shipment phone number override is **not** built (staff can type a number in Send tracking link, which already beats routing). |
| D-AK6 | Dispatch/Schedule "Text" links & schedule copy-paste text | Not routed — they are staff-initiated from their own phone/clipboard; Dispatch shows both numbers for reference. | n/a |
| D-AK7 | Driver-app header | Display-only "Your work phone · truck N" line (+ `tel:`); no edit by drivers. | Hide for owner-operators (`fleetGroup`) if Ryne wants it Ivan-only. |

---------------------------------------------------------------------------------------------------

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Nav/route removal breaks bookmarks and in-app links** (notifications, Load Review drawer, `devVerify*` registries, `AA_ROUTE_INVENTORY`). | One redirect table (`legacyRoutes.ts`) used by `App.tsx`, tests, registries and the harness (`ui-nav` step); every in-app link retargeted in S3/S6; grep gate in S6 for `/tms/check-calls` and `/tms/documents/review` in `src` (only the redirect table may mention them). |
| R2 | **Work moved, not lost**: log/snooze/resolve and accept/reject have working tests today. | Extract-then-delete order inside S3; behaviours (payload shapes) migrated into new tests before the page files are deleted. |
| R3 | **Replies to a text sent to a truck number**: the webhook matches senders by `Driver.phone` only (F12) and nothing bridges SMS into `ShipmentMessage`. | §4.6 (work-phone match + conservative bridge); outbound `textInto` already creates the conversation with `driverId`, so the first reply from the truck phone lands in the right conversation even before the roster knows the number; the bridge refuses to guess when a driver has several live shipments (reply stays in Dispatch only). Unit-tested in the webhook; harness step 6 covers the router half. |
| R4 | `TruckConfig` is writable by any signed-in staff user with no server validation (existing pattern). | UI validation + `toE164Strict` at send time + `workPhoneFor` treats invalid as absent; a garbage value can only cause a fallback to personal, never a send to a wrong number format. Moving writes behind a Lambda is out of scope. |
| R5 | **Dev texts real drivers** if Twilio is ever configured on dev (roster was copied from prod). | Truck-phone routing + John's seed is the safe test path; harness uses fictional numbers and only asserts `NOT_SENT` rows; the plan adds no Twilio configuration. Main must not set Twilio secrets on dev without Ryne. |
| R6 | Behaviour change for **own-fleet** manual sends: after a truck has a phone, "Text driver" no longer reaches the personal number. | That is the requested rule; every response and the SMS pane show *which* number was used (`source` in audit, `to` on the message row); `PERSONAL` override exists. |
| R7 | Two-pane thread must stay above the fold at 1440×900 with five check-call rows and a 12-line strip. | Fixed vertical budget (head 48 + strip 36 + panes flex + recent ≤ 150); harness `ui-drawer` measures bounding rects; panes `min-height: 280px` and the drawer body scrolls only if the viewport is shorter than ~720 px. |
| R8 | `useTruckConfigs` uses `listTruckConfigs` (limit 100, no pagination). | Fleet is far below 100; S1 adds pagination via the existing `listAllByIndex`-style loop if the builder finds a helper (otherwise noted in the code comment and the Settings card shows a warning when `items.length === 100`). |
| R9 | `trackingMode` null on legacy customers hides the fact that automation might be on for them. | `mode` column and the profile card say "Not set — follows Settings › Tracking automation" and show the resolved Step V switch state. |
| R10 | Concurrent edits to hot files while the deploy is verified. | Ownership lists above; builders re-read before editing; S1 first and small; no formatter runs by builders. |
| R11 | Data-stack template size (adds 6 attributes only). | Main re-measures (`scripts/measureDataTemplate.mjs`) before the push. |

---------------------------------------------------------------------------------------------------

## 14. Acceptance (what "done" means for the whole plan)

1. The sidebar shows **one** "Load Tracking" row with the due-work badge; no children, no live list; every old URL lands on the right grid view; `/tms/tracking/links` still works and is linked from Settings › Tracking and the drawer.
2. The grid has Focus (All / Check calls due / Documents to review / Exceptions), `Check calls` and `Docs` columns, and row actions Log check call · Snooze · Review documents; the old pages' working behaviours are covered by migrated tests.
3. Row click opens a drawer (and `?shipment=` deep link) with the summary strip, SMS/e-mail panes with independent scroll and `NOT_SENT` shown (driver replies by text appear in the SMS pane through the §4.6 bridge), and the last 5 check calls, all above the fold at 1440×900; the same component is the Tracking tab.
4. Customers get mode/method (and driver-SMS target) at creation and in the profile; shipments override; `MANUAL` ⇒ no automatic requests; method filters channels; both proven by Lambda tests and `devVerifyAJ` steps 3–4.
5. `TruckConfig.phone/phoneLabel` exist; `workPhoneFor`/`driverSmsTarget` drive every driver-SMS send (truck first, personal fallback, overrides); work/personal shown on driver drawer + profile, Dispatch, Schedule, driver-app header, summary strip and the SMS pane; Fleet has the Phone column; the "Trucks without a phone" report exists.
6. John Brittich's dev truck carries Ryne's test phone (seed run once, verified masked in logs); nothing was sent; production checklist updated.
