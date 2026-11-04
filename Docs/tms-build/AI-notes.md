# Step AI — Conversational dashboards: runbook

Dev branch only; nothing here is deployed by a builder. Plan: `AI-plan.md`. Harness: `scripts/devVerifyAI.mjs` (runs only after the AI deploy). Exposure evidence: `AI-exposure-audit.md` (`scripts/auditDataExposure.mjs`).

> ## D1 — read this first: the visibility rule is a VIEW rule, not an access boundary
>
> Everything the dashboards feature serves is filtered per viewer inside the Lambda. **It cannot stop a hand-written GraphQL query.** Every business model carries `allow.authenticated().to(['read'])`, so any signed-in user — including one with no role and no group — can call `listShipments`, `listInvoices`, `listCustomers`, `listLaneRateSamples`, `listQuotes`, `listCarrierBills`… and get every row. The dev audit found **95 of 109 models readable** that way (Shipment 10,903 rows, Invoice 7,526, Customer 744, DashboardRollup 91 …). The dashboard UI says so on the builder ("This is not a security boundary for the underlying records").
>
> Closing that hole means replacing the model-level read rules with group rules and routing every list through a Lambda: it touches most pages and is a separate, costed step (decision **D1**, needs Ryne). Until then do not describe "reps only see their customers" as security; it is what the dashboards show. Re-run `node scripts/auditDataExposure.mjs --write` after any schema auth change.

## 1. Permissions (Settings > Users > Additional permissions)

| Claim (Cognito group) | Label in Settings > Users | Gives |
|---|---|---|
| `DASHBOARDS_CREATE` (`claim-DASHBOARDS_CREATE`) | Create dashboards | New dashboard button, the builder, chat, save/edit own, running an unsaved spec |
| `DASHBOARDS_PUBLISH_COMPANY` (`claim-DASHBOARDS_PUBLISH_COMPANY`) | Publish company dashboards | the "Whole company" scope, saving/archiving COMPANY dashboards |
| `VIEW_ALL` (`claim-VIEW_ALL`) | See all customers' data | the visibility predicate becomes `true` (see §2) |

