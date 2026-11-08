# Step U — Shipments simplification, Academy/Workflows hidden, division intake e-mail, Intake area + review

> **Status: COMPLETE DRAFT — ready for Main to dispatch. (Written incrementally; sections 12–13 hold risks and the decisions for Ryne.)**
> Plan only. Nobody edits code until Main dispatches the slices in §7. Dev only; one Amplify deploy together with Step V (`V-plan.md`, VPlan).

Spec (Ryne, via Main): **U1** Shipments shows exactly two lists, ACTIVE (not yet released to invoicing) and ALL; remove every view/queue/workstation/saved-board-view/sub-board; keep column customization, type-ahead filters, batch actions, duplicate; keep Tracking inbox + customer links + the shipment detail tabs. **U2** hide Academy and Workflows (nav, routes, dashboard cards, settings UI) — hide only, no data or backend deletion. **U3** creating/editing a rev division REQUIRES an intake e-mail address (pick from configured mailboxes or type; validated), stored on the division. **U4** an Intake area inside Shipments, one tab per rev division, listing loads partially built from tender e-mails that arrived at that division's address (reuse the tender/parse pipeline + AI extraction; mark auto-filled vs missing/low-confidence; link to source e-mail). **U5** a reviewer checks/corrects every field and presses **Move to active** (creates/promotes into Active; audits who/when; blocked until required fields are valid); new intake-reviewer permission.

Standing rules honoured: `Docs/TMS_BUILD_BRIEF.md` hard rules (dev only; additive schema; PRO numbers permanent; release gate untouched; never `invoice_*.json`); conventions of `S1..S4-plan.md` (kit + tokens, **no colour literal in `.ts/.tsx/.css`** lint guard, `devVerify` patterns, behavioural tests only).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Eight findings that shape the design (all grounded in code read during recon)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F1** | **A tender e-mail does not become a Shipment today.** `workflow-agent` produces a `WorkflowRun` (outcome `PROPOSED`, `proposal.tender`); a person applies it through `NewShipmentDialog` (`source:'TENDER'` → `CREATE_SHIPMENT` → `TENDER_PENDING`). `CREATE_SHIPMENT` never writes `buildState`/`missingFields`/`revDivision`; only the demo seed writes `BUILDING`. | `workflow-agent/run.ts` L691-710 (`PROPOSE_TENDER` → `finishWith(run,'PROPOSED')`, `run.test.ts` L498 asserts the run table is the only write); `tms-shipment-actions/handler.ts` L1727-1990 (`createShipment`); `demo.ts` L726-745 | "Partially built load" cannot be a Shipment: **every Shipment burns a permanent PRO** (`createShipment` claims it in the same transaction; shipments can only be voided, never deleted). Junk e-mails must not consume PROs. → **Intake rows are a separate additive record (`IntakeLoad`); a PRO is claimed only at Move to active** (§5.1). |
| **F2** | **No SES inbound exists anywhere** (no receipt rules, no inbound bucket, no SNS). Inbound mail = Gmail mailbox + Apps Script bridge (`scripts/agentEmailBridge.gs`, 5-min poll) posting JSON to the public `workflow-agent` Function URL. The bridge decides the role **by which address the message was delivered to** (`agentRoleFor_` checks To/Cc/Delivered-To/X-Original-To/List-ID against a fixed 4-role table) and posts **no recipient list** to the server. | `agentEmailBridge.gs` L47-52, L550-575; `workflow-agent/inbox.ts` `BasePayload` (no `to`) | Per-division routing needs (a) the bridge to post the recipient list, (b) the bridge to learn the division addresses (new secret-guarded `intakeAddresses` action on the same URL), (c) the server to match recipient → division (§5.2). Real mail needs one **human step** (Ryne: create the addresses/aliases, paste the updated bridge script); dev is exercised by posting through the same `prepare`/`commit` path (§11.5). |
| **F3** | **No mailbox model, no per-address config, no division e-mail field.** Nearest constants: `THREAD_MAILBOX='ai4bcat@gmail.com'` (`src/lib/shipmentThread.ts` L18, duplicated at `shipment-email-intake/resource.ts` L23), `INBOX_PLUS_ROLES` (`tenders→TENDER`), the bridge default `tenders@bcatcorp.com`. | recon of `resource.ts`, `shipmentThread.ts`, `integrations/registry.ts` | The picker is a **suggestion list + free typing**, not a settings table (§4.2). No Integration/TmsSettings schema change. |
| **F4** | **Per-field confidence/provenance does not exist on the tender path.** Only `TenderPrefill.format` (`E2OPEN`/`SUBJECT`/null) and the classifier's routing confidence. `TENDER_FILL_SCHEMA` (`model.ts` L116) has no confidence. But the merge order is deterministic (`tenderFromParse`: parser wins, the model fills blanks), so **provenance is recoverable**; low confidence needs one small schema extension (`lowConfidence: string[]`) plus format validation. | `model.ts` L116; `tenderProposal.ts` L92; `run.ts` L818-847 | §5.3 field model: `source` + `confidence` per field, computed at staging; no extra model call. |
| **F5** | **"Needs / build gate" is a pure function we can reuse without a Shipment.** `resolveRequiredFields(settings, customer)` + `missingRequiredFields(subject, required)` (`src/lib/flowDefaults.ts` L174/L239; labels from `REQUIRED_FIELD_CATALOG`). `buildGate.ts` only wraps them around a stored bundle. | `buildGate.ts` L99-165 (`buildSubject` → `RequiredFieldSubject`) | Required-field validation for Move to active = the same two functions over a subject built from the draft (client live, server authoritative). Same labels as the shipment page's "Needs:" line. |
| **F6** | **"Released to invoicing" lives on the Order, not the Shipment**: `Order.arStatus` starts `DOCS_NEEDED`; `READY_TO_INVOICE` (`documents.ts` ~L830-920) moves it to `UNBILLED` and stamps `readyToInvoiceAt`; later `UNPAID`/`PAID`; `INVOICE_NOT_NEEDED`/`LEGACY` are set at create/backfill. The board already receives `arStatus`, `readyToInvoiceAt`, `invoiceId` on every row. | `resource.ts` Order; `useShipments.ts` L338/L580; `ShipmentsBoard.tsx` L238-269; `shipmentViews.ts` L464 (`massReleaseReady`) | ACTIVE vs ALL is a **pure client filter** over fields the row already has (§3). No schema/data change. |
| **F7** | **Dispatch and Documents workstations duplicate what the shipment detail already does.** `CarrierSection` (Carrier tab) mounts `CarrierOffersSection`, `PostingsSection`, `RateConPanel`, `CarrierOffersCard`; `OfferQueue`/`PostingPanel`/`rateCon.ts` under `workstations/dispatch/` are imported only by `DispatchWorkstation`. `/tms/documents/review` (`DocumentReviewPage`) is a separate page. | `CarrierSection.tsx` L19-29/L74-93; grep of `workstations/(dispatch\|documents\|coverage\|documentMatrix)` importers: only the workstations themselves | Dispatch + Documents boards can be removed with **no capability loss**. `workstations/motion.ts` is imported by `NotificationsDrawer` and by `tracking/*` → KEEP. |
| **F8** | **The Ask-assistant lives inside Academy** (`AskPanel` in `src/features/tms/pages/AcademyPage.tsx`, `askAcademy` → `ASK_ACADEMY`); nothing else mounts it. **Workflows is load-bearing**: `/tms/workflows/runs/:id` is linked from the shipment AI Agent tab, `QuoteDetail`, `AiAgentsPage`, Errors rows; `/tms/workflows?tab=errors` from the notification drawer and Platform health. | AcademyWf recon: `App.tsx` L167-170, `TmsShell.tsx` L649, `collectNotifications.ts` L340, `PlatformHealthPage.tsx` L18 | Academy: unmount fully (routes + nav + Help icon). Workflows: remove the **nav item only**; keep the two routes reachable by URL (decision **D-U2**). |

### 0.2 Decisions (each has a default so work does not wait; Ryne can overrule any — full list with alternatives in §13)

