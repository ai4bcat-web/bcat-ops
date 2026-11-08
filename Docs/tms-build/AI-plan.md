# Step AI — Conversational dashboards (chat-built, permissioned, per-viewer filtered)

Status: PLAN (recon complete, **dev only**). Author: AIPlan, 2026-11-04. Built later by Sonnet-class `task` agents (§11, ≤ 6 slices). Nothing here touches `main`, production tables/buckets/SSM, `invoice_*.json` or the Aljex export; no SSM writes (the Anthropic key already reaches Lambdas as an Amplify `secret()`; this step reads it the same way); neither the plan nor the builders commit, push or deploy (Main does). No PII is printed anywhere (harness output carries ids, counts, aggregates).

Sources read (working tree on `dev`, after AF/AH/AJK): `src/lib/crm/{visibility,owner,types}.ts`, `amplify/functions/tms-crm-actions/actions.ts`, `amplify/functions/tms-directory-actions/{handler.ts,resource.ts}` (Ask assistant), `src/features/tms/pages/AcademyPage.tsx`, `src/features/tms/dashboard/*`, `src/lib/dashboardRollup*.ts`, `amplify/functions/tms-dashboard-rollup/{handler,store}.ts`, `amplify/data/resource.ts` (Shipment, Customer, Invoice, Quote, LaneRateSample, DashboardRollup, UserProfile, TmsSettings), `amplify/backend.ts`, `src/lib/roles.ts`, `src/types/tms.ts` (ClaimKey, Team), `src/features/users/UsersPage.tsx`, `amplify/functions/userManagement/handler.ts`, `src/lib/apiClient.ts`, `Docs/tms-build/{AF,AJK,AB}-plan.md`, `BUILD_LOG.md`, `scripts/{measureDataTemplate,devVerifyAJ}.mjs`, `scripts/lib/devIdentity.mjs`.

Conventions inherited (PERF/AA/AB/AF/AJK): additive schema only, one owner per shared file, kit components + `--tms-*` tokens only, behavioural tests only, `devVerifyX` harness with throwaway `ZZ`/`zz-` identities deleted in `finally`, one deploy per batch, clean cutover (no shims).

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **Team already exists; no Team model is needed.** `TmsSettings.teams` (JSON `Team[] = {key,name,memberIds[],active}`) is where membership is decided; `UserProfile.teamKeys` is its best-effort mirror (`mirrorTeamKeys`, `tms-directory-actions/handler.ts` ~L1699); `Customer.teamKey` is assigned in the customer form/profile (`TeamPicker` in `CustomerForm.tsx` L213, `CustomerProfile.tsx` L383); Settings has `TeamsCard.tsx`. | `amplify/data/resource.ts` L1196, L951, L3222; `src/types/tms.ts` L3647 | Zero schema bytes for "Team". Visibility reads `TmsSettings.teams` (authoritative), never a new table. |
| F2 | **The ask's field names are not the real ones.** There is no `Customer.salesRepId`/`teamId`. A customer's rep is `accountOwnerIds[]` (`[0]` primary) and `defaultSalesRepId`, its team is `teamKey`; `src/lib/crm/owner.ts` `ownerIdsOf()` already unions the first two. `Shipment.salesRepId` exists (L1930) but is **null on Aljex-imported rows until the AljexCodeMap is applied** (`salesRepCode` kept verbatim, L1947). | `owner.ts`, `resource.ts` L901/L951/L953/L1930/L1947 | Predicate uses `ownerIdsOf(customer)` + `customer.teamKey` + row rep fields (§2.1). Coverage of imported history is a measured risk (R2), not assumed. |
| F3 | **CRM's visibility rule cannot be reused as-is.** `canSeeAccount` lets a rep see accounts *nobody owns* (`owners.length === 0`) and treats MANAGER as see-all (`isManager`). Ryne's rule is stricter: rep OR team member, else nothing, unless `viewAll`. | `src/lib/crm/visibility.ts` L29-38 | New module `src/lib/dataVisibility.ts` **reuses** `viewerFromGroups`, `OWNER_EMAIL`, `ownerIdsOf` and shares the `CrmViewer` shape, but defines its own row predicate. CRM behaviour is left untouched (decision D3). |
| F4 | **Every business model is readable by any signed-in user straight from AppSync.** `Shipment`, `Order`, `Invoice`, `Quote`, `LaneRateSample`, `DashboardRollup`, `Customer`… all carry `allow.authenticated().to(['read'])`; the existing Company Dashboard computes in the browser from those reads (`useBrokerageDashboard`). `limitCustomerRepView` is documented as "a board filter, never a read boundary". | `resource.ts` (every model), L1197 | A filter inside the new Lambda enforces the hard rule for **everything the dashboard feature serves**, but cannot stop a hand-written GraphQL query. Closing that hole means changing model auth for ~10 models and every page that lists them: out of scope for this step, stated as decision **D1** and measured by a read-only audit script (AI6). For non-viewAll users the classic client-computed dashboard is not mounted at all (§8.2), so no page of this feature ever loads rows they may not see. |
| F5 | **Per-viewer filtering cannot be applied to the existing rollup.** `DashboardRollup` rows are per month × day × `revDivision|revSubdivision` (`src/lib/dashboardRollup.ts` `scopeKey`); there is no rep or team dimension, and `Customer.accountOwnerIds/teamKey` are not stream-subscribed, so a reassignment would never dirty a row. | `dashboardRollup.ts` (`scopeKey`, `COMPARED`), `backend.ts` L3886-3893 | **Decision: no per-rep rollup rows. Dashboards read bounded, indexed source queries and apply the viewer predicate on the rows (§2.3).** The rollup keeps serving the classic page to viewAll users unchanged. |
| F6 | **AppSync caps a resolver at 30 s**; the Ask assistant works because one `low`-effort call returns ≤ 1,500 tokens. A generated spec is ~1,000–1,500 tokens plus validation. | `tms-directory-actions/handler.ts` `ASK_*` constants + `askAcademy`, AB log: "model calls bounded (10 s)" | Chat turn and data run are **two separate mutations** (each its own 30 s clock); model call aborted at 22 s; Lambda `timeoutSeconds: 29` (§6.4). |
| F7 | **The apiClient cache wipes on every router mutation whose action is not a read verb** (the AF F3 defect). `READ_ROUTER_ACTION = /^(?:SPOT_\|CRM_)?(GET\|LIST\|SEARCH\|FIND\|READ\|COUNT\|PREVIEW\|CHECK\|LOOKUP\|STATUS)(_\|$)/`. An action named `DASH_LIST` or `RUN_DASHBOARD` would wipe the list cache on every chat turn and every dashboard render. | `src/lib/apiClient.ts` L71-93 | Action names are **read-verb first**: `PREVIEW_DASHBOARD_CHAT`, `PREVIEW_DASHBOARD`, `LIST_DASHBOARDS`, `GET_DASHBOARD`, `GET_DASHBOARD_OPTIONS` (reads); `SAVE_DASHBOARD`, `ARCHIVE_DASHBOARD` (writes). A table test row for each name (AI4). |
| F8 | **The user-visible permission system is `claim-*` Cognito groups.** `CLAIMS`/`CLAIM_LABELS`/`ENFORCED_CLAIMS` in `roles.ts`; `userManagement` validates with `isClaimKey` and projects `claim-<KEY>` groups; `UsersPage` renders `CLAIMS.map(...)` automatically; regex `^claim-[A-Z_]+$` forbids dots. | `roles.ts` L78-117, L140; `userManagement/handler.ts` L774-794; `UsersPage.tsx` L329 | `dashboards.create` → claim `DASHBOARDS_CREATE`, `dashboards.publishCompany` → `DASHBOARDS_PUBLISH_COMPANY`, `viewAll` → `VIEW_ALL`. Adding three constants lights up Settings > Users, the group projection and the server check with no new UI. |
| F9 | **Data-stack headroom is 32,393 B** (967,607 of 1,000,000 B, `BUILD_LOG.md`). A function costs the most (K: model + 3 GSIs + Lambda ≈ +21,889 B; L: one model, no function ≈ +7,000-9,000 B est.). | `BUILD_LOG.md`, `K-plan`, `L-plan` | One new model with **every GraphQL operation disabled** (verified valid: `DisableOperationsOptions` includes `'queries' \| 'mutations' \| 'subscriptions'` in `@aws-amplify/data-schema`), no GSI; one new Lambda in the `data` group. Estimated **+10,000-14,000 B total [INFERENCE]**, gate: Main measures with `scripts/measureDataTemplate.mjs` after AI2; fallback in §4.3. |
| F10 | **Anthropic credit on dev may be exhausted** (`BUILD_LOG.md`: "the key available to the builders returned 'credit balance too low'", decision (b) still open). | `BUILD_LOG.md` 2026-11-04 AF/AB entries | The deterministic parts (scope gate, validation, data run, permissions) are testable without the model; the live-chat harness steps report `SKIP: MODEL_UNAVAILABLE` with the exact provider message instead of faking a model (§10). |

### 0.2 Decisions needing Ryne (defaults implemented; each flips in one place — §12)

**D1** how far "hard rule" reaches (default: everything the dashboard feature serves + Overview for non-viewAll; model-level read lockdown is a separate, costed follow-up), **D2** who is `viewAll` (default: owner, ADMIN, role `AR_AP`, claim `VIEW_ALL`; **MANAGER is not**), **D3** customers nobody owns and no team are invisible to non-viewAll (CRM shows them), **D13** Anthropic credit on the dev key.

### 0.3 Schema and deploy impact — stated plainly

* **GraphQL schema: one additive model `Dashboard`, all operations disabled, no GSI** (`amplify/data/resource.ts`, after `DashboardRollup` L3079-3095). Lambda-only access through the DynamoDB SDK, like the four CRM tables. **No `Team` model** (F1). No new field on any existing model.
* **One new Lambda `tms-dashboard-actions`** + one custom mutation `tmsDashboardActions(action, input)` (pattern: `tmsCrmActions`, `resource.ts` ~L4780). Secret `ANTHROPIC_API_KEY` as in `tms-directory-actions/resource.ts` L30. No schedule rule (so `amplify/devRuleGuard.ts` is untouched).
* **Roles code:** three `ClaimKey`s. **No Cognito change by hand**: the groups are created on demand by `userManagement` `setClaims` (existing behaviour, `pool.groups` test in `userManagement/handler.test.ts`).
* **Prod migration:** additive; no backfill. Nobody holds the claims until an admin ticks them in Settings > Users (owner/ADMIN hold all implicitly). A new table appears empty.

### 0.4 Slice map (6 builders, disjoint files — details §11)