* All three are **enforced** (tagged so in Settings > Users): the server refuses with `Forbidden:` text; the UI mirrors it (no button, `/tms/dashboard/new` redirects to `/tms/dashboard`, the Whole-company chip is disabled with a tooltip).
* **Implied grants** (`src/lib/dashboards/access.ts`): the owner e-mail and the `ADMIN` group hold all three; role `AR_AP` holds `viewAll`; **MANAGER holds none** (a manager still sees his team's customers through team membership). Everyone else needs the explicit claim.
* Opening a saved dashboard needs only the door check (`owner || ADMIN || page-tms`) plus audience (§3). A user without `DASHBOARDS_CREATE` keeps read access to dashboards shared with them.
* A grant reaches the token at the person's **next sign-in or token refresh**, like every claim. Revoking a team or ownership takes effect on the next run (§2); revoking a claim does not until the token refreshes.

## 2. The visibility rule (what a dashboard shows)

`src/lib/dataVisibility.ts`, applied in one `VisibleReader` per request (`src/lib/dashboards/visibleReader.ts`); the executors never see the raw reader.

A viewer who is not `viewAll` sees a row only if **(a)** the row's `salesRepId` / `customerRepId` names the viewer (id or e-mail, case-insensitive), **or (b)** the row's customer is owned by the viewer (`accountOwnerIds ∪ defaultSalesRepId`), **or (c)** the customer's `teamKey` is a team the viewer belongs to (`TmsSettings.teams`, active teams only, read per request).

* A customer with **no owner and no team is invisible** to every non-viewAll user (stricter than the CRM). A row with no resolvable customer is visible only through (a). `carrierRepId` grants nothing.
* **`scope` decides who may OPEN a dashboard, never which data it shows.** The same COMPANY dashboard opened by two people returns two different sets of numbers; a viewAll viewer sees the union.
* Non-viewAll viewers never mount the classic client-computed Company Dashboard (its hooks read every row); their Overview is the built-in `OVERVIEW_SPEC` run through the same reader, with the banner "Showing only the customers you own or your team covers."
* Customer names typed in chat resolve only among the viewer's visible customers; "not found" and "not visible" give the identical answer, so a rep cannot probe which customers exist.
* Cache note: the Lambda memoises raw Customer rows and month pages for **30 s** (never anything viewer-filtered). A just-reassigned owner can still see rows for up to 30 s; team membership is not memoised.
* Coverage is data, not code: on dev 94.4 % of customers have no owner/team and 34.2 % of last-90-day shipments have no `salesRepId`, so a rep sees little until Customers > Owner/Team are filled in (`AI-exposure-audit.md`, coverage table).

## 3. Scope and audience

| Scope | Who may open it | Saved with |
|---|---|---|
| `ME` | the owner (and ADMIN) | — |
| `COMPANY` | everyone with the door | needs `publishCompany` |
| `USERS` | the owner, the listed active users, ADMIN | up to 25 user ids (must be ACTIVE staff) |
| `TEAM` | the owner, members of the listed teams, ADMIN | up to 10 active team keys |

Non-owners get read-only plus "Duplicate to my dashboards". Archive only (no delete); an archived dashboard leaves lists and answers `Dashboard not found`, the same text as a missing id or one outside the audience. Edit uses `expectedVersion`; a stale one is `Conflict: dashboard changed; reload`.

## 4. How a widget binds to a whitelisted query

A spec (`v: 1`) is plain JSON: title, scope, `filters` (window preset or CUSTOM ≤ 400 days, divisions, customer ids, rep ids, modes) and 1-12 widgets `{ id, type, title, size, query: { id, params } }`. **There is no SQL, table name or expression anywhere.** `query.id` must be one of the 16 ids of `QUERY_CATALOG` (`src/lib/dashboards/catalog.ts`) — `fin.summary|byGroup|byTime`, `ship.summary|byStatus|byTime|byGroup|recent`, `ar.summary|aging|byCustomer|list`, `quote.summary|byStatus|byCustomer|recent` — and the params are checked against that entry's own parameter spec (an unknown key, a value outside an enum, a limit over 25 is a hard refusal). `type` must be one of the entry's allowed widget types. The executor picks code by catalog id (`src/lib/dashboards/execute.ts`) and returns the `ChartSeries`-compatible result the existing renderers draw. The model has no tools and never sees a row: it receives the transcript, the catalog text and today's date, and its `queryId` field is an enum of the catalog ids; anything else is dropped before validation.

Definitions so a number is never a surprise: UTC calendar days/months/quarters; revenue/profit/cost come from priced lane-rate samples (`excluded !== true`) by delivery day; shipments by pickup day, voided excluded; AR is the open invoice set (no window), bucketed by days past due; quotes are SELL quotes by quote date and are not split by division (the widget note says so); margin is recomputed from summed profit and revenue, never averaged.

## 5. Where it is stored — `DASH:` rows in `DashboardRollup`

No new model, table or Lambda. The actions run in `tmsCrmActions` (`amplify/functions/tms-crm-actions/dashboardActions.ts`); `dashStore.ts` keeps one row per dashboard `DASH:<uuid>` and one `DASH:INDEX` row (the active-dashboard summaries) in the existing `DashboardRollup` table, `kind: 'DASH'`, spec JSON in `payload`. A save is one `TransactWriteItems` (row CAS on `version` + index CAS). The rollup sweep (`isDashboardRowId`) and the client rollup reader both skip `DASH:` ids, so they are never shown as rollup rows and never recomputed; `devVerifyAI` AI09/AI13 prove both on a live stack. These rows hold specs and titles only, never customer data, but they are readable through AppSync like the rest of that table (D1).

## 6. Actions (router `tmsCrmActions`, read verbs first so the apiClient cache is not wiped)

| Action | Needs |
|---|---|
| `PREVIEW_DASHBOARD_CHAT` | door + create (COMPANY scope: + publishCompany) — the only model call |
| `PREVIEW_DASHBOARD` | door; an unsaved spec needs create; `{ id }` needs the audience; `{ builtin: 'OVERVIEW' }` needs only the door |
| `LIST_DASHBOARDS` / `GET_DASHBOARD` / `GET_DASHBOARD_OPTIONS` | door (+ audience for GET) |
| `SAVE_DASHBOARD` | door + create; COMPANY needs publishCompany; update = owner or ADMIN + `expectedVersion` |
| `ARCHIVE_DASHBOARD` | owner or ADMIN (COMPANY: publishCompany or ADMIN) + `expectedVersion` |

## 7. Limits

| Limit | Value |
|---|---|
| widgets per dashboard | 12 |
| spec size | 32,000 B |
| title / description | 80 / 200 chars |
| USERS / TEAM scope entries | 25 / 10 |
| customer / rep / division filters | 25 / 25 / 8 |
| list / group `limit` | 25 |
| CUSTOM window | 400 days; shipments ≤ 4 months, quotes ≤ 6, financials ≤ 13 (a longer window gives that widget an error, never truncated data) |
| chat | 20 messages, 2,000 chars each, 12,000 total; ≤ 2 clarifying questions |
| dashboards | 200 active in total, 50 per owner |
| time | model call aborted at 22 s; data run budget 24 s (a slow widget returns `ok:false` instead of blanking the dashboard); Lambda timeout 60 s |

## 8. The chat contract

The server asks the scope question **always** while `scope` is null ("Is this dashboard for the whole company, or for specific users/teams?"), appended by code, and returns `spec: null` whatever the model produced. Only the scope picker sets the scope (a typed "company-wide" is not accepted). When the provider refuses (credit, key, rate limit, abort) the action does not throw: it returns `modelError` with the provider's message, the scope question is still attached and no spec is invented; the UI shows "Model unavailable" with Retry. The dev Anthropic key may lack credit: the harness then **SKIPs `AI10-live-chat` with the provider message** and the rest still runs.

## 9. Verifying

```
node scripts/devVerifyAI.mjs --inventory      # offline: files, claims, action wiring/classification, catalog == schema == prompt, testids, routes
node scripts/devVerifyAI.mjs                  # after the deploy; <= 12 model calls; screenshots in Docs/tms-build/screenshots/ai/
node scripts/devVerifyAI.mjs --skip-model     # no model call at all (AI04/AI10 skip)
node scripts/auditDataExposure.mjs --write    # D1 evidence -> Docs/tms-build/AI-exposure-audit.md (read-only, dev)
```

The harness fixtures are `ZZ AI …` rows with distinct amounts (1,000 / 2,000 / 4,000 / 8,000 / 16,000 dollars) so any total names exactly which customers contributed; everything is deleted in `finally` and the shared `TmsSettings.teams` is restored and compared.