| # | Decision | Default taken |
|---|---|---|
| D-U1 | Representation of a partially-built load | **Separate additive record `IntakeLoad`** (not a Shipment row). PRO claimed only at Move to active. |
| D-U2 | Workflows/Academy "hide" scope | Academy: routes + nav + header Help icon removed (files and `ASK_ACADEMY` backend left in tree, unreferenced). Workflows: **nav item removed; `/tms/workflows` and `/tms/workflows/runs/:id` stay routable by URL** (4 live deep links depend on them); `My Brokerage → AI Agents` tab stays (only UI for the agents' spend cap/memory). |
| D-U3 | What "released to invoicing" is | `Order.readyToInvoiceAt` set **or** `invoiceId` set **or** `arStatus` ∉ {`DOCS_NEEDED`, null} (§3). |
| D-U4 | Canceled / voided in the two lists | Voided: in neither list unless the existing Statuses facet names VOIDED (unchanged). Canceled: **ALL only** (never invoiced, so not "active"). |
| D-U5 | Which divisions need an intake address | **Every active division** (top-level, subdivisions, COMPANY) — the literal reading. Archived/inactive: exempt. |
| D-U6 | State of the shipment created by Move to active | `source:'TENDER'` → **`TENDER_PENDING`** (the existing Accept/Reject + credit check stays the business decision). Shows in ACTIVE. |
| D-U7 | Permission | New **page grant `intakeReview`** (group `page-intakeReview`), not a new Cognito role. Owner/ADMIN always pass. Anyone who can open Shipments may *view* Intake; only reviewers may edit/move/dismiss. |
| D-U8 | E-mail to an address no division owns | Still staged, `divisionCode = null`, shown under an **Unrouted** tab; the reviewer must choose the division before Move (it is the required "Revenue division" field anyway). |
| D-U9 | Status checkbox facet ("Statuses") on the board's left panel | **KEEP** as a filter (it is a facet with counts, not a view/queue/tab) — flagged because Ryne said "status tabs". |

---------------------------------------------------------------------------------------------------

## 1. U1 — Shipments simplification: KEEP / HIDE / REMOVE ledger (route by route, with dependency evidence)

Legend: **KEEP** untouched · **EDIT** kept, changed · **REMOVE** deleted (route, component, tests) · **REDIRECT** route kept as a `<Navigate>` so bookmarks, notifications and old deep links still land somewhere sensible · **HIDE** unlinked, still routable.

### 1.1 Routes (`src/App.tsx`, `/tms` block, L137-150 + legacy L178-184/L257)

| Route | Component | Verdict | Evidence / why |
|---|---|---|---|
| `/tms/shipments` | `ShipmentsBoard` | **EDIT** | Becomes the two-list board: `?list=active` (default) / `?list=all`. Slug effect (`ShipmentsBoard.tsx` L280-286) that redirects to the default view slug is deleted. |
| `/tms/shipments/view/:slug` | `ShipmentsBoard` | **REDIRECT** → `/tms/shipments` (`view/*` splat; slug `all-shipments` → `?list=all`) | Saved-view URL; bookmarks (`navSections.ts` L80-81, `TmsShell.tsx` L164/L170, `ShipmentViewsPage` "Open view") all die with the views. |
| `/tms/shipments/:id` | `ShipmentPage` | **KEEP** | Detail tabs are not view-dependent (recon: `components/detailTabs.ts`). |
| `/tms/shipments/intake`, `/tms/shipments/intake/:intakeId` | `IntakeBoard`, `IntakeReviewPage` | **NEW** (slice F) | Static segment `intake` outranks `:id` in React Router v6 ranking. Shipment ids are `shp-<uuid>` so no collision. |
| `/tms/dispatch` | `DispatchWorkstation` | **REMOVE** + **REDIRECT** → `/tms/shipments` | Only `App.tsx` imports it. Capability lives on the shipment Carrier tab (F7). Files removed: `workstations/DispatchWorkstation.tsx(+test)`, `workstations/coverage.ts(+test)`, `workstations/dispatch/{OfferQueue,PostingPanel,rateCon}.*` (each grep-verified to have no importer outside the removal set; builder re-greps before deleting). |
| `/tms/documents`, `/tms/documents/view/:slug` | `DocumentsWorkstation` | **REMOVE** + **REDIRECT** → `/tms/documents/review` | Only `App.tsx` imports it. Removed: `workstations/DocumentsWorkstation.tsx(+test)`, `workstations/documentMatrix.ts`, `workstations/documents/PodReviewCard.tsx` (importer: DocumentsWorkstation only). Release-to-billing stays available: board batch action `release` (`RELEASE_TO_BILLING`), `ArCard`, shipment Documents tab. |
| `/tms/documents/review` | `DocumentReviewPage` | **KEEP** | A document review queue (badge `documentReview`), not a shipment board; was linked *from* the Documents workstation (L301). It becomes the nav target of the rail's "Documents" child. **Unsure → KEEP, flagged.** |
| `/tms/tracking` | `TrackingWorkstation` | **KEEP (U makes a small mechanical edit; V rewrites)** | Per brief: Tracking pages stay; V replaces the Inbox UI. It imports `useShipmentViews`/`viewsVisibleTo` + passes view props to `BoardFilterPanel`; with views gone it must drop that wiring or typecheck fails. **Coordination with VPlan (agreed by IRC): U's slice B performs only the mechanical removal that keeps typecheck green, in landing step 1, and V treats the result as its base:** in `TrackingWorkstation.tsx` — local `viewSlug` state, `useShipmentViews`/`viewsVisibleTo`, the save-view dialog + state (`createView`, `viewName`, `shared`, `saveOpen`), the `viewer`/`teamRepIdsFor` option, the `onSaveView={() => panelProps.onCreateFilterSet()}` prop; in `tracking/TrackingBoard.tsx` — `ViewsDropdown` and its use (L310, L547-), the **Save view** button (L311-313), the `onSaveView` prop; in `tracking/types.ts` — `onSaveView`. Nothing else in `tracking/*` (InboxPanel, Inbox*, statusTimeline…) is touched; **U's own code and tests do not depend on the Inbox UI** — V deletes it per Ryne's newer requirement, and the earlier "keep the Tracking inbox pages" wording of U1 is superseded for the Inbox UI (the Tracking *page* and customer links stay). |
| `/tms/tracking/links` | `CustomerLinksPage` | **KEEP** | Type-imports `ShipmentRow` only; nav item "Manage Customer Links" stays. |
| `/tms/check-calls` | `CheckCallsPage` | **KEEP** | Not view-dependent (`features/tracking`); bell deep links (`collectNotifications.ts` L198/L201) and the `checkCalls` badge on the Shipments parent depend on it. **Unsure → KEEP, flagged.** |
| `/loads`, `/shipments`, `/shipments/:id`, `/grid` (legacy) | `Navigate`/`ParamRedirect` | **KEEP** | Land on `/tms/shipments[/id]`. |
| `/check-calls` (legacy) | `Navigate` | **KEEP** | → `/tms/check-calls`. |
| `/documents` (legacy) | `Navigate` | **EDIT** target | → `/tms/documents/review` (was `/tms/documents`). |
| `/tms/brokerage/views` | `ShipmentViewsPage` (inside `BrokeragePage`, `RequireAdmin`) | **REMOVE** the tab + route | Saved board views are gone. `ShipmentViewsPage.tsx(+test)`, `settings/viewDraft.ts(+test if any)` deleted. Backend untouched (`SAVE_/ARCHIVE_SHIPMENT_VIEW`, `ShipmentView` table, `SEED_VIEWS` in `lib/shipmentViewDefs.ts` — the Lambda bundles that file, so it is **not edited**). |
| `/tms/workflows`, `/tms/workflows/runs/:id` | `WorkflowsPage`, `RunTracePage` | **HIDE** (see §2) | |
| `/tms/academy`, `/tms/academy/:slug` | `AcademyPage` | **REDIRECT** → `/tms/dashboard` (see §2) | |

### 1.2 Navigation

| Item | Verdict | Detail |
|---|---|---|
| `PINNED_ITEMS[1].children` (`navSections.ts` L74-77): My queue, Team queue | **REPLACE** | `children: [{ to: '/tms/shipments/intake', label: 'Intake', badgeKey: 'intakeLoads' }]`. |
| `TmsShell.childrenFor` (L150-174) | **REWRITE** | `items = [{Shipments → /tms/shipments}, ...item.children (Intake), {Tracking → /tms/tracking, badgeKey 'tracking', live: trackedLoads}, {Documents → /tms/documents/review}]`; `groups = []` (the **Views** group is gone). `isChildActive`: Shipments child active only for exactly `/tms/shipments`; Intake child for `/tms/shipments/intake*`; Tracking unchanged. The `shipmentViews` prop is removed from `TmsShellProps`. |
| `TmsLayout.tsx` L69-80 | **EDIT** | Remove `useShipmentViews`/`viewsVisibleTo`/`viewCallerOf` and the `shipmentViews` prop to `TmsShell`; keep `trackedLoads` and `onSearch → /tms/shipments?q=`. |
| `navSections.ts` division fallback (L267, `/tms/shipments/view/division-<CODE>`) | **REPLACE** | A division with no pages gets `Intake · <name>` → `/tms/shipments/intake?division=<CODE>` (`pageKey: TMS_PAGE_KEY`). Keeps the section visible and points at the one per-division surface that now exists. |
| `tmsBreadcrumb(pathname, shipmentViews)` | **EDIT** | Drop the `shipmentViews` parameter and the `view/` branch (L173-177); add `/tms/shipments/intake` → `[Shipments, Intake]`, `/tms/shipments/intake/:id` → `[Shipments, Intake, Load]` **before** the generic `startsWith('/tms/shipments/')` branch (else they read "Shipment"); `SHIPMENT_WORKSTATIONS`: remove `/tms/dispatch`, `/tms/documents`; add `/tms/documents/review: 'Document review'`. |
| `useShellBadgeCounts.ts` | **EDIT** | Remove `myQueue`/`teamQueue` (and the `boardStatusOf`/`teamKeys` code only they used — builder greps); add `intakeLoads` = count of `IntakeLoad` rows with `status='OPEN'` (60 s poll via `countOpenIntakeLoads()`, visible-tab only, same pattern as the others). `useShellBadgeCounts.test.ts` L46-50 (enumerates declared `badgeKey`s) is updated. |
| Header Help icon `TmsShell.tsx` L649 → `/tms/academy` | **REMOVE** | |

### 1.3 Board internals (`src/features/shipments/`)

| Piece | Verdict | Detail |
|---|---|---|
| `ShipmentsBoard.tsx` | **EDIT** | Remove: `useParams` slug, `useShipmentViews`, `viewsVisibleTo`/`viewCallerOf`, `visibleViews`, default-view redirect, `onSelectView`, `currentViewId`, `rightViewId`, per-pane `key` from view id, `activeView` (L447-456 `savedFilters/savedColumns/sort`), `rehydrate on view id change` (L513-523), `handleUpdateFilterSet`/`handleRevertFilterSet`/create-view flow. Add: `list` from `useSearchParams` (`'active'` default, `'all'`), `ShipmentsSectionTabs` (§6.4) above the grid, row scope = `inShipmentList(row, list)` applied **before** `matchesBoardFilters`, columns = server column template if chosen else `ALJEX_COLUMN_KEYS`, sort = `DEFAULT_SORT`. **Keep**: column templates + `ColumnsPickerDialog`, type-ahead (`BoardTagPicker`/`detailSearch`), `?q=` search, batch actions (`release`, `rep:`, `carrierRep:`, `carrierTeam:`, `export`), `duplicateShipment` row action, split screen, map, footer, voided toggle semantics, Create shipment button. Split-screen's right pane gets its own `list` state (`'all'` default) instead of `rightViewId`. |
| `board/BoardFilterPanel.tsx` | **EDIT** | Delete the **View** section (select + Save / Save as view / Revert / Delete) and props `viewName, filterSets, activeFilterSetId, filterSetDirty, onSelectFilterSet, onCreateFilterSet, onUpdateFilterSet, onRevertFilterSet, onDeleteFilterSet`. Keep Column Templates, Statuses (D-U9), Details, Dates, Tracking & paperwork, Clear/Reset. |
| `board/useBoardFilters.ts` | **EDIT** | Remove `activeView, views, viewSlug, dirty, onSelectView, onCreateView, saveView, revert, remove`, `createView` (audience logic L342), `resolveQueueSentinels` (`@me`/`@myteam`, `ME_SENTINEL`/`MY_TEAM_SENTINEL` usage), the `viewer` option and `teamRepIdsFor` (their only callers are the three workstations; `ShipmentsBoard` builds its own team list). Filters become plain local state initialised to `EMPTY_BOARD_FILTER_SET`, reset on list change. |
| `board/FilterSetDialog.tsx(+test)` | **REMOVE** | Only "Save as view". |
| `board/queueSentinels.test.ts` | **DELETE** (pins `@me/@myteam` view-seed semantics that no longer exist). |
| `shipmentViews.ts` (row type + columns + filters, 1000+ lines) | **EDIT (small)** | Keep everything. Remove `DIVISION_VIEW_PREFIX`/`divisionCodeOfViewSlug` (only its own test uses it). **Add** nothing else — the list scope lives in the new pure lib below. |
| **NEW** `src/lib/shipmentLists.ts` (+test) | slice B | `ShipmentList`, `isReleasedToInvoicing`, `inShipmentList`, `shipmentListCounts` (§3). |
| `src/features/tms/useShipmentViews.ts` | **REMOVE `useShipmentViews`** (importers: `ShipmentsBoard`, the three workstations, `TmsLayout`, tests — all handled) **but RELOCATE `useOwnershipDivisions` + its `divisionsStore`** (same file, L118; imported by `ShipmentsBoard.tsx` L33/L418, `TmsLayout.tsx` L11/L50, their tests' mocks, and by V's Settings card): slice A creates `src/features/tms/useOwnershipDivisions.ts` exporting `useOwnershipDivisions(): { divisions: OwnershipDivisionRecord[] | null; loading: boolean; error: string | null; refresh: () => void }` with the identical body/60 s poll, then deletes the old file; slice B and V import from the new path (contract fixed here so B/V need not wait). | `listShipmentViews/saveShipmentView/archiveShipmentView` client wrappers and the `ShipmentViewRecord/Row/Filters` types in `apiClient.ts`/`types/tms.ts` are **left** (types are still imported by the Lambda-bundled `lib/shipmentViewDefs.ts`; wrappers removed only if the builder's grep shows zero callers — then delete, since `devVerifyR2` calls GraphQL directly). |
| `src/lib/shipmentViewDefs.ts` | **KEEP unedited** | Bundled into `tms-directory-actions` (SEED_VIEWS, validateView, `boardStatusOf`, `matchesBoardFilters`); seeding of the legacy `ShipmentView` rows by `ENSURE_OWNERSHIP_SEED` continues (data not deleted; nothing reads it). `viewsVisibleTo`, `viewCallerOf`, sentinels become client-dead code in a backend-shared file — accepted and noted; `shipmentViewDefs.test.ts` stays (it defends `boardStatusOf` + `matchesBoardFilters` + seed shape which the backend still uses) but its **view-audience** cases (`viewsVisibleTo`) remain valid because the function still exists. |
| `workstations/motion.ts(+test)` | **KEEP** | Imported by `NotificationsDrawer.tsx` L17 and `tracking/*`. |
| `workstations/tracking/*`, `TrackingSection.tsx` import of `TrackingDetailPanel` | **KEEP** | V-owned. |
| Demo (`demoFlow.ts` P2 text "showing in My queue and in the team queue"; P5) | **EDIT** | See §7 (slice F). |

### 1.4 Tests pinned to removed views (disposition)

Delete (they only pin removed UI): `DispatchWorkstation.test.tsx`, `DocumentsWorkstation.test.tsx`, `workstations/coverage.test.ts`, `board/FilterSetDialog.test.tsx`, `board/queueSentinels.test.ts`, `settings/ShipmentViewsPage.test.tsx`.
Retarget (behaviour survives the cutover):
* `ShipmentsBoard.test.tsx` — default redirect case + `/view/active-shipments` + `/view/all-shipments` (L711) become "`/tms/shipments` shows Active; `?list=all` shows released rows too"; status-count, type-ahead, voided toggle, 50-of-75 paging, CSV, batch release, create, repoint/unvoid, duplicate, check-call tones, accept/reject tender (L779) keep. The `useShipmentViews` mock is removed.
* `board/BoardFilterPanel.test.tsx` — delete the View-selector/Save/Revert/Delete cases; keep status/detail/date/flag cases; remove the view props from the render helper.
* `board/ColumnsPickerDialog.test.tsx`, `BoardGrid/BoardMapView/BoardFooterBar/BatchTaskDialog/BoardTagPicker/detailSearch/IconKeyDialog` tests — unchanged (they are not view-aware).
* `shipments/shipmentViews.test.ts` — drop the `divisionCodeOfViewSlug` case only.
* `TrackingWorkstation.test.tsx` — delete the View-selector/Save-view assertions and the "passes the signed-in viewer to useBoardFilters" case (L380-); `TrackingBoard`-level tests likewise for `ViewsDropdown`/`onSaveView` (V rewrites the rest).
* `tms/TmsShell.test.tsx` — drop the "Views group", "workstation hrefs" for Dispatch/Documents→review; add Intake child + badge; "Active Shipments active on /view/*" → "Shipments child active on `/tms/shipments` only, Intake child active on `/tms/shipments/intake/:id`".
* `lib/navSections.test.ts` — pinned children, division fallback (`Intake · <name>`), breadcrumbs (intake trail; no `view/` branch; workstation list).
* `tms/TmsLayout.test.tsx` — drop the `shipmentViews` slug/default-excluded cases.
* `useShellBadgeCounts.test.ts` — myQueue/teamQueue cases → `intakeLoads`.
* `brokerage/DemoPage.test.tsx` (queue children badges), `brokerage/BrokeragePage.test.tsx` ('Shipment views' tab label list), `RequirePage.test.tsx` (if it uses `/tms/shipments/view/*`).
* `amplify/.../tms-directory-actions/handler.test.ts` — **unchanged** (backend views untouched).

### 1.5 Dev-verify registries touched by removals (all owned by slice A, §7)

`scripts/devVerifyS2.mjs`: ROUTES rows **03** `shipments-view`, **07** `dispatch`, **11** `documents`, **11b** `documents-view`, **24** `academy`, **24a** `academy-article` removed; **02** `shipments` stays (add row **02b** `shipments-all` `/tms/shipments?list=all`); STATES **02a-filterset** (click `^Save as view`) removed; resolvers `view` (L443), `docview` (L444), `academy` (L449) removed; inventory regexes L448-449 (`run`, `academy`) → keep `run`, drop `academy`; `SKIP_ALLOWED` `'23-run'` unchanged; nn09/nn10/08 (tracking) left to V. New rows `02i` `/tms/shipments/intake`, `02j` `/tms/shipments/intake/{intake}` (new resolver `intake`: first OPEN `IntakeLoad`, else `skipLine` allowed). `devVerifyS3.mjs`: REDIRECTS `['/documents','/documents','/tms/documents']` → landing `/tms/documents/review`; the tolerance clause `landed.startsWith('/tms/shipments/view/')` (L215) is deleted; add redirect rows for the new REDIRECT routes (`/tms/shipments/view/zz-x → /tms/shipments`, `/tms/dispatch → /tms/shipments`, `/tms/documents → /tms/documents/review`, `/tms/academy → /tms/dashboard`) — placed in `uRoutes.mjs` `U_REDIRECTS` and asserted by `devVerifyU` (they are `/tms` routes, outside S3's non-/tms gate). `devVerifyS4.mjs`/`s4Routes.mjs`: **no reference** to any removed route (recon).

---------------------------------------------------------------------------------------------------

## 2. U2 — Academy and Workflows: hide, don't delete

Recon (every entry point; grep of `dashboard`, `demoFlow`, `DemoPage`, `roles`, `navItems`, global search/palette found nothing else — there is **no** dashboard card, global search entry, command palette entry or demo step for either; there is **no** "Workflows" tab in My Brokerage):

| Entry point | Evidence | Verdict |
|---|---|---|
| Sidebar `Workflows` (`/tms/workflows`) and `Academy` (`/tms/academy`, `badge:'BETA'`) | `navSections.ts` `TMS_ITEMS` L99-100 | **REMOVE both rows** (and the now-unused `Workflow`, `GraduationCap` lucide imports). `navItems.ts` has no academy/workflow rows; `PERMISSION_PAGES` (built from `NAV_ITEMS`) is unaffected. |
| Header Help icon → `/tms/academy` | `TmsShell.tsx` L649 | **REMOVE** (no replacement). |
| Routes `academy`, `academy/:slug` | `App.tsx` L169-170 | **REDIRECT** both to `/tms/dashboard`; remove the `AcademyPage` import. |
| Routes `workflows`, `workflows/runs/:id` | `App.tsx` L167-168 | **KEEP, unlinked from the nav (D-U2).** Load-bearing deep links that would otherwise 404: shipment "AI Agent" tab (`ShipmentDetail.tsx` L569), `QuoteDetail.tsx` L662, `AiAgentsPage.tsx` L133/L568, `AgentsTab` row click L128, `exceptions.ts` L225, notification drawer "Workflow errors" (`collectNotifications.ts` L340-342 → `/tms/workflows?tab=errors`), Platform health KPI (`PlatformHealthPage.tsx` L18). `RunTrace` → `proposalCards` → `NewShipmentDialog` is also the only place QUOTE / AP / CAPACITY proposals are applied. Page guard unchanged (`RequirePage page="tms"`). |
| Ask-assistant | **Lives inside Academy** (`AcademyPage.tsx` `AskPanel` L150/L219 → `askAcademy` `apiClient.ts` L1594 → `ASK_ACADEMY` in `tms-directory-actions/handler.ts` L271/L1930/L3278). No global mount. | Disappears with the Academy route. Backend action + `handler.test.ts` L3151 left in place. |
| `AcademyPage.tsx(+test)`, `academyMarkdown.ts(+test)`, `.tms-academy-*` CSS (`styles/admin.css` L86-106), `Docs/academy/*.md` | only `App.tsx` imported the page | **Left in the tree, unreferenced** ("HIDE, do not delete"): their tests keep passing and revival is a two-line route + nav change. |
| `My Brokerage → AI Agents` tab (`BrokeragePage.tsx` L56/L101, `AiAgentsPage`) | only UI for `TmsSettings.aiAgents` (daily run cap, per-agent enable, org memory); `PartyAiMemoryTab` is imported by `CarrierProfile`/`CustomerProfile` | **KEEP** (D-U2). The tender pipeline that feeds Intake still obeys that cap/enable switch (§5.4), so hiding its only control would strand it. |
| Dashboard cards / settings cards | none exist | nothing to do (stated so nobody searches again). |
| Grants | both pages use page key `tms`, which no non-ADMIN role carries (`ROLE_PAGES` has no `tms`) | nothing to do; hiding by nav removal is sufficient. |

Tests/scripts: `devVerifyS2` rows 24/24a and resolver `academy` removed, row 22 `workflows` / 23 `run` **stay**; no Academy/Workflows literal in `navSections.test.ts`/`TmsShell.test.tsx` (still re-run: they iterate `TMS_ITEMS`).

## 3. ACTIVE vs ALL — the exact, pure definition

All inputs are fields **already on the board row** (`ShipmentListRow`/`ShipmentRow`; `ShipmentsBoard` already overlays `readyToInvoiceAt`/`invoiceId` from `listOrders()` by `order.shipmentId`). No new query, no schema change.

```ts
// src/lib/shipmentLists.ts  (pure; imports only types + boardStatusOf via relative path)
export type ShipmentList = 'active' | 'all'

export interface ListRow {
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  arStatus?: ArStatus | null            // DOCS_NEEDED | UNBILLED | UNPAID | PAID | INVOICE_NOT_NEEDED | LEGACY
  readyToInvoiceAt?: string | null
  invoiceId?: string | null
}

/** Released to invoicing = the order has left DOCS_NEEDED. Same facts massReleaseReady() already reads
 *  (shipmentViews.ts L464) plus the arStatus rung, so a LEGACY / factored / not-needed order counts as released. */
export function isReleasedToInvoicing(row: ListRow): boolean {
  return row.readyToInvoiceAt != null || row.invoiceId != null
    || (row.arStatus != null && row.arStatus !== 'DOCS_NEEDED')
}

/** The scope applied BEFORE matchesBoardFilters (which still decides VOIDED/CANCELED visibility via the Statuses facet). */
export function inShipmentList(row: ListRow, list: ShipmentList): boolean {
  if (list === 'all') return true
  return !isReleasedToInvoicing(row) && boardStatusOf(row) !== 'CANCELED'
}
export function shipmentListCounts(rows: ListRow[]): { active: number; all: number }   // voided rows excluded from both counts (the Statuses facet opts them in)
```

Rules, stated so a test can pin them:
1. **Released** ⇔ `readyToInvoiceAt` set **or** `invoiceId` set **or** `arStatus` is any rung other than `DOCS_NEEDED` (`UNBILLED`, `UNPAID`, `PAID`, `INVOICE_NOT_NEEDED`, `LEGACY`). A row with **no** order data (`arStatus` null, no stamps) is **not** released → ACTIVE.
2. **ACTIVE** = not released **and** not CANCELED. A `DELIVERED` shipment stays ACTIVE until it is released (that is the collection backlog). A `TENDER_PENDING`/`DRAFT` shipment is ACTIVE (it maps to board status OPEN).
3. **ALL** = every row; `matchesBoardFilters` then applies its existing rule — a VOIDED row (PRO is permanent, voiding is the only exit) is hidden unless the Statuses facet names VOIDED; CANCELED shows only when the facet is empty. So **ALL = ACTIVE ∪ released ∪ canceled**, and ACTIVE ⊆ ALL by construction.
4. Release **cannot be undone** by the UI, so a row only ever moves ACTIVE → ALL-only. The **release gate itself is untouched** (`evaluateReleaseGate`, `READY_TO_INVOICE`).
5. Known limitation (inherited): `useShipments` projects the **last** order's `arStatus` when a shipment has several orders (`arByShipment[o.shipmentId] = …`). Multi-order shipments are rare; the list follows the board's existing projection. Noted, not fixed.
6. The Mass Release column, `massReleaseReady`, and the `release` batch action keep working unchanged; releasing a row from ACTIVE makes it leave that list on the next refresh (the board's 30 s refresh countdown / manual refresh) — pinned by a ShipmentsBoard test.

---------------------------------------------------------------------------------------------------

## 4. U3 — Intake e-mail on the rev division

### 4.1 Which "Division" and where it is stored

Two models exist (recon): the legacy billing/branding `Division` (`resource.ts` L1021, edited by `DivisionCard`) and **`OwnershipDivision`** (`resource.ts` L2691; id = code; `Shipment.revDivision` holds its code; edited by `DivisionsPage`'s `DivisionDialog`). "Rev division" is the second. The address is stored there:

* `OwnershipDivision.intakeEmail: a.string()` — optional in the schema (additive), **required by the save path** (§4.4). Stored lower-cased, trimmed.
* Mirrors to touch (each one is an exact edit): `OWNERSHIP_DIVISION_FIELDS` and `OwnershipDivisionInput` / `OwnershipDivisionRecord` in `apiClient.ts`/`types/tms.ts`; `DivisionDraft` + `blankDivisionDraft` + `divisionToDraft` + `draftToDivisionInput` in `src/features/tms/settings/taxonomyDrafts.ts`; the dialog in `DivisionsPage.tsx`; `saveOwnershipDivision` in `tms-directory-actions/handler.ts` (L2655-2737, also the audit `changes`).
* `SEED_DIVISIONS` (`src/lib/ownership.ts` L372, 7 rows) is **not edited**: the seed rows are created by `ENSURE_OWNERSHIP_SEED` with `putIfAbsent` and no address. That seeding path is the single documented exemption from "required" (§4.5).

### 4.2 The picker: which mailboxes are "configured"

There is no mailbox model (F3). Default (D-U10): the picker is a **combobox with suggestions + free typing**, suggestions from a pure function, no new settings schema:

| Suggestion | Source | Note shown beside it |
|---|---|---|
| `tenders@bcatcorp.com` | `SHARED_TENDERS_MAILBOX` constant = the bridge's default TENDER address (`agentEmailBridge.gs` `AGENT_INBOX_ROLES`) | "Shared tenders inbox (the bridge's default). Only one division can own it." |
| `<local>+tenders-<code>@<domain>` (e.g. `ai4bcat+tenders-brokerage@gmail.com`) | `THREAD_MAILBOX` (`src/lib/shipmentThread.ts` L18) + lower-cased division code with `_`→`-` | "Plus-address of the intake mailbox — Gmail delivers it with no setup." This is the only suggestion that works with **zero** mail-system work. |
| Addresses other divisions already use | from the loaded division list | shown disabled with "Used by <division name>" so the user sees why a pick is refused. |
| Anything typed | free text | validated live (§4.3). |

The bridge learns the chosen addresses from the server (§5.2), so *any valid typed address that actually reaches the bridge's mailbox* works; the constants are only convenience. No change to `Integration`/`TmsSettings`.

### 4.3 Validation (one pure module, used by the dialog, the Lambda and the matcher)

New `src/lib/intakeMail.ts` (+ `intakeMail.test.ts`), **relative/type-only imports only** (bundled into `tms-directory-actions` and `workflow-agent`, like `ownership.ts`):

* `normalizeIntakeEmail(raw): string | null` — trim, lower-case, empty → null.
* `checkIntakeEmail(raw): { email: string|null; problem: 'EMPTY'|'FORMAT'|'RESERVED'|null; message: string|null }` — format reuses the `EMAIL_RE` pattern of `src/lib/teams.ts` (single address, ≤254 chars, local ≤64, no spaces/commas/angle brackets, one `@`, dotted domain); **RESERVED** = addresses that already mean something else in the mail system and would hijack routing: `THREAD_MAILBOX` itself (the catch-all inbox), any local part containing `+tracking` (shipment reply threads), and the other agents' bridge inboxes `quotes@`, `carrierinvoices@`, `trucks@bcatcorp.com`, `tasks@bcatcorp.com`. Domain is **not** restricted (a warning chip "unverified domain" shows for domains other than `bcatcorp.com`/the `THREAD_MAILBOX` domain; not a block).
* `intakeEmailOwner(divisions, email, exceptCode?)` — the **active** division already using that address (case-insensitive), or null.
* `suggestIntakeMailboxes({ divisionCode, divisions })` and `matchDivisionByAddresses(addresses, divisions)` (§5.2).

Uniqueness: **one address ↔ one active division.** Enforced twice: client pre-check in the dialog (`divisionsWithDraft` already feeds `validateDivisions`) and authoritatively in `saveOwnershipDivision` over the loaded division set (extend `validateDivisions` in `src/lib/ownership.ts` with the rule `intake-email-duplicate`, whole-set, because it already validates the whole resulting set; the **required** rule is *not* put there — see §4.5). Archiving a division frees its address.

### 4.4 Dialog and server behaviour

* `DivisionDialog`: new required `TmsField` "Intake e-mail" (label shows the required marker), `TmsInput type="email"` with the suggestion list (a `<datalist>` or the kit's combobox — builder uses whichever the dialog already uses for the owner slots), live message under it from `checkIntakeEmail` + duplicate owner; Save disabled while invalid **and** the server error is shown inline if it still refuses. Divisions list (tree) shows a small `TmsBadge tone="amber"` "No intake e-mail" on any active row without one.
* `SAVE_OWNERSHIP_DIVISION` (server, authoritative): after existing validations, resolve `intakeEmail` = input value if the key is present, else the stored value (an older client that omits the key does not erase it). If the resulting division is `active` and the value is empty → `A division needs an intake e-mail address — choose the address tender e-mails for <name> arrive at`. Invalid/reserved/duplicate → the `checkIntakeEmail` / `intakeEmailOwner` message (`That address already receives tenders for <other name>`). Audit `changes` gains `intakeEmail` (before/after).
* `ARCHIVE_OWNERSHIP_DIVISION` unchanged except: archiving keeps the stored address on the row (history) but `intakeEmailOwner` ignores inactive rows.

### 4.5 Migration for existing divisions (and why the requirement is scoped to the saved row)

All seven existing rows (and any dev copy of production data) have no address. Nothing breaks: staging treats a division without an address as "cannot receive" (its tab exists but is empty with an explanation). Rules:
1. **Required on create and on every edit-save of an active division** — checked only for the division being saved (not the whole set), otherwise reordering, archiving or editing *another* division would fail on rows nobody has had a chance to fix.
2. **Existing rows are flagged, not blocked**: the amber "No intake e-mail" badge on `DivisionsPage`, and a banner at the top of the Intake area for owner/ADMIN listing divisions with no address (link → My Brokerage → Divisions).
3. `ENSURE_OWNERSHIP_SEED` is exempt (creates rows without an address; `createdBy:'seed'`).
4. Existing tests that create active divisions without an address (`tms-directory-actions/handler.test.ts` L2122-2155 and the owner/ADMIN-only matrix L2257) and `DivisionsPage.test.tsx` are updated to supply one; a new test asserts the refusal.

---------------------------------------------------------------------------------------------------

## 5. U4/U5 — Intake: how a tender e-mail becomes a partially built load, and how it becomes an Active shipment

```
Gmail mailbox ──► agentEmailBridge.gs ──(prepare/commit, + toAddresses)──► workflow-agent Function URL
   ▲  asks  {action:'intakeAddresses'} each run                                      │ existing pipeline (unchanged order)
   └──────── division addresses ◄──────────────── OwnershipDivision.intakeEmail      ▼
                                                  RECEIVE → CLASSIFY → PARSE_TENDER → MATCH_EMAIL_ENTITIES → MATCH_STOP → PROPOSE_TENDER   (WorkflowRun, as today)
                                                                                         │ NEW step STAGE_INTAKE (never fails the run)
                                                                                         ▼
                                              IntakeLoad  (OPEN, divisionCode by recipient, fields + per-field source/confidence)
                                                                                         │ reviewer: edit / confirm / (INTAKE_SAVE_DRAFT)
                                                                                         ▼ Move to active (INTAKE_MOVE_TO_ACTIVE: validate → createShipment(source TENDER) → references/tag/rep → audit)
                                                   Shipment (TENDER_PENDING, Order.arStatus DOCS_NEEDED = ACTIVE list), IntakeLoad MOVED
```

### 5.1 Data model — additive schema (exactly this; forces a data deploy)

1. **New model `IntakeLoad`** (`amplify/data/resource.ts`, next to `WorkflowRun`; `.disableOperations(['subscriptions'])`, `allow.authenticated().to(['read'])`; writes only through Lambdas — `workflow-agent` creates, `tms-shipment-actions` updates):

| Field | Type | Meaning |
|---|---|---|
| `id` | `a.id()` | `il:` + `WorkflowRun.id` (deterministic ⇒ staging is idempotent; one e-mail ⇒ one intake) |
| `status` | enum `OPEN` · `PROMOTING` · `MOVED` · `DISMISSED` (required; declared the way `WorkflowRun.outcome` is) | |
| `divisionCode` | `a.string()` | matched division; **null = Unrouted** |
| `toAddress` / `toAddresses` | `a.string()` / `a.string().array()` | the address that matched / every recipient the bridge reported (To, Cc, Delivered-To, X-Original-To, lower-cased, ≤20) |
| `runId`, `sourceKey` | `a.string()` | the `WorkflowRun` and `workflow-inbox/<sha20>/message.json` (source e-mail link target `/tms/workflows/runs/<runId>`) |
| `subject`, `fromEmail`, `fromName`, `receivedAt`, `bodyText` (≤20 000 chars), `attachments` json `[{name,contentType,size,key}]` | | self-contained review page; no S3 read needed for the text |
| `parseState` | enum `PARSED` · `NOT_PARSED` · `FAILED`; `parseNote` string | `NOT_PARSED` = agent gated (daily cap / disabled) so only the e-mail was staged; `FAILED` = pipeline error |
| `format` | string | parser format `E2OPEN`/`SUBJECT`/null |
| `fields` | json (`IntakeFields`, §6.1) | the working draft the reviewer edits |
| `autoFields` | json | immutable snapshot of what automation produced (diff for the audit; "Revert to e-mail" in the UI) |
| `meta` | json | per-field provenance/confidence map (§5.3) |
| `confirmed` | `a.string().array()` | field keys the reviewer explicitly confirmed |
| `missingFields` | `a.string().array()` | required-field catalog keys still missing at last save (list badge / sort) |
| `shipmentId`, `shipmentNumber` | string | set the moment `createShipment` returns (resume key) |
| `reviewedBy`, `reviewedAt` | string, `a.datetime()`-style as `Shipment.voidedAt` is declared | the Move-to-active audit pair |
| `lastEditedBy`, `lastEditedAt`, `dismissedBy`, `dismissedAt`, `dismissReason` | string | |
| `createdBy` (required), `updatedBy` (required), `version` (integer, required) | | CAS token for every write |

   Index: `i('status').sortKeys(['receivedAt'])` (list OPEN rows newest first; the table is small — tens per day).
2. **`OwnershipDivision.intakeEmail: a.string()`** (§4).
3. **`Shipment`**: `intakeLoadId`, `intakeReviewedBy`, `intakeReviewedAt` — three optional strings (so the shipment page and reports can show "reviewed by X on Y" without joining; written by the promote action).
4. **No change** to `WorkflowRun`, `TmsSettings`, `Customer`, `Order`, `ShipmentMessage`, `UserProfile`.

**Deploy impact (plain):** a new DynamoDB table + AppSync resolvers for `IntakeLoad` and three additive attributes ⇒ **this step forces a data (schema) deploy** on the single Amplify job it shares with V's schema additions (`Shipment.trackerId`, `Customer.defaultTrackerId`, `TmsSettings.trackingAutomation`); no `copy-data`, no renames/removals; the new table starts empty. Backend wiring (`amplify/backend.ts`, slice C only): `INTAKE_LOAD_TABLE_NAME` + `OWNERSHIP_DIVISION_TABLE_NAME` env and read/write IAM for `workflow-agent` (Put/Get conditional put on IntakeLoad; read OwnershipDivision, Customer already read via `loadDirectory`), `INTAKE_LOAD_TABLE_NAME` + Query/Update/Put for `tms-shipment-actions`, `ownership` division read for `workflow-agent`. AppSync resolver cap: one more model with subscriptions disabled — within the existing practice (flagged R2).

### 5.2 Routing: recipient address → division

* **Bridge** (`scripts/agentEmailBridge.gs`): (a) at the start of each run POST `{secret, action:'intakeAddresses'}` and append every returned `{email}` to `cfg.inboxes` as `{role:'TENDER', email}` **after** the four env/default roles (table order decides ties, so a message also sent to `quotes@` stays a QUOTE); a failed call logs and continues with the env roles. (b) Both `prepare` and `commit` payloads gain `toAddresses: string[]` built from To, Cc, `Delivered-To`, `X-Original-To` (de-duplicated, lower-cased, address part only, order preserved).
* **Server** (`workflow-agent/inbox.ts`): new action `intakeAddresses` (same secret check) → `{ok:true, addresses:[{email, divisionCode}]}` = active divisions with an `intakeEmail`; `BasePayload` gains optional `toAddresses` (array, ≤20 × ≤320 chars, lower-cased, non-strings dropped); written into `message.json`, surfaced on `SourceData`. `RUN_SAMPLE` (admin) accepts an optional `toAddresses` too (no-S3 dev path).
* **Match** (`matchDivisionByAddresses`, pure): exact lower-cased equality against active divisions' `intakeEmail`, scanning `toAddresses` in the order the bridge reported (To → Cc → Delivered-To → X-Original-To); first hit wins ⇒ `divisionCode`, `toAddress`. No hit ⇒ `divisionCode = null` (**D-U8: Unrouted tab**; includes mail to the shared `tenders@` when no division owns it). Mail to two divisions' addresses goes to the first reported.
* The existing roles are unaffected: QUOTE/AP/CAPACITY mail never produces an IntakeLoad; a tender-inbox message the classifier re-routes to another agent is **not** staged (intake follows `run.agent`, not the inbox).
* **Existing PROPOSED tender runs** are not back-filled (D-U11); Intake starts at deploy.

### 5.3 What "partially built" means: the field model and auto-filled / missing / low-confidence

`IntakeFields` (§6.1) holds the load as far as automation could build it. Each field key has `meta[key] = { source, confidence }`:

* `source`: `PARSER` (deterministic `parseTender`), `MODEL` (e-mail prompt fill), `RATECON` (attachment extraction), `DIRECTORY` (customer matched from sender, facility matched by `MATCH_STOP`), `ADDRESS` (division from the recipient), `DEFAULT` (customer default sales rep, bill-to), `REVIEWER`.
* `confidence`: `'high' | 'low'` — **no extra model call**: `PARSER` ⇒ high; `RATECON` ⇒ high; `MODEL` ⇒ high unless the model listed the key in the new `lowConfidence: string[]` output (a one-line extension of `TENDER_FILL_SCHEMA` in `model.ts`, `required`, may be `[]`); `DIRECTORY` customer ⇒ high only when `partyMatchHow==='EMAIL'`, **low** for `DOMAIN`/`NAME`; any value failing its format check (state not 2 letters, zip not 5/9 digits, date not `YYYY-MM-DD`, time not `HH:mm`, weight ≤ 0 or > 80 000 lb) ⇒ low regardless of source.
* Derived **status** per field (`fieldStatusOf`, pure): `MISSING` (empty) · `LOW` (low confidence, not confirmed) · `AUTO` (present, high confidence, not edited) · `CONFIRMED` (reviewer edited it, or ticked confirm) · `INVALID` (present but fails format after the reviewer typed it). UI chips: *Auto-filled* (green), *Check this* (amber), *Missing* (red), *Confirmed* (blue), *Invalid* (red).
* Provenance is recovered at staging because `parseFor` already computes `parseTender(...)` before `tenderFromParse(...)` merges the model fill: `parseFor` is changed to return `{ tender, parserTender, fillKind, lowConfidence }` and `run()` keeps using `tender` exactly as today (the proposal and every existing test stay identical); the extra values are handed to `stageIntake`.

### 5.4 Staging step (`workflow-agent`): `stageIntake`

New `amplify/functions/workflow-agent/intakeStage.ts` (+ test), called from `run.ts` in four places, each wrapped so a staging error is logged and recorded as a step detail but **never changes the run's outcome**:
1. just before `return finishWith(run,'PROPOSED')` in the TENDER branch (L705-710);
2. just before `return finishWith(run,'UNKNOWN_PARTY')` (L685-687) when `run.agent==='TENDER'` — the parse already ran; customer is then a *missing* field with up to 3 candidates stored in `autoFields.customerCandidates` for a "Did you mean…" pick;
3. the spending/enable gate `NO_ACTION` (L587-588) for a TENDER run → a **bare** row (`parseState:'NOT_PARSED'`, `parseNote` = the gate code) so the e-mail is never lost; blacklist hits are **not** staged;
4. the pipeline `catch` for a TENDER run → bare row `parseState:'FAILED'`.

Row creation is a **conditional put `attribute_not_exists(id)`** — `RETRY_RUN` / `SET_RUN_PARTY` re-runs never overwrite a row a reviewer may have started editing. Prefills: `divisionCode` (source `ADDRESS`), customer fields, `salesRepId` from `Customer.defaultSalesRepId` (`DEFAULT`), `billToId` from the customer's default bill-to **if the Customer record carries one** (builder greps `defaultBillTo`; else left missing), stops (with facility `name` from `MATCH_STOP`), reference → `reference`, `pickupNumber`, `weightLb`, `equipmentType` (rate-con extraction when present). `missingFields` is computed with the §5.5 function.

### 5.5 Required-field validation: reuse the build gate

New pure `src/lib/intakeLoad.ts` (named so because `src/lib/intake.ts` is the legacy IntakePage helper and is left untouched) (relative imports only; used by the Lambda **and** the review page so they cannot disagree):

* `intakeSubject(fields): RequiredFieldSubject` — maps the draft to the **same subject shape `buildGate.ts` builds from a bundle** (`stops[]` with `type/city/state/appt`, `billToId`, `salesRepId`, `revDivision` ← `divisionCode`, `customerRateCents`, `equipmentType`, `references: {po: reference, pickup: pickupNumber, delivery, bol}`, `freight: [{commodity, weightLbs}]`).
* `intakeRequired(settings, customer): string[]` = `resolveRequiredFields(settings, customer)` (org defaults ∪ customer list, catalog order) **∩ the intake-collectable keys** (everything in `REQUIRED_FIELD_CATALOG` except `carrierRep` and `bolNumber`, which only exist after booking/delivery). Excluded keys are listed in a muted line "Checked later on the shipment: …" so nothing is hidden; unknown keys (stale lists) are likewise excluded from the gate and shown there.
* `intakeMissing(fields, required)` = `missingRequiredFields(intakeSubject(fields), required)` — same labels as the shipment's "Needs:" line (`needsLine`).
* **Hard minimum, always, regardless of customer lists** (`intakeProblems(fields, ctx)`): H1 a **resolved, active customer** (typed-name-only cannot be moved: `TENDER_RESPOND` needs `assertCustomerResolved` and the credit check); H2 an **active division** chosen; H3 ≥1 pickup and ≥1 delivery stop; H4 per stop: city present, state two letters, zip empty or 5/5+4 digits, date empty or valid `YYYY-MM-DD`, time empty or `HH:mm`; H5 weight/rate numeric ≥ 0 when present.
* `canMoveToActive(fields, meta, confirmed, ctx) → { ok, missing: string[] /*labels*/, problems: string[], unconfirmed: string[] }`: ok ⇔ no hard problem, `intakeMissing` empty, **no `LOW` field left unconfirmed**, no `INVALID`. The server runs it again inside `INTAKE_MOVE_TO_ACTIVE` against the stored row + live settings/customer (authoritative); the UI runs it live to enable/disable the button and print the exact list.

### 5.6 Move to active — what it changes

`INTAKE_MOVE_TO_ACTIVE { intakeId, expectedVersion }` (`tms-shipment-actions`, new file `intake.ts`; one dispatch case + `Action` union + authorize entry in `handler.ts`):
1. **Authorize**: owner/ADMIN or group `page-intakeReview`; else `Forbidden: INTAKE_MOVE_TO_ACTIVE requires owner, ADMIN, or page-intakeReview`.
2. Load the row; `status` must be `OPEN` (or `PROMOTING` with a `shipmentId` ⇒ **resume** at step 6). Re-validate (§5.5). Failure ⇒ throw `Not ready to move to active — still needs: <labels>` (+ problems), **nothing written**.
3. CAS `OPEN → PROMOTING` on `version`. Any failure before step 5 restores `OPEN`.
4. Call the existing `createShipment(input, caller)` **unchanged** (V's `trackerId` default for the customer then applies automatically): `customerId`, `source:'TENDER'`, `workflowRunId: row.runId`, `load:{ tmsId: reference, pickupNumber, weight, equipmentType, commodity, rateCents, stops:[…] }`. The field mapping is **exactly what `NewShipmentDialog` does for a tender** (L313-334, L455-470, including `tenderStopForms` and the `requiresApptProofs` appointment-skip rule) — the builder extracts it to a shared pure helper `toCreateShipmentInput(fields, ctx)` in `src/lib/intakeLoad.ts` and points nothing else at it. `revDivision` cannot be passed in the load bag (`LOAD_BAG_REFUSED`), so step 6 tags it.
5. Immediately write `shipmentId`/`shipmentNumber` onto the `IntakeLoad` (still `PROMOTING`): from here a retry never creates a second shipment/PRO.
6. Finish the shipment idempotently: Order `billToId` and `references` (`po`←reference, `pickup`←pickupNumber, `delivery`) through the same internals `SAVE_ORDER_FORM` uses (builder reads `saveOrderForm`/`referenceRecord` for the exact shape); `SET_REV_TAG` as a **hand tag** with `divisionCode` (the reviewer's explicit choice beats rules — `revTagSource 'HAND'`); `SET_SALES_REP` if it differs from the customer default; write `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt` (CAS on the shipment's `updatedAt`).
7. `IntakeLoad` → `MOVED` with `reviewedBy = caller.email`, `reviewedAt = now`; `writeAudit('SHIPMENT', shipmentId, 'INTAKE_MOVE_TO_ACTIVE', …)` and `writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_MOVE_TO_ACTIVE', …)` with `{ reviewedBy, reviewedAt, runId, confirmed, corrected: <keys where fields ≠ autoFields>, divisionCode }`.
8. Response `{ intake, shipmentId, shipmentNumber }`; the page navigates to `/tms/shipments/<id>`. The shipment is `TENDER_PENDING` (D-U6): it is in ACTIVE (arStatus `DOCS_NEEDED`), and the existing Accept/Reject buttons (credit check, `TENDER_RESPOND`) are the next click. The client then best-effort calls the existing `linkWorkflowRun(runId, { shipmentId }, run.version)` (`apiClient.ts` L7712; what `NewShipmentDialog` does — it reads the run's current `version` first) so the run reads APPLIED; for an `UNKNOWN_PARTY` run (not linkable) it is dismissed with reason "Moved to active via intake review". Failure of either is a toast, not an error (the run list is hidden anyway).

Other actions (same router, same authorize rule): `INTAKE_SAVE_DRAFT { intakeId, expectedVersion, fields (patch), confirmed (patch: {add:[], remove:[]}) }` → recompute `meta` (edited keys ⇒ `source:'REVIEWER'`), `missingFields`, `lastEditedBy/At`, `version+1`; allowed only while `OPEN`; `INTAKE_DISMISS { intakeId, expectedVersion, reason }` (reason required) → `DISMISSED`; changing `divisionCode` is a normal draft edit (re-route an Unrouted/mis-routed load). Version conflict ⇒ `This intake load changed while you were editing — reload it`.

### 5.7 Permission: the intake-reviewer

Recon: page key `intake` **already exists** (legacy `/intake` IntakePage; `navItems.ts` L57; `RequirePage page="intake"`) — reusing it would also open that page, so the new key is **`intakeReview`** (group `page-intakeReview`). Why a page grant rather than a new `RoleKey`: grants are judged by shape (`PAGE_GROUP_RE`), the Users page lists any key present in `PERMISSION_PAGES`, the group is created lazily by `userManagement`, and no `UserProfile.role` enum / `ROLES` / `ROLE_PAGES` / Lambda-validation change is needed. Recipe (slice A, exact):
1. `src/lib/navItems.ts`: add to `OFF_NAV_PERMISSION_PAGES` (L142-145) `{ key: 'intakeReview', label: 'Intake review' }` ⇒ appears in `PERMISSION_PAGES`/`pageOptions()` ⇒ a checkbox on `UsersPage` (L393-396) for every user (extra page grant). `roles.ts` is **not** edited (no `ROLE_PAGES` change in U; the owner grants it per person — D-U7).
2. Client: `useAuth().hasPageAccess('intakeReview')` (owner/ADMIN pass automatically) ⇒ shows edit controls, **Move to active** and **Dismiss**; without it the review page is read-only (fields disabled, a note "You can look but not change intake loads").
3. Server: `INTAKE_*` mutating actions: owner/ADMIN or `page-intakeReview` only (note `page-tms` does **not** pass — the reviewer role is deliberately narrower than "can open Brokerage"). Implemented in `tms-shipment-actions/handler.ts` next to `QUOTES_PAGE_GROUP`/`LOADS_PAGE_GROUP` (L674-681): `const INTAKE_REVIEW_PAGE_GROUP = 'page-intakeReview'`, an `INTAKE_REVIEW_ACTIONS` set, a branch in `isActionAuthorized` (L727-744) and the matching `Forbidden` message in `authorize` (L746-765). Reads: `IntakeLoad` is `allow.authenticated()` read like every model, and the Intake pages are guarded by `RequirePage page={['loads','tms','intakeReview']}`.
4. Tests that enumerate pages/groups (`roles.test.ts` "offers every grantable page exactly once", `navSections.test.ts` L205-209 PERMISSION_PAGES loop, `userManagement/handler.test.ts` L519-564/L618-632) are re-run; a new grant adds no exact-array expectation because no `ROLE_PAGES` entry changed.

### 5.8 UI behaviour (slice F)

* **Shipments page header** (`ShipmentsSectionTabs`, §6.4): `Active (n) · All (n) · Intake (n)` as `TmsSegmentedTabs`; Active/All are `?list=` on `/tms/shipments`, Intake is a link to `/tms/shipments/intake`. Counts: Active/All from `shipmentListCounts`, Intake = open intake count.
* **`/tms/shipments/intake`** (`IntakeBoard`): one tab per **active** division (tree order via `flattenDivisions`, label `name`, count badge of OPEN rows) + an **Unrouted** tab (shown when it has rows or the viewer is owner/ADMIN) selected by `?division=<CODE|unrouted>` (default: first tab with open rows, else the first). Inside a tab: status chips *Open · Moved · Dismissed*, then a `TmsTable`: Received, From/Subject, Customer, Reference, Pickup → Delivery (`City, ST`), Completeness (`3 of 5 required · 2 to check`), Source-e-mail icon-link, row click → review. A division with no address shows an empty state "No intake e-mail set for <name>" (owner/ADMIN: link to Divisions). Empty tab: "No tender e-mails waiting."
* **`/tms/shipments/intake/:intakeId`** (`IntakeReviewPage`, `TmsDetailSplit`): left **Source e-mail** card (from, to, received, subject, `bodyText`, attachment links via the existing `getIntakePdfUrl`, "Open in Workflows" → `/tms/workflows/runs/<runId>`, `parseState` alert when `NOT_PARSED`/`FAILED`); right **Fields** in groups (Customer & billing · Load · each Stop), every field showing its chip + a `title` with the source; `LOW` fields get a confirm checkbox; "Confirm all auto-filled" button; "Revert to e-mail" (restores `autoFields`); footer: `Needs: …` line (`needsLine`), **Save**, **Dismiss** (reason dialog), **Move to active** (disabled with the exact reason list from `canMoveToActive`; hidden for non-reviewers). Optimistic-concurrency conflicts reload the row with a toast.
* After Move: navigate to the new shipment; the Intake tab count drops; Active list shows the shipment (TENDER_PENDING).


---------------------------------------------------------------------------------------------------

## 6. Exact shared interfaces (every builder codes against these; names and signatures are final)

### 6.1 Types — new file `src/types/intake.ts` (slice C; `tms.ts` stays untouched except the three one-line additions in §7 slice C)

```ts
export type IntakeStatus = 'OPEN' | 'PROMOTING' | 'MOVED' | 'DISMISSED'
export type IntakeParseState = 'PARSED' | 'NOT_PARSED' | 'FAILED'
export type IntakeSource = 'PARSER' | 'MODEL' | 'RATECON' | 'DIRECTORY' | 'ADDRESS' | 'DEFAULT' | 'REVIEWER'
export type IntakeConfidence = 'high' | 'low'
export interface IntakeFieldMeta { source: IntakeSource; confidence: IntakeConfidence }
export type IntakeFieldStatus = 'AUTO' | 'LOW' | 'MISSING' | 'CONFIRMED' | 'INVALID'

export interface IntakeStop {
  type: 'pickup' | 'delivery'
  name: string | null; street: string | null
  city: string | null; state: string | null; zip: string | null
  date: string | null          // YYYY-MM-DD
  time: string | null          // HH:mm
  instructions: string | null
}
export interface IntakeFields {
  customerId: string | null;  customerName: string | null          // customerName = typed/parsed text when unresolved
  billToId: string | null;    salesRepId: string | null;  divisionCode: string | null
  reference: string | null;   pickupNumber: string | null;  deliveryNumber: string | null
  equipmentType: string | null; commodity: string | null
  weightLb: number | null;    customerRateCents: number | null
  stops: IntakeStop[]
}
/** meta keys: scalar field names above, and `stops.<i>.<key>` for stop fields. */
export type IntakeMeta = Record<string, IntakeFieldMeta>

export interface IntakeAttachment { name: string; contentType: string; size: number; key: string }
export interface IntakeCustomerCandidate { id: string; name: string; how: string }

export interface IntakeLoadRecord {
  id: string; status: IntakeStatus
  divisionCode: string | null; toAddress: string | null; toAddresses: string[]
  runId: string; sourceKey: string | null
  subject: string; fromEmail: string; fromName: string; receivedAt: string; bodyText: string
  attachments: IntakeAttachment[]
  parseState: IntakeParseState; parseNote: string | null; format: string | null
  fields: IntakeFields; autoFields: IntakeFields & { customerCandidates?: IntakeCustomerCandidate[] }
  meta: IntakeMeta; confirmed: string[]; missingFields: string[]
  shipmentId: string | null; shipmentNumber: string | null
  reviewedBy: string | null; reviewedAt: string | null
  lastEditedBy: string | null; lastEditedAt: string | null
  dismissedBy: string | null; dismissedAt: string | null; dismissReason: string | null
  createdBy: string; updatedBy: string; version: number; createdAt: string; updatedAt: string
}
```

### 6.2 Pure libs

`src/lib/shipmentLists.ts` (slice B) — `ShipmentList`, `isReleasedToInvoicing`, `inShipmentList`, `shipmentListCounts` (signatures in §3).

`src/lib/intakeMail.ts` (slice C) — `SHARED_TENDERS_MAILBOX`, `RESERVED_INTAKE_ADDRESSES`, `normalizeIntakeEmail`, `checkIntakeEmail`, `intakeEmailOwner`, `MailboxSuggestion { email; label; note; disabledReason?: string }`, `suggestIntakeMailboxes({ divisionCode, divisions }): MailboxSuggestion[]`, `matchDivisionByAddresses(addresses: readonly string[], divisions: ReadonlyArray<{ code: string; active: boolean; intakeEmail?: string | null }>): { divisionCode: string; address: string } | null`.

`src/lib/intakeLoad.ts` (slice D; **relative imports only**, bundled by `workflow-agent` and `tms-shipment-actions`):
```ts
export const INTAKE_NOT_READY_PREFIX = 'Not ready to move to active'
export const INTAKE_COLLECTABLE_EXCLUDED: readonly string[] = ['carrierRep', 'bolNumber']
export function emptyIntakeFields(): IntakeFields
export function buildIntakeDraft(input: {
  tender: TenderPrefill | null; parserTender: TenderPrefill | null
  fillKind: 'RATECON' | 'EMAIL' | 'NONE'; lowConfidence: readonly string[]
  party: { kind: string | null; id: string | null; name: string | null; how: string | null; candidates: IntakeCustomerCandidate[] }
  customer: { defaultSalesRepId?: string | null; /* + default bill-to if present */ } | null
  divisionCode: string | null; stopFacilityHits: readonly boolean[]
}): { fields: IntakeFields; meta: IntakeMeta; customerCandidates: IntakeCustomerCandidate[] }
export function fieldStatusOf(key: string, fields: IntakeFields, meta: IntakeMeta, confirmed: readonly string[]): IntakeFieldStatus
export function intakeSubject(fields: IntakeFields): RequiredFieldSubject
export function intakeRequired(settings: unknown, customer: unknown): { gated: string[]; deferred: string[] }
export function intakeMissing(fields: IntakeFields, required: readonly string[]): string[]      // catalog keys
export function intakeProblems(fields: IntakeFields, ctx: { customerActive: boolean; divisionActive: boolean }): string[]
export function canMoveToActive(row: Pick<IntakeLoadRecord, 'fields' | 'meta' | 'confirmed'>, ctx: { settings: unknown; customer: unknown; customerActive: boolean; divisionActive: boolean }):
  { ok: boolean; missing: string[] /* labels */; problems: string[]; unconfirmed: string[] }
export function patchIntakeFields(row: Pick<IntakeLoadRecord,'fields'|'meta'|'confirmed'>, patch: DeepPartial<IntakeFields>, confirm: { add: string[]; remove: string[] }):
  { fields: IntakeFields; meta: IntakeMeta; confirmed: string[] }      // edited keys → source 'REVIEWER', high
export function correctedKeys(autoFields: IntakeFields, fields: IntakeFields): string[]
export function toCreateShipmentInput(fields: IntakeFields, ctx: { requiresApptProofs: boolean; runId: string }): Row   // the createShipment input; mapping = NewShipmentDialog's tender path
export function intakeCounts(row: IntakeLoadRecord): { required: number; missing: number; toCheck: number }
```

### 6.3 `apiClient.ts` additions (slice C is the **single** editor of `apiClient.ts` in U; wrappers use the existing `shipmentAction`/`directoryAction`/`gql` helpers exactly as `completeBuild`/`saveOwnershipDivision` do)

```ts
// OwnershipDivisionRecord / OwnershipDivisionInput gain:  intakeEmail: string | null   (input: string — required by callers)
export async function listIntakeLoads(opts?: { status?: IntakeStatus; limit?: number }): Promise<IntakeLoadRecord[]>   // status index, newest first; default status 'OPEN'
export async function getIntakeLoad(id: string): Promise<IntakeLoadRecord | null>
export async function countOpenIntakeLoads(): Promise<number>
export async function saveIntakeDraft(input: { intakeId: string; expectedVersion: number; fields: DeepPartial<IntakeFields>; confirm?: { add: string[]; remove: string[] } }): Promise<IntakeLoadRecord>
export async function moveIntakeToActive(input: { intakeId: string; expectedVersion: number }): Promise<{ intake: IntakeLoadRecord; shipmentId: string; shipmentNumber: string }>
export async function dismissIntake(input: { intakeId: string; expectedVersion: number; reason: string }): Promise<IntakeLoadRecord>
```
Router action names: `INTAKE_SAVE_DRAFT`, `INTAKE_MOVE_TO_ACTIVE`, `INTAKE_DISMISS` (tms-shipment-actions). `shipmentViews`-related wrappers removed only per §1.3.

### 6.4 `ShipmentsSectionTabs` (slice F owns; slice B imports it)

`src/features/shipments/ShipmentsSectionTabs.tsx`:
```ts
export interface ShipmentsSectionTabsProps { current: 'active' | 'all' | 'intake'; activeCount?: number; allCount?: number }
export function ShipmentsSectionTabs(p: ShipmentsSectionTabsProps): JSX.Element
// Active → /tms/shipments ; All → /tms/shipments?list=all ; Intake → /tms/shipments/intake (count = useOpenIntakeCount()).
```
and `useOpenIntakeCount()` in `src/features/shipments/intake/useIntakeLoads.ts` (60 s poll, same hook family as `useIntakeLoads({status})`).

### 6.5 Routes & URL contract

`/tms/shipments?list=active|all&q=<text>` (default `active`, unknown value ⇒ active) · `/tms/shipments/intake?division=<CODE|unrouted>&status=open|moved|dismissed` · `/tms/shipments/intake/:intakeId` · `/tms/shipments/view/*` ⇒ `<Navigate to="/tms/shipments" replace/>` (slug `all-shipments` ⇒ `?list=all`) · `/tms/dispatch` ⇒ `/tms/shipments` · `/tms/documents`, `/tms/documents/view/*` ⇒ `/tms/documents/review` · `/tms/academy`, `/tms/academy/*` ⇒ `/tms/dashboard`. Guards: intake routes `RequirePage page={['loads','tms','intakeReview']}`.

### 6.6 Nav/badge keys

`PINNED_ITEMS[1].children = [{ to: '/tms/shipments/intake', label: 'Intake', badgeKey: 'intakeLoads' }]`; `useShellBadgeCounts` returns `intakeLoads: number`; `myQueue`/`teamQueue` removed from the counts type and every consumer.

### 6.7 Bridge ↔ server protocol (slice D)

`POST {WORKFLOW_AGENT_URL}` body `{ secret, action: 'intakeAddresses' }` → `200 { ok: true, addresses: [{ email: string, divisionCode: string }] }` (`401` bad secret). `prepare`/`commit` bodies gain `toAddresses: string[]`.

---------------------------------------------------------------------------------------------------

## 7. Slices — six builders, disjoint file ownership

Every builder (look rules S2 §5 / S3 §5.3, unchanged): **T1 no colour literal in any `.ts/.tsx/.css` you own** (`var(--tms-*)`, `TmsBadge tone`, `TmsAlert`); reuse kit components before creating any; behavioural tests only; **no formatter/linter/project-wide build or test run** (Main runs them once; run only your own test files); yield with the list of files touched, states not exercised, and each `[INFERENCE]` settled. A test file belongs to the slice that owns the component it tests. Cross-slice needs go by `hub` to the owner named in §8.

### Slice A — Shell, routes, nav, permission, Academy/Workflows hide, S2/S3 registries
**Owns:** `src/features/tms/useOwnershipDivisions.ts` (new, relocated hook) and the deletion of `src/features/tms/useShipmentViews.ts`; `src/App.tsx`; `src/lib/navSections.ts` (+`navSections.test.ts`); `src/lib/navItems.ts`; `src/features/tms/TmsShell.tsx` (+`TmsShell.test.tsx`); `src/features/tms/TmsLayout.tsx` (+`TmsLayout.test.tsx`); `src/features/tms/useShellBadgeCounts.ts` (+test); `src/features/tms/brokerage/BrokeragePage.tsx` (+`BrokeragePage.test.tsx`); `scripts/devVerifyS2.mjs`, `scripts/devVerifyS3.mjs` (edits listed in §1.5).
**Does:** §1.1 route table (redirects, intake routes with `RequirePage`, removals + import cleanup, `/documents` legacy target), §1.2 nav (children, `childrenFor`, breadcrumbs, division fallback, badge counts incl. `intakeLoads` via `countOpenIntakeLoads`, Help icon), §2 (Academy/Workflows nav + routes), §5.7 step 1 (`OFF_NAV_PERMISSION_PAGES`), remove the `Shipment views` tab/route in `BrokeragePage`.
**Acceptance:** `/tms/shipments/view/x`, `/tms/dispatch`, `/tms/documents[/view/x]`, `/tms/academy[/x]` land on the §6.5 targets; the rail shows Shipments › {Shipments, Intake, Tracking (live children), Documents→review} and no Views group, no My/Team queue, no Dispatch, no Academy, no Workflows; `/tms/workflows` and `/tms/workflows/runs/:id` still render by URL; `Users` page offers an "Intake review" checkbox; breadcrumbs per §1.2.

### Slice B — Shipments board: two lists
**Owns:** `src/features/shipments/ShipmentsBoard.tsx` (+`ShipmentsBoard.test.tsx`); `src/features/shipments/shipmentViews.ts` (+`shipmentViews.test.ts`); `src/features/shipments/board/**` (edits to `BoardFilterPanel`, `useBoardFilters`; deletes `FilterSetDialog.*`, `queueSentinels.test.ts`; test updates); **new** `src/lib/shipmentLists.ts` (+test); deletes `workstations/DispatchWorkstation.*`, `workstations/DocumentsWorkstation.*`, `workstations/coverage.*`, `workstations/documentMatrix.ts`, `workstations/dispatch/**`, `workstations/documents/**`; the mechanical view-wiring removal in `workstations/TrackingWorkstation.tsx`, `workstations/tracking/TrackingBoard.tsx`, `workstations/tracking/types.ts` (+ their tests' View-selector/viewer assertions) and `workstations/CustomerLinksPage.tsx` only if it imports something removed (recon says no); deletes `src/features/tms/settings/ShipmentViewsPage.*`, `settings/viewDraft.*` (after grep) and changes its `useOwnershipDivisions` import to `@/features/tms/useOwnershipDivisions`; the old `src/features/tms/useShipmentViews.ts` is deleted by A after A creates the relocated hook.
**Acceptance:** §1.3 verbatim; §3 rules pinned by `shipmentLists.test.ts`; board header renders `ShipmentsSectionTabs` (imported from slice F's file per §6.4 — until it exists, code against the signature).

### Slice C — Schema, division intake e-mail, `apiClient.ts`, types, backend wiring
**Owns:** `amplify/data/resource.ts` (U hunks: `IntakeLoad`, `OwnershipDivision.intakeEmail`, `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt`); `amplify/backend.ts` (U hunks: table env + IAM per §5.1); `src/types/intake.ts` (new) and the three additive lines in `src/types/tms.ts` (`OwnershipDivisionRecord.intakeEmail`, `ShipmentRecord.intakeLoadId/intakeReviewedBy/intakeReviewedAt`); `src/lib/apiClient.ts` (**all** U edits: §6.3 + `OWNERSHIP_DIVISION_FIELDS` + the §1.3 view-wrapper cleanup); `src/lib/intakeMail.ts` (+test); `src/lib/ownership.ts` (+`ownership.test.ts`: `validateDivisions` duplicate-address rule, `OwnershipDivisionSeed` untouched); `src/features/tms/settings/{taxonomyDrafts.ts,DivisionsPage.tsx,DivisionsPage.test.tsx}` (+`taxonomyDrafts` test if present); `amplify/functions/tms-directory-actions/handler.ts` (**only** `saveOwnershipDivision` + audit) and its `handler.test.ts` hunks (§4.5 item 4).
**Order:** (1) publish `src/types/intake.ts` + the §6.3 wrapper stubs (types compile for everyone) → (2) schema + backend wiring → (3) division UI/server.
**Acceptance:** §4 in full; dialog refuses empty/invalid/reserved/duplicate with the §4.4 messages; server refuses the same independent of the client; existing rows keep saving other divisions; `amplify` typechecks with the new model.

### Slice D — Intake pipeline (workflow-agent, bridge, pure intake lib)
**Owns:** `amplify/functions/workflow-agent/{inbox.ts,run.ts,model.ts,actions.ts (RUN_SAMPLE toAddresses only),intakeStage.ts (new),intakeStage.test.ts, store.ts only if the conditional-put helper lives there}` and the existing `inbox.test.ts`/`handler.test.ts`/`run.test.ts` hunks they force (a TENDER run now also writes the IntakeLoad table — `run.test.ts` L498 "tablesWritten() == [TABLES.run]" is **updated, not loosened**: tender writes exactly run + intake); `scripts/agentEmailBridge.gs` (+`scripts/agentEmailBridge.test.mjs`); `src/lib/intakeLoad.ts` (new, +`intake.test.ts`).
**Acceptance:** §5.2–§5.5; the unchanged `PROPOSE_TENDER` proposal shape (existing `tenderProposal.test.ts` untouched); staging never throws into the run; bridge unit tests (§10).

### Slice E — Intake actions (tms-shipment-actions) and demo seed
**Owns:** `amplify/functions/tms-shipment-actions/{intake.ts (new), intake.test.ts (new)}`; **three hunks** in `handler.ts` (the `Action` union entries, the authorize set/branch near L674-765, one `case` block beside `case 'CREATE_SHIPMENT'` at ~L6735 — `createShipment`'s body is V's and is not edited); `handler.test.ts` hunks for authorization; `demo.ts` (+`demo.test.ts`) to seed one OPEN `IntakeLoad` (DEMO key) and clear it on reset; `src/lib/demoFlow.ts` is slice F's.
**Acceptance:** §5.6 including **resume after a failure between steps 5 and 7** (no second shipment/PRO), no state written on a failed validation, CAS conflicts, authorization matrix (owner, ADMIN, `page-intakeReview` pass; `page-tms`, `page-loads`, none refused).

### Slice F — Intake UI, section tabs, demo wiring, `devVerifyU`
**Owns:** `src/features/shipments/ShipmentsSectionTabs.tsx` (+test); `src/features/shipments/intake/**` (`IntakeBoard.tsx`, `IntakeReviewPage.tsx`, `IntakeFieldRow.tsx`, `SourceEmailCard.tsx`, `useIntakeLoads.ts`, `useIntakePermissions.ts`, tests); `src/lib/demoFlow.ts` (+test) and `src/features/tms/brokerage/DemoPage.tsx` (+`DemoPage.test.tsx`, whose queue-children assertion is retargeted) (P2 text, P5 retarget to the Intake review of the seeded load — `opensOn:'intake.review'`, tick = open intake loads > 0); `scripts/devVerifyU.mjs`, `scripts/lib/uRoutes.mjs` (new).
**Acceptance:** §5.8; §11 devVerify green.

### Non-overlap check
`App.tsx`, `navSections.ts`, `navItems.ts`, `TmsShell.tsx`, `TmsLayout.tsx`, `useShellBadgeCounts.ts`, `BrokeragePage.tsx`, `devVerifyS2/S3` → **A** · `ShipmentsBoard.tsx`, `shipmentViews.ts`, `board/**`, `shipmentLists.ts`, removed workstations, `TrackingWorkstation.tsx` (mechanical) → **B** · `resource.ts`, `backend.ts`, `types/*`, `apiClient.ts`, `intakeMail.ts`, `ownership.ts`, `DivisionsPage`/`taxonomyDrafts`, `tms-directory-actions` (division only) → **C** · `workflow-agent/*`, `agentEmailBridge.*`, `src/lib/intakeLoad.ts` → **D** · `tms-shipment-actions/intake*`, three `handler.ts` hunks, `demo.ts` → **E** · `shipments/intake/**`, `ShipmentsSectionTabs`, `demoFlow.ts`, `DemoPage.tsx`, `devVerifyU`, `uRoutes` → **F**. No path appears twice.

---------------------------------------------------------------------------------------------------

## 8. Shared files — exactly one owner each, and the Step V overlap

U and V ship together, so every file both plans touch has one U owner and a stated hunk boundary (agreed with VPlan by IRC: **U first, V second, one deploy; U owns the shell/route/nav files; V owns `TrackingWorkstation` + `tracking/*` + `CustomerLinksPage`; U adds no `TmsSettings`/`Customer` fields and does not touch `SAVE_SETTINGS`/`UPSERT_CUSTOMER`/`tms-tracking-actions`**).

| Shared file | U's additions (exact) | U owner | V's hunk (not U's) |
|---|---|---|---|
| `src/App.tsx` | §6.5 redirects/routes; remove `DispatchWorkstation`, `DocumentsWorkstation`, `AcademyPage` imports; add `IntakeBoard`, `IntakeReviewPage` | **A** | none (Tracking path unchanged) |
| `src/lib/navSections.ts` | §1.2 | **A** | none |
| `src/features/tms/useOwnershipDivisions.ts` (relocated) | created by A (contract §1.3) | **A** | V's Settings card imports it |
| `src/features/tms/TmsShell.tsx` / `TmsLayout.tsx` | §1.2 (`childrenFor`, `isChildActive`, Help icon, drop `shipmentViews`) | **A** | `Tracking` child keeps `badgeKey:'tracking'` + `live: trackedLoads` — A preserves them verbatim |
| `src/lib/navItems.ts` | `OFF_NAV_PERMISSION_PAGES` + `intakeReview` | **A** | none |
| `amplify/data/resource.ts` | `IntakeLoad` model; `OwnershipDivision.intakeEmail`; `Shipment.intakeLoadId/intakeReviewedBy/intakeReviewedAt` | **C** | `Shipment.trackerId`, `Customer.defaultTrackerId`, `TmsSettings.trackingAutomation` (V's schema builder; **different hunks, applied sequentially: C first**) |
| `src/types/tms.ts` | 3 one-line additions (§7 slice C) | **C** | `trackerId` etc. |
| `src/lib/apiClient.ts` | §6.3; `OWNERSHIP_DIVISION_FIELDS`; view-wrapper cleanup | **C** | `TMS_SETTINGS` field group `V16` (V names its own; U adds no `TmsSettings` fields) |
| `amplify/backend.ts` | env/IAM for `IntakeLoad` + `OwnershipDivision` (workflow-agent, tms-shipment-actions) | **C** | V's own wiring if any (different lines) |
| `amplify/functions/tms-shipment-actions/handler.ts` | `Action` union, authorize set/branch, one `case` (all in slice E's three hunks) | **E** | `createShipment` body (V sets `trackerId` from `Customer.defaultTrackerId`); the promote action calls `createShipment` unchanged so V's default applies |
| `amplify/functions/tms-directory-actions/handler.ts` | `saveOwnershipDivision` + audit only | **C** | `SAVE_SETTINGS`/`UPSERT_CUSTOMER` whitelists |
| `workstations/TrackingWorkstation.tsx`, `tracking/TrackingBoard.tsx`, `tracking/types.ts` | mechanical removal of the view wiring (§1.1), **first**, in landing step 1 | **B** | V rewrites the files on top of the result |
| `scripts/devVerifyS2.mjs`, `devVerifyS3.mjs` | §1.5 | **A** | V edits the tracking rows (08/09/10, STATES 08-tabs, inline 567/592) — different rows |
| `scripts/devVerifyU.mjs`, `scripts/lib/uRoutes.mjs` | new | **F** | V has its own `devVerifyV` |

**Files nobody in U touches:** `invoice_*.json`, `amplify/functions/tms-tracking-actions/**`, `tms-finance-actions/**` (the release gate), `src/lib/releaseGate.ts`, `src/lib/shipmentViewDefs.ts`, `src/features/shipments/workstations/{motion.ts,tracking/**,CustomerLinksPage.tsx}` (except the one mechanical `TrackingWorkstation` edit), `workflows/*` UI, `settings/AiAgentsPage.tsx`, `amplify/functions/workflow-agent/{memory,partyMatch,store}.ts` beyond what slice D needs.

---------------------------------------------------------------------------------------------------

## 9. Landing order (all six slices are dispatched in **one** `tasks[]` batch; the order is for proof, not for waiting)

1. **C publishes** `src/types/intake.ts` and the §6.3 wrapper stubs first (`hub` "C types ready"), then schema/backend wiring. B, D, E, F code against §6 immediately; nobody waits for a build (Main typechecks once, at the end).
2. **B** lands the mechanical `TrackingWorkstation` edit as its first change and tells VPlan (`hub`) so V's builder starts from it.
3. **D and E** are independent of each other (both consume `src/lib/intakeLoad.ts` — D owns it; E codes against §6.2 until it exists, then `hub`-checks signatures).
4. **A** and **F** land last (they register/mount what the others export); F's `devVerifyU` is written against §6 and run after the deploy.
5. Main: `npm run typecheck && npm run lint && npm run test` green **once** (fix-forward through the owning slice) → then **V's** slices on top (same files untouched) → ONE commit series on `dev` → ensure `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not RUNNING/PENDING → `git push origin dev` once → wait for the job (data deploy: new `IntakeLoad` table) → devVerify (§11), then S2, S3, S4, P regression runs.
6. **Not** to be done before the deploy: any `copy-data`; any production access; any edit of `main`.

---------------------------------------------------------------------------------------------------

## 10. Tests — behavioural only (each defends a plausible bug); removals are in §1.4

| Slice | File | Asserts |
|---|---|---|
| B | `src/lib/shipmentLists.test.ts` | released ⇔ `readyToInvoiceAt` **or** `invoiceId` **or** `arStatus` ∉ {`DOCS_NEEDED`,null} — one case per rung (`UNBILLED`, `UNPAID`, `PAID`, `INVOICE_NOT_NEEDED`, `LEGACY`) and the "no order data ⇒ active" edge; `DELIVERED` unreleased stays active; CANCELED is in `all` and not in `active`; ACTIVE ⊆ ALL for every generated row; `shipmentListCounts` excludes voided and equals the filter lengths |
| B | `ShipmentsBoard.test.tsx` (retargeted) | default `/tms/shipments` shows only unreleased rows and the "Active" tab is selected; `?list=all` also shows released rows; a bogus `?list=` falls back to active; releasing a row (batch `release`) removes it from Active on refresh; columns/type-ahead/batch/duplicate cases keep passing without any view mock; **no** "View" selector, "Save as view" or queue link is rendered |
| B | `BoardFilterPanel.test.tsx` | still renders Column Templates, Statuses with counts, Details, Dates, flags; View section absent |
| C | `intakeMail.test.ts` | normalise (case/space); format table (missing `@`, two `@`, spaces, trailing dot, >254, comma list) refused; each RESERVED address refused with its own message; `intakeEmailOwner` ignores archived divisions and the division being edited; `matchDivisionByAddresses` — first reported address wins, case-insensitive, plus-address exact only, archived division ignored, empty list ⇒ null; suggestions exclude taken addresses and carry `disabledReason` |
| C | `tms-directory-actions/handler.test.ts` | create **active** division without address ⇒ refused with the required message; invalid/reserved/duplicate refused; edit that omits `intakeEmail` keeps the stored value; inactive division saves without one; saving a *different* division while another lacks an address succeeds; address change writes the audit before/after |
| C | `DivisionsPage.test.tsx` | dialog Save disabled until a valid unique address; duplicate shows "Used by <name>"; row badge "No intake e-mail" on legacy rows; server error text shown inline |
| C | `ownership.test.ts` | `validateDivisions` reports `intake-email-duplicate` for two active divisions with the same address (case-insensitive) and not for an archived twin |
| D | `src/lib/intakeLoad.test.ts` | `buildIntakeDraft`: parser fields ⇒ `PARSER/high`; model-only ⇒ `MODEL`, key in `lowConfidence` ⇒ low; customer by EMAIL ⇒ high, by DOMAIN/NAME ⇒ low, none ⇒ missing + candidates kept; format-invalid state/zip/date/weight ⇒ low; `fieldStatusOf` MISSING/LOW/AUTO/CONFIRMED/INVALID transitions (edit ⇒ CONFIRMED, confirm tick clears LOW); `intakeRequired` = defaults ∪ customer ∩ collectable and reports `carrierRep` as deferred; `canMoveToActive` blocks on each of: no customer, no division, no delivery stop, bad state code, missing default-required `billTo`, an unconfirmed LOW field — and passes when all fixed; its missing **labels equal `needsLine`'s** for the same keys (parity with the shipment page); `toCreateShipmentInput` maps tender fields to the same `tmsId/pickupNumber/weight/stops` the dialog sends and drops times when `requiresApptProofs` |
| D | `intakeStage.test.ts` | one row per e-mail (second stage is a no-op and does **not** overwrite an edited row); division chosen by first matching reported address; no match ⇒ `divisionCode null`; UNKNOWN_PARTY run stages with customer missing + ≤3 candidates; gated run stages a bare `NOT_PARSED` row with the gate code; blacklisted run stages nothing; non-TENDER (re-routed) run stages nothing; a throwing table write is swallowed and recorded, the run outcome unchanged |
| D | `run.test.ts` / `inbox.test.ts` / `handler.test.ts` | tender still ends `PROPOSED` with the identical proposal; writes exactly run + intake; `toAddresses` validated/limited/lower-cased and persisted in `message.json`; `intakeAddresses` needs the secret and lists only **active** divisions with an address; `RUN_SAMPLE` accepts `toAddresses` |
| D | `scripts/agentEmailBridge.test.mjs` | `toAddresses` built from To/Cc/Delivered-To/X-Original-To, de-duplicated, lower-cased, address part only; intake addresses are appended **after** the env roles (a message to `quotes@` and a division address stays QUOTE); a failed `intakeAddresses` call leaves the env roles working; both phases post the same `toAddresses` |
| E | `intake.test.ts` | authorization matrix (owner, ADMIN, `page-intakeReview` pass; `page-tms`, `page-loads`, none ⇒ `Forbidden: … requires owner, ADMIN, or page-intakeReview`); `INTAKE_SAVE_DRAFT` marks edits `REVIEWER`, recomputes `missingFields`, bumps `version`, refuses non-OPEN, CAS conflict message; `INTAKE_MOVE_TO_ACTIVE`: refuses with `Not ready to move to active — still needs: …` and writes **nothing** when invalid; success creates exactly one shipment (`TENDER_PENDING`, `source TENDER`, `workflowRunId`), tags `revDivision` with a HAND tag, sets Order references/billTo, stamps `intake*` on shipment and intake, audits both with `corrected`/`confirmed`; **resume**: a row left `PROMOTING` with `shipmentId` finishes without a second `createShipment`; double-click (second call after MOVED) is refused; a failure before `createShipment` restores `OPEN`; `INTAKE_DISMISS` requires a reason |
| E | `demo.test.ts` | seed creates one OPEN intake with a DEMO key; reset removes it |
| F | `IntakeBoard.test.tsx` | one tab per **active** division + Unrouted when non-empty; counts per tab; archived divisions have no tab; division without address shows the explanatory empty state; owner/ADMIN banner lists divisions missing an address; status chips switch Open/Moved/Dismissed; row click opens review |
| F | `IntakeReviewPage.test.tsx` | chips per field status (Auto-filled / Check this / Missing / Confirmed); **Move to active disabled with the exact missing list** until every gate item is satisfied, enables after edits+confirms, calls `moveIntakeToActive` once and navigates to the shipment; non-reviewer sees fields disabled and no Move/Dismiss; Dismiss needs a reason; version conflict toast reloads; source e-mail card shows subject/from/body and the `/tms/workflows/runs/<runId>` link |
| F | `ShipmentsSectionTabs.test.tsx` | selected tab per `current`; links per §6.4; Intake count from the hook |
| A | `navSections.test.ts` / `TmsShell.test.tsx` / `TmsLayout.test.tsx` / `useShellBadgeCounts.test.ts` | rail children and active states per §1.2; no Views group; no Academy/Workflows/Dispatch items; division fallback `Intake · <name>`; breadcrumbs for intake and removal of `view/`; `intakeLoads` badge; `roles.test.ts` "offers every grantable page exactly once" still green with `intakeReview` |

Existing tests that **change**: those in §1.4 plus `tms-directory-actions/handler.test.ts` (division fixtures), `workflow-agent/run.test.ts` L498, `DivisionsPage.test.tsx`. Any existing test that only pins wording/structure of a removed view (e.g. the "Views" group heading) is **deleted**, not re-pinned.

---------------------------------------------------------------------------------------------------

## 11. `devVerifyU` — `scripts/devVerifyU.mjs` (slice F)

Same harness as S3/S4: `scripts/lib/uiWalk.mjs` `createWalk`, the dev-only refusals of S4 §8.1 (dev AppSync URL, dev staff pool `us-east-1_UKhMNVAG1`, dev origin allow-list, DynamoDB table names must carry the discovered dev suffix and are refused with the production suffix), identities via `scripts/lib/devIdentity.mjs` `mintIdentity`/`deleteIdentity` (mint **before** the call: groups come from the token). Registry file `scripts/lib/uRoutes.mjs` exports `U_ROUTES` (rendered `/tms` pages), `U_REDIRECTS` (`[pattern, concrete path, expected landing]`), `U_GONE` (see 11.3), `uNavGaps()` (every nav target U added has a `<Route>` in `App.tsx` and a `U_ROUTES` row) — mirroring `s4Routes.mjs`.

### 11.1 Identities and seeds (every name `ZZ`/`zz-u-…` + run stamp, tracked and removed in `finally`)

| Kind | What |
|---|---|
| Staff | `zz-u-admin-<ts>@example.invalid` groups `['ADMIN','page-tms']`; `zz-u-rev-<ts>` `['page-intakeReview','page-tms']`; `zz-u-view-<ts>` `['page-tms']` (can open Intake, cannot review); `zz-u-none-<ts>` `[]` |
| Divisions | `ZZ_U_<ts>` created through the **real** `SAVE_OWNERSHIP_DIVISION` as admin: first attempt without address ⇒ asserts the required refusal; with `not-an-email` ⇒ format refusal; with `quotes@bcatcorp.com` ⇒ reserved refusal; then with `zz-u-tenders-<ts>@example.invalid` ⇒ created; a second `ZZ_U2_<ts>` with the same address ⇒ duplicate refusal, then saved with its own address (proves a tab per division) |
| Customer | `ZZ U Customer <ts>` with one contact `zz-u-sender-<ts>@example.invalid` (via `UPSERT_CUSTOMER`, same helper pattern as `devVerifyStepK.mjs`), `defaultSalesRepId` = the admin's profile if resolvable |
| Tender e-mails (real ingest path: `prepare` then `commit` on the discovered `workflow-agent` Function URL with `INTAKE_WEBHOOK_SECRET`, as `devVerifyStepK.mjs` `deliver()`; **no SES**) | **M1** complete tender (parser-readable subject/body with reference, pickup #, weight, 2 stops with dates) from the temp customer's contact, `toAddresses:[ZZ_U address]`; **M2** sparse tender (subject only, unknown sender) to the same address; **M3** tender to `zz-u-nowhere-<ts>@example.invalid` (no division); **M4** QUOTE-style mail to the same address (must stage nothing if the classifier re-routes it — recorded, not asserted hard because it is model-dependent) |
| Released/unreleased shipments for the lists | **none created**: Active/All counts are asserted against an independent recomputation from GraphQL (`listShipments` + `listOrders`) using §3's definition, so the check is data-independent |

### 11.2 The walk (1600×1000, light then dark for read-only audits; mutations once, in light; all pages through `waitLoaded` → `audit` → S3 shell facts → S4 text audit)

| Id | Flow | Assertions |
|---|---|---|
| **U01** `/tms/shipments` | Active then All | tab selected; footer **total equals the independently computed count** for each list; `ALL ≥ ACTIVE`; no "View" select / "Save as view" / "Views" group; column templates, filter pickers (type a customer prefix ⇒ rows narrow), batch bar (select 2 rows ⇒ Release/Rep actions present, **not pressed**), row menu **Duplicate** present; screenshots Active + All (L/D) |
| **U02** removed | `U_GONE` | each of `/tms/shipments/view/zz-x`, `/tms/dispatch`, `/tms/documents`, `/tms/documents/view/zz-x`, `/tms/academy`, `/tms/academy/zz-x`, `/tms/brokerage/views` lands on its §6.5 target (or, for `views`, the Brokerage default) **and** renders none of that page's markers; the sidebar text contains none of "Dispatch", "Academy", "Workflows", "My queue", "Team queue", "Views"; `/tms/workflows` and `/tms/tracking`, `/tms/tracking/links`, `/tms/check-calls`, `/tms/documents/review` still render (KEEP set) |
| **U03** division dialog | `/tms/brokerage/divisions` as admin | "Add division" shows a required "Intake e-mail" field; Save disabled when empty; format / reserved / duplicate messages; the §11.1 creation sequence passes against the **real server**; screenshots light + dark (empty-error state and filled state); legacy divisions show the amber badge |
| **U04** intake ingest | after the four `commit`s | poll `listIntakeLoads` ≤ 120 s (pipeline calls the model; `StepK` precedent): M1 and M2 rows exist with `divisionCode = ZZ_U_<ts>`; M3 has `divisionCode null`; M1 `customerId` resolved with `PARSER` provenance for reference/stops, M2 customer missing; a second `commit` of M1 (same `messageId`) yields `duplicate` and still **one** row |
| **U05** Intake area | `/tms/shipments/intake` (admin, then `zz-u-view`) | a tab for **every active division** (count recomputed from GraphQL) incl. `ZZ_U`; ZZ tab lists M1+M2 with completeness text, Unrouted tab lists M3; archived division has no tab; rail "Intake" badge equals the open count; `zz-u-view` sees the list, opens M2 read-only (no Move/Dismiss, fields disabled) |
| **U06** review + Move | as `zz-u-rev` on M1 | chips: reference/stops *Auto-filled*, unmatched fields *Missing*; source-e-mail card shows the sent subject/body and the run link; Move disabled with the `Needs: …` list; fill the missing required fields + confirm LOW ones ⇒ Move enables; press ⇒ lands on `/tms/shipments/<id>`; shipment is `TENDER_PENDING`, `source TENDER`, `intakeReviewedBy = zz-u-rev`, appears in **Active** and `revDivision = ZZ_U_<ts>`; `IntakeLoad` `MOVED` with `shipmentId`; an `AuditLog` row `INTAKE_MOVE_TO_ACTIVE` names the reviewer. M2: edit only half the fields ⇒ Move stays disabled; **server probe**: call `INTAKE_MOVE_TO_ACTIVE` on M2 directly ⇒ refused with `Not ready to move to active`; as `zz-u-view` and `zz-u-none` ⇒ `Forbidden`. Dismiss M3 with a reason ⇒ `DISMISSED` |
| **U07** gone/kept sanity | `/tms/dashboard` | no Academy/Workflows card; bell drawer still lists "Workflow errors" link target `/tms/workflows?tab=errors` that renders |
| **Phone** | 390×844 | `/tms/shipments`, `/tms/shipments/intake`, review page: audit + no horizontal overflow |

### 11.3 Completeness gates (fail first)
(1) `uNavGaps()`; (2) every `App.tsx` `/tms` route has a `ROUTES`/`U_ROUTES`/redirect row (S2's route-completeness gate, after slice A's edits); (3) **gone-gate**: for every path in `U_GONE`, `App.tsx` has either no `<Route>` for the old component or a `<Navigate>` element for it (greps the source, so a half-removal cannot pass); (4) no remaining `import … from '…useShipmentViews'` anywhere under `src/`.

### 11.4 Cleanup (proof, not hope) — `finally`, reverse order
Void the promoted shipment (`VOID_SHIPMENT` with reason `step U verification fixture` — shipments/PROs are never deleted, as in StepK); dismiss the temp `WorkflowRun`s with a reason (undeletable) and delete their S3 prefixes; delete the `IntakeLoad` rows, the temp `OwnershipDivision` rows (archive first, then delete — there is no client delete, so via the AWS SDK against the discovered dev tables) and `AuditLog` rows whose `entityId` is in the tracked set and `createdAt ≥ run start` (S4 §8.5 pattern); archive the temp customer; delete the four identities (re-read to prove); **re-scan every table for the tracked ids and fail non-zero on residue**. Missing AWS credentials ⇒ prints the residue ids and exits non-zero.

### 11.5 How intake is exercised on dev (SES inbound is not live — nor anywhere in this repo)
* The only inbound mail path in this codebase is Gmail → Apps Script bridge → `workflow-agent` Function URL. `BCAT_DEV_STACK=true` leaves Function URLs callable and denies `ses:*` only for *outbound*, so posting `prepare`/`commit` to the dev URL **is** the same code path the bridge uses and is what `devVerifyU` and the unit tests exercise (`toAddresses` supplied explicitly in the payload).
* The Lambda concurrency guard (`BCAT_ISOLATED_PREVIEW`) is not set on the real dev stack; if a preview stack is used, `workflowAgent` and `tmsShipmentActions` are already in `previewCallable` (recon).
* Deployed bridge behaviour (address discovery, Gmail search for the division addresses) cannot be proven by any script in this repo: the Apps Script runs in Ryne's Google account. It is covered by `agentEmailBridge.test.mjs` (pure functions) and by **one manual acceptance step for Ryne**: create the division, send a mail to its address, watch it appear in the Intake tab (≤ 5 min poll). Stated as a dependency, not hidden.
* Locally (`npm run dev` against the dev backend before the push) everything that needs the **new backend** (`IntakeLoad`, `INTAKE_*`, staging, address validation on save) is reported `SKIPPED (allowed: ships with the deploy)`; the structural assertions (U01 removed UI, U02 gone-gate, U03 client-side validation) run locally and produce the screenshots.

### 11.6 Screenshots → `Docs/tms-build/screenshots/U/<id>-<slug>-<L|D|M>.png` (+ `index.txt`)
`U01` Shipments Active (L,D) · `U02` Shipments All (L,D) · `U03` left filter panel with Column Templates and no View section (L) · `U04` rail with Shipments › Intake/Tracking/Documents (L,D) · `U05` Division dialog: empty-required error, then filled (L,D) · `U06` Divisions list with "No intake e-mail" badge (L) · `U07` Intake tabs, ZZ division populated (L,D,M) · `U08` Unrouted tab (L) · `U09` review page with Auto-filled/Check this/Missing chips + source e-mail card (L,D) · `U10` Move disabled with `Needs:` list (L) · `U11` after Move: the new shipment in Active with the reviewed-by line (L) · `U12` Users page showing the "Intake review" grant (L). Ryne's review set: **U01, U02, U05, U07, U09, U10** (L + D).

---------------------------------------------------------------------------------------------------

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Real inbound mail needs a human step**: Ryne must create each division's address (a Google Group/alias delivering to the bridge's mailbox, or just use the plus-address suggestion) and re-paste `agentEmailBridge.gs`. Until then Intake stays empty; nothing breaks. | Stated in §11.5; plus-address suggestion needs no mail-system work; acceptance step for Ryne listed in §13. |
| R2 | One more AppSync model + three attributes against the CloudFormation resolver cap noted in the brief. | Subscriptions disabled on `IntakeLoad` (the brief's rule); V adds fields only, no model. Main watches the deploy; failed deploy is fixed before any other work. |
| R3 | **[INFERENCE]** Gmail search operators (`deliveredto:`, `to:`) for a `+` plus-address are assumed to match; the bridge also keeps its quoted-address fallback. | First live mail in §13 settles it; the server-side match is independent (`toAddresses`). |
| R4 | **Every tender now becomes an Intake row**, and the old "apply the proposal from Workflows" route is unlinked. An unstaffed Intake pile = tenders nobody enters. | Rail badge + Intake count in the Shipments header; the reviewer grant is per person (D-U7). Unrouted tab catches mail to unowned addresses. |
| R5 | A staging error would leave an e-mail with a PROPOSED run but no Intake row. | `stageIntake` is its own recorded step (`STAGE_INTAKE`) so the trace says why; staging is idempotent, so `RETRY_RUN` re-stages; failures never alter the run outcome. |
| R6 | Model cost/limits. | No extra model call; `lowConfidence` adds a short array to the existing output; `MAX_MODEL_CALLS`, spending gate and blacklist unchanged and still decide first. If the model ignores `lowConfidence`, format validation still downgrades bad values. |
| R7 | **Duplicate loads**: the same load tendered twice (two e-mails) yields two Intake rows and could become two shipments. There is no content-level dedupe today (recon). | Out of scope; recommended follow-up (D-U13): non-blocking "a shipment with this customer + reference already exists" banner on the review page. |
| R8 | Division address changed/archived after mail arrived. | Rows keep the `divisionCode` stamped at staging; a row can be re-routed by editing the division field. An archived division's open rows are visible under Unrouted. |
| R9 | Two reviewers edit one row. | `version` CAS on every write; the second gets the reload toast. |
| R10 | Promote step failure after the PRO is claimed. | `PROMOTING` + `shipmentId` written immediately after `createShipment`; Move is resumable and never creates a second shipment. Pre-create failures (e.g. the customer's credit-limit rule inside `createShipment`) restore `OPEN` and show the existing message. |
| R11 | Someone applies the same run from `/tms/workflows/runs/:id` **and** moves its Intake row. | `LINK_RUN` already refuses a run linked elsewhere; the client links the run right after Move. Low likelihood (Workflows is unlinked). |
| R12 | Client-dead code in a backend-shared file (`lib/shipmentViewDefs.ts`: `viewsVisibleTo`, sentinels). | Accepted and noted (§1.3); removing it needs a backend change outside U. |
| R13 | Retiring the Dispatch/Documents boards removes shortcuts people may have used. | Capability parity proven (F7); redirects land on the replacement; `Documents` rail child keeps the review queue. |
| R14 | `devVerifyU` needs the deployed backend for ingest/review; the model call inside the pipeline can take tens of seconds. | Poll budget 120 s with the StepK precedent; local run reports `SKIPPED (allowed: ships with the deploy)` for backend-dependent steps and still proves the structural ones. |
| R15 | Step V edits the same repository areas. | §8 ownership table + agreed landing order (U first); B's mechanical Tracking edit gives V a compiling base. |

---------------------------------------------------------------------------------------------------

## 13. Decisions for Ryne (each has a default so building does not wait; he can overrule any)

| # | Question | Default taken | Alternative if he disagrees |
|---|---|---|---|
| D-U1 | What is a "partially built" load? | A separate `IntakeLoad` record; a Shipment (and its **permanent PRO**) exists only after Move to active. | Shipment rows in a new `INTAKE` status — rejected: burns a PRO per junk e-mail, and every board/status switch grows a new case. |
| D-U2 | How much of Workflows to hide? | Nav item removed; `/tms/workflows` and `/tms/workflows/runs/:id` stay reachable by URL (shipment AI-Agent tab, quote card, notifications, Platform health and non-tender proposals link to them); `My Brokerage → AI Agents` stays; Academy fully unmounted (page files and `ASK_ACADEMY` left in place). | Remove the two routes too and repoint 6 deep links (needs a place for QUOTE/AP/CAPACITY proposals first). |
| D-U3 | "Released to invoicing" | Order has left `DOCS_NEEDED` (`readyToInvoiceAt` or `invoiceId` set, or any other `arStatus`, which includes factored/`LEGACY` and `INVOICE_NOT_NEEDED`). | Narrower: only `readyToInvoiceAt`/`invoiceId` set — would leave old factored/legacy shipments in Active forever. |
| D-U4 | Canceled shipments | In ALL only; not Active. Voided stay out of both (existing Statuses-facet opt-in). | Show canceled in Active until someone voids them. |
| D-U5 | Which divisions need an intake address | Every **active** division incl. subdivisions and COMPANY. | Top-level business divisions only; subdivisions inherit the parent's address and get no tab. |
| D-U6 | What state does Move to active create? | `TENDER_PENDING` (source TENDER) — in Active, with the existing Accept/Reject + credit check as the next click. | Move also performs ACCEPT (lands `OPEN`) — one fewer click, but skips a deliberate credit decision on a not-yet-accepted tender. |
| D-U7 | Intake-reviewer permission | Page grant `intakeReview` assigned per person on the Users page (owner/ADMIN always allowed; `page-tms` alone can view but not review). | A named role (`INTAKE_REVIEWER`) with default pages — needs a `UserProfile.role` enum change; or add `intakeReview` to MANAGER's `ROLE_PAGES`. |
| D-U8 | Mail to an address no division owns (incl. the shared `tenders@`) | Staged under **Unrouted**; reviewer picks the division. | Discard, or route to a default division. |
| D-U9 | "Status tabs" | The board's **Statuses** checkbox facet (with counts) stays as a filter; it is not a view/queue. | Remove it too (then status is only reachable through the Details type-ahead). |
| D-U10 | Mailbox picker source | Suggestions (`tenders@bcatcorp.com`, `ai4bcat+tenders-<code>@gmail.com`) + free typing, validated; no mailbox settings table. | A real "inbound mailboxes" list in settings (additive `TmsSettings` field + card) feeding the picker. |
| D-U11 | Existing PROPOSED tender runs | Not back-filled into Intake; Intake starts at deploy. | One-off `scripts/backfillIntakeFromRuns.mjs` over `WorkflowRun` outcome PROPOSED + agent TENDER. |
| D-U12 | Strictness of "check every field" | Move requires: all gate fields valid **and** every *low-confidence* field explicitly confirmed (auto-filled high-confidence fields need no click; a "Confirm all" button exists). | Require a confirm tick on every auto-filled field, or only the missing-field rule. |
| D-U13 | Duplicate-load warning | Not built (R7). | Banner on the review page when customer + reference already match a non-voided shipment. |
| D-U14 | Kept pages I was unsure about | `/tms/check-calls` and `/tms/documents/review` (a worklist and a document-review queue, not shipment views) and the shipment-detail tabs are KEPT; the rail's "Documents" child now opens the review queue. | Remove `/tms/check-calls` from the rail and bell if he counts it as a queue. |
| D-U15 | Source-e-mail link | Review page shows the stored body + attachments and links "Open in Workflows" (`/tms/workflows/runs/<runId>`), which stays routable. | Store the raw RFC-822 (not stored today) — a bridge change. |
| D-U16 | Intake in the Shipments page vs. separate nav | Intake is a header tab on Shipments **and** a rail child with a badge. | Header tab only. |

**Manual acceptance for Ryne after the deploy** (cannot be scripted — the bridge runs in his Google account): (1) create or edit a division with an intake address (try the plus-address suggestion); (2) paste the updated `scripts/agentEmailBridge.gs` and run `setupAgentEmailBridge()`; (3) send a tender to that address; (4) within ~5 minutes it appears on Shipments › Intake under that division; (5) grant a user "Intake review" on the Users page and walk it to Move to active.