| Slice | Owns | Lands |
|---|---|---|
| **AI1** Contract: spec, catalog, executors, visibility, claims | `src/lib/dashboards/*`, `src/lib/dataVisibility.ts`, `src/lib/roles.ts(+test)`, `ClaimKey` union in `src/types/tms.ts` | first |
| **AI2** Backend: model, Lambda, wiring | `amplify/functions/tms-dashboard-actions/*`, `amplify/functions/_shared/ddbReads.ts`, blocks in `amplify/data/resource.ts` + `amplify/backend.ts` | after AI1 |
| **AI3** Builder UI (chat panel, scope picker, save dialog) | `src/features/tms/dashboard/custom/{DashboardBuilderPage,ChatPanel,ScopePicker,SaveDashboardDialog,useDashboardChat}` | after AI4's `apiClient` block |
| **AI4** Viewer UI + client API (tabs, cards, view page, widget renderer, Overview for non-viewAll, routes) | `src/lib/apiClient.ts` (append-only block), `src/features/tms/dashboard/DashboardHome.tsx`, `custom/{DashboardCards,DashboardViewPage,WidgetGrid,WidgetView,ScopedOverview,useDashboardAccess,useDashboardRun}`, `custom/custom.css`, `src/App.tsx` (route lines) | parallel with AI2 (apiClient block first) |
| **AI5** Harness + screenshots | `scripts/devVerifyAI.mjs`, `scripts/lib/aiProbe.mjs(+test)`, `Docs/tms-build/screenshots/ai/` | after AI1; runs after Main's deploy |
| **AI6** Permissions surface, docs, exposure audit | `Docs/academy/dashboards.md`, `scripts/auditDataExposureAI.mjs`, `userManagement/handler.test.ts` (one case), `UsersPage.test.tsx` (if it pins the claim list) | any time after AI1 |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (anchors the builders start from; re-read before editing — other agents are editing AD/AE/AJ files on `dev`)

Line numbers are as read on 2026-11-04 and **drift** (`tms-directory-actions/handler.ts` moved +12 lines while this plan was being written); the symbol names are the anchors.

| Area | Anchor | Fact |
|---|---|---|
| Ask assistant (model plumbing) | `tms-directory-actions/handler.ts` symbols `ASK_MODEL`…`askAcademy` (~L1900-1960) | `ASK_MODEL = 'claude-sonnet-5'`, `messages.stream({ model, max_tokens, output_config: { effort: 'low', format: { type: 'json_schema', schema } }, system, messages })`, `final.content` text → `JSON.parse`; `anthropicClient()` reads `process.env.ANTHROPIC_API_KEY`; audit row `writeAudit('TmsSettings','default','ACADEMY_QUESTION_ASKED',…)`. AuthZ: `assistantActions` allow owner/ADMIN/`page-tms` (~L274-277 and the `else if (assistantActions[action])` branch ~L308). Dispatch `case 'ASK_ACADEMY'` ~L3317. |
| Key handling | `tms-directory-actions/resource.ts` L30; `backend.ts` L3956-3990 | `ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY')` on the function resource (never an env value in code). On the dev stack Anthropic keeps its **real** key (not in `NEUTERED_SECRETS`), so dev chat works if credit exists (F10). |
| Structured-output lesson | `BUILD_LOG.md` AB entry | "Anthropic structured-output schema had 21 union params (HTTP 400; now plain string/number with sentinels)". The model-facing schema here is **union-free** with sentinels (§7.3). |
| UI of Ask | `src/features/tms/pages/AcademyPage.tsx` `AskPanel`, `apiClient.askAcademy` L1774 → `directoryAction` L1457 | textarea + button + `loading/error` + cited answer. Route hidden (`App.tsx` L194). Reuse = the call/error plumbing and kit controls, not the (private) component. |
| Router pattern | `apiClient.ts` `callCrm` L8546 (`mutation TmsCrmActions($action: String!, $input: AWSJSON!)`, `graphqlErrorText`, `unwrapJson`); `data/resource.ts` ~L4780 `tmsCrmActions: a.mutation().arguments({action,input}).returns(a.json()).authorization(allow.authenticated()).handler(a.handler.function(tmsCrmActions))`; `backend.ts` L70/L169 import + `defineBackend` entry; wiring L3729-3860 (`crmFn.addEnvironment(...)`, `addToRolePolicy`) | copy this shape. |
| Viewer + audit in a router | `tms-crm-actions/actions.ts` `authorize()` L109-124 (`identity.username ?? sub`, email from claims, `viewerFromGroups`), `audit()` (ids/counts only, never text) | copy `authorize`/`audit`. |
| Company Dashboard | `src/features/tms/dashboard/DashboardPage.tsx` (`export function DashboardPage` ~L97, own `TmsPage` header with Views select, Refresh, Save view, Export CSV, chart picker); route `src/App.tsx` L151 `RequirePage page="tms"` | Views are **localStorage** per user (`dashboardViews.ts`); there is no server-side dashboard row today. |
| Chart/series contract | `src/features/tms/dashboard/types.ts` `ChartSeries {kpis?, rows:[{label,values,text?}], groups, columns?, valueFormat, note?}`, `ChartKind`, `ValueFormat`; renderers `ChartCard.tsx` (`SeriesTable`, recharts), kit `TmsKpiCard`, `TmsChartCard` | server-computed widget results use this shape so the existing renderers draw them. |
| Rollup | `src/lib/dashboardRollup.ts` (`scopeKey`, `marginBpsOf`, `stripFigures`), `tms-dashboard-rollup/handler.ts` | pure lib is **relative-imports-only** (bundled by the Lambda; `amplify/functions/bundle.test.ts` checks). `src/lib/dashboardCharts.ts` uses `@/` aliases and imports UI types → **not** reusable inside a Lambda; executors in `src/lib/dashboards/execute.ts` are self-contained and reuse only `marginBpsOf` (relative import). |
| Indexes the Lambda may query (Amplify default names, as used by `tms-dashboard-rollup/store.ts`) | `shipmentsByPickupMonthAndPickupAppt`, `shipmentsByCustomerIdAndPickupAppt`, `laneRateSamplesBySampleMonthAndDate`, `invoicesByArOpenAndDueAt`, `quotesByQuoteMonthAndQuoteDate` | **No index on any salesRepId/teamKey/accountOwnerIds** (Shipment L1990-1995, Invoice L2352-2356, Quote L2976-2985, LaneRateSample L3068-3072, Customer). Adding one GSI per table is rejected (§2.3). |
| Rep fields on rows | `Shipment.salesRepId` L1930; `Load.salesRepId` L177; `Order.customerRepId`; `Quote.customerRepId`; `LaneRateSample.salesRepId/customerRepId/teamKey` L3041-3052 (`teamKey` = team **at sample time**, so stale by design: not used for visibility); `Invoice` has **no rep field** (joins its shipment). |
| Claims | `roles.ts` L78-117 (`CLAIMS`, `CLAIM_LABELS`, `ENFORCED_CLAIMS`), `claimGroup` L131, `groupsForProfile` L162; `src/types/tms.ts` L3590 `ClaimKey`; `userManagement/handler.ts` L774 `setClaims`; `UsersPage.tsx` L329-352 | see F8. Token groups refresh on next sign-in/refresh (same as every claim). |
| Client auth | `src/hooks/useAuth.ts` (`user.groups`, `isAdmin`, `isOwner`, `hasPageAccess`); `RequirePage` | UI gating mirrors the pure `dashboardAccess()` of AI1; the server is the boundary. |
| Teams for pickers | `TmsSettings.teams` via `getTmsSettings`; `UserProfile` list | tens of rows. |
| Template size | `scripts/measureDataTemplate.mjs` | real synth; Main runs it once (§11). |

---------------------------------------------------------------------------------------------------

## 2. The hard rule — data visibility

### 2.1 Definition (one pure module, `src/lib/dataVisibility.ts`, owned by AI1)

```ts
import { viewerFromGroups, OWNER_EMAIL } from './crm/visibility'     // reused
import { ownerIdsOf, type OwnedCustomer } from './crm/owner'         // reused
import type { CrmViewer } from './crm/types'                          // reused shape

export interface DataViewer extends CrmViewer {
  email: string                   // lower-cased
  teamKeys: ReadonlySet<string>   // UPPER-CASED keys of ACTIVE teams whose memberIds contain id or email
  viewAll: boolean
}

/** Groups -> viewer. Teams come from TmsSettings.teams (authoritative), passed in by the caller. */
export function dataViewer(input: { id: string; email?: string | null; groups?: readonly string[] | null; teams?: readonly Team[] | null }): DataViewer

/** viewAll = owner || ADMIN group || role AR_AP || claim-VIEW_ALL.  (VIEW_ALL_ROLES = ['AR_AP'] is the single flip point for D2.) */
export function hasViewAll(viewer: CrmViewer, groups: readonly string[]): boolean

export interface RowRef {            // the only fields the predicate reads
  customerId?: string | null
  salesRepId?: string | null         // Shipment / Load / LaneRateSample
  customerRepId?: string | null      // Order / Quote / LaneRateSample
}
export type VisCustomer = OwnedCustomer & { id: string; teamKey?: string | null }

/** Customer-level test: viewer owns it (accountOwnerIds ∪ defaultSalesRepId) or is on its team. */
export function canSeeCustomer(v: DataViewer, c: VisCustomer | null | undefined): boolean
/** Row-level: viewAll || row rep fields name the viewer || the row's customer passes canSeeCustomer. */
export function canSeeRow(v: DataViewer, row: RowRef, customerById: ReadonlyMap<string, VisCustomer>): boolean
```

Rules (each is a test in §9):

1. `viewAll` → everything.
2. Otherwise a row is visible iff **(a)** `row.salesRepId` or `row.customerRepId` equals the viewer (id **or** e-mail, case-insensitive, trimmed — rep fields hold the Cognito username which is the e-mail for everyone invited through Users), **or (b)** the row's customer is owned by the viewer (`ownerIdsOf(customer)` = `accountOwnerIds ∪ defaultSalesRepId`), **or (c)** `customer.teamKey` (upper-cased) ∈ `viewer.teamKeys`.
3. A row with no resolvable customer (unresolved `customerId`, F-Step-R "customer not yet resolved") is visible **only** through (a).
4. **A customer with no owner and no team is invisible to every non-viewAll user** (CRM would show it; D3). An **inactive** team (`active === false`) or a removed member grants nothing.
5. `carrierRepId` / `carrierTeamKey` (the carrier-side covering rep/team) grant **no** visibility (D4: the rule is "sales rep or team assigned to the customer").
6. Team membership is read per request from `TmsSettings.teams` (one `GetItem`), not from the token and not from `UserProfile.teamKeys` (a best-effort mirror that "never refuses the settings save" can lag: a lagging mirror must not widen access).

### 2.2 Where it is enforced (every read path of the feature)

| # | Enforcement point | How |
|---|---|---|
| E1 | `tms-dashboard-actions/visibleReader.ts` **`VisibleReader`** — the only object the executors receive. Each method (`samples(month)`, `shipments(month)`, `openInvoices()`, `quotes(month)`, `recentShipments()`…) calls the raw `SourceReader` and returns **already filtered** rows; the raw reader is a private closure parameter, never exported to `execute.ts`. | structural, not by convention |
| E2 | `execute.ts` signature `runWidget(query, params, reader: VisibleReader, ctx): WidgetResult` — takes no raw reader, no table name, no viewer to bypass. Every catalog entry is run through it. | the catalog-wide invariant test (§9 T2) iterates `QUERY_CATALOG` so a new query that reads around the reader fails CI |
| E3 | `PREVIEW_DASHBOARD` / `GET_DASHBOARD` build the `DataViewer` from **the caller's** identity — never the dashboard owner's, never the spec's `scope`. A COMPANY dashboard opened by a rep returns that rep's rows. `scope` decides who may **open** a dashboard, never which data it shows. | test T4: same dashboard, two viewers, different totals |
| E4 | Name pickers in chat: customer names resolve only against the viewer's **visible** customer set; "not found" and "not visible" return identical text (CRM `EMPTY_VIEW` precedent) so a rep cannot probe which customers exist. | test T4 |
| E5 | Aggregates: totals, "Other" buckets, group labels, top-N and counts are computed from visible rows only; a LIST/TABLE has no row the predicate rejected; `note` never mentions hidden counts. | catalog test T2 (sentinel rows) |
| E6 | `LIST_DASHBOARDS`/`GET_DASHBOARD` apply the **audience** rule (owner, COMPANY, `sharedWith` user/team, ADMIN) — separate from data visibility; archived rows are never returned. | T4 |
| E7 | Overview for non-viewAll (§8.2): the classic client-computed page is **not mounted**; the built-in `OVERVIEW_SPEC` runs through E1-E3. | UI test T5 (`useBrokerageDashboard` never called) |

Result carries `visibility: { viewAll: boolean; ownedCustomers: number; teamKeys: string[] }` (counts and team keys only, no names) so the UI can print "Showing only the customers you own or your team covers".

### 2.3 Rollup vs per-viewer reads — decision and cost (the question the brief asked to settle)

**Decision: bounded server-side queries over the existing indexes with the viewer predicate applied to the rows. No per-rep/per-team rollup rows. No new GSI.**

Why per-rep rollup rows lose:
* **Size.** The month row is 15-90 KB and already guarded at 300 KB (`MAX_PAYLOAD_BYTES`, AF §3.3). Adding a rep × team dimension multiplies it by the number of distinct cells (≈ staff count); one busy month passes the guard and the page silently falls back to "live" for that month.
* **Wrong dependency graph.** The predicate depends on **customer** ownership/team (live, editable), not on anything stored on the shipment. `Customer` is not a stream source and `accountOwnerIds`/`teamKey` are not in `COMPARED`; a reassignment would have to dirty every month the customer ever shipped (≥ 24 `M:` + `LG:` rows each) and until the sweep reached them a former owner would still see the customer's money. `LaneRateSample.teamKey` is frozen "at sample time" so it cannot stand in.
* **Latency of revocation.** Removing someone from a team must take effect on their next request; a pre-aggregate gives minutes of stale visibility, which is the opposite of a hard rule.

What the bounded path costs (dev numbers from `AF-plan` §1.1/§1.3/§3.3 and BUILD_LOG; **[INFERENCE]** marks estimates not measured):

| Read (shared per request, memoised by key inside one invocation) | Source | Size on dev | Time |
|---|---|---|---|
| Visible-customer set | `Scan Customer` (no GSI on owner/team) projecting `id,accountOwnerIds,defaultSalesRepId,teamKey,name,aliases`, then in-memory `canSeeCustomer`; module-level memo **30 s** for the raw customer rows only (the viewer filter is applied after the memo, never cached) | 705 rows, ~1.2 MB (AF §1.3) | 2 pages ≈ 0.2-0.4 s [INFERENCE]; 0 when memo warm |
| Teams + staff + divisions | `GetItem TmsSettings`, `Scan UserProfile`, `Scan OwnershipDivision` | tens of rows / 7 rows | ≈ 30 ms |
| Revenue/profit/cost facts | `Query laneRateSamplesBySampleMonthAndDate` per month, in parallel | 29 rows for 2026-11 on dev (AF §1.1); a few hundred/month in prod [INFERENCE] | 30-80 ms/month |
| Shipment facts | `Query shipmentsByPickupMonthAndPickupAppt` per month with `attribute_not_exists(voidedAt)` filter (exactly `rollupSource.shipments`) | Nov: 2,509 items scanned, 210-330 returned (AF §3.3) | ≈ 0.3-0.8 s/month, months in parallel [INFERENCE] |
| Open AR | `Query invoicesByArOpenAndDueAt('OPEN')` then `BatchGet` the 253 invoices' shipments (rep + division tag) | 253 rows (AF §1.3) | ≈ 0.2-0.35 s |
| Quotes | `Query quotesByQuoteMonthAndQuoteDate` per month | small | ≤ 0.1 s/month [INFERENCE] |

Reference dashboard (this quarter, 8 widgets: revenue KPIs, revenue by customer, AR aging, shipments by status…): one customer scan, 3 sample months ∥ 3 shipment months ∥ invoices ∥ quotes → **≈ 1.2-1.8 s data time + ≤ 1 s cold start [INFERENCE]**. Gates (AI5 measures, p95 of 5 warm runs on the reference spec): `PREVIEW_DASHBOARD` ≤ 4 s warm, hard 25 s; RCU burn per run ≈ the ~3 MB of month pages (eventually consistent, PAY_PER_REQUEST: negligible).

Guards that keep the cost bounded: catalog `maxMonths` per query (shipments 4, quotes 6, samples 13; beyond the cap the spec is rejected with a plain-English issue, not truncated); `maxWidgets` 12; `limit ≤ 25` everywhere; per-request `DataSession` memo so 12 widgets share reads; total run budget 24 s with per-widget error capture (a slow widget returns `{ok:false}` instead of blanking the dashboard).

viewAll users on the *classic* Company Dashboard keep the rollup fast path untouched (AF). New dashboards use the one bounded path for **everyone** (single code path; viewAll just makes the predicate `true`), so there is no rollup-vs-live equivalence to maintain. Using the rollup inside custom dashboards for viewAll viewers is a later optimisation, explicitly not in this step.

---------------------------------------------------------------------------------------------------

## 3. Permissions (Settings > Users)

| Product name | `ClaimKey` | Cognito group | Label (`CLAIM_LABELS`) | Enforced? |
|---|---|---|---|---|
| `dashboards.create` | `DASHBOARDS_CREATE` | `claim-DASHBOARDS_CREATE` | "Create dashboards" | yes (`ENFORCED_CLAIMS`) |
| `dashboards.publishCompany` | `DASHBOARDS_PUBLISH_COMPANY` | `claim-DASHBOARDS_PUBLISH_COMPANY` | "Publish company dashboards" | yes |
| `viewAll` | `VIEW_ALL` | `claim-VIEW_ALL` | "See all customers' data" | yes |

* `src/lib/roles.ts` (AI1): add to `CLAIMS`, `CLAIM_LABELS`, `ENFORCED_CLAIMS`; `src/types/tms.ts` `ClaimKey` gains the three literals. `userManagement` accepts them through `isClaimKey` with no handler change; `UsersPage` renders them in the existing "Permissions" grid.
* **Implied grants (pure, `src/lib/dashboards/access.ts` `dashboardAccess({ email, groups })`):** owner (`ryne@bcatcorp.com`) and the `ADMIN` group hold all three; role `AR_AP` (`role-AR_AP` group) holds `viewAll`; everyone else needs the explicit claim. Returns `{ create, publishCompany, viewAll }`. `publishCompany` implies `create`'s UI but the server checks each independently.
* **Server refusals** (§6.3): `PREVIEW_DASHBOARD_CHAT` and `SAVE_DASHBOARD` require `create`; `SAVE_DASHBOARD` with `scope: COMPANY` (or editing an existing COMPANY dashboard) requires `publishCompany`; `PREVIEW_DASHBOARD` of an **unsaved spec** requires `create`; opening a saved dashboard needs only `page-tms` + audience. Error text starts with `Forbidden:` like every other router.
* **UI:** no `create` → **no "New dashboard" button, no builder route reachable** (`/tms/dashboard/new` redirects to the Overview), no Edit menu; `publishCompany` missing → the "Whole company" chip is disabled with the tooltip "Needs the Publish company dashboards permission". The UI reads `useDashboardAccess()` (pure function over `useAuth().user`); the server never trusts it.
* A grant only reaches the token on the user's next sign-in/refresh (true of every claim); the Users page has no such sentence today (grep found none), so AI6 adds one line.

---------------------------------------------------------------------------------------------------

## 4. Data model (additive; template-size gated)

### 4.1 `Dashboard` (the only new model) — `amplify/data/resource.ts`, immediately after `DashboardRollup`

```ts
Dashboard: a
  .model({
    id:          a.id(),
    title:       a.string().required(),            // ≤ 80
    scope:       a.enum(['COMPANY', 'USERS', 'TEAM', 'ME']),
    ownerId:     a.string().required(),            // Cognito username (= UserProfile.id)
    ownerName:   a.string(),                       // display snapshot for cards
    sharedWith:  a.json(),                         // { userIds: string[], teamKeys: string[] } ; {} for COMPANY/ME
    spec:        a.json().required(),              // DashboardSpec v1, ≤ 32,000 bytes serialised
    specVersion: a.integer().required(),           // 1
    widgetCount: a.integer(),                      // for cards, no spec parse
    archivedAt:  a.datetime(),                     // archive, never delete (house rule)
    archivedBy:  a.string(),
    createdBy:   a.string().required(),
    updatedBy:   a.string().required(),
    version:     a.integer().required(),           // CAS token, +1 per write
  })
  .disableOperations(['queries', 'mutations', 'subscriptions'])   // Lambda-only via the SDK; no resolvers emitted
  .authorization((allow) => [allow.groups(['ADMIN']).to(['read'])]),  // CRM-table precedent; moot with queries disabled
```
No GSI. The table is tens of rows: `LIST_DASHBOARDS` is a `Scan` with `ProjectionExpression` (`id,title,scope,ownerId,ownerName,sharedWith,widgetCount,archivedAt,updatedAt,version`) and the audience filter in memory. Caps enforced in `SAVE_DASHBOARD`: ≤ 200 active dashboards, ≤ 50 per owner, spec ≤ 32,000 bytes (so a full scan stays one or two 1 MB pages). Client-write protection is automatic: with all operations disabled there is no mutation to call. Writes use `PutItem`/`UpdateItem` with `__typename`, `createdAt`, `updatedAt` stamped like `rollupStore.rowBase` and `ConditionExpression version = :expected` (the `putVersioned` pattern in `tms-directory-actions`).

### 4.2 Team — nothing to add (F1)

Membership: `TmsSettings.teams` (Settings > Teams). Customer assignment: `Customer.teamKey` via the existing `TeamPicker`. The dashboard's `TEAM[list]` scope stores team **keys**. AI2 validates keys against `TmsSettings.teams` (active) and user ids against `UserProfile` (ACTIVE) on save.

### 4.3 Template budget and the fallback

* Baseline 967,607 B (cap 1,000,000). Estimate: `Dashboard` with every operation disabled **+2,000-4,000 B**, Lambda + role/policies + log group + env **+8,000-10,000 B**, custom mutation **+1,000 B** [INFERENCE from K/L entries]. Stop-line: Main runs `node scripts/measureDataTemplate.mjs --branch dev` after AI2 lands; **> 990,000 B ⇒ do not push**, apply the fallback.
* **Fallback A (saves the function, ≈ 8-10 KB):** move the actions into `tms-crm-actions` (already in the data stack, already reads Customer/Quote/Shipment/UserProfile). AI2 keeps all logic in `tms-dashboard-actions/actions.ts` exporting `dispatch(action, input, identity, deps?)` exactly like `tms-crm-actions/actions.ts`, so relocation is: import `dispatch` in the CRM handler for `*_DASHBOARD*` actions, give `crmFn` the extra table grants + the secret. Costs: the CRM resource comment "no model" stops being true; IAM widens to Invoice/LaneRateSample/Dashboard.
* **Fallback B (saves the model, ≈ 2-4 KB, loses sharing):** My-only dashboards as `UserProfile.dashboards: a.json()` (fields cost no template bytes). **Rejected as the default:** shared specs cannot live in existing JSON (the `TmsSettings` singleton is one 400 KB item, edited under CAS by Settings, and every settings read would carry every dashboard; `UserProfile` rows are per owner so sharing becomes a cross-row lookup). Say so to Ryne if the budget forces it.

---------------------------------------------------------------------------------------------------

## 5. Spec schema and widget catalog (whitelisted queries only)

### 5.1 `DashboardSpec` v1 — zod, `.strict()` everywhere, `src/lib/dashboards/spec.ts` (AI1; zod ^4 is already a dependency, `src/lib/schemas.ts`)

```jsonc
{
  "v": 1,
  "title": "Ivan Cartage — revenue by customer, this quarter",        // 1-80
  "description": "Revenue and open AR for Ivan Cartage",              // 0-200, optional
  "scope": { "kind": "TEAM", "teamKeys": ["EAST"] },                  // ME | COMPANY | USERS{userIds 1-25} | TEAM{teamKeys 1-10}
  "filters": {
    "window":     { "preset": "THIS_QUARTER" },                       // THIS_MONTH|LAST_MONTH|THIS_QUARTER|LAST_QUARTER|LAST_30_DAYS|LAST_90_DAYS|YEAR_TO_DATE|CUSTOM{from,to}
    "divisions":  ["BOX_TRUCK"],                                      // OwnershipDivision codes, ≤ 8, validated against the tree (+descendants)
    "customerIds": [],                                                // ≤ 25, intersected with visibility at run time
    "repIds": [],                                                     // ≤ 25
    "modes": []                                                       // ShipmentMode subset
  },
  "widgets": [                                                         // 1-12
    { "id": "w1", "type": "KPI",  "title": "Revenue",          "size": "S",
      "query": { "id": "fin.summary",    "params": { "metrics": ["revenue", "profit", "margin"] } } },
    { "id": "w2", "type": "BAR",  "title": "Revenue by customer", "size": "L",
      "query": { "id": "fin.byGroup",    "params": { "metric": "revenue", "groupBy": "CUSTOMER", "limit": 12 } } },
    { "id": "w3", "type": "TABLE","title": "Open AR by customer", "size": "L",
      "query": { "id": "ar.byCustomer",  "params": { "limit": 12 } } }
  ]
}
```
* `size`: `S` = 3 of 12 columns, `M` = 6, `L` = 9, `F` = 12 (rows are auto-height; `autoLayout(widgets)` places in order, KPI tiles first-row packing). **No free-form coordinates, no drag/drop in v1** (D11): the layout is the order + size, edited by chat ("make the chart wider").
* Validation rules beyond shape (`parseSpec(raw): { ok: true; spec } | { ok: false; issues: string[] }`, issues in plain English, identical on client and server): widget ids unique `w1…w12`; `type` ∈ the query's `types`; params parsed by the **query's own** zod object (a `z.discriminatedUnion('id', …)` built from `QUERY_CATALOG`, so an unknown query id or an extra param key is a hard failure); `CUSTOM` window `from ≤ to`, ≤ 400 days; resolved month count ≤ the strictest `maxMonths` among the dashboard's widgets; `scope` shape; total serialised size ≤ 32,000 B; no string field may contain control characters. **No SQL, no table names, no expression strings exist anywhere in the schema** — the executor selects code by catalog id, so there is nothing to inject into.
* `DashboardRecord.scope` (the column) and `spec.scope` are validated equal on save; the column is what listings read.

### 5.2 Catalog — `src/lib/dashboards/catalog.ts` (`QUERY_CATALOG`, the single source for the validator, the executor, the model prompt and the UI labels)

Each entry: `id`, `label`, `description` (one line, goes into the model prompt), `types` (allowed widget types), `params` (zod), `maxMonths`, `source` (`'SAMPLE' | 'SHIPMENT' | 'INVOICE' | 'QUOTE'`), `supports: { divisions, customers, reps, modes }`.

| id | Source (index) | Widget types | Params | maxMonths |
|---|---|---|---|---|
| `fin.summary` | `LaneRateSample` (`sampleMonth`) | KPI | `metrics ⊆ {revenue,cost,profit,margin,count}` | 13 |
| `fin.byGroup` | same | BAR, PIE, TABLE | `metric`, `groupBy ∈ {CUSTOMER,REP,CARRIER,DIVISION,MODE}`, `limit ≤ 25`, `sort desc` | 13 |
| `fin.byTime` | same | LINE, BAR, TABLE | `metric`, `grain ∈ {MONTH,WEEK}` | 13 |
| `ship.summary` | `Shipment` (`pickupMonth`, voided excluded) | KPI | `metrics ⊆ {count,delivered,inTransit,open}` | 4 |
| `ship.byStatus` | same | PIE, BAR, TABLE | — | 4 |
| `ship.byTime` | same | LINE, BAR, TABLE | `grain ∈ {MONTH,WEEK}` | 4 |
| `ship.byGroup` | same | BAR, TABLE | `groupBy ∈ {CUSTOMER,REP,DIVISION,MODE}`, `limit` | 4 |
| `ship.recent` | same | LIST, TABLE | `limit ≤ 25` (pickup desc) | 4 |
| `ar.summary` | `Invoice` (`arOpen`) + shipment join | KPI | `metrics ⊆ {open,overdue,count,avgDaysOpen}` | — (open set, no window) |
| `ar.aging` | same | BAR, PIE, TABLE | fixed buckets 0-30, 31-60, 61-90, 90+ (days past due) | — |
| `ar.byCustomer` | same | BAR, TABLE | `limit` | — |
| `ar.list` | same | LIST, TABLE | `limit ≤ 25`, `sort ∈ {dueAt,balance}` | — |
| `quote.summary` | `Quote` (`quoteMonth`) | KPI | `metrics ⊆ {count,won,lost,winRate,openValue}` | 6 |
| `quote.byStatus` | same | PIE, BAR, TABLE | — | 6 |
| `quote.byCustomer` | same | BAR, TABLE | `metric ∈ {count,value}`, `limit` | 6 |
| `quote.recent` | same | LIST, TABLE | `limit ≤ 25` | 6 |

Definitions (stated so a number is never a surprise): window = pickup day for shipments, sample `date` for revenue (delivery day), quote date for quotes, **UTC calendar** like AF; quarter = UTC calendar quarter (D9); margin = `marginBpsOf(Σprofit, Σrevenue)` (recomputed, never averaged); priced samples = `excluded !== true`; voided shipments never counted; AR = open `Invoice`s bucketed by the **shipment's** `revDivision/revSubdivision` (the rollup's rule), so `divisions` works on `ar.*`; **`quote.*` and `Invoice.divisionKey` do not support the revenue-division filter** (quotes carry no ownership tag): a spec with `divisions` and a `quote.*` widget is accepted but the widget's `note` says "Quotes are not split by division" (honesty rule, as AF). AP/carrier-bill queries are **not** in v1 (D10: carrier cost is the most sensitive figure; add behind `viewAll` later).

Result shape (`src/lib/dashboards/types.ts`): `WidgetResult = { widgetId, ok: true, kind: ChartKind, series: ChartSeries-compatible } | { widgetId, ok: false, error: string }` — `ChartSeries`-compatible by structure (`kpis?, rows, groups, columns?, valueFormat, note?`) so `ChartCard`/`SeriesTable`/`TmsKpiCard` render it unchanged; a type-level `satisfies` check in `WidgetView.tsx` keeps the two from drifting. LIST widgets use `kind: 'table'` with `columns` + `text` cells (first column is the item title).

---------------------------------------------------------------------------------------------------

## 6. Lambda `tms-dashboard-actions`

### 6.1 Files (AI2)

```
amplify/functions/tms-dashboard-actions/
  resource.ts        defineFunction({ name:'tms-dashboard-actions', entry:'./handler.ts', resourceGroupName:'data',
                       timeoutSeconds: 29, memoryMB: 512, environment: { ANTHROPIC_API_KEY: secret('ANTHROPIC_API_KEY') } })
  handler.ts         AppSync entry (copy of tms-crm-actions/handler.ts): arguments.action / .input / .identity -> dispatch()
  actions.ts         authorize(), dispatch(action, rawInput, identity, deps = defaultDeps), the seven actions
  sources.ts         raw DynamoDB SourceReader: samples(month) shipments(month) openInvoices() shipmentsByIds() quotes(month)
                     customers() settings() staff() divisions()   -- NOT exported to execute.ts
  visibleReader.ts   makeVisibleReader(raw, viewer, customerById) -> VisibleReader (E1)
  store.ts           Dashboard table: list/get/putVersioned/archive, caps, audit()
  chat.ts            interview + build turns, name resolution, scope gate, retry-once
  model.ts           ModelPort { complete(system, messages, schema, signal) }; real impl = Anthropic stream (askAcademy shape)
  testkit.ts         in-memory SourceReader / Dashboard store / scripted ModelPort (pattern: tms-spot-quoter/testkit.ts)
  *.test.ts
amplify/functions/_shared/ddbReads.ts   extracted from tms-dashboard-rollup/store.ts: pages(), pool(), batchGet(), plain()
```
`ddbReads.ts` is a pure move of the four private helpers (`store.ts` L~150-215 import them back; `store.test.ts` keeps passing). If AI2 prefers zero edits to AF's file it may copy them instead — the move is preferred (no duplicate).

### 6.2 `authorize()` and `Caller`

Copy `tms-crm-actions/actions.ts` `authorize` (L109-124): `id = identity.username ?? sub`, email from claim (fallback `UserProfile` GetItem), `groups` from `cognito:groups`; **door check** `owner || ADMIN || page-tms` (the `/tms/dashboard` route guard; same set as `assistantActions` in directory-actions). `Caller = { id, email, groups, access: dashboardAccess({email, groups}), viewerBase: viewerFromGroups(...) }`. The full `DataViewer` (teams) is built per request from `TmsSettings.teams` after the door check.

### 6.3 Actions and authorization

| Action (read verbs first — F7) | Needs | Input → output | Touches the model? |
|---|---|---|---|
| `PREVIEW_DASHBOARD_CHAT` | door + `access.create` (+ `publishCompany` if `scope.kind==='COMPANY'`) | `{ messages, scope \| null, draft \| null }` → `DashChatResult` (§7.2) | **yes — the only one** |
| `PREVIEW_DASHBOARD` | door; unsaved `spec` needs `access.create`; `{ id }` needs audience; `{ builtin: 'OVERVIEW' }` needs only the door | `{ spec } \| { id } \| { builtin }` → `{ results: WidgetResult[], resolved, visibility, asOf, ms }` | no |
| `LIST_DASHBOARDS` | door | `{}` → `{ company: DashboardSummary[], mine: DashboardSummary[] }` (audience-filtered, archived dropped; `mine` = owned ∪ shared-with-me) | no |
| `GET_DASHBOARD` | door + audience | `{ id }` → `{ dashboard: DashboardRecord, canEdit }` | no |
| `GET_DASHBOARD_OPTIONS` | door | `{}` → `{ access, divisions[{code,name,brand,parentId}], staff[{id,name,teamKeys}], teams[{key,name}], catalog[{id,label,types}], limits, visibility }` (no customers, no row data) | no |
| `SAVE_DASHBOARD` | door + `access.create`; `scope COMPANY` ⇒ `publishCompany`; update ⇒ owner-with-create or ADMIN/owner, and `expectedVersion` | `{ id?, spec, sharedWith?, expectedVersion? }` → `DashboardRecord` | no |
| `ARCHIVE_DASHBOARD` | door + (owner or ADMIN/owner); archiving a COMPANY dashboard ⇒ `publishCompany` or ADMIN | `{ id, expectedVersion }` → `{ id, archivedAt }` | no |

* **Unknown action ⇒ `Unknown action: X`** (CRM `dispatch`). **No action trusts a client-supplied owner, scope-derived viewer, `viewAll` or result.**
* `SAVE_DASHBOARD` re-parses the spec with the same `parseSpec`, re-validates `scope` (user ids exist and are ACTIVE; team keys exist and are active; COMPANY gate), forces `ownerId = caller.id` on create (never from input), stamps `ownerName`, `widgetCount`, `specVersion = 1`, `version+1`, writes an `AuditLog` row (`entityType 'Dashboard'`, action `DASHBOARD_SAVED|ARCHIVED|CHAT`, changes = ids, scope kind, widget count, **never** message text or spec body — `tms-crm-actions` `audit()` precedent). `CAS`: `expectedVersion` mismatch ⇒ `Conflict: dashboard changed; reload`.
* **Sharing never widens data** (E3): `USERS`/`TEAM` only decide who sees the card; each viewer runs the spec under their own visibility. Viewers who are not the owner get **read-only** + "Duplicate to my dashboards" (needs `create`; saves a new row with `scope: ME`).
* `PREVIEW_DASHBOARD` with `{ id }` where the caller is outside the audience returns the same `Dashboard not found` as a missing id (no existence probe).
* A user who loses `create` keeps read access to dashboards shared with them and keeps their own as read-only until the claim returns.

### 6.4 Time, memory and failure behaviour

* AppSync allows 30 s: `timeoutSeconds: 29`. Chat: model call has an `AbortController` at **22 s**; on abort/overload/credit error the action does **not** throw: it returns a normal `DashChatResult` with `modelError: '<provider message, trimmed to 200 chars>'`, `spec: null`, and the SCOPE question still attached when `scope === null` (so R1/R2 hold even when the provider is down) — no write, the client keeps the conversation and shows Retry. Data run: a **24 s budget** shared by widgets; widgets are executed with concurrency 4 over the memoised `DataSession`; a widget that exceeds the budget or throws returns `{ ok:false, error }`.
* Model retry: at most **one** repair call when `parseSpec` fails and ≥ 10 s remain, feeding the issue list back; otherwise return the issues and no spec.
* Logging: ids and counts only (`console.warn` on audit failure, like CRM). No message text, no spec body, no row values.
* Module-level memo: raw Customer rows (30 s) and raw month pages (30 s, keyed table+month, capped at 8 entries) only; **the viewer predicate is never cached** and no `VisibleReader` outlives a request.

### 6.5 `amplify/backend.ts` wiring (AI2; one block after the rollup block, L~3934; same shape as the `crmFn` block L3729-3860)

```ts
import { tmsDashboardActions } from './functions/tms-dashboard-actions/resource'   // next to L70
// defineBackend({ ..., tmsCrmActions, tmsDashboardActions, tmsDashboardRollup, ... })  // next to L169-170

// ── tmsDashboardActions (Step AI) ──
{
  const fn = backend.tmsDashboardActions.resources.lambda as LambdaFunction
  const T = backend.data.resources.tables
  for (const [env, model] of Object.entries({
    DASHBOARD_TABLE_NAME: 'Dashboard', SHIPMENT_TABLE_NAME: 'Shipment', INVOICE_TABLE_NAME: 'Invoice',
    QUOTE_TABLE_NAME: 'Quote', LANE_RATE_SAMPLE_TABLE_NAME: 'LaneRateSample', CUSTOMER_TABLE_NAME: 'Customer',
    TMS_SETTINGS_TABLE_NAME: 'TmsSettings', USER_PROFILE_TABLE_NAME: 'UserProfile',
    OWNERSHIP_DIVISION_TABLE_NAME: 'OwnershipDivision', AUDIT_LOG_TABLE_NAME: 'AuditLog',
  })) fn.addEnvironment(env, T[model].tableName)
  fn.addToRolePolicy(new PolicyStatement({            // the only writer of Dashboard
    actions: ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:Scan','dynamodb:Query'],
    resources: [T['Dashboard'].tableArn] }))
  fn.addToRolePolicy(new PolicyStatement({            // read-only on the sources, tables + indexes
    actions: ['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:Query','dynamodb:Scan'],
    resources: ['Shipment','Invoice','Quote','LaneRateSample','Customer','TmsSettings','UserProfile','OwnershipDivision']
      .flatMap((m) => [T[m].tableArn, `${T[m].tableArn}/index/*`]) }))
  fn.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [T['AuditLog'].tableArn] }))
}
```
`Scan` is granted on the small tables only in practice (Customer, UserProfile, OwnershipDivision, Dashboard); the code never scans Shipment/Invoice/Quote/LaneRateSample (no `Scan` call exists for them — `sources.ts` test asserts the fake db rejects a `Scan` on those tables). No S3, no SSM, no SES, no Secrets besides `ANTHROPIC_API_KEY`. `amplify/data/resource.ts`: import next to L26, the mutation next to `tmsCrmActions` (~L4780), **no** `allow.resource(...)` grant (SDK only).

---------------------------------------------------------------------------------------------------

## 7. Chat protocol (stateless server; the client owns the transcript)

### 7.1 Why stateless
No conversation table (template bytes, retention questions, PII in storage). The client sends the transcript (≤ 20 messages, ≤ 2,000 chars each, ≤ 12,000 total — rejected above) and the current `draft` spec on every turn. Closing the page discards the chat; **Save** is the only persistence. The model never receives rows, customer lists, e-mails or any data: only the transcript, the catalog text generated from `QUERY_CATALOG`, today's UTC date, the current draft, and the scope status.

### 7.2 Contract (`src/lib/dashboards/types.ts`)

```ts
interface DashChatInput  { messages: { role: 'user' | 'assistant'; text: string }[]; scope: DashboardScope | null; draft: DashboardSpec | null }
interface DashQuestion   { id: string; kind: 'SCOPE' | 'CLARIFY'; text: string; choices: string[] }    // SCOPE has no free choices: the UI renders the scope picker
interface DashChatResult {
  reply: string                       // plain text shown as the assistant bubble
  questions: DashQuestion[]           // rendered under the bubble
  spec: DashboardSpec | null          // null while any question is open or scope is null
  issues: string[]                    // plain-English validation / resolution problems
  resolved: { divisions: {code:string;name:string}[]; customers: {id:string;name:string}[]; reps: {id:string;name:string}[]; unresolved: string[] }
  modelMs: number
  modelError: string | null           // set when the provider refused/aborted; never a fabricated spec
}
```

### 7.3 Server rules (deterministic; tests in §9 T4 run them with a scripted `ModelPort`)

| # | Rule |
|---|---|
| R1 | **Scope is asked, always.** If `scope === null`, the result's `questions` **always** contains `{ id:'scope', kind:'SCOPE', text:'Is this dashboard for the whole company, or for specific users/teams?' }` — appended by code, not the model — on the first turn and on every later turn until a chip sets `scope`. |
| R2 | **No spec without a scope.** If `scope === null`, `spec` is returned `null` whatever the model produced ("I'll build it as soon as you tell me who it is for."). `scope` is set **only** by the scope picker (the client sends it after the chip click); a typed "company-wide" is echoed back as "Pick one of the options below" (testable, no ambiguous NLP on a permission-bearing choice). |
| R3 | `scope.kind === 'COMPANY'` without `publishCompany` ⇒ `Forbidden:` at the chat call (fail early, not at Save). `USERS`/`TEAM` lists are validated against `UserProfile`/`TmsSettings.teams`. |
| R4 | **Interview vs build.** The model returns a flat object (below). If `ready === false` or `questions.length > 0` the result carries the (≤ 2) clarifying questions and `spec: null`; if `ready === true` and scope is known the server builds the spec. `draft !== null` (iteration) is always treated as ready unless the model asks something. |
| R5 | **Name resolution is server-side.** `divisionNames[]` resolve against `OwnershipDivision` (name, code, brand, via `normalizeName` from `_shared/directoryKeys.ts`; descendants included) — **"Ivan Cartage" is a division**, not a customer; `customerNames[]` resolve only among the viewer's **visible** customers (`normalizeName` + `aliases`); `repNames[]` among ACTIVE staff. Ambiguous ⇒ a `CLARIFY` question with the candidate names as choices; none ⇒ issue "No customer you can see matches 'X'" (identical for not-found and not-visible, E4). |
| R6 | **Validate, repair once, else refuse to draw.** `buildSpecFromModel(out, resolved)` → `parseSpec`. Invalid and time allows ⇒ one repair turn with the issues; still invalid ⇒ `spec: null`, `issues` set, `reply` "I couldn't build that one: …", `draft` unchanged on the client. |
| R7 | Only whitelisted catalog ids can come out: the model-facing schema's `queryId` is an `enum` of `QUERY_CATALOG` ids, and `buildSpecFromModel` drops anything else before zod sees it. The model has **no tools**; it cannot call anything. |

**Model-facing schema `MODEL_OUT_SCHEMA`** (`src/lib/dashboards/spec.ts`, passed as `output_config.format.json_schema`; **union-free, every field required, sentinels for "unset"** — the AB lesson):
`{ reply:string, ready:boolean, questions:[{id,text,choices:string[]}], title:string, description:string, window:enum(presets)|"" , from:string, to:string, divisionNames:string[], customerNames:string[], repNames:string[], modes:string[], widgets:[{ type:enum, title:string, queryId:enum, metric:string, metrics:string[], groupBy:string, grain:string, sort:string, limit:integer(0=unset), size:enum }] }`.
`buildSpecFromModel` maps sentinels (`""`, `0`, `[]`) to absent keys, assigns ids `w1…`, resolves names, and runs `autoLayout`. Model: `claude-sonnet-5` with `effort: 'low'`, `max_tokens: 2500`, `messages.stream(...)`, system block with `cache_control` (the catalog text is ~2-3 K tokens, identical across turns). Latency **p50 6-12 s, p95 < 20 s [INFERENCE]** for a full spec; AI5 records the real numbers and fails the harness step above 22 s.

### 7.4 Conversation walk-through (the target flow; the screenshots in §10 are this exact script)

1. Ryne clicks **New dashboard** → builder opens. Assistant: "Describe the dashboard you want — metrics, who it's about, the time period."
2. User: "revenue by customer for Ivan Cartage this quarter, with open AR" → `PREVIEW_DASHBOARD_CHAT({ messages:[u1], scope:null, draft:null })`.
3. Assistant bubble: "Ivan Cartage matches 4 divisions (Ivan Cartage, Box Truck, …). Include all of them? Do you want AR as a table by customer or an aging chart?" + CLARIFY choices, **and** the SCOPE question with the picker: ◉ Whole company ○ Specific users… ○ Specific teams… ○ Just me.
4. User answers in text and clicks **Just me** (or Whole company if they hold `publishCompany`) → `({ messages:[u1,a1,u2], scope:{kind:'ME'}, draft:null })` → `spec` returned → client immediately calls `PREVIEW_DASHBOARD({ spec })` and the preview pane fills (skeleton per widget while loading).
5. User: "make the chart monthly" → `({ …, scope, draft: spec })` → revised full spec → preview re-runs; widgets whose JSON changed get a 2-second highlight ring.
6. User: "add margin" → same loop.
7. **Save** → dialog (title prefilled, scope recap with the same picker, shared-with lists) → `SAVE_DASHBOARD` → navigates to `/tms/dashboard/d/<id>`; the Company/My tab now shows the card.

---------------------------------------------------------------------------------------------------

## 8. UI

### 8.1 Routes and files (kit components + `--tms-*` tokens only; `data-testid` for the harness)

| Route (added in `src/App.tsx` next to L151, all `RequirePage page="tms"`) | Element | Notes |
|---|---|---|
| `/tms/dashboard` (existing) | `DashboardHome` (new, replaces `TmsDashboardPage` as the route element) | tab strip + the existing page |
| `/tms/dashboard/d/:id` | `DashboardViewPage` | run + render; Edit (owner/ADMIN with `create`), Duplicate, Archive |
| `/tms/dashboard/new` and `/tms/dashboard/d/:id/edit` | `DashboardBuilderPage` | chat panel + live preview; redirects to `/tms/dashboard` without `create` |

`DashboardHome` (AI4) renders **above** the untouched `DashboardPage`: a `TmsTabs` row — **Overview** · **Company dashboards (n)** · **My dashboards (n)** — and, right-aligned, the **New dashboard** `TmsButton` (`data-testid="dash-new"`) shown only when `useDashboardAccess().create`. `DashboardPage.tsx` is not edited (AF3 owns it; AD1 is reworking page headers — `DashboardHome` sits outside `TmsPage`, so a header refactor does not collide; tab state is `?tab=overview|company|mine`). Company/My panes are card grids (`DashboardCards`: title, scope badge `TmsBadge`, owner, "n widgets", updated, widget-type glyphs); a card links to `/tms/dashboard/d/:id`. Empty states say what to do ("No company dashboards yet." + the button when allowed).

### 8.2 Overview and the hard rule
* `viewAll` viewers: Overview = today's `DashboardPage` (rollup fast path, 26 cards) — unchanged.
* **Non-viewAll viewers: `DashboardPage` is not mounted** (its hooks would read every shipment, invoice and sample from AppSync). `ScopedOverview` runs `PREVIEW_DASHBOARD({ builtin:'OVERVIEW' })` (`src/lib/dashboards/builtin.ts` `OVERVIEW_SPEC`: this-month revenue/profit/margin/shipments KPIs, shipments by status, revenue by customer, open AR + aging, recent shipments, open quotes) and shows the banner **"Showing only the customers you own or your team covers."** (from `result.visibility`). Same banner on every dashboard opened by a non-viewAll user.
* Filters chips on custom dashboards are read-only summaries of `spec.filters`; a viewer can change the **window preset** locally (not saved) because it is a parameter, not a definition.

### 8.3 Builder (AI3)
Two-pane `TmsDetailSplit`-style layout: **left** chat (`ChatPanel`: transcript, `TmsTextarea` composer with Enter-to-send, spinner "Thinking…", error line with **Retry** for `Model unavailable`/timeouts, scope picker rendered inline under the SCOPE question, CLARIFY choices as buttons); **right** live preview (`WidgetGrid` running `PREVIEW_DASHBOARD`, "Draft — not saved" badge, title field, **Save** primary). `useDashboardChat` owns transcript + `scope` + `draft`; `scope` is only ever set by `ScopePicker`; sending is disabled while a turn is pending (no double-submit). `ScopePicker`: 4 radios (Whole company — disabled with tooltip when `!publishCompany`; Specific users — multi-select of ACTIVE staff from `GET_DASHBOARD_OPTIONS`; Specific teams — multi-select of active teams; Just me). `SaveDashboardDialog`: title, scope recap (re-editable), "Visible to" summary, **Save**/**Save as new** (edit mode), CAS conflict message.

### 8.4 Viewer (AI4)
`WidgetGrid` = CSS grid of 12 columns from `autoLayout`; `WidgetView` maps `{type, series}` → `TmsKpiCard` row (KPI), `ChartCard` (BAR/LINE/PIE via a `ChartDef` shim whose `compute` returns the server series), `SeriesTable` (TABLE/LIST). Per-widget `ok:false` renders an inline error card with Retry for that widget only. Loading = skeleton cards. Everything respects dark theme tokens; no new colours.

### 8.5 Settings > Users
No code beyond AI1's claim constants (F8): the three permissions appear in the per-user "Permissions" grid with the green "Enforced" tag; AI6 adds one sentence ("Takes effect the next time the person signs in") if the page lacks it (it does not today: grep found none).

---------------------------------------------------------------------------------------------------

## 9. Tests (behavioural; each defends an observable contract)

| ID | File | What fails if the contract breaks |
|---|---|---|
| **T1** | `src/lib/dataVisibility.test.ts` | the matrix of §2.1: rep via `Shipment.salesRepId`; rep via `accountOwnerIds[1]` (not just primary); rep via `defaultSalesRepId`; **rep with no link sees nothing**; team member sees every row of a customer whose `teamKey` matches (case-insensitive), non-member does not, **inactive team grants nothing, removed member loses access**; viewAll via owner e-mail / `ADMIN` / `role-AR_AP` / `claim-VIEW_ALL`; **`role-MANAGER` alone is not viewAll**; customer with no owner and no team invisible (differs from `canSeeAccount`, asserted side by side); unresolved-customer shipment visible only via direct rep; id vs e-mail, case, whitespace; `carrierRepId` grants nothing. |
| **T2** | `src/lib/dashboards/execute.catalog.test.ts` | **catalog-wide invariant, parametrised over `QUERY_CATALOG`**: fixture = visible rows (rep A's customer + a team customer) + hidden rows carrying a unique sentinel (customer name, amount `777777777`, rep id). For every query and every allowed widget type: rep A's serialised result contains no sentinel and its totals equal the visible-only totals; viewAll contains both; a viewer who owns nothing gets zeros/empty states (`null` per the AF null-vs-zero rule), never an error. A new query that reads around `VisibleReader` cannot pass. |
| **T3** | `src/lib/dashboards/spec.test.ts` (+ `windows.test.ts`) | unknown query id / extra key / param outside the catalog enum / widget type not allowed for the query / > 12 widgets / window over `maxMonths` / CUSTOM span > 400 d / empty USERS list / spec > 32,000 B / bad scope all rejected with readable issues; the §5.1 example parses; `buildSpecFromModel` maps sentinels and drops unknown query ids; `THIS_QUARTER` on 2026-11-04 is 2026-10-01…2026-12-31; `autoLayout` is deterministic. |
| **T4** | `amplify/functions/tms-dashboard-actions/actions.test.ts` (scripted `ModelPort`, in-memory stores) | **no claim ⇒ `Forbidden`** on `PREVIEW_DASHBOARD_CHAT`/`SAVE_DASHBOARD`/unsaved-spec `PREVIEW_DASHBOARD`; no `page-tms` ⇒ `Forbidden` on all; COMPANY save without `publishCompany` refused, with it accepted; **same saved COMPANY dashboard run by viewer A and viewer B returns different totals (their own visibility), and viewAll sees the union**; sharing to a user/team changes `LIST_DASHBOARDS` only; non-owner `SAVE`/`ARCHIVE` refused, ADMIN allowed; CAS conflict; **R1/R2: `scope:null` ⇒ SCOPE question present and `spec:null` even when the scripted model returns a full spec; once `scope` set ⇒ spec returned**; R5 ambiguous division ⇒ CLARIFY; "customer you can't see" and "customer that doesn't exist" produce byte-identical issues; model failure/timeout ⇒ result with `modelError`, `spec:null`, SCOPE question still present when `scope:null`, no Dashboard write, no AuditLog text; repair-once then refuse; transcript over limits rejected; audit rows contain no message or spec text; the fake db throws on `Scan` of Shipment/Invoice/Quote/LaneRateSample. |
| **T5** | `src/features/tms/dashboard/DashboardHome.test.tsx`, `custom/ChatPanel.test.tsx`, `custom/DashboardBuilderPage.test.tsx`, `custom/DashboardViewPage.test.tsx` | **no `create` ⇒ no New dashboard button and `/tms/dashboard/new` redirects**; with it the button opens the builder; Company chip disabled without `publishCompany`; **non-viewAll never mounts `DashboardPage` (the `useBrokerageDashboard` mock is not called) and shows `ScopedOverview` + banner**; chat flow with a mocked `dashboardChat`: question + scope picker → spec appears only after a chip click → preview runs → "make it monthly" re-runs; send disabled while pending; `Model unavailable` shows Retry and keeps the transcript; save → card appears; a widget `ok:false` does not blank the grid. |
| **T6** | `src/lib/roles.test.ts` (edit), `src/lib/apiClient.*.test.ts` (existing read-classification table, add rows) | `groupsForProfile` emits `claim-DASHBOARDS_CREATE` etc.; `isEnforcedClaim` true for the three; **read-verb names do not clear the list cache, `SAVE_DASHBOARD`/`ARCHIVE_DASHBOARD` do** (F7). |
| **T7** | `amplify/functions/userManagement/handler.test.ts` (one case) | `setClaims` with the three new claims mints the groups (existing pool fake). |

Existing tests that must change because the contract changed: `src/lib/roles.test.ts` if it pins the full `CLAIMS` list; `UsersPage.test.tsx` only if it counts claim cards; `src/App` route tests if any enumerate `/tms/dashboard` children (AI4 greps). No test is re-pinned to wording.

---------------------------------------------------------------------------------------------------

## 10. Verification harness — `scripts/devVerifyAI.mjs` (AI5)

Pattern of `devVerifyAJ.mjs` / `devVerifyAB.mjs`: flags `--inventory` (offline, no network: files exist, claim constants present, every action name classifies as read/write exactly as §0.1-F7, `QUERY_CATALOG` ids == the ids in the model schema enum == the ids in the prompt text, example specs parse), `--only=<AIxx>`, `--no-dark`, `--skip-model`; guards: `DEV_APPSYNC` regex, prod-suffix refusal (`5ucwdyvwivelbo4k4jomvrwel4`), `ALLOWED_ORIGINS` = dev origin only; **≤ 12 model calls per run** (the dev Anthropic key is real and billed); fixtures named `ZZ AI …`; passwords never printed; screenshots to `Docs/tms-build/screenshots/ai/`; every created identity deleted in `finally` with `identity deleted: true`; dev-table writes only through the guarded owned-id SDK writers of the AJ harness (`sdkPut` refuses ids this run did not create; Shipments are voided with reason "AI harness", never deleted — delete is disabled on that model). **No SSM writes. No claim/permission is changed on any real user.**

Identities (`mintIdentity(email, groups)`): `zz-ai-admin` (`ADMIN`,`page-tms`), `zz-ai-pub` (`page-tms`,`claim-DASHBOARDS_CREATE`,`claim-DASHBOARDS_PUBLISH_COMPANY`), `zz-ai-repa`, `zz-ai-repb` (`page-tms`,`claim-DASHBOARDS_CREATE`), `zz-ai-plain` (`page-tms`), `zz-ai-nopage` (no page group), `zz-ai-acct` (`page-tms`,`role-AR_AP`).

Fixtures: customers C1 (`accountOwnerIds:[repa]`), C2 (`teamKey:'ZZAI'`), C3 (owned by `someone-else@example.invalid`), C4 (no owner, no team); one shipment + sample + open invoice per customer with **distinct amounts** (1,000 / 2,000 / 4,000 / 8,000 ×100 cents, so any subset sum identifies exactly which customers contributed) plus one C3 shipment with `salesRepId = repb` (direct-rep path). `TmsSettings.teams` gets a temporary `ZZAI` team containing `repb` through `SAVE_SETTINGS` (read-modify-write with `expectedUpdatedAt`, the original `teams` JSON snapshotted and restored in `finally`, restoration asserted equal) — the only shared-config write, dev only.

| Step | Proves | Needs model? |
|---|---|---|
| **AI01** inventory | files, constants, catalog/prompt/schema parity, read-vs-write classification | no |
| **AI02** refusals | `plain` and `nopage` get `Forbidden` on chat/save/unsaved-run; `repa` (create, no publish) refused `scope COMPANY`; `pub` accepted | no |
| **AI03** scope gate | chat with `scope:null` returns the SCOPE question and `spec:null`; with the model unavailable the same holds with `modelError` set (R1/R2 do not depend on the provider) | no (works with or without credit) |
| **AI04** hard rule, live | `admin` saves a COMPANY dashboard (revenue/AR/shipments/quotes widgets). `repa` sees exactly C1; `repb` sees exactly C2 + the C3 direct-rep shipment; `plain` sees nothing (zeros, no error); `acct` and `admin` (viewAll) see all four; **sums match the fixture arithmetic and no hidden amount appears anywhere in the serialised result**; a `repa` hand-typed filter `customerIds:[C3]` returns empty | no |
| **AI05** revocation | remove `repb` from `ZZAI` → next run drops C2 immediately (no cache serves it); restore | no |
| **AI06** audience vs data | share an ME-scope dashboard with `repb` (USERS) and with team `ZZAI`: `LIST_DASHBOARDS` shows it, the run shows `repb`'s data not `repa`'s; non-owner `SAVE`/`ARCHIVE` refused | no |
| **AI07** live chat | scripted transcript of §7.4 against the real model: first turn has the SCOPE question and no spec; after scope the spec validates and every `queryId` ∈ catalog; "make the chart monthly" changes `grain`/`groupBy` of the chart widget only; "add margin" adds the metric; save works. On a provider error (`credit balance`, 401, 429, abort) the step is **SKIP: MODEL_UNAVAILABLE** with the provider's message — never faked | yes |
| **AI08** timing | `PREVIEW_DASHBOARD` reference spec p50/p95 over 5 warm runs (budget p95 ≤ 4 s; cold run recorded separately), chat turn p50/p95 (budget < 22 s); numbers go into `BUILD_LOG.md` | partly |
| **AI09** browser | screenshots below, console/network problem check with the AJ allow-list; asserts `[data-testid=dash-new]` exists for `repa`, absent for `plain`; non-viewAll banner text present for `repa`; `DashboardPage` KPI strip (`.tms-dash-kpis`) absent for `repa` (classic page not mounted) | no (uses API-saved specs when AI07 skipped) |
| **AI10** cleanup | Dashboard rows archived/removed, ZZ rows voided/removed, `TmsSettings.teams` restored byte-equal, six identities deleted | no |

Screenshots (`Docs/tms-build/screenshots/ai/`, 1440×900, light + dark for the three marked †; customer/staff names are `ZZ`, so no blur needed, but any real name that appears is blurred as in AC): `AI01-dashboard-tabs` (Overview / Company dashboards / My dashboards + New dashboard)†, `AI02-no-permission-no-button` (`plain`), `AI03-chat-first-turn` (user prompt, clarifying questions, SCOPE question with the four options)†, `AI04-scope-company-disabled` (`repa`: Whole company greyed with tooltip), `AI05-scope-picked-generating`, `AI06-generated-dashboard` (chat + live preview, KPI/bar/table)†, `AI07-iterate-monthly` (after "make the chart monthly", changed widget ringed), `AI08-save-dialog`, `AI09-my-dashboards-cards`, `AI10-company-dashboard-as-repa` and `AI11-company-dashboard-as-acct` (same dashboard, different numbers, banner on the first), `AI12-overview-non-viewall` (ScopedOverview), `AI13-settings-users-permissions` (the three new checkboxes with "Enforced"), `AI14-model-unavailable` (only if the provider refused: Retry state). When AI07 is skipped, AI06/AI07 are produced from an API-saved spec and the BUILD_LOG entry says so.

---------------------------------------------------------------------------------------------------

## 11. Slices, ownership, landing order

Six builders (`task` agents, one `tasks[]` batch per wave). **A file appears in exactly one slice**; cross-slice needs go through `hub` to the owner, never an edit. Builders run **no** formatter/linter/typecheck/project-wide test run (Main runs them once); they may run their own single test file. Contracts between slices are the exported names below — fixed here so nobody negotiates.

### 11.0 Shared contract (AI1 exports; everyone imports)

`src/lib/dashboards/types.ts`: `DashboardScope`, `DashboardSpec`, `Widget`, `WidgetType`, `WidgetSize`, `QueryId`, `DashboardRecord`, `DashboardSummary`, `WidgetResult`, `DashChatInput`, `DashChatResult`, `DashQuestion`, `DashOptions`, `DashRunResult`, `DashboardAccess`.
`src/lib/dashboards/spec.ts`: `SPEC_LIMITS`, `parseSpec`, `MODEL_OUT_SCHEMA`, `buildSpecFromModel`, `autoLayout`.
`src/lib/dashboards/catalog.ts`: `QUERY_CATALOG`, `queryMeta(id)`.
`src/lib/dashboards/windows.ts`: `resolveWindow(window, nowIso) → { from, to, months[] }`.
`src/lib/dashboards/access.ts`: `dashboardAccess({ email, groups }) → { create, publishCompany, viewAll }`.
`src/lib/dashboards/execute.ts`: `VisibleReader`, `runWidget`, `runSpec(spec, reader, ctx) → WidgetResult[]`.
`src/lib/dashboards/builtin.ts`: `OVERVIEW_SPEC`.
`src/lib/dataVisibility.ts`: `DataViewer`, `dataViewer`, `hasViewAll`, `canSeeCustomer`, `canSeeRow`.
`src/lib/apiClient.ts` (AI4): `dashboardChat(input)`, `dashboardPreview({ spec } | { id } | { builtin })`, `listDashboards()`, `getDashboard(id)`, `dashboardOptions()`, `saveDashboard(input)`, `archiveDashboard(id, expectedVersion)` — over `mutation TmsDashboardActions($action: String!, $input: AWSJSON!) { tmsDashboardActions(action: $action, input: $input) }`, errors via `graphqlErrorText`, results via `unwrapJson` (the `callCrm` shape, L8546).

### 11.1 AI1 — contract, visibility, claims (lands first; small and reviewed before the wave)

| File | Change |
|---|---|
| N `src/lib/dashboards/{types,windows,catalog,spec,access,execute,builtin}.ts` | as §5, §2.1, §3; relative imports only (Lambda-bundled); reuse `marginBpsOf` from `../dashboardRollup`; no `@/` aliases |
| N `src/lib/dataVisibility.ts` | §2.1; imports `viewerFromGroups`, `OWNER_EMAIL` from `./crm/visibility`, `ownerIdsOf` from `./crm/owner`, `CrmViewer` from `./crm/types` |
| E `src/lib/roles.ts` | `CLAIMS` + `CLAIM_LABELS` + `ENFORCED_CLAIMS` gain the three keys (L78-117); nothing else |
| E `src/types/tms.ts` | `ClaimKey` union (L3590) gains `'DASHBOARDS_CREATE' \| 'DASHBOARDS_PUBLISH_COMPANY' \| 'VIEW_ALL'` — single anchored edit, re-read first |
| N tests | T1, T2, T3 (+ windows), T6 `roles.test.ts` edit |

### 11.2 AI2 — backend (after AI1)

| File | Change |
|---|---|
| N `amplify/functions/tms-dashboard-actions/*` | §6.1; `actions.test.ts` = T4; `sources.test.ts` (index names, `Scan` forbidden on big tables, projection lists, month query shapes) |
| N `amplify/functions/_shared/ddbReads.ts` | extracted helpers; E `amplify/functions/tms-dashboard-rollup/store.ts` imports them (behaviour identical; `store.test.ts` is the proof) |
| E `amplify/data/resource.ts` | three anchored insertions, append-only, re-read first: import near L26; `Dashboard` model after `DashboardRollup` (L3079-3095); `tmsDashboardActions` mutation after `tmsCrmActions` (~L4780). No other model touched. |
| E `amplify/backend.ts` | import near L70, `defineBackend` entry near L169-170, wiring block after the rollup block (L3934) as §6.5. No dev-guard change (no schedule). |
| — | `amplify/functions/bundle.test.ts` picks the handler up automatically (esbuild bundle check: this is why `src/lib/dashboards/*` must stay relative-import-only) |

### 11.3 AI4 — viewer UI + client API (parallel with AI2; its `apiClient` block lands first)

| File | Change |
|---|---|
| E `src/lib/apiClient.ts` | one append-only block `// ── Step AI: conversational dashboards ──` with the seven wrappers (§11.0); **no edits to existing functions**. Add the new action names to the existing read-classification table test (F7). |
| N `src/features/tms/dashboard/DashboardHome.tsx` | tab strip + New dashboard + hosts `DashboardPage` (viewAll) or `ScopedOverview` (non-viewAll) |
| N `src/features/tms/dashboard/custom/{DashboardCards,DashboardViewPage,WidgetGrid,WidgetView,ScopedOverview,useDashboardAccess,useDashboardRun}.tsx|ts`, `custom.css` | §8; CSS uses `--tms-*` tokens only (no hard-coded colours) |
| E `src/App.tsx` | route element at L151 becomes `DashboardHome`; add `dashboard/d/:id` and the two builder routes (AI3's component, imported by name); single anchored hunk |
| N tests | T5 parts for Home/View/Overview/Cards |

### 11.4 AI3 — builder UI (after AI4's apiClient block)

| File | Change |
|---|---|
| N `src/features/tms/dashboard/custom/{DashboardBuilderPage,ChatPanel,ScopePicker,SaveDashboardDialog}.tsx`, `useDashboardChat.ts` | §8.3; reuse `WidgetGrid` from AI4 by its exported props `{ spec, results, loading, onRetry(widgetId) }`; reuse kit `TmsTextarea`, `TmsButton`, `TmsDialog`, `TmsField`, `TmsBadge` |
| N tests | T5 builder/chat parts |

### 11.5 AI5 — harness (after AI1; runs after Main's deploy)

`scripts/devVerifyAI.mjs`, `scripts/lib/aiProbe.mjs` (+ `aiProbe.test.ts`: fixture arithmetic/sentinel scanner and the percentile helper — the only harness logic worth a unit test), screenshots dir. §10.

### 11.6 AI6 — permissions surface, docs, exposure audit (any time after AI1)

| File | Change |
|---|---|
| N `scripts/auditDataExposureAI.mjs` | read-only, dev only, temp `zz-ai-audit-<ts>` identity with `page-tms` only: for each of Shipment, Order, Invoice, Quote, LaneRateSample, Customer, DashboardRollup, Load, CarrierBill attempts `list…(limit: 1)` and prints `readable: yes/no` + `count only` — the evidence for D1; plus a **visibility coverage report** (counts, no names): % of last-90-day shipments with `salesRepId` null, % of customers with no owner and no team, % of those rows a typical rep can see; identity deleted in `finally` |
| N `Docs/academy/dashboards.md` | how to build one, the scope question, permissions, "you only see your customers" |
| E `amplify/functions/userManagement/handler.test.ts` | T7 |
| E `src/features/users/UsersPage.tsx` (one hint line) and `UsersPage.test.tsx` only if it pins the claim list | "Takes effect the next time the person signs in." |

### 11.7 Landing order and what Main does

`AI1` → { `AI2` ∥ `AI4` (apiClient block first, then the rest) ∥ `AI5` ∥ `AI6` } → `AI3` (needs AI4's `WidgetGrid` + wrappers) → Main: `tsc -p tsconfig.app.json`, `amplify/tsconfig.json`, eslint on touched dirs, full vitest, **`node scripts/measureDataTemplate.mjs --branch dev` (stop-line 990,000 B, §4.3)**, one commit/push on `dev`, wait for the Amplify dev job, then `node scripts/devVerifyAI.mjs` and `node scripts/auditDataExposureAI.mjs`, then the BUILD_LOG entry (timing numbers, D1 evidence, template size).

**Files other agents touch (collision list).** `amplify/data/resource.ts` and `amplify/backend.ts` (AD carriers/MCP and AE quotes/spot may add models/blocks: AI2 re-reads immediately before each of its three insertions and never reorders); `src/lib/apiClient.ts` (append-only block, other steps append too); `src/types/tms.ts` (one union, tiny hunk); `src/App.tsx` (AD1 is working navigation/crumbs: keep our hunk to the route lines); `src/features/tms/dashboard/` is otherwise AF-owned and quiet — `DashboardPage.tsx` is **not edited**; `src/lib/roles.ts` (AI1 only).

---------------------------------------------------------------------------------------------------

## 12. Decisions (defaults are what the builders implement; each flips in one place)

| ID | Question | Default | Flip |
|---|---|---|---|
| **D1** | How far does "enforced server-side" reach? | Everything the dashboard feature serves (custom dashboards, built-in Overview for non-viewAll) is filtered in the Lambda; the classic client-computed page is not mounted for non-viewAll; **model-level read auth on Shipment/Order/Invoice/Quote/LaneRateSample/Customer/DashboardRollup is unchanged** (F4) | A separate costed step: replace `allow.authenticated().to(['read'])` on those models with `allow.groups(['ADMIN'])` + route every list through Lambdas — touches most pages and the rollup client. `auditDataExposureAI.mjs` gives the evidence. **Needs Ryne.** |
| **D2** | Who is `viewAll`? | owner, `ADMIN`, role `AR_AP`, claim `VIEW_ALL`. **MANAGER is not** (his teams' customers still show via team membership) | `VIEW_ALL_ROLES = ['AR_AP']` in `dataVisibility.ts` (add `'MANAGER'`). **Needs Ryne.** |
| **D3** | Customer with no owner and no team | invisible to non-viewAll (stricter than CRM `canSeeAccount`) | one branch in `canSeeCustomer`. CRM is left as is; adopting this rule there is a separate call. |
| **D4** | Does a carrier rep covering a shipment see it? | No (`carrierRepId`/`carrierTeamKey` ignored; rule is sales rep or the customer's team) | add the fields to `RowRef` + `canSeeRow` |
| **D5** | Team source | `TmsSettings.teams` (active teams, `memberIds`), read per request | `UserProfile.teamKeys` mirror (rejected: can lag) |
| **D6** | Permission names | `DASHBOARDS_CREATE`, `DASHBOARDS_PUBLISH_COMPANY`, `VIEW_ALL` (displayed as `dashboards.create`, `dashboards.publishCompany`, `viewAll` in docs) — the claim regex forbids dots; implied for owner/ADMIN (all) and role AR_AP (`viewAll`) | `ROLE_IMPLIED_CLAIMS` constant in `access.ts` (e.g. give MANAGER `DASHBOARDS_CREATE`) |
| **D7** | Storage | one new minimal model `Dashboard` (all ops disabled, no GSI) | Fallback A/B in §4.3 if `measureDataTemplate` > 990,000 B |
| **D8** | Model | `claude-sonnet-5`, `effort: low`, 22 s abort, ≤ 12 widgets, ≤ 20 messages | constants in `model.ts` |
| **D9** | Time | UTC calendar days/months/quarters like the rollup; no fiscal year | `windows.ts` |
| **D10** | Catalog scope v1 | shipments, revenue/profit/margin, open AR, quotes. No AP/carrier cost, no loads/tracking | add queries to `QUERY_CATALOG` (executor + test row are the only places); AP only behind `viewAll` |
| **D11** | Layout | order + size S/M/L/F; no drag-drop; edit by chat | later |
| **D12** | Lambda placement | new `tms-dashboard-actions` | relocate into `tms-crm-actions` (Fallback A) |
| **D13** | Anthropic credit on dev | needed for live chat only; everything else works without | Ryne tops up / names the key (BUILD_LOG decision (b)) |
| **D14** | Delete | archive only (`archivedAt`), like every other directory object | — |
| **D15** | Who may run an unsaved spec | creators only (`PREVIEW_DASHBOARD` with `spec`) | relax to the door check |
| **D16** | Shared dashboards | view-only for non-owners + "Duplicate to my dashboards" | edit grants are a later model change |
| **D17** | `scope` meaning | audience only (who can open); data is always the viewer's own visibility | — (this is the rule) |

---------------------------------------------------------------------------------------------------

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Direct GraphQL still reads every row** (F4/D1). Anyone with a token can query `listShipments`. | Stated, measured by `auditDataExposureAI.mjs`, decision D1; the feature itself never loads forbidden rows into a non-viewAll browser |
| R2 | **Coverage:** imported Aljex shipments have `salesRepId` null until the code map is applied, and many customers may have no owner/team. Reps then see far less than they expect; viewAll sees everything. | Coverage report in AI6 (counts only) before Ryne shows it to reps; fix is data (Customers > Team/Owner, AljexCodeMap), not code |
| R3 | Data-stack template size (F9). | Stop-line 990,000 B, Fallbacks A/B, `Dashboard` has no GSI and no operations |
| R4 | Model latency / credit / 30 s AppSync cap (F6, F10). | Two mutations, 22 s abort, one repair at most, typed `modelError` result, harness records numbers and **SKIPs honestly** |
| R5 | Prompt injection / hostile spec text. | No tools; output reduced to a whitelisted, strict-zod spec before anything runs; executors choose code by catalog id; titles are rendered as text |
| R6 | Chat cost abuse. | claim-gated (`create`), message/size caps, harness ≤ 12 calls; a per-user rate limit is not built (no store) — add if spend appears |
| R7 | Stale claim in the token after a grant/revoke. | Same as every claim (next sign-in); revocation of **data** access (team/owner) is immediate because it is read per request |
| R8 | Shipment month pages are the heaviest read (2,509 items scanned for ~300 rows). Prod data is larger. | `maxMonths` 4, memoised per request, 30 s page memo; if p95 breaches, add the `salesRepId` GSI later (not now: one new GSI per table per update, template bytes) |
| R9 | Hand-typed `accountOwnerIds` (`accountOwnersText` lines) that do not match a username silently hide a customer from its owner. | id **and** e-mail, case-insensitive compare; coverage report lists the count of owner ids matching no `UserProfile` |
| R10 | Specs can embed customer names in titles; a COMPANY dashboard shows the title to everyone. | Titles are author text, accepted (D17: a dashboard is a definition, not data); filter chips print "N customers" unless the viewer can see them |
| R11 | Stale 30 s customer memo lets a just-removed owner see rows for ≤ 30 s. | Documented; memo holds raw customer rows only; TTL constant; the harness AI05 uses the team path (read per request) for the immediacy proof |
| R12 | Concurrent edits to `resource.ts`, `backend.ts`, `apiClient.ts`, `App.tsx`, `tms.ts`. | §11.7 collision list, anchored append-only hunks, re-read before editing, Main integrates |
| R13 | Two time bases (UTC windows vs a rep thinking in Chicago time). | Same as AF; labelled in the filter summary ("UTC days") |

---------------------------------------------------------------------------------------------------

## 14. Acceptance (what "done" means)

1. Settings > Users shows **Create dashboards**, **Publish company dashboards**, **See all customers' data** with the "Enforced" tag; ticking one mints the `claim-*` group; owner/ADMIN hold them implicitly.
2. A user without `DASHBOARDS_CREATE` sees **no New dashboard button**, `/tms/dashboard/new` bounces, and `PREVIEW_DASHBOARD_CHAT` / `SAVE_DASHBOARD` return `Forbidden:`; COMPANY save needs `DASHBOARDS_PUBLISH_COMPANY`.
3. **New dashboard** opens the chat builder; the assistant **always** asks "Is this dashboard for the whole company, or for specific users/teams?" with the four options and never produces a spec before the choice; then returns a spec that renders live; "make the chart monthly" and "add margin" revise it; **Save** creates a `Dashboard` row (owner, scope, spec, sharedWith) that appears under **Company dashboards** (COMPANY) or **My dashboards** (own + shared).
4. Every spec is parsed by the strict schema on both client and server; unknown queries/params are refused; no code path accepts SQL, a table name or an expression.
5. **Visibility:** a rep sees only rows where they are the sales rep or own the customer or are on its team; viewAll sees all; the same COMPANY dashboard opened by two people shows two different sets of numbers; revoking a team membership takes effect on the next run. Proven by T1/T2/T4 and live by AI04-AI06.
6. Non-viewAll users never mount the classic client-computed dashboard; their Overview comes from the Lambda with the "Showing only…" banner.
7. Template stays under the stop-line; `devVerifyAI` passes all steps except documented model SKIPs; screenshots exist for the flow; all six identities deleted; `TmsSettings.teams` restored.
8. `BUILD_LOG.md` records: template bytes, timing p50/p95, the D1 evidence table, and the coverage percentages.

## 15. Production migration note and merge-to-main checklist

* Ships to prod when `dev` merges: one new empty table (`Dashboard`), one Lambda, one mutation, three claim constants. **Additive, no backfill.** Behaviour for existing users is unchanged until an admin ticks a claim; the classic dashboard still renders for owner/ADMIN/AR_AP; **other roles (customer reps, managers, carrier reps, compliance) will see the scoped Overview instead of the classic page the day this merges** — tell Ryne before merging (D2).
* Add to `BUILD_LOG.md` § MERGE-TO-MAIN CHECKLIST: re-run `scripts/measureDataTemplate.mjs`; confirm `ANTHROPIC_API_KEY` secret exists for `main` (same one `tms-directory-actions` uses); confirm production `Customer.accountOwnerIds`/`teamKey` coverage with the audit script **before** reps use dashboards; decide D1/D2.
