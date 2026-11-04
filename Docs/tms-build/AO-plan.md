# Step AO — Driver GPS map in the Load Tracking drawer (+ AJ follow-up: inline tracking-prefs row) — build plan

Planned by AOPlan, 2026-11-04 (planning only; this file is the only thing edited). **Dev branch only.** Nothing here is committed, pushed or deployed by a builder; never `main`/production, no SSM writes by hand, `invoice_*.json` and the Aljex export untouched, no PII/credentials/keys printed (harness output carries ids, counts and masked values only). Sources: Ryne's brief (2026-11-04), `Docs/tms-build/mvmnt-ui/tracking-drawer-feedback.png` (read as an image), and the working tree on `dev`. Anything not observed in code or docs is tagged **[INFERENCE]**.

**Ask in one paragraph.** A collapsible Google Maps panel (~260 px tall at 1440) between the summary strip and the SMS / e-mail panes of the Load Tracking drawer, drawing pickup and delivery pins, the planned route, breadcrumb dots with timestamps, the driver's **current** position marker with age, "last source" and the ETA. Position sources, best first: (a) own assets via Motive/Blue Ink, (b) a tap-to-share link on the driver's phone, (c) a shared-location SMS, (d) an approximate fix geocoded from a free-text reply, (e) the same pings on the customer link page — **plus, added by Ryne via Main, (f) a provider slot** for continuous carrier tracking (MacroPoint / Trucker Tools style) that is STUB until credentials exist and produces the same ping output. Separately, the AJ "Tracking: Mode / Method / Driver SMS to" popover (the screenshot shows it floating over the strip and the SMS pane) becomes an inline, fixed-height row inside the strip.

---------------------------------------------------------------------------------------------------

## 0. At a glance

### 0.1 Findings that shape the plan (read first)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **The tap-to-share link already exists end to end.** `TrackingLink.kind='CARRIER_PING'` is minted by `SEND_TRACKING_LINK` (SMS via Dispatch, or COPY), the SPA page is `/track/l/:token` (`src/features/tracking/CarrierPingPage.tsx`, **one** `getCurrentPosition` per tap), the public Lambda route is `POST /l/<token>/ping` (`tracking-api/handler.ts` `pingRoute` L522) which rate-limits (`MIN_PING_GAP_MS` 60 s, `MAX_LINK_PINGS` 500, `MAX_ACCURACY_M` 5000), bumps link counters and writes **one `LoadCheckCall` row** (`type TRACKING_PING`, `source LINK`, lat/lng/accuracyM) and recomputes `deliveryEtaAt`. | `tracking-api/handler.ts` L126-131, L522-632; `CarrierPingPage.tsx` L44-69; `src/lib/trackingLink.ts` `carrierView` | Source (b) is a **change** (continuous `watchPosition`, consent, stop rules, a different store), not new infrastructure. There is no `/track` route; the pages are `/track/s/:token` (customer), `/track/l/:token` (driver), `/track/u/:token` (upload), `/track/:code` (permanent truck page) — `App.tsx` L113-118. |
| F2 | **Source (d) already exists, and it is over-eager.** `ingestShipmentMessage` (`tms-tracking-actions/thread.ts` L433-478) sends **every** inbound body (≥ 3 chars) to `geocodeReply` (`handler.ts` L2289, Google Geocoding, `components=country:US`, server key `GOOGLE_MAPS_API_KEY`), and on a hit writes a `LOCATION_UPDATE` check call and `Load.lastKnown*` with `lastKnownSource 'MANUAL'`. "Thanks" or "ok" can therefore become a position. It records no accuracy and no "approximate" flag. | same | (d) is *hardened and flagged*, not built: a `looksLikePlace` gate, an `approx` flag and a radius (§4.4). |
| F3 | **Source (c) has a hole.** The inbound SMS bridge (`dispatch-twilio-webhook/shipmentBridge.ts` `bridgeToShipment`) returns `null` when `body` is empty, and `handler.ts` L157-170 stores MMS media to S3 without ever reading it. An iPhone "Share My Location" to a non-iMessage number arrives as a **vCard attachment** [INFERENCE: standard iOS behaviour, not verified against a live Twilio message]; a Google Maps share arrives as a text link (`maps.app.goo.gl/…`, a redirect that must be resolved). | same | (c) needs a pure parser (`src/lib/locationShare.ts`), a vCard-to-text step in the webhook, and an SSRF-safe short-link resolver (§4.3). |
| F4 | **Motive breadcrumbs already reach the timeline without being copied.** `motive-location-sync` (every 10 min) writes `TruckLocation` + `TruckLocationHistory` (`source 'motive'`); `blueink-sync` the same (`'blueink'`). `useLoadTracking` merges `listTruckPositions(truckId, from, to)` into `buildTimeline`; `tracking-api` `motivePositions` does the same for the customer page. The model comment says why they are *not* copied: "six an hour per truck would swamp" `LoadCheckCall`. | `resource.ts` L2501-2502; `hooks/useLoadTracking.ts`; `tracking-api/handler.ts` L393-423 | Source (a) needs **no writer**. Copying Motive into a ping table would double 6 rows/hour/truck for nothing; the reader unions sources instead (D-AO2, a deliberate deviation from "(a) all writing TrackingPing rows"). |
| F5 | **`LoadCheckCall` cannot take watchPosition traffic.** Its consumers assume human-scale rows: `RecentCheckCalls` (5 newest), `carrierView` (own pings), `customerView.lastUpdate` (newest of `EVENT_LIMIT=200`), `laneSamples.ts` `PING_TYPES`, the check-call worklist, `buildTimeline`. A 5-minute ping over a 3-day trip is ~860 rows. | `tracking-api/handler.ts` L131-133; `laneSamples.ts` L44 | Breadcrumbs go to a high-volume store; `LoadCheckCall` keeps **one** `TRACKING_PING` row on the first fix and at most one per 30 min after (D-AO4). |
| F6 | **`TruckLocationHistory` is already a purpose-built breadcrumb store** — key `(truckId, locatedAt)`, GSI `truckId+locatedAt`, `source` is a free string (`motive`, `blueink`), unmatched vehicles already use synthetic keys (`motive:<n>`, `blueink:<n>`), nothing in `src/`, `scripts/` or `amplify/` writes it through GraphQL (only DynamoDB-SDK Lambdas), and `tracking-api` already holds Query on its index. Its required columns (`unitNumber`, `lat`, `lon`, `source`, `syncedAt`) are all available on a ping. | `resource.ts` L4087-4107; `motive-location-sync/handler.ts`; `backend.ts` L1553, L1586; grep for `createTruckLocationHistory` = none | **Data-model decision (D-AO1):** load-scoped pings are rows of this table with `truckId = 'load:<loadId>'`. No new model, no GSI. Cost ≈ +1 KB, §0.3. |
| F7 | **The three Lambdas that matter live in the data stack** (`resourceGroupName: 'data'` for `tracking-api`, `tms-tracking-actions`, `tms-directory-actions`), so their env vars, IAM statements and permissions count against the template. | `tracking-api/resource.ts` L7; `tms-tracking-actions/resource.ts` L24 | Cost is counted per statement, not just per model (§0.3). |
| F8 | **The browser key in this repo is `VITE_GOOGLE_MAPS_API_KEY` (+ `VITE_GOOGLE_MAPS_MAP_ID`)**, referrer-restricted, read in four files (`TrackingWorkstation.tsx` L59, `ShipmentsBoard.tsx` L126, `TrackingSection.tsx` L24, `LocationDetail.tsx` L13) and documented in `POST-DEPLOY-RUNBOOK.md` L162/L172. `GOOGLE_PLACES_API_KEY` is a **server-side branch env var** (`backend.ts` L1349, L2043; `blueink-sync/reverseGeocode.ts`); the server Geocoding/Distance key is the Amplify secret `GOOGLE_MAPS_API_KEY`, and the runbook says the browser key is *rejected* by server APIs with `REQUEST_DENIED`. | grep | Ryne's "existing GOOGLE_PLACES_API_KEY referrer key" is, in code, `VITE_GOOGLE_MAPS_API_KEY`. The plan reuses it unchanged (nothing in the repo); whether its value equals `GOOGLE_PLACES_API_KEY` is **unknown** — Q1. |
| F9 | **Directions has a deprecation clock.** `google.maps.DirectionsService` is deprecated as of 2026-02-25 (not scheduled for removal, 12 months' notice) in favour of the Routes library; the Directions API (Legacy) cannot be enabled on **new** Cloud projects from Oct 2026. | Google docs: developers.google.com/maps/documentation/javascript/routes/routes-js-migration, …/legacy/directions | The route is computed **server-side with the Routes API** (`routes.googleapis.com/directions/v2:computeRoutes`, server key), cached, and drawn from an encoded polyline — the browser never calls Directions (D-AO3). The existing `routeMiles.ts` uses legacy Distance Matrix and is left alone. |
| F10 | **A map already exists but is the wrong shape.** `TrackingDetailMap.tsx` (full page, `TrackingDetailPanel.tsx` L111) draws last-known + delivery with a straight two-point `Polyline`; its no-key fallback is an offline SVG US outline (us-atlas + d3-geo). The drawer's `ShipmentTrackingView` has no map. | `TrackingDetailMap.tsx` | The new panel supersedes it: the SVG fallback is extracted and reused, `TrackingDetailMap.tsx` is deleted (clean cutover, D-AO17). |
| F11 | **The prefs popover is mounted in two places**, `TrackingDrawer.tsx` L40 (header `headerExtra`) and `TrackingSection.tsx` L79, and opens an absolutely positioned `.tms-strip-menu.tms-prefs-panel` (`conversation.css` L392-409, `z-index:70`) — that is the overlay in the screenshot. `TrackingSummaryStrip` is one `nowrap` flex line with 7 segments and is also rendered by `form/sections/CheckCallsSection.tsx` (no shipment, `busy`, `NOOP`). | files named | The inline row lives in `ShipmentTrackingView` (both mounts get it) and reaches the strip through an optional `prefs` slot, so `CheckCallsSection` is untouched (§8.3). |
| F12 | **The integration registry already lists the tracking providers** — `TRUCKER_TOOLS`, `MACROPOINT`, `LOAD_MARKET` (category `TRACKING`, capability `track`, STUB), project44 (`sync` only), plus Motive/Blue Ink (`TELEMATICS`, `liveCapabilities` incl. `track`). `stubAdapter(d)` already gives each declared capability an honest `STUB — …` result; `adapterFor(d, creds, live?)` falls back to the stub unless credentials are present **and** a live adapter is supplied; `liveCapabilitiesOf(d)` is what the page treats as real. `webhookRoute` (`tracking-api/api.ts`) verifies `x-bcat-signature`, dedupes by receipt and **"receipts and nothing more"**. | `registry.ts` L131-179, L793-820; `adapter.ts`; `api.ts` webhookRoute | The provider slot is a **port + a consumer**, not new registry rows: `src/lib/integrations/trackingProvider.ts` (§5). No provider is made LIVE; `liveCapabilities` stays without `track` for them. |
| F13 | **Dev facts that bound verification:** the dev Maps key is neutered (`devVerifyAJ.mjs` ALLOW_PROBLEMS "dev Maps key is neutered"); Twilio is unset on dev (texts land `NOT_SENT`, so a tracking link is minted with `via:'COPY'`); `BCAT_DEV_STACK='true'` is injected into **every** Lambda by the dev guard (`backend.ts` L3979-4003); `scripts/lib/cdpBrowser.mjs` has no geolocation override today. | files named | Google-rendered markers cannot be screenshotted on dev; the harness proves the data and the fallback/consent pages and the Google branch is covered by a mocked-library unit test plus a manual look (R1). Sim doors are gated on `BCAT_DEV_STACK` with no new env var. |
| F14 | **Data stack: 970,712 / 1,000,000 B (Ryne, now); BUILD_LOG recorded 967,607 at AF-AK.** Measured deltas: fields on existing models ≈ 0; one model, no GSI **+3,839 B**; two models + seven GSIs +9,602 B. Queued and not yet landed: AG +11-16 KB, AI +10-14 KB, AL ≈ +1.5-2.5 KB. | `BUILD_LOG.md` L53, L1573; `AL-plan.md` F11 | AO is designed at **≈ +1.0-1.3 KB** and carries an optional **−2..−3 KB** offset (§0.3). A new `TrackingPing` table is the stated fallback, not the plan. |

### 0.2 Decisions taken (full table with alternatives in §15)

| ID | Decision | Default |
|---|---|---|
| D-AO1 | Where pings live | Rows in the existing **`TruckLocationHistory`**, `truckId = 'load:<loadId>'`, + 6 optional attributes. No new model/GSI. |
| D-AO2 | Own-asset (Motive / Blue Ink) breadcrumbs | **Not copied.** Read from `TruckLocationHistory` by the leg's real `truckId` and unioned with the load's pings in the reader. |
| D-AO3 | Planned route | Server-side **Routes API** `computeRoutes`, one call per distinct lane per 30 days, cached as a row in `TruckLocationHistory` (`truckId='route:<sha1>'`); drawn from an encoded polyline; estimate (straight legs) when no key or Google refuses. |
| D-AO4 | Tap-to-share cadence | `watchPosition`, posted at most every **5 min** (server floor 60 s, link cap 1,500); one `LoadCheckCall` row at first fix then ≤ 1 per 30 min. |
| D-AO5 | Retention | `ttlEpoch = fix time + 90 days` on load-keyed rows (DynamoDB TTL); route rows 30 days. Motive/Blue Ink rows untouched. |
| D-AO6 | Consent | Explicit consent screen + server-recorded `consentAt` on the link; no geolocation prompt before consent; sharing never auto-starts; stops at delivery. |
| D-AO7 | Customer page | Sees a thinned, rounded trail (+ route) inside the load's tracking window; **never** sees source, accuracy, speed, phone or carrier (unless the link already shows the carrier). |
| D-AO8 | Approximate fixes | Flagged `approx`, drawn as a circle, and **never replace a precise fix younger than 4 h** as "current". |
| D-AO9 | Own-asset legs and the tracking link | Allowed only when the truck has no ELD fix in the last 2 h (or no truck); otherwise the existing refusal stands. |
| D-AO10 | `TruckLocationHistory` client CRUD | **Disabled** (`disableOperations(['subscriptions','create','update','delete'])` — nothing writes it via GraphQL); integrity for customer-visible data, and likely a template saving. |
| D-AO11 | Provider slot | `PROVIDER_TRACK` link kind + `trackingProvider.ts` port + webhook consumer; STUB until credentials; pings carry `source = 'provider:<key>'`. |
| D-AO12 | Prefs control | An always-present 28 px row of three small selects + Save inside the strip card (not a chip, not a popover). |

### 0.3 Schema and deploy impact — stated plainly

* **GraphQL schema — additive only, no new model, no new GSI, no new mutation:**
  * `TruckLocationHistory` (+6 optional): `loadId: a.string()`, `accuracyM: a.integer()`, `approx: a.boolean()`, `refId: a.string()`, `ttlEpoch: a.integer()`, `payload: a.json()` (route rows only). Authorization `read` for `authenticated`, `disableOperations(['subscriptions','create','update','delete'])` (D-AO10).
  * `TrackingLink` (+3 optional, +1 enum value): `provider: a.string()`, `providerRef: a.string()`, `consentAt: a.datetime()`; `kind` enum gains `'PROVIDER_TRACK'`.
* **Backend (`amplify/backend.ts`, one append-only "Step AO" block, owned by AO1):** `timeToLiveAttribute` on `TruckLocationHistory` (`ttlEpoch`; precedent `backend.ts` L2229, L3868); `tracking-api`: append the history table ARN to the existing `PutItem` statement (L1560-1564) and `GetItem` statement (L1565-1568); `tms-tracking-actions`: env `TRUCK_LOCATION_HISTORY_TABLE_NAME` and one statement (`GetItem`, `PutItem`, `Query` on the table and `…/index/*`). **No** new function, function URL, rule, S3 grant, SSM, secret or env secret (`tms-tracking-actions` already holds `GOOGLE_MAPS_API_KEY`).
* **Template-byte estimate [INFERENCE from measured deltas in `AL-plan.md` F11 / BUILD_LOG; Main measures]:**

| Item | Est. bytes |
|---|---|
| 6 + 3 attributes, 1 enum value (GraphQL asset, not the CFN template — BUILD_LOG L1734) | ≈ 0 |
| TTL spec on `TruckLocationHistory` | ≈ +100 |
| `tracking-api`: 2 extra resource ARNs on existing statements | ≈ +250 |
| `tms-tracking-actions`: 1 env var (+~180) and 1 policy statement (+~420) | ≈ +600 |
| `disableOperations` create/update/delete on `TruckLocationHistory` (3 mutation resolvers removed) | **≈ −2,000 … −3,000** [INFERENCE: BUILD_LOG says dropping three subscription resolvers was needed to stay under the cap] |
| **Total, without the offset** | **≈ +0.9-1.3 KB** → ~971.6-972.0 KB |
| **Total, with the offset** | **≈ −0.7 … −2.1 KB** |

* **Gate (Main):** `node scripts/measureDataTemplate.mjs --branch dev` after AO1 lands and again after the last AO slice. **Stop-line: AO alone ≤ +2,000 B.** If exceeded: (1) keep D-AO10 (it is the offset), (2) drop the TTL spec and let `TrackingPing` rows age out through a daily delete in the existing nightly sweep (−100 B), (3) move the route cache from the history table to S3 only if the history-table rows cause a problem (+~450 B, not recommended).
* **What a separate table would cost (stated fallback).** `model TrackingPing` with `.identifier(['loadId','at'])` (native list-by-load, **no GSI**) **+3.8 KB measured**; with two GSIs and TTL ≈ **+5.5-7.5 KB** [INFERENCE: AG-plan §3.4]; plus the same ~+0.85 KB of Lambda wiring. With AG (+11-16), AI (+10-14), AL (+1.5-2.5) already queued against a 29.3 KB headroom, that table does not fit; reuse does.
* **Rejected stores.** *Ping JSON on `Load`*: every ping would rewrite the hottest item in the system, bump `updatedAt` (the CAS token every staff dialog sends — `lastKnownPatch` callers pass `expectedUpdatedAt`), fan out to the Load stream (`load-tracking-projector`, AF rollup recompute), grow every Load scan, be client-writable, and the public Lambda role is deliberately **not** allowed to write Load (`backend.ts` L1561). *`LoadCheckCall`*: F5.

### 0.4 Slice map (6 builders; disjoint file ownership §12; landing order §12)

| Slice | Owns | Landing |
|---|---|---|
| **AO1 FOUNDATION** | `amplify/data/resource.ts`, `amplify/backend.ts` (Step AO block), `src/types/tms.ts` (AO block), `src/lib/{trackingPings,locationShare,polyline}.ts`, `src/lib/trackingTimeline.ts` (additive), `amplify/functions/_shared/trackingPings.ts`, `src/lib/integrations/trackingProvider.ts`, `src/lib/apiClient.ts` (AO block), `src/hooks/useLoadTracking.ts` + all their tests | **first** |
| **AO2 PUBLIC EDGE** | `tracking-api/handler.ts`, `src/lib/{trackingLink,trackingClient}.ts`, `CarrierPingPage.tsx` (+ tests) | parallel after AO1 |
| **AO3 SERVER INGEST + ROUTE** | `tms-tracking-actions/{thread,handler,route,shareIngest}.ts`, `dispatch-twilio-webhook/handler.ts` (media hunk) (+ tests) | parallel after AO1 |
| **AO4 PROVIDER SLOT** | `tracking-api/{api,providerTracking}.ts`, `tms-tracking-actions/providers.ts`, `src/lib/integrations/registry.test.ts` expectations (+ tests) | parallel after AO1 |
| **AO5 UI** | `tracking/map/*`, `TrackingPrefsRow.tsx`, `TrackingSummaryStrip.tsx`, `ShipmentTrackingView.tsx`, `TrackingDrawer.tsx`, `TrackingSection.tsx`, `TrackingDetailPanel.tsx`, `CustomerTrackPage.tsx`, `conversation.css`, deletions (+ tests) | parallel after AO1 |
| **AO6 HARNESS + DOCS** | `scripts/devVerifyAO.mjs`, `scripts/lib/cdpBrowser.mjs` (geolocation override), route registries, BUILD_LOG / `Docs/WORKFLOWS.md` text | last to write; **runs** after the deploy |

---------------------------------------------------------------------------------------------------

## 1. Recon ledger (exact anchors the builders start from)

| Area | Anchor | Fact used by AO |
|---|---|---|
| Drawer | `tracking/TrackingDrawer.tsx` L16-54: `TmsDrawer size="xl"` (≤ 1040 px), `headerExtra` = `TrackingPrefsPopover` + "Manage links" + "Open full page"; body `<ShipmentTrackingView bundle customer actions>`; `onSaved={async () => { await refresh(); onChanged() }}` | Popover leaves the header; `actions.reload()` (already given to the view) replaces `refresh()`. |
| View | `tracking/ShipmentTrackingView.tsx` L120-: `TrackingSummaryStrip` → `.tms-tracking-panes` (two `TrackingConversation`) → `RecentCheckCalls` (+ buttons Log check call / Send tracking link / Customer link) → dialogs. Hooks: `useLoadTracking({loadId, shipmentId, truckId: loadCarrier?.truckId, load:{pickupAppt, deliveredAt}, loadCarrier:{dispatchedAt}})`, `useDriverPhones`, `summaryOf` | Map panel goes between strip and panes. `tracking.positions/timeline/lastKnown` already flow in. |
| Strip | `TrackingSummaryStrip.tsx` L56-103; segments `strip-driver`, `strip-phones`, `last-known`, `delivery-eta`, `strip-next-check`, `strip-pod`, `strip-carrier`; `summaryOf` in `trackingSummary.ts` L62-110 (`lastKnown = {place, ageMinutes, source}` from `i.lastKnown` else `load.lastKnown*`; ETA via `loadCarrier.deliveryEtaAt` / `etaOf`) | The panel reads the **same** `summary` (one ETA, one "last known"), never a second computation. |
| CSS | `src/features/tms/styles/conversation.css` L365-421 (`.tms-tracking-view`, `.tms-strip`, `.tms-strip-seg`, `.tms-strip-menu*`, `.tms-prefs-*`, `.tms-tracking-panes` `flex:1 1 360px; min-height:280px; height:360px`, drawer override `height:auto`) | New `.tms-strip-line`, `.tms-strip-prefs`, `.tms-map-panel*`. |
| Timeline | `src/lib/trackingTimeline.ts`: `TrackPosition {truckId, lat, lon, locatedAt, description?, speed?, motion?}`, `TimelineItem` (`check_call` \| `position` \| `link`), `trackingWindow`, `thinPositions(…, 15)`, `buildTimeline`, `lastKnownPosition` (hard-codes `source:'MOTIVE'` for positions), `LastKnownFix {at, lat, lng, description, source: LastKnownSource}` | Additive fields `source/accuracyM/approx` on positions and a `pingSource` on `LastKnownFix`; `LastKnownSource` (the `Load.lastKnownSource` enum) is **not** changed. Bundled by path into three Lambdas — relative, type-only imports. |
| Hook | `hooks/useLoadTracking.ts` polls every 60 s (events, links, `listTruckPositions`) | Adds a third read `listLoadBreadcrumbs(loadId, from, to)`; after the first full read, polls fetch only `(lastSeenAt, now]`. |
| Client reads | `apiClient.ts` `listTrackingIndex` L4056, `listTruckPositions` L4171 (query `listTruckLocationHistoryByTruckIdAndLocatedAt`, `limit 1000`, ASC), `TRUCK_LOCATION_HISTORY_FIELDS` L6002, `trackingAction()` L3864 | Same index query with `truckId:'load:<id>'`. |
| Public Lambda | `tracking-api/handler.ts`: `carrierRoute` L480 (`carrierView`), `pingRoute` L522, `customerRoute` L426 (`customerView`, `motivePositions`, `EVENT_LIMIT 200`, `POSITION_LIMIT 500`), `activeLink` L334, `countOpen` L364; routes `/l/<t>`, `/l/<t>/ping`, `/s/<t>` (L1079-1123); IAM `backend.ts` L1555-1586, L1616-1618 (GetItem Load/LoadCarrier) | Consent + closed-load gate + breadcrumb write; customer trail. |
| Views | `src/lib/trackingLink.ts` `customerView` (position rounded to 3 dp when `showPosition !== false`), `carrierView` (own pings filtered by `createdBy === link:<id8>`); types `CustomerTrackingView`/`CarrierTrackingView`/`TrackingViewPing` `src/types/tms.ts` L2686-2720 | Extended (§6). |
| Inbound SMS | `dispatch-twilio-webhook/handler.ts` L157-170 (media loop), L208-212 (`bridgeToShipment`); `shipmentBridge.ts` (`pickBridgeTarget`, `invokeTracking` as system caller `INGEST_SHIPMENT_MESSAGE`, `messageId: sms:<sid>`) | vCard-to-text; bridge unchanged. |
| Thread ingest | `thread.ts` `ingestShipmentMessage` L339-: dedupes on `messageId` (GSI) **before** geocoding, then one `transact([message, …clearAwaiting, …checkCalls, …loadPatches])` | The ping put goes **after** `transact`, best effort. `ThreadDeps` (L95-99) gains optional deps. |
| Router | `tms-tracking-actions/handler.ts`: `Action` union L258-, `SYSTEM_CALLERS` L349, `authorize` L357 (owner/ADMIN/`page-loads`/`page-tms`), `geocodeReply` L2289, `threadDeps` L2333, `case` dispatch L2451-; `sendTrackingLink` L806 (refuses `kind==='OWN_ASSET'` L822) | New actions: `GET_LOAD_ROUTE`, `START_PROVIDER_TRACKING`, `STOP_PROVIDER_TRACKING`, `TRACKING_SIM_PINGS`, `TRACKING_SIM_PROVIDER`. |
| Motive | `motive-location-sync/handler.ts` (10 min; `TruckLocation` upsert + `TruckLocationHistory` idempotent put); `blueink-sync` (10 min, `source 'blueink'`, `reverseGeocode.ts`) | Read-only for AO. |
| Registry | `src/lib/integrations/{registry,adapter,types,health}.ts`; Step J `postings.ts` adapter-port precedent (`adapterFor(provider)` → `{mode, post, unpost}`); `RUN_STUB` in `tms-directory-actions/integrations.ts` L719 | `trackingPort` mirrors `adapterFor`. |
| Dev | `devVerifyAJ.mjs` header (guards: dev AppSync only, dev pool only, refuses prod suffix `5ucwdyvwivelbo4k4jomvrwel4`, ZZ fixtures voided/archived in `finally`, `Docs/tms-build/screenshots/<step>/`), `scripts/lib/{devIdentity,cdpBrowser,uiWalk}.mjs` | §11 follows it. |

---------------------------------------------------------------------------------------------------

## 2. Data model (additive; exact attributes)

### 2.1 `TruckLocationHistory` — three row kinds in one table

```ts
// amplify/data/resource.ts, TruckLocationHistory model — append after `syncedAt`
loadId:    a.string(),    // Step AO. Set on load-keyed rows (truckId = 'load:<loadId>'); null on Motive / Blue Ink rows
accuracyM: a.integer(),   // Step AO. Reported horizontal accuracy; for approx fixes, the radius of the guess
approx:    a.boolean(),   // Step AO. true = geocoded from free text (source 'sms-geocode'); never a GPS reading
refId:     a.string(),    // Step AO. Provider event id / Twilio MessageSid — audit and idempotency, never shown
ttlEpoch:  a.integer(),   // Step AO. Epoch SECONDS; DynamoDB TTL enabled in backend.ts. Absent on Motive / Blue Ink rows
payload:   a.json(),      // Step AO. Route rows only: { encoded, meters, seconds, source, fetchedAt, key, waypoints }
// …and, at the end of the model chain:
.authorization((allow) => [allow.authenticated().to(['read'])])
.disableOperations(['subscriptions', 'create', 'update', 'delete'])
```

| Row kind | `truckId` | `locatedAt` (sort key) | `source` | Written by |
|---|---|---|---|---|
| Fleet (existing) | `Equipment.id` / `motive:<n>` / `blueink:<n>` | provider fix time | `motive` · `blueink` | motive-location-sync, blueink-sync (unchanged, no `ttlEpoch`) |
| **Load ping (new)** | `load:<loadId>` | ISO ms of the **fix** (device clock if within [now − 10 min, now + 2 min], else server now) | `link` · `sms-share` · `sms-geocode` · `provider:<key lower-case>` (e.g. `provider:macropoint`) | `putPing()` (`_shared/trackingPings.ts`) from `tracking-api` and `tms-tracking-actions` |
| **Route cache (new)** | `route:<sha1 of the lane key>` | the constant `'route'` | `routes-api` · `directions-legacy` · `estimate` | `GET_LOAD_ROUTE` only |

Required columns on a load ping: `unitNumber` = leg truck number or `'LOAD'`; `lat`/`lon`; `source`; `syncedAt` = write time; `speed` (mph) and `bearing` when the source reports them; `description` = "City, ST" when known (shared-pin reverse geocode, geocode hit). Route rows carry the origin's `lat/lon` and `unitNumber:'ROUTE'` to satisfy the required columns.

**Idempotency / dedupe.** `putPing` is `PutItem` with `ConditionExpression: 'attribute_not_exists(locatedAt)'`; a `ConditionalCheckFailedException` is a silent success. A retry therefore needs the same `locatedAt`: link pings use the device fix time, SMS fixes use the message time, provider fixes use the provider's timestamp (+ `refId`). Sources are not de-duplicated against each other (a Motive fix and a driver tap 4 s apart are both true); the reader (`mergeFixes`) collapses same-source fixes < 1 s apart and `thinFixes` thins for display.

**Read path.** `listLoadBreadcrumbs(loadId, from, to)` = the existing GSI query with `truckId:'load:<loadId>'` and `locatedAt between`. The window is `trackingWindow()` — dispatch to delivery + 2 h — exactly as Motive. TTL deletion lags by up to ~48 h [INFERENCE: DynamoDB documents deletion "within a few days"; treat as ≤ 48 h], so readers ignore rows with `ttlEpoch*1000 < now` (route rows) and the window already bounds ping rows.

### 2.2 `TrackingLink` (+3, +1 enum value)

```ts
kind:      a.enum(['CARRIER_PING', 'CUSTOMER_VIEW', 'CARRIER_UPLOAD', 'PROVIDER_TRACK']),
provider:    a.string(),     // Step AO. PROVIDER_TRACK: registry key, e.g. 'MACROPOINT'
providerRef: a.string(),     // Step AO. The provider's own id for the subscription ('stub:<token8>' while STUB)
consentAt:   a.datetime(),   // Step AO. CARRIER_PING: when the driver ticked the consent box (server clock)
```
`PROVIDER_TRACK` rows reuse the whole link lifecycle for free: `loadId`/`loadCarrierId`/`shipmentId`, `expiresAt` (same rule as `CARRIER_PING`: last delivery appt + settings hours), `status` ACTIVE/REVOKED/EXPIRED, `pingCount`/`lastPingAt` counters, GSIs `shipmentId` and `loadId`, `createdBy`. The row `id` (the 192-bit token) is the **reference we give the provider**, so an inbound webhook resolves its subscription with one `GetItem` — no index. A `PROVIDER_TRACK` token never works on `/l/…` (`activeLink(token, 'CARRIER_PING')` checks `kind`).

Existing code that enumerates `kind` and must stay correct (builders grep `TrackingLinkKind`, `'CARRIER_UPLOAD'`): `linkExpiry(kind, …)` in `trackingLink.ts` (treat `PROVIDER_TRACK` like `CARRIER_PING`), `activeLinksForLoad` / `revokeTx` in `tms-tracking-actions/handler.ts` (SEND_TRACKING_LINK revokes `CARRIER_PING` rows only — it must **not** revoke a `PROVIDER_TRACK` row), `listCarrierPingLinks` (filters `CARRIER_PING`; unchanged), the Customer links page (filters `CUSTOMER_VIEW`; unchanged).

### 2.3 Types (`src/types/tms.ts`, AO1 block)

`TrackingLinkKind` gains `'PROVIDER_TRACK'`; `TrackingLinkRecord` gains `provider?`, `providerRef?`, `consentAt?`; `CarrierTrackingView` gains `share` (§6.1); `CustomerTrackingView` gains `map` (§6.2); `LastKnownFix` (in `trackingTimeline.ts`) gains `pingSource?`, `accuracyM?`, `approx?`. Nothing is added to `LastKnownSource` or to the `Load` model.

### 2.4 What is deliberately NOT stored

No speed trace beyond the `speed`/`bearing` columns a source already reports; no phone numbers, names or message text on a ping row; no raw provider payload (only `refId`); no ping is ever written to `Load` (D-AO16, below); no pings after the load is closed (§6.1).

---------------------------------------------------------------------------------------------------

## 3. Shared contracts (AO1 writes these first; every slice codes against them)

Pure TypeScript, **relative imports only** in anything a Lambda bundles (`trackingTimeline.ts` and `trackingLink.ts` precedent); the browser imports through `@/lib/…`.

```ts
// src/lib/trackingPings.ts  (AO1)
export type PingSource =
  | 'motive' | 'blueink'                       // ELD (fleet rows)
  | 'link' | 'sms-share' | 'sms-geocode' | 'manual'
  | `provider:${string}`                       // lower-case registry key
export const LOAD_PING_PREFIX = 'load:'
export const ROUTE_ROW_PREFIX = 'route:'
export const PING_RETENTION_DAYS = 90
export const ROUTE_RETENTION_DAYS = 30
export const loadPingKey = (loadId: string) => `${LOAD_PING_PREFIX}${loadId}`

export interface TrackingFix {
  at: string                       // ISO
  lat: number; lng: number
  source: PingSource
  accuracyM: number | null         // for approx fixes: radius of the guess
  approx: boolean
  speedMph: number | null; headingDeg: number | null
  place: string | null             // "Joliet, IL" when known
}
export interface PingInput {       // what a writer hands to pingRow()
  loadId: string; unitNumber?: string | null
  at: string; lat: number; lng: number
  source: PingSource; accuracyM?: number | null; approx?: boolean
  speedMph?: number | null; headingDeg?: number | null; place?: string | null
  refId?: string | null; nowIso: string
}
export function pingRow(i: PingInput): Record<string, unknown>          // full DynamoDB item incl. ttlEpoch = at + 90 d, syncedAt, __typename
export function fixOfRow(row: Record<string, unknown>): TrackingFix | null   // validates ranges; null for a malformed row
export function mergeFixes(...sets: TrackingFix[][]): TrackingFix[]      // ascending, same-source < 1 s apart collapsed
export function thinFixes(fixes: TrackingFix[], minGapMin: number, max: number): TrackingFix[]   // always keeps first and last
export function trustRank(source: PingSource, approx: boolean): number   // motive/blueink 100 · provider 90 · link 80 · sms-share 70 · manual 60 · sms-geocode 10
export function sourceLabel(source: PingSource): string                  // 'Motive ELD' · 'Blue Ink ELD' · 'Driver phone (link)' · 'Driver-shared pin (SMS)' · 'Text reply (approximate)' · 'MacroPoint'
export interface CurrentFix {
  fix: TrackingFix                  // the marker
  overlay: TrackingFix | null       // a newer approx fix shown as a circle beside a still-fresh precise fix
  ageMinutes: number
  tone: 'fresh' | 'aging' | 'stale' // < 15 min · 15-60 min · > 60 min
}
export function currentFix(fixes: TrackingFix[], nowMs: number): CurrentFix | null
//   newest fix wins, except: an approx newest fix does not replace a precise fix < 4 h old (it becomes `overlay`)
export function remainingMiles(path: Array<{ lat: number; lng: number }>, at: { lat: number; lng: number }): number | null  // along-route distance from the nearest vertex to the end; null when the point is > 25 mi off route
export function routeKeyOf(stops: Array<{ lat: number; lng: number }>): string   // the canonical string `lat,lng|lat,lng|…` rounded to 0.01°; the Lambda hashes it with node:crypto sha1 (hashing is server-side only; the browser never computes a route key)
```
```ts
// src/lib/polyline.ts (AO1) — Google encoded polyline, precision 5
export function decodePolyline(encoded: string): Array<{ lat: number; lng: number }>
export function encodePolyline(path: Array<{ lat: number; lng: number }>): string
export function haversineMiles(a: LatLng, b: LatLng): number
```
```ts
// src/lib/locationShare.ts (AO1) — pure; no network
export type ShareParse =
  | { kind: 'COORDS' | 'APPLE_MAPS' | 'GOOGLE_MAPS'; lat: number; lng: number; label: string | null }
  | { kind: 'SHORT_LINK'; url: string }            // maps.app.goo.gl / goo.gl/maps — needs a server-side redirect resolve
export function parseLocationShare(text: string): ShareParse | null
export function looksLikePlace(text: string): boolean      // gate in front of the geocoder
export function isAllowedShareHost(url: string): boolean   // the SSRF allow-list: https only, hosts maps.app.goo.gl, goo.gl, www.google.com, maps.google.com, maps.apple.com
export function textOfVcard(vcf: string): string | null    // the URL / GEO line of a shared-location vCard, else null
```
```ts
// amplify/functions/_shared/trackingPings.ts (AO1) — the one server-side writer
export interface PingDeps { ddb: DynamoDBDocumentClient; table: string }    // TRUCK_LOCATION_HISTORY_TABLE_NAME
export async function putPing(deps: PingDeps, input: PingInput): Promise<'WRITTEN' | 'DUPLICATE'>   // conditional put; never throws on a duplicate
export async function ingestProviderDelivery(
  deps: PingDeps & { getLink(token: string): Promise<TrackingLinkRecord | null>; bumpLink(token: string, n: number, lastAtIso: string): Promise<void>; loadClosed(loadId: string): Promise<boolean> },
  providerKey: string, raw: { headers: Record<string, string | undefined>; body: string }, nowIso: string,
): Promise<{ accepted: number; duplicates: number; ignored: string | null }>
```
```ts
// src/lib/integrations/trackingProvider.ts (AO1) — see §5
```
```ts
// src/lib/apiClient.ts (AO1 block, appended)
export async function listLoadBreadcrumbs(loadId: string, from: string, to: string): Promise<TrackingFix[]>
export async function getLoadRoute(loadId: string): Promise<LoadRoute>             // trackingAction('GET_LOAD_ROUTE')
export async function startProviderTracking(i: { loadCarrierId: string; provider: string }): Promise<{ link: TrackingLinkRecord; mode: 'STUB' | 'LIVE'; message: string }>
export async function stopProviderTracking(i: { linkId: string }): Promise<{ link: TrackingLinkRecord }>
export interface LoadRoute {
  encoded: string | null; meters: number | null; seconds: number | null
  source: 'ROUTES_API' | 'DIRECTIONS_LEGACY' | 'ESTIMATE' | 'NONE'
  cached: boolean; fetchedAt: string | null
  waypoints: Array<{ type: 'pickup' | 'delivery' | 'stop'; lat: number; lng: number; name: string | null }>
  reason: string | null            // why the route is an estimate / absent ("No server Maps key", "Delivery address has no coordinates", Google's status)
}
```
`useLoadTracking` (AO1) additionally returns `fixes: TrackingFix[]` (all sources merged: Motive/BIT by the leg's `truckId`, load pings, plus the `Load.lastKnown*` fallback when no fix exists) and `current: CurrentFix | null`; `lastKnown` keeps its shape and gains the optional fields so the strip is unchanged.

---------------------------------------------------------------------------------------------------

## 4. Ingestion paths, per source

Priority order is **display trust** (`trustRank`), not write order. All load-keyed writes go through `putPing`.

| # | Source | `source` | Writer | Accuracy / trust | Dedupe key |
|---|---|---|---|---|---|
| a | Own assets: Motive TruckLocation → breadcrumbs | `motive` / `blueink` | none new (existing sync) | ELD, ~10 m, rank 100 | `(truckId, locatedAt)` existing |
| b | Tap-to-share link, `watchPosition` | `link` | `tracking-api` `pingRoute` | browser GPS, `accuracyM` as reported (≤ 5 km accepted, > 500 m drawn with a halo), rank 80 | `(load:<id>, deviceFixAt)` |
| c | Shared-location SMS (Apple / Google / lat,lon) | `sms-share` | `tms-tracking-actions` `ingestShipmentMessage` | exact pin the driver chose, no accuracy known (`null`), rank 70 | `sms:<sid>` already dedupes the message; ping key = message time |
| d | Check-call text → geocode | `sms-geocode` | same | **approximate**, `approx:true`, `accuracyM` = radius (≥ 2,000 m), rank 10 | same |
| e | Customer page | — (reader) | `tracking-api` `customerRoute` | trail thinned, rounded, approx flagged | — |
| f | Provider (MacroPoint / Trucker Tools / …) | `provider:<key>` | `ingestProviderDelivery` (webhook or sim door) | provider-reported, rank 90 | `(load:<id>, providerTimestamp)` + `refId` |

### 4.1 (a) Own assets
No write. The reader unions `listTruckPositions(loadCarrier.truckId, from, to)` with the load's pings. For an `OWN_ASSET` leg the current marker prefers a Motive/BIT fix by recency like any other. The strip's existing "Last: place · age" stays; the map header adds the source label ("Motive ELD · 6 min ago"). The 10-minute sync cadence means "age" is normally 0-10 min; > 60 min paints the stale tone.
**Deviation from the brief (D-AO2):** Ryne wrote that every source writes `TrackingPing` rows. For (a) that would be 6 duplicate rows an hour per truck beside rows that already exist; the reader treats both identically, so nothing user-visible differs. If Ryne still wants the copy, it is a 20-line addition to `motive-location-sync` with `putPing` — listed in §15 as the alternative.

### 4.2 (b) Tap-to-share link (the existing `/track/l/:token`)
Page and Lambda changes in §6.1. Server writes in `pingRoute` after the existing guards pass:

1. `putPing({ loadId: link.loadId, unitNumber: leg truck number, at: deviceFixAt ?? now, lat, lng, source:'link', accuracyM, speedMph, headingDeg, nowIso })`.
2. `LoadCheckCall` `TRACKING_PING` row **only** when this is the link's first ping or `link.lastLogPingAt` is ≥ 30 min old (the same conditional `UpdateItem` that already bumps the counters also sets `lastLogPingAt`; if the condition shows a newer one the row is skipped). `carrierView`'s "Your recent check-ins" therefore stays short, `customerView.lastUpdate` still moves, and the check-call agent's "any ping clears the reply clock" behaviour (thread.ts comment) is preserved because the first/30-min row exists.
3. ETA: the existing `etaToStop` recompute + `LoadCarrier.deliveryEtaAt` update stays, but runs on **every accepted ping** only when the previous ETA write is > 10 min old (avoids a `LoadCarrier` write per ping).

**Own-asset legs (D-AO9).** `sendTrackingLink` (`handler.ts` L822) refuses `OWN_ASSET`. Relaxed to: refuse only if the leg's `truckId` has a `TruckLocation.locatedAt` within 2 h; otherwise mint the link and send it to the truck work phone via the existing `resolveDriverSmsForLeg` (Step AK precedent). Needs `GetItem` on `TruckLocation` — `tms-tracking-actions` does not appear to hold it today (`backend.ts` L939-943 grants `TruckConfig`/`Driver` only; builder confirms with a grep for `TRUCK_LOCATION_TABLE_NAME` on that Lambda) [INFERENCE], so AO1's statement for this Lambda includes `TruckLocation` `GetItem` (+~130 B, counted in the +420). The existing test "refuses an own-asset leg and points at Motive instead" is rewritten, not deleted: it still refuses when a fresh fix exists.

### 4.3 (c) Shared-location SMS
1. **Text path.** `bridgeToShipment` already forwards the body. In `ingestShipmentMessage`, before `deps.geocode(body)`:
   `const share = parseLocationShare(body)` →
   * `COORDS | APPLE_MAPS | GOOGLE_MAPS` → exact fix. City/state via new optional dep `deps.reverseGeocode(lat, lng)` (Google Geocoding `latlng=`, server key, never throws, `null` on failure → place falls back to `"41.525, -88.081"`).
   * `SHORT_LINK` → `deps.resolveShareLink(url)` (follow ≤ 3 redirects manually with `redirect:'manual'`, 3 s timeout, **every hop must pass `isAllowedShareHost`**, final URL re-run through `parseLocationShare`); failure ⇒ the message is stored as a `NOTE` and the Tracking pane shows it (a person can open the link).
   * no share → existing `looksLikePlace(body)` gate → `geocode` (path d).
2. **What is written for an exact share.** Same as today's geocode branch (a `LOCATION_UPDATE` check call with lat/lng/city/state + the `Load.lastKnown*` patch, `lastKnownSource:'MANUAL'`, because a person-supplied text is what `thread.ts` already calls MANUAL), **plus** `putPing(source:'sms-share')` after the `transact`. The check call's `note` is the original text, so the pane reads naturally.
3. **vCard / MMS.** `dispatch-twilio-webhook/handler.ts` L157-170 already downloads each media item (`got.bytes`). New: when `contentType` is `text/vcard` or `text/x-vcard` and the body is empty, `textOfVcard(new TextDecoder().decode(bytes))` is used as the `body` handed to `bridgeToShipment` (the stored Dispatch message and S3 object are unchanged). `bridgeToShipment` then needs no change (its empty-body guard now sees text).
4. **Who can send.** Only a driver the Dispatch webhook already matched (driver phone or truck work phone, AJK) and whose live load `pickBridgeTarget` resolves. A text from an unknown number stays in Dispatch only — no fix is ever created from an unmatched sender.
5. **Trust.** A shared pin is the driver's own act but can be dropped anywhere; it is flagged in the tooltip as "Driver-shared pin". A pin > 500 mi from the previous fix inside 30 min is still written but drawn with a warning marker (`jumpMiles` computed in `currentFix`, not stored).

### 4.4 (d) Check-call text → approximate fix
* **Gate** (`looksLikePlace`, pure): true for `City, ST`, a 2-letter state after a capitalised word, or a preposition (`in|near|at|past|passed|by|leaving|outside|approaching|just past`) followed by ≥ 1 capitalised word; false for ≤ 3 words with no capital/state token ("Thanks", "ok", "on my way"). Cuts Geocoding calls and removes false positives (F2).
* **Radius.** `geocodeReply` additionally returns `radiusM`: half the diagonal of `geometry.viewport` (clamped 2,000-50,000 m); `location_type` `ROOFTOP`/`RANGE_INTERPOLATED` ⇒ keep the radius but cap at 2,000 m. The existing dev fallback table (`COMMON_GEOCODE_FALLBACKS`) returns `radiusM: 8000`.
* **Writes.** Unchanged `LOCATION_UPDATE` + `Load.lastKnown*` **plus** `putPing(source:'sms-geocode', approx:true, accuracyM: radiusM, place: "Gary, IN")`.
* **Display.** Drawn as a translucent circle labelled "Driver said: near Gary, IN · 12 min ago"; does not replace a fresher precise fix (D-AO8).

### 4.5 (e) Customer-visible reuse
Same rows, read by `tracking-api` `customerRoute` through the same index query (`load:<loadId>` + `motivePositions`), merged by the shared `mergeFixes`/`thinFixes`. Contract in §6.2.

### 4.6 Retention
`ttlEpoch` per §2.1 (90 d from the fix); route rows 30 d. No per-load knob in v1 (constants in `trackingPings.ts`).

---------------------------------------------------------------------------------------------------

## 5. Provider slot (continuous carrier tracking — MacroPoint / Trucker Tools style)

### 5.1 What exists and what is added
Registry rows `MACROPOINT`, `TRUCKER_TOOLS`, `LOAD_MARKET` already declare `track`; `stubAdapter` already answers `STUB — A live … connection would have started … tracking on this shipment`; the Integrations page shows them STUB and `liveCapabilitiesOf` excludes `track`. **Added:** a typed *port* beside the generic `Adapter` (which only takes a sample), a webhook *consumer*, a `PROVIDER_TRACK` link row as the subscription record, and start/stop actions. **Not added:** any live HTTP call. `registry.ts` rows are unchanged; `liveCapabilities` is not extended (a LIVE mapping needs the provider's real contract and credentials — nothing in this repo or the task states MacroPoint's or Trucker Tools' webhook/subscription schema, so none is invented).

### 5.2 The port (`src/lib/integrations/trackingProvider.ts`, AO1; pure)
```ts
export interface ProviderFix { lat: number; lng: number; at: string; accuracyM?: number | null; speedMph?: number | null; headingDeg?: number | null; refId: string }
export interface TrackingSubscription {
  reference: string                 // = TrackingLink.id; the provider echoes it back on every delivery
  loadId: string; loadCarrierId: string; shipmentId: string
  carrier: { name: string | null; dot: string | null; mc: string | null }     // MacroPoint needs the carrier DOT (registry `feeds` note)
  driverPhone: string | null
  origin: { city: string | null; state: string | null }; destination: { city: string | null; state: string | null }
  pickupAppt: string | null; deliveryAppt: string | null
}
export interface PortResult { mode: 'STUB' | 'LIVE'; ok: boolean; message: string; providerRef: string | null }   // a stub message begins "STUB — "
export interface ParsedDelivery { reference: string; fixes: ProviderFix[]; status: 'ACTIVE' | 'ARRIVED' | 'COMPLETE' | 'DECLINED' | 'NO_SIGNAL' | null }
export interface TrackingProviderPort {
  readonly key: ProviderKey
  readonly mode: 'STUB' | 'LIVE'
  subscribe(sub: TrackingSubscription): Promise<PortResult>
  unsubscribe(providerRef: string): Promise<PortResult>
  parseDelivery(raw: { headers: Record<string, string | undefined>; body: string }): ParsedDelivery | null   // webhook -> fixes; null = not ours / malformed
  poll?(providerRef: string, sinceIso: string): Promise<ProviderFix[]>    // pull-style providers; unused until a LIVE port supplies it
}
export function trackingPortFor(d: ProviderDescriptor, creds: Record<string, string>, live?: TrackingProviderPort): TrackingProviderPort
//   same rule as adapterFor(): live only when every required credential is present and not 'disabled-on-dev' AND a live port was supplied (none is, today)
export const SIM_DELIVERY_SHAPE: '{ "reference": "<token>", "status": "ACTIVE", "fixes": [{ "refId": "…", "at": "ISO", "lat": 0, "lng": 0, "accuracyM": 30, "speedMph": 54 }] }'
```
The **stub port** (`stubTrackingPort(d)`): `subscribe` returns `{mode:'STUB', ok:true, message:'STUB — A live <label> connection would have started <label> tracking on this shipment.', providerRef:'stub:'+reference.slice(0,8)}`; `unsubscribe` likewise; `parseDelivery` accepts **only** the documented SIM shape above (so a hand-built or harness delivery exercises the whole consumer, and a real provider body is rejected until a live port exists); `poll` absent.

### 5.3 Start / stop
`START_PROVIDER_TRACKING { loadCarrierId, provider }` (`tms-tracking-actions/providers.ts`, AO4): authorize like `SEND_TRACKING_LINK`; requires an ACTIVE `kind:'CARRIER'` leg on an open load; `provider` must be a registry key with category `TRACKING`, `applicability LIVE_CAPABLE` and `capabilities ∋ 'track'`; revokes any prior ACTIVE `PROVIDER_TRACK` row for the same leg; mints a token, writes the `TrackingLink` row (`kind:'PROVIDER_TRACK'`, `provider`, `expiresAt` via `linkExpiry('CARRIER_PING', …)`), calls `trackingPortFor(...).subscribe(...)`, stores `providerRef`, writes an `AuditLog` row, returns `{ link, mode, message }`. In STUB mode nothing leaves the Lambda. `STOP_PROVIDER_TRACKING { linkId }` revokes and calls `unsubscribe`. Sets `LoadCarrier.trackingLinkId` **not** (that field is the driver's ping link); the map panel finds the subscription with `links.find(l => l.kind==='PROVIDER_TRACK' && l.status==='ACTIVE')`.

### 5.4 Webhook consumer
`POST /api/webhooks/<provider>` already exists (`tracking-api/api.ts` `webhookRoute`: connected provider row + `<PROVIDER>/webhook` secret + HMAC `x-bcat-signature` + replay receipt). AO4 adds, **after the receipt is filed** and only when `descriptorOf(key).category === 'TRACKING'`, `consumeTrackingDelivery()` (`tracking-api/providerTracking.ts`), a thin wrapper that calls the shared `ingestProviderDelivery`:
1. `trackingPortFor(...).parseDelivery(raw)`; `null` ⇒ 200 `{received:true, ignored:'unparseable'}` (a provider must not retry forever).
2. `getLink(reference)` — kind `PROVIDER_TRACK`, `provider` equals the route's provider, status `ACTIVE`, not expired; else ignored.
3. `loadClosed(link.loadId)` ⇒ ignored (no pings after delivery).
4. ≤ 100 fixes per delivery; each validated, `putPing(source:'provider:<key>', refId)`; link counters `ADD pingCount n`, `SET lastPingAt`.
5. Response: the existing receipt body plus `{ pings: { accepted, duplicates } }`.
The receipt's own signature/replay rules stay as they are; the "receipted and nothing more" comment in `api.ts` is replaced and its test updated.
**Open item (blocked on the provider):** MacroPoint and Trucker Tools authenticate their callbacks in their own ways [INFERENCE: neither is known to sign with BCAT's `x-bcat-signature`]. A LIVE port will therefore carry its own `verifyDelivery`; until then only deliveries that pass BCAT's HMAC reach `parseDelivery`, which in STUB mode accepts only the sim shape.

### 5.5 Sim doors (dev only; `BCAT_DEV_STACK==='true'`, ADMIN, never `main`)
* `TRACKING_SIM_PINGS { loadId, fixes: [{ minutesAgo, lat, lng, source, accuracyM?, approx?, place? }] }` — writes load pings through `putPing` (the harness's "SIM pings, no real GPS").
* `TRACKING_SIM_PROVIDER { linkId, fixes: [...] }` — builds the SIM-shaped body and runs the **same** `parseDelivery` → `ingestProviderDelivery` the webhook uses (everything except the HMAC step, which Step J's tests already cover).
* `TRACKING_SIM_TEXT { shipmentId, body, sid? }` — runs `ingestShipmentMessage` with a synthetic `sim:<n>` message id as an ADMIN caller, so the shared-pin / geocode paths (§4.3, §4.4) are exercised without Twilio (`INGEST_SHIPMENT_MESSAGE` itself is system-caller-only and stays so).
All three refuse outside dev with `This action only exists on the dev stack`. `TRACKING_SIM_PINGS` and `TRACKING_SIM_TEXT` live in `tms-tracking-actions/shareIngest.ts` (AO3), `TRACKING_SIM_PROVIDER` in `providers.ts` (AO4); no new function, no URL, no env var (`BCAT_DEV_STACK` is already injected into every Lambda by the dev guard).

### 5.6 UI
The map panel's overflow menu lists `PROVIDERS.filter(p => p.category==='TRACKING' && isApplicable(p) && p.capabilities.includes('track'))` as "Start <label> tracking (STUB)" for a brokered leg with no active `PROVIDER_TRACK` row; with one active it shows "<label> · STUB — no live data · Stop". The label disappears the day a live port makes `mode==='LIVE'`.

---------------------------------------------------------------------------------------------------

## 6. Public pages contract (token auth reused; no new URL, no new Lambda)

### 6.1 Driver page `/track/l/:token` (`CarrierPingPage`) + `GET /l/<t>` + `POST /l/<t>/ping`
**Auth:** the existing 32-char base64url link token, `kind 'CARRIER_PING'`, `ACTIVE`, unexpired (`activeLink`). Wrong / revoked / expired / unknown = one 404 wording (`LINK_GONE`), unchanged.

`GET /l/<t>` view gains:
```ts
share: {
  everyMin: 5                        // server-controlled cadence
  consentRequired: boolean           // link.consentAt == null
  consentVersion: 'ao-1'
  consentText: string                // see below — the page renders this verbatim
  active: boolean                    // false when the load is closed
  lastPingAt: string | null; pingCount: number
}
```
`POST /l/<t>/ping` body: `{ lat, lng, accuracyM?, fixAt?, speedMph?, headingDeg?, trigger: 'tap' | 'watch', consent?: true }`.

| Condition | Response | Writes |
|---|---|---|
| link wrong/expired | 404 `LINK_GONE` | — |
| load closed (`deliveredAt` set or `CLOSED_LOAD_STATUSES`) | **410** `{ error:'Delivery is complete — sharing has stopped. Thank you.', done:true }` | none |
| `link.consentAt` null and `consent !== true` | **403** `{ error:'consent' }` | none |
| bad body / out of range | 400 | none |
| `accuracyM > 5000` | 409 (unchanged) | none |
| < 60 s since `lastPingAt` or `pingCount ≥ 1500` | 429 (unchanged wording; cap raised from 500) | none |
| ok | 200 `{ ok:true, at, eta, nextInMin: 5 }` | counters (+ `consentAt` on first consenting ping, conditional `attribute_not_exists`), ping row, check-call row per §4.2 |

**Page behaviour (`CarrierPingPage.tsx`):**
1. Shows load number, next stop, the consent text and a required checkbox **"I agree"** → button **Start sharing**. No `navigator.geolocation` call before the tap.
2. After consent: `watchPosition` with `enableHighAccuracy:true, maximumAge:30_000, timeout:20_000`. The page posts the **latest** fix immediately (`trigger:'tap'`), then at most one fix every `share.everyMin` minutes (`trigger:'watch'`) and whenever the device has moved > 1 km since the last post. 429 is read as "already in", not an error.
3. A status line: "Sharing · last sent 3 min ago · keep this page open" and a **Stop sharing** button (`clearWatch`). Reloading the page never auto-restarts (a tap is required — also what iOS requires for the permission prompt).
4. 410 ⇒ `clearWatch`, "Delivery complete" state.
5. Browsers do not deliver geolocation to a page that is backgrounded or on a locked screen [INFERENCE: standard web-platform behaviour on iOS Safari and Android Chrome]. The page says so ("Keep this page open and the screen on; for continuous tracking dispatch can use your ELD"), offers an optional **Keep screen on** toggle (Screen Wake Lock, hidden when unsupported, default off), and the 5-minute cadence + the stale tone on the map are the honest result.

**Consent text (server-provided, versioned, rendered verbatim):**
> {broker} will receive this phone's location while this page is open — about every 5 minutes — until load {loadNumber} is delivered or you tap Stop sharing. It is used only to track this load. It is shown to {broker} dispatch and, as a map position, to the customer whose freight you are hauling. We keep it for 90 days. You can stop at any time; nothing is collected when the page is closed.

The customer sentence is omitted when the link's customer page hides the position (`showPosition === false`) — the server builds the string from `settings`/`division` name and the shipment's `CUSTOMER_VIEW` links. `consentAt` plus `consentVersion` (written into `LoadCheckCall.note` of the first ping row: `"Driver consented (ao-1)"`) is the audit trail.

**Rate limits summary:** 60 s per-link floor (existing), 1,500 pings per link, 30,000 GETs per link (existing, comfortably above 5-min polling), `MAX_ACCURACY_M` 5,000. No per-IP limit exists on a Function URL; the 192-bit token is the control, as for every other public route.

### 6.2 Customer page `/track/s/:token` (`CustomerTrackPage`) + `GET /s/<t>`
**Auth:** unchanged (`CUSTOMER_VIEW` token, 14-day default expiry). `customerView` gains, **only when `link.showPosition !== false`**:
```ts
map: {
  stops: Array<{ type: 'pickup' | 'delivery' | 'stop'; lat: number; lng: number }>   // facility coordinates rounded to 3 dp
  route: string | null                                                              // encoded polyline from the cached route row; null when never computed
  trail: Array<{ lat: number; lng: number; at: string; approx?: true }>             // <= 96 points, >= 15 min apart, 3 dp, inside trackingWindow
}
```
`position` keeps its current shape (the current fix, 3 dp) and now comes from `currentFix` over all sources. Never included: `source`, `accuracyM`, `speed`, `heading`, `refId`, phone numbers, the carrier (still only via `showCarrier`), approximate-fix radius. An approx fix is shown as `approx:true` (the page draws "near …" with a larger circle, no precision claim). The window is `trackingWindow()`; nothing before dispatch or after delivery + 2 h. The route is read-only from the cache (the public role has no server Maps key); `SEND_CUSTOMER_LINK` and `SEND_TRACKING_LINK` warm the cache best-effort (§7). The page replaces the one-point `FleetMiniMap` with the shared lazy map in **public mode** (no tooltips with times older than the window, no source legend), falling back to the SVG outline without a key.

---------------------------------------------------------------------------------------------------

## 7. Directions / route (quota, caching)

**Action** `GET_LOAD_ROUTE { loadId }` in `tms-tracking-actions/route.ts` (AO3). Authorization: the router's existing owner/ADMIN/`page-loads`/`page-tms` rule. Never throws for a Google problem — returns `source:'ESTIMATE'|'NONE'` with a `reason`.

1. Read the load's `stops`; waypoints = first pickup, intermediate stops (≤ 8), last delivery, each with `address.lat/lng` (round 5 dp for the request). A stop with an address but no coordinates is geocoded once with the existing server geocoder (`geocodeReply`'s Google call) and **not** persisted; a stop that cannot be geocoded drops the route to `NONE` with `reason:'Delivery address has no coordinates'`.
2. `key = sha1(lat,lng of every waypoint rounded to 0.01°)` (≈ 1 km: two loads on the same lane share a route).
3. `GetItem { truckId:'route:<key>', locatedAt:'route' }` (history table). Hit and `ttlEpoch*1000 > now` ⇒ return it with `cached:true`. **One Routes call per distinct lane per 30 days**; opening the drawer a hundred times costs nothing.
4. Miss: `POST https://routes.googleapis.com/directions/v2:computeRoutes`, headers `X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>`, `X-Goog-FieldMask: routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration`, body `{ origin, destination, intermediates, travelMode:'DRIVE', routingPreference:'TRAFFIC_UNAWARE', polylineQuality:'OVERVIEW', polylineEncoding:'ENCODED_POLYLINE', units:'IMPERIAL' }` (no traffic, no Pro field set — the cheapest SKU [INFERENCE: Routes API pricing tiers by field mask/preference; confirm in the Cloud console]). `duration` comes back as `"12345s"`. A 3-5 KB encoded overview polyline per cross-country lane.
5. Routes refused (403 / `REQUEST_DENIED`) **and** the project still has the legacy Directions API enabled ⇒ one retry against `maps.googleapis.com/maps/api/directions/json` (`overview_polyline.points`); else the estimate: straight legs `encodePolyline([w0, w1, …])`, `source:'ESTIMATE'`, drawn dashed with the caption "Estimated path — no road route available".
6. Write the row (`payload`, `ttlEpoch = now + 30 d`) with `attribute_not_exists(locatedAt) OR ttlEpoch < :now`; `ESTIMATE` results are cached for 1 day only (so a fixed key is picked up tomorrow), `NONE` is not cached.
7. Browser: `getLoadRoute(loadId)` once when the panel first expands (and again if the stops change); the polyline is decoded client-side by `decodePolyline` (no Maps `geometry` library needed, works for the SVG fallback too).

**Quota facts for Ryne:** the server key `GOOGLE_MAPS_API_KEY` must have **Routes API** enabled (the runbook lists Geocoding, Places (New), Time Zone only) — Q2. The browser key needs **Maps JavaScript API** (already used by the board map) and nothing else. Browser map loads are billed per map load; the panel mounts the map lazily and only while expanded.

---------------------------------------------------------------------------------------------------

## 8. The map panel and the drawer layout

### 8.1 Files (all under `src/features/shipments/workstations/tracking/map/`, AO5)
| File | Role |
|---|---|
| `TrackingMapPanel.tsx` | Eager shell: header row (28 px) + collapsible body; owns collapse state; calls `getLoadRoute`; wraps the lazy body in `Suspense`. Props `{ bundle, tracking: LoadTracking, summary: TrackingSummary, links: TrackingLinkRecord[], onProviderChanged: () => void }`. |
| `TrackingRouteMap.tsx` | `React.lazy` target — Google implementation (`APIProvider` + `Map` + `AdvancedMarker`s + polylines; `@vis.gl/react-google-maps` is already a dependency). |
| `FallbackRouteMap.tsx` | The SVG outline map extracted from `TrackingDetailMap.tsx` `StaticRouteMap` (us-atlas + d3-geo + `useTmsTokens`), extended to draw the route path, breadcrumb dots, current marker, approx circle. Used with no key, on Maps auth failure, or when the Google chunk fails to load. |
| `mapModel.ts` | Pure: `buildMapModel({ bundle, fixes, current, route, nowMs, mode })` → `{ pins, path, dots, currentMarker, approxCircle, bounds, caption }` — the single thing both renderers draw (and the unit-test target). |
| `ProviderMenu.tsx` | The overflow menu of §5.6. |

### 8.2 Behaviour
* **Placement:** inside `.tms-tracking-view`, between `TrackingSummaryStrip` and `.tms-tracking-panes`: `<TrackingMapPanel/>` renders `<section class="tms-map-panel" data-testid="tracking-map-panel">`.
* **Header row (always visible, 28 px):** `Map` · chevron toggle (`data-testid="tracking-map-toggle"`, `aria-expanded`) · current-position text (`tracking-map-current`): **"Joliet, IL · 14 min ago · Driver phone (link)"** with a tone dot (green < 15 min, amber 15-60, gray > 60 + "stale") · **ETA** chip (`tracking-map-eta`, the `summary.eta` text — one ETA, shared with the strip) · remaining-miles chip ("~312 mi to go", `remainingMiles` over the decoded route; omitted when off-route/unknown) · "approx." badge when an overlay exists · provider badge ("MacroPoint · STUB") · overflow menu.
* **Body:** `height: 232px` (header + body = 260 px) at 1440 wide; collapsed state persisted in `localStorage['tms.tracking.map.collapsed']` (default **expanded**). Collapsing sets body height 0 with no animation (no reflow flicker).
* **Layers:** pickup pin (green "P"), delivery pin (blue "D"), intermediate stops (small gray); route polyline (solid for `ROUTES_API`/`DIRECTIONS_LEGACY`, dashed gray for `ESTIMATE`); breadcrumb dots (`thinFixes(fixes, 10, 150)`; each `AdvancedMarker` has `title="Nov 4, 3:57 AM · Motive ELD"`; a visible time label on the first, last and every ~60 min dot to avoid clutter); the **current marker** (larger, tone-coloured, pulsing only while `fresh`); an accuracy halo when `accuracyM > 100`; the approx overlay circle (`radius = accuracyM`) with a dashed outline; a warning glyph on a > 500 mi jump (§4.3).
* **Viewport:** fit to current ∪ delivery ∪ pickup on first paint and when the load changes; **never refit on a poll** (a dispatcher panning must not be yanked back) — a "Recenter" button in the header refits.
* **Lazy load:** `TrackingRouteMap` and its Maps loader are `React.lazy(() => import('./TrackingRouteMap'))`, mounted only when expanded; nothing from Google loads for a collapsed panel. The key comes from `import.meta.env.VITE_GOOGLE_MAPS_API_KEY` and Map ID from `VITE_GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID'` (Advanced Markers need a Map ID; `.env.example` L13 already documents the default). **No key in the repo.**
* **Mode (`data-mode` on `tracking-map`):** `google` (key present, library loaded) · `fallback` (no key — caption "Google map not configured — showing outline"; or `window.gm_authFailure` fired — "Google rejected the map key — showing outline"; or the lazy chunk failed) · `unavailable` (the SVG data also failed to load: plain text "Map unavailable" with the position as text, `tracking-map-unavailable`). The panel never shows Google's own error overlay for more than the instant before `gm_authFailure`, and never blocks the rest of the drawer.
* **Empty states (all inside the panel, same height):** no fixes and no route ⇒ "No position yet — send a tracking link or log a check call"; fixes but no coordinates for the stops ⇒ pins omitted + caption "Stop coordinates missing"; route `NONE` ⇒ breadcrumbs only.
* **Polling:** the panel reads `tracking` (60 s, incremental); it adds no timer. The age text recomputes from `tracking.nowMs`.

### 8.3 Inline tracking-prefs row (the AJ follow-up) — exact component changes
Root cause: `TrackingPrefsPopover` (`TrackingPrefsPopover.tsx`) renders its form as `<div class="tms-strip-menu tms-prefs-panel" role="dialog">`, `position:absolute; top:100%; z-index:70` under a header button, so it floats over the strip and the SMS pane.

| File | Change |
|---|---|
| `tracking/TrackingPrefsRow.tsx` (**new**) | Same props as the popover `{ shipment, customer, onSaved }` and the same logic (`draftOf`, `overrideOf`, `effectiveTrackingPrefs`, `parseTrackingPrefs`, `setTrackingPrefs`, `toast.error` on failure — moved verbatim). Renders `<div class="tms-strip-prefs" data-testid="tracking-prefs-row">`: label **Tracking** · `TmsSelect size="sm"` **Mode** · **Method** · **Driver SMS to** (aria-labels unchanged: `Mode`, `Method`, `Driver SMS to`) · **Save** (primary, `disabled` unless dirty or busy) · **Reset** (ghost, disabled unless dirty) · trailing muted read-out `In force: AI agent · E-mail + SMS · truck phone` (`data-testid="tracking-prefs-effective"`) · the existing "customised" dot (`tracking-prefs-dot`) when an override exists. Option labels are the **short** forms: Mode `Inherit · AI agent` / `AI agent` / `Manual`; Method `Inherit · E-mail + SMS` / `E-mail` / `SMS` / `E-mail + SMS`; Driver SMS to `Inherit · truck phone` / `Truck phone, then personal` / `Truck phone only` / `Personal phone` (the "(not set)" wording in the screenshot is gone: unset reads `Inherit · not set`). No `role="dialog"`, no `position:absolute`, no `useRef` outside-click handler. Draft re-initialises when the stored override changes (`useEffect` keyed on `JSON.stringify(override)`, written as a derived-state reset to satisfy `react-hooks/set-state-in-effect`). |
| `tracking/TrackingPrefsPopover.tsx` + `.test.tsx` | **Deleted** (clean cutover). Its four tests move to `TrackingPrefsRow.test.tsx` with the interaction rewritten (§10). |
| `tracking/TrackingSummaryStrip.tsx` | Optional prop `prefs?: ReactNode`. The existing seven segments move into `<div className="tms-strip-line">`; when `prefs` is given it renders as a second child `<div className="tms-strip-line tms-strip-line-prefs">`. Without `prefs` the DOM is the same one line as today (so `CheckCallsSection` and its mocked-strip test are unaffected). |
| `tracking/ShipmentTrackingView.tsx` | `<TrackingSummaryStrip … prefs={<TrackingPrefsRow shipment={shipment} customer={customer} onSaved={() => actions.reload()} />} />`; inserts `<TrackingMapPanel/>` after the strip. |
| `tracking/TrackingDrawer.tsx` | Remove the `TrackingPrefsPopover` import and its `headerExtra` child (keep "Manage links" and "Open full page"); the `refresh` destructure is used only for `onSaved` today — drop it if nothing else needs it (builder checks). |
| `components/TrackingSection.tsx` | Remove the import and the `<div className="ml-auto">…TrackingPrefsPopover…</div>` block (L78-81). |
| `conversation.css` | `.tms-strip` becomes `display:flex; flex-direction:column; gap:4px` (padding/border unchanged); the old flex declarations (`display:flex; align-items:center; gap:12px; white-space:nowrap; overflow:visible`) move to `.tms-strip-line`; new `.tms-strip-line-prefs { height:28px; flex:0 0 28px; gap:8px }`, `.tms-strip-prefs .tms-select { height:24px; font-size:12px }` with fixed widths (Mode 128, Method 150, SMS 168); delete `.tms-prefs-panel`, `.tms-prefs-field`, `.tms-prefs-foot`. `.tms-strip-menu` stays (the **next-check reminder** menu is a separate, small control and is not part of this ask). Add `.tms-map-panel*`. Both selectors `.tms-shell …` and `.tms-portal …` per file convention. |

**Why the drawer cannot reflow:** the row is rendered unconditionally with a fixed 28 px height; Save/Reset are always present (disabled, not removed); selects have fixed widths; no portal, overlay or conditional height anywhere in the control. The harness measures it (§11, AO09).

**Single-chip alternative (Ryne's other option):** `Tracking: AI · Email+SMS · truck phone` as a chip that expands inline would have to reserve the expanded height to avoid pushing the panes (defeating its compactness) or accept a reflow. Rejected as D-AO12; the read-out text in the row gives the same at-a-glance sentence.

### 8.4 Vertical budget at 1440 × 900 (drawer body)
Header 49 + strip 34 + prefs 28 + gaps 8×3 + map 260 + panes (min 280) + check calls ≈ 170 ⇒ ≈ 845 px, inside the 900 px viewport; panes keep their `min-height:280px`, and on shorter windows the drawer body scrolls as it does today. Collapsed map: −232 px.

### 8.5 Full-page Tracking tab
`TrackingSection` already mounts `ShipmentTrackingView`, so the panel appears there too. `TrackingDetailPanel.tsx` (below it) drops its `TrackingDetailMap` card (L111 and its slot) and `TrackingDetailMap.tsx` is deleted with its `.tms-detail-map*` CSS; `googleMapsExtras.ts` stays (the ETA geo code in the same panel still imports it).

---------------------------------------------------------------------------------------------------

## 9. Privacy and security notes
* **Consent** (§6.1) is explicit, versioned, server-recorded, and required before the first geolocation call and before the first write; no ping row exists without a `consentAt` on its link (provider and Motive rows have their own consent basis — the carrier's agreement with the provider / BCAT's own fleet).
* **Purpose and sharing:** dispatch staff and, when the customer link shows position, the customer. Customer view: rounded to 3 dp (~110 m), ≥ 15 min apart, inside the tracking window, no source/accuracy/speed.
* **Stops:** Stop sharing (client), delivery (server 410), link expiry (existing), revoke (existing `REVOKE_TRACKING_LINK`), TTL 90 d.
* **SSRF:** the short-link resolver only ever fetches `isAllowedShareHost` URLs over https, manual redirects, each hop re-checked, 3 s, ≤ 3 hops, no cookies.
* **Auth on writes:** the public Lambda can `PutItem` only to the history table and the existing tables; clients can no longer create/update/delete history rows (D-AO10), so a signed-in user cannot forge a breadcrumb the customer would see.
* **Logs/harness:** coordinates are never logged by the Lambdas (`console.warn` carries ids and counts); the harness prints counts, ids, masked tokens (`abcd…`), never lat/lng of a real driver (all fixtures are ZZ with fictional coordinates).
* **Data minimisation:** the shared-pin and geocode paths store the coordinates, the place label and `refId` — not the message text on the ping row (the message itself is already in the thread).

---------------------------------------------------------------------------------------------------

## 10. Tests (behavioural only; each fails on a plausible bug)

Conventions: vitest, `// @vitest-environment jsdom` for components, in-memory DynamoDB doubles as in `tracking-api/handler.test.ts` / `thread.test.ts`. Nothing asserts wiring, field copies or source text.

| File (owner) | Cases |
|---|---|
| `src/lib/trackingPings.test.ts` (AO1) | `pingRow`: `truckId='load:<id>'`, `locatedAt` = the fix time, `ttlEpoch` = fix + 90 d, no `ttlEpoch` leak onto a Motive-shaped input. `fixOfRow` rejects out-of-range / NaN / missing lat. `currentFix`: newest wins; **a newer approx fix does not replace a 3-hour-old precise fix** (becomes `overlay`) **but does replace a 5-hour-old one**; tone thresholds 14/16/61 min. `thinFixes` keeps first and last. `mergeFixes` collapses same-source < 1 s, keeps cross-source. `remainingMiles` along a known 3-vertex path, `null` when 40 mi off route. `sourceLabel`/`trustRank` for `provider:macropoint`. |
| `src/lib/polyline.test.ts` (AO1) | Decode Google's documented vector `_p~iF~ps|U_ulLnnqC_mqNvxq`@ → (38.5,-120.2), (40.7,-120.95), (43.252,-126.453); `encode(decode(x)) === x`. |
| `src/lib/locationShare.test.ts` (AO1) | Apple (`?ll=`, `?sll=`, `?q=41.5,-88.1`), Google (`?q=`, `/@lat,lng,17z`, `!3d…!4d…`, `maps.google.com/?q=`), raw `41.5251, -88.0817`, `lat 41.5 lng -88.1`; short links return `SHORT_LINK`; **false positives rejected**: phone `312.555.0142`, PRO `99270`, dates `11/4/2026`, `1.5, 2.5`, `12345.678, 99.1` (needs ≥ 3 decimals each and plausible lat/lng, US/AK/HI/PR box); `looksLikePlace`: "just passed Gary IN" ✓ "in Dallas tx" ✓ "Joliet, IL" ✓ "Thanks" ✗ "ok" ✗ "on my way" ✗; `isAllowedShareHost` refuses `http:`, `goo.gl.evil.com`, `google.com.evil.io`, an IP; `textOfVcard` pulls the Apple Maps URL from a `.vcf`. |
| `amplify/functions/_shared/trackingPings.test.ts` (AO1) | `putPing` duplicate → `'DUPLICATE'`, no throw; `ingestProviderDelivery`: unknown reference ignored, wrong provider ignored, closed load ignored (no write), > 100 fixes truncated, replay of the same `refId` writes nothing twice, link counters incremented by the accepted count only. |
| `src/lib/integrations/trackingProvider.test.ts` (AO1) | `trackingPortFor` stays STUB with full credentials and no live port, and with a live port + neutered credentials (`disabled-on-dev`); goes LIVE only with both; stub `subscribe` message starts `STUB — `; stub `parseDelivery` accepts the SIM shape and rejects a MacroPoint-looking body. |
| `src/hooks/useLoadTracking.test.ts` (AO1) | First read fetches the whole window, second read fetches only newer rows (assert the `from` argument); fixes from Motive, load pings and `Load.lastKnown*` fallback merge; a failed breadcrumb read keeps the last good list. |
| `tracking-api/handler.test.ts` (AO2, extends the existing ping tests) | Ping without `consent` on a fresh link → 403 and **no** ping row, no counter bump; with `consent:true` → ping row (condition `attribute_not_exists(locatedAt)`, `ttlEpoch` ≈ +90 d), `consentAt` set once; second ping 61 s later → ping row but **no** second check-call row; ping on a delivered load → 410 and no write; imprecise → 409; 1,500th ping refused. `GET /l/<t>`: `share.consentRequired` flips after consent, `share.active:false` on a closed load. `GET /s/<t>`: `map.trail` thinned to ≥ 15 min and rounded to 3 dp, contains **no** `source`/`accuracyM`/`speed`/`refId` anywhere in the serialised body, includes an `approx:true` point flagged, is absent when `showPosition:false`, excludes fixes before dispatch / after delivery + 2 h, includes `route` only when a cached row exists. |
| `src/lib/trackingLink.test.ts` (AO2) | `customerView` map projection and `carrierView.share` (pure); `linkExpiry('PROVIDER_TRACK', …)` equals the `CARRIER_PING` rule. |
| `CarrierPingPage.test.tsx` (AO2) | `getCurrentPosition`/`watchPosition` are **not** called before consent; after consent the first fix posts immediately and later fixes post no more often than `everyMin` (fake timers); Stop sharing clears the watch and no further post happens; a 410 clears the watch and shows the done state; 429 does not show an error. |
| `CustomerTrackPage.test.tsx` (AO5) | Renders the trail in fallback mode with `data-fixes`; renders nothing about a trail when `map` is absent; never prints a source or accuracy string. |
| `tms-tracking-actions/thread.test.ts` (AO3) | Apple-Maps text → `LOCATION_UPDATE` with coordinates + a `sms-share` ping + `Load.lastKnown*`; Google short link resolved through the injected resolver → ping; **resolver refusing a non-allow-listed hop → NOTE, no ping**; "Thanks" → NOTE, **geocode dep called zero times**; "just passed Gary IN" → `sms-geocode` ping with `approx:true` and `accuracyM ≥ 2000`; the same Twilio sid twice → one ping; `putPing` failure does not roll back the message/check call. |
| `tms-tracking-actions/route.test.ts` (AO3) | `GET_LOAD_ROUTE`: miss → one Routes call (assert URL, field mask header, body) → row written with `ttlEpoch`; hit → zero calls, `cached:true`; expired hit → refetch; Routes 403 + no legacy → `ESTIMATE` with a reason, cached 1 day; missing key → `ESTIMATE`; stop without coordinates → geocoded once, else `NONE`; Google network error never throws; two loads on the same lane share one row. |
| `tms-tracking-actions/handler.test.ts` (AO3) | `SEND_TRACKING_LINK`: own-asset leg **with** a fresh `TruckLocation` still refuses; own-asset leg whose truck last reported > 2 h ago (or has none) is allowed and texts the truck work phone; a `PROVIDER_TRACK` row on the leg is not revoked by a new `CARRIER_PING`; sim doors throw when `BCAT_DEV_STACK !== 'true'`. |
| `tms-tracking-actions/providers.test.ts` + the `POST /api/webhooks/<provider>` block of `tracking-api/handler.test.ts` (AO4; AO2 owns the other blocks of that file, so AO4 adds a new `describe` at the end of the file and touches no existing one) | `START_PROVIDER_TRACKING`: refuses an own-asset leg, a non-`TRACKING` provider, a provider without `track`, a closed load; STUB result recorded with the STUB message; second start revokes the first; `webhookRoute` for a connected tracking provider with a valid HMAC and a SIM body → pings written for the right load with `source 'provider:macropoint'`, a replayed delivery writes none; a delivery for a revoked/expired link, a closed load or an unparseable body → 200 `received`, no write. **Chain test:** that `webhookRoute` output is read back through `fixOfRow` → `buildMapModel` and asserts the current marker, source label and dot count. |
| `src/lib/integrations/registry.test.ts` (AO4) | The `track` providers (`MACROPOINT`, `TRUCKER_TOOLS`, `LOAD_MARKET`) still have `liveCapabilitiesOf(d)` without `track` — the registry does not claim a live capability the repo cannot perform. |
| `map/mapModel.test.ts` (AO5) | Pins, path, dots thinned to ≤ 150 and ≥ 10 min apart, current marker colour by tone, approx circle radius from `accuracyM`, jump warning at > 500 mi / 30 min, bounds, empty-state captions. |
| `map/TrackingMapPanel.test.tsx` (AO5) | No key → `data-mode="fallback"` and the Google library is never imported (spy on the lazy module); `gm_authFailure` → fallback + caption; collapsed state persists across remounts and mounts no map; header shows "place · N min ago · Driver phone (link)" and the **same** ETA text as the strip's `delivery-eta`; stale tone after 61 min; approx badge only with an overlay; Google branch with `@vis.gl/react-google-maps` mocked renders one marker per thinned dot and a polyline from the decoded route; STUB provider badge; `Start MacroPoint tracking (STUB)` calls `startProviderTracking`. |
| `TrackingPrefsRow.test.tsx` (AO5, replaces `TrackingPrefsPopover.test.tsx`) | Shows the effective values (inherit → customer value, override → pin) and the dot only when overridden; the three selects are in the DOM without any click and **no element with `role="dialog"` ever exists**; Save disabled until a change; saves only pinned keys; all-inherit saves `null`; Reset restores; a failed save keeps the draft and toasts. |
| `TrackingSummaryStrip.test.tsx` (AO5, new) | With `prefs` the strip has two lines and the first line's segments are unchanged; without `prefs` the DOM is one line (guards `CheckCallsSection`). |
| `ShipmentTrackingView.test.tsx` (AO5, updated) | Map panel is between the strip and the panes (DOM order); the prefs row is inside `tracking-strip`; the old `tracking-prefs-button` is gone. |
| `TrackingSection.test.tsx` (AO5, updated; there is no `TrackingDrawer` test file) | The section header no longer renders the prefs control (the row is inside the mounted `ShipmentTrackingView`). |

Deleted tests: `TrackingPrefsPopover.test.tsx` (`TrackingDetailMap` has no test file). Existing tests that pin removed behaviour are rewritten to the new contract, not re-pinned to old wording.

---------------------------------------------------------------------------------------------------

## 11. `scripts/devVerifyAO.mjs` — harness (SIM pings, no real GPS, dev only)

Pattern: `devVerifyAJ.mjs` (dev AppSync only, dev pool only, `ALLOWED_ORIGINS`, refuses prod suffix `5ucwdyvwivelbo4k4jomvrwel4`, `--inventory`, `--only=`, `--no-dark`, two throwaway identities `zz-ao-admin-<ts>` / `zz-ao-tms-<ts>` created and deleted + proven gone in `finally`, ZZ fixtures voided/archived in `finally`, no SSM, no main, no `invoice_*.json`, no Aljex export). Output carries ids, counts and masked tokens; every coordinate is fictional (an I-80 corridor, Joliet IL → Gary IN → Toledo OH). Nothing is texted (Twilio unset: `via:'COPY'`).

`--inventory` (no network): every file the plan creates exists, every `data-testid` the steps use is in source, the AO actions are in the `Action` union, the prefs popover and `TrackingDetailMap` are gone, no source file still imports them.

| Step | What it proves | How |
|---|---|---|
| AO01 schema | New attributes readable; `TrackingLink.kind` accepts `PROVIDER_TRACK`; `TruckLocationHistory` create/update/delete mutations are **not** exposed (D-AO10) | GraphQL introspection + a read of a SIM row |
| AO02 sim pings → read | `TRACKING_SIM_PINGS` writes 12 fixes (link ×6, sms-share ×2, sms-geocode ×1 approx, provider:macropoint ×3) for a ZZ brokered load; `listLoadBreadcrumbs` returns 12; ordering, `ttlEpoch ≈ +90 d`, replay writes nothing | `routerAs(admin)` + `gql` |
| AO03 public ping (b) | Mint a COPY link; `GET /l/<t>` says `consentRequired`; ping without consent = 403 and zero rows; with consent = 200 and one breadcrumb + one `TRACKING_PING`; a second ping inside 60 s = 429; ping after a SIM delivery (`DELIVERED`) = 410 | `fetch` against the dev `TrackingApiFunctionUrl` |
| AO04 shared SMS (c) | `INGEST_SHIPMENT_MESSAGE` equivalent through the sim text door (`TRACKING_SIM_TEXT`): Apple URL, Google long URL, raw coords → `sms-share` pings; a short link to a non-allow-listed host → NOTE, no ping | `TRACKING_SIM_TEXT` (AO3, same dev gate) |
| AO05 check-call text (d) | "Thanks" → no geocode, no fix; "just passed Gary IN" → one approx fix with radius; strip "Last known" shows it but the map's current marker stays on a fresher precise fix | same door + UI read |
| AO06 own assets (a) | Direct DynamoDB put of 8 `motive` rows for a ZZ truck in the load's window (AJ harness precedent, dev suffix only); the merged read shows them with the load pings; the real `motive-location-sync` is never called | AWS SDK |
| AO07 provider (f) | `START_PROVIDER_TRACKING` (STUB message, `PROVIDER_TRACK` row, no HTTP out) → `TRACKING_SIM_PROVIDER` 5 fixes → `provider:macropoint` rows; stop → revoked; an own-asset leg is refused | router |
| AO08 route | `GET_LOAD_ROUTE` twice: first `cached:false`, second `cached:true`; with the neutered dev key the source is `ESTIMATE` with a reason (never an error); one `route:<sha1>` row exists | router + SDK read |
| AO09 customer page | `GET /s/<t>` JSON contains `map.trail` with the expected thinning, no `source`/`accuracy`/`speed` strings anywhere in the body, carrier absent unless `showCarrier`; a second link with `showPosition:false` has no `map`/`position` | `fetch` |
| AO10 UI drawer | `/tms/tracking?shipment=<id>` at 1440×900: `tracking-map-panel` between strip and panes; `data-mode` is `fallback` (dev key neutered) with the SVG; `data-fixes`, `data-breadcrumbs`, `data-current-source` match AO02/AO06; header text contains the source label and age; collapse/expand persists across a reload; ETA text equals `delivery-eta`; no console errors beyond the allow-listed "dev Maps key is neutered" | CDP via `launchBrowser` |
| AO11 prefs row | Selects present with no click; read `getBoundingClientRect().top` of `tracking-panes`, change all three selects, click Save, wait for the toast, re-read: **delta 0 px** and no `[role=dialog]`, no `.tms-prefs-panel`; the saved override reads back (`getShipmentBundle`) and the dot appears | CDP |
| AO12 driver page UI | `/track/l/<t>` at 390×844: consent text visible, **Start sharing** disabled until the box is ticked, geolocation not requested before the tap (CDP permission left at "prompt"); then `Browser.grantPermissions(['geolocation'])` + `Emulation.setGeolocationOverride` (a new `setGeolocation(lat, lng, accuracy)` helper in `cdpBrowser.mjs`) → first fix posts, status line "Sharing · last sent …", Stop sharing works; a delivered load shows the done state | CDP |
| AO13 customer page UI | `/track/s/<t>` renders the trail in fallback mode; the `showPosition:false` link renders no map | CDP |
| AO14 Google branch | **SKIP with reason** on dev (neutered key); runs only when `DEV_VERIFY_MAPS=1` is set by someone with a referrer-valid key, asserting `data-mode="google"` and the marker count | env flag |

Order in the file follows the table; AO02 creates the fixtures the later steps use. Exported `AO_STEPS` (ids + slugs) is imported by the route registries the way `AJ_STEPS` is.

---------------------------------------------------------------------------------------------------

## 12. Slices, ownership, landing order

**Landing:** AO1 → { AO2, AO3, AO4, AO5 in parallel } → AO6. One deploy for all (dev), then `devVerifyAO` and the template gate. Cross-slice contracts are §3 (types/signatures), §5.2 (port), and these handler signatures: `startProviderTracking(deps, input, caller): Promise<Row>`, `stopProviderTracking(...)`, `simProviderDelivery(...)` exported from `tms-tracking-actions/providers.ts` (AO4) and wired by **one `case` line each** in `handler.ts` (AO3 adds the `Action` union entries and the three `case` lines; AO4 never edits `handler.ts`).

### AO1 FOUNDATION (first)
Owns: `amplify/data/resource.ts` (§2.1-2.2 attributes, `kind` enum, authorization/disableOperations on `TruckLocationHistory`), `amplify/backend.ts` (one append-only "Step AO" block: TTL; the two `tracking-api` ARN appends; the `tms-tracking-actions` env + statement incl. `TruckLocation` `GetItem`), `src/types/tms.ts`, `src/lib/trackingPings.ts`, `locationShare.ts`, `polyline.ts`, `trackingTimeline.ts` (additive), `amplify/functions/_shared/trackingPings.ts`, `src/lib/integrations/trackingProvider.ts`, `src/lib/apiClient.ts` (AO block: `listLoadBreadcrumbs`, `getLoadRoute`, `startProviderTracking`, `stopProviderTracking`, `TRUCK_LOCATION_HISTORY_FIELDS` + `loadId accuracyM approx`, `TrackingLink` fields), `src/hooks/useLoadTracking.ts`, and their tests (§10). Acceptance: `tsc` app/node/amplify clean, the AO1 tests green, `measureDataTemplate.mjs` run by Main.

### AO2 PUBLIC EDGE
Owns: `tracking-api/handler.ts` (`pingRoute`, `carrierRoute`, `customerRoute`, constants `MAX_LINK_PINGS 1500`), `src/lib/trackingLink.ts` (`customerView.map`, `carrierView.share`), `src/lib/trackingClient.ts` (ping body, `share`, 403/410 handling), `src/features/tracking/CarrierPingPage.tsx` (+ test), and the `tracking-api/handler.test.ts` ping / carrier / customer cases. The customer **page** is AO5's (it renders the shared map), so AO2 and AO5 never touch the same file; the JSON shape AO5 consumes is `CustomerTrackingView.map` from §6.2, typed by AO1. Acceptance: §6 table, tests in §10.

### AO3 SERVER INGEST + ROUTE
Owns: `tms-tracking-actions/thread.ts` (share parse → ping, gate, `ThreadDeps` optional deps `reverseGeocode`, `resolveShareLink`, `putPing`), `handler.ts` (`geocodeReply` radius, `reverseGeocode`, `resolveShareLink`, `sendTrackingLink` relax, `case` lines for `GET_LOAD_ROUTE`, `START_/STOP_PROVIDER_TRACKING`, `TRACKING_SIM_PINGS`, `TRACKING_SIM_TEXT`, `TRACKING_SIM_PROVIDER`, cache-warm calls in `sendTrackingLink`/`sendCustomerLink`, best effort), new `route.ts`, `shareIngest.ts`, `dispatch-twilio-webhook/handler.ts` (vCard hunk only), tests. Acceptance: §4.3, §4.4, §7.

### AO4 PROVIDER SLOT
Owns: `tracking-api/api.ts` (`webhookRoute` consumption hook), new `tracking-api/providerTracking.ts`, new `tms-tracking-actions/providers.ts`, `registry.test.ts` expectation, tests. Acceptance: §5, chain test in §10.

### AO5 UI
Owns: `tracking/map/*` (new), `tracking/TrackingPrefsRow.tsx` (new), `TrackingSummaryStrip.tsx`, `ShipmentTrackingView.tsx`, `TrackingDrawer.tsx`, `components/TrackingSection.tsx`, `tracking/TrackingDetailPanel.tsx` (map card removal only), `src/features/tracking/CustomerTrackPage.tsx` (+ test; replaces the one-point `FleetMiniMap` with the shared lazy map in **public mode** — no source legend, no tooltips, trail from `map.trail`), `conversation.css`, deletions (`TrackingPrefsPopover.tsx` + test, `TrackingDetailMap.tsx`, `.tms-detail-map*` CSS), tests. Acceptance: §8, tests in §10, no hard-coded colours (kit tokens via `useTmsTokens`/`var(--tms-*)`).

### AO6 HARNESS + DOCS (last)
Owns: `scripts/devVerifyAO.mjs`, `scripts/lib/cdpBrowser.mjs` (`setGeolocation`), the route registries that enumerate harness steps (`scripts/lib/aaRoutes.mjs`, `uRoutes.mjs`, `devVerifyS2.mjs` `ROUTES` — add `/track/l/*` and `/track/s/*` screenshots only if those registries enumerate public routes; builder confirms), `Docs/tms-build/BUILD_LOG.md` entry text, `Docs/WORKFLOWS.md` tracking paragraph, `Docs/POST-DEPLOY-RUNBOOK.md` (enable Routes API on the server key; confirm `VITE_GOOGLE_MAPS_API_KEY`/`VITE_GOOGLE_MAPS_MAP_ID` on the dev branch), the merge-to-main checklist bullets (TTL on `TruckLocationHistory`; the CRUD-disable; no backfill). **Runs** after the deploy; writes screenshots.

---------------------------------------------------------------------------------------------------

## 13. Screenshots (`Docs/tms-build/screenshots/ao/`, `index.txt` lists them; 1440×900 unless noted)

1. `01-drawer-map-expanded` (light) — strip, prefs row, map (fallback on dev), panes, check calls above the fold
2. `02-drawer-map-expanded-dark`
3. `03-drawer-map-collapsed`
4. `04-prefs-row-idle` (crop of the strip)
5. `05-prefs-row-dirty` (Save enabled)
6. `06-prefs-row-saved-no-reflow` (before/after stacked, panes top aligned)
7. `07-map-all-sources` (link + sms-share + provider + motive dots, source legend/tooltips text)
8. `08-map-approx-overlay` (driver-said circle beside a precise marker)
9. `09-map-stale` (gray tone, "stale")
10. `10-map-no-key-fallback` (caption)
11. `11-map-unavailable` (SVG data blocked)
12. `12-map-provider-stub` (badge + menu)
13. `13-tracking-tab-full-page` (map above the old cards; the removed detail map is gone)
14. `14-driver-consent` (390×844)
15. `15-driver-sharing` (390×844)
16. `16-driver-done` (390×844)
17. `17-customer-trail`
18. `18-customer-no-position`

---------------------------------------------------------------------------------------------------

## 14. Risks

| # | Risk | Mitigation / owner |
|---|---|---|
| R1 | **Google-rendered markers cannot be verified on dev** (neutered key, F13); the `google` branch is only unit-tested with the library mocked. | Fallback + data are proven on dev; AO14 runs on any env with `DEV_VERIFY_MAPS=1`; Ryne eyeballs the first prod-like load. `gm_authFailure` path means a bad key degrades to the outline, not a broken drawer. |
| R2 | **Key naming/identity (Q1)**: `VITE_GOOGLE_MAPS_API_KEY` vs `GOOGLE_PLACES_API_KEY`. | Code uses `VITE_GOOGLE_MAPS_API_KEY` only; Ryne sets the value in the Amplify branch env. |
| R3 | **Routes API not enabled on the server key (Q2)** ⇒ every route is an `ESTIMATE`. | Visible caption + `reason`; runbook line; not an error. |
| R4 | **Template headroom** (29.3 KB, with AG/AI/AL queued). | AO ≤ +2 KB stop-line, D-AO10 offset, §0.3 fallbacks; Main measures after AO1 and last. |
| R5 | **Browser geolocation stops when the page is backgrounded** [INFERENCE]; tap-to-share is best-effort, not an ELD. | Honest copy on the page, stale tone on the map, provider slot / Motive for continuous tracking; cadence is a server value (`everyMin`) so it can change without a deploy of the page. |
| R6 | **Privacy**: a driver's personal phone location reaching a customer. | Consent text names the customer; `showPosition:false` honoured; delivery stops sharing; 90-day TTL; thinned/rounded customer trail; Q3 asks Ryne to confirm the consent wording with whoever owns driver agreements. |
| R7 | **False positives in (c)/(d)** (phone numbers, PRO numbers, chatter) producing a wrong position on a customer-visible map. | `parseLocationShare` needs ≥ 3 decimals + plausible range; `looksLikePlace` gate; approx never overrides a fresh precise fix; jump warning; sender must be a matched driver with one resolvable live load. |
| R8 | **Short-link resolver SSRF / abuse.** | `isAllowedShareHost` on every hop, https only, manual redirects, 3 s, 3 hops, no body read beyond the redirect target. |
| R9 | **iOS vCard assumption** (F3) is unverified. | Marked [INFERENCE]; harness covers text forms; if the real payload differs only `textOfVcard` changes (pure, one file). |
| R10 | **Provider LIVE contract unknown** (MacroPoint / Trucker Tools callback auth, subscription payloads). | Port + STUB only; LIVE blocked on credentials and the provider's docs; `liveCapabilities` stays honest (Q4). |
| R11 | **TTL on a table that has 65k+ untouched rows** — enabling TTL scans nothing for rows without the attribute, but the first deploy of the TTL spec is a one-time table update, and DynamoDB allows a TTL change once per hour. | Only one deploy changes it; rows without `ttlEpoch` are never touched. |
| R12 | **History GSI eventual consistency**: a ping written by the public Lambda may not be in the `truckId+locatedAt` index for a moment. | The drawer polls every 60 s; the driver page confirms from the POST response, not a re-read. |
| R13 | **Cost of polling**: 1,000 breadcrumb rows per 60 s poll per open drawer. | Incremental reads after the first (§3 `useLoadTracking`); thinning in the model; map collapsed ⇒ no map work (the hook still polls, as today). |
| R14 | `Load.lastKnown*` is not updated by ping/watch traffic, so the board's "Last location" column can lag the drawer for a link-tracked load (as it does today for link pings). | Deliberate (D-AO16: a Load write per ping would churn `updatedAt` CAS and the Load stream). Out of scope; the drawer and the strip read the timeline first. |

---------------------------------------------------------------------------------------------------

## 15. Decisions (defaults taken; Ryne can overrule any)

| ID | Question | Default | Alternative and cost |
|---|---|---|---|
| D-AO1 | Where do pings live? | Reuse `TruckLocationHistory` with `truckId='load:<id>'` (§2.1) | New `TrackingPing` model, `identifier(['loadId','at'])`, no GSI: +3.8 KB (+5.5-7.5 KB with two GSIs and TTL) — does not fit beside AG/AI/AL |
| D-AO2 | Copy Motive fixes into the ping store? | No; the reader unions (F4) | 20-line addition to `motive-location-sync` using `putPing`; doubles 6 rows/hour/truck |
| D-AO3 | Route source | Routes API server-side, cached 30 d per lane, estimate fallback | Browser `google.maps.routes.Route.computeRoutes` (key exposure, per-open billing, no cache); legacy `DirectionsService` (deprecated) |
| D-AO4 | Tap-to-share cadence / caps | 5 min client, 60 s server floor, 1,500/link, one check-call row per 30 min | 2 min cadence = ~2.5× rows and more battery; setting in `TmsSettings` if wanted (free attribute) |
| D-AO5 | Retention | 90 d pings, 30 d routes | Longer for claims: change the constant |
| D-AO6 | Consent | Required, versioned, server-recorded, per link | None (not recommended) |
| D-AO7 | What the customer sees | Thinned (15 min), 3 dp, route, approx flagged, no metadata | Current marker only (today's behaviour) |
| D-AO8 | Approx vs precise | Approx never replaces a precise fix < 4 h old | Newest wins always (can show a city centre over a real GPS fix) |
| D-AO9 | Tracking link to own-asset legs | Allowed only with no ELD fix for 2 h | Keep refusing always (then a Motive-less own truck can only be tracked by SMS pins) |
| D-AO10 | Disable GraphQL create/update/delete on `TruckLocationHistory` | Yes (nothing uses them; forgery protection; likely −2..−3 KB) | Leave client CRUD on (and +0 KB) |
| D-AO11 | Provider subscription record | `TrackingLink.kind='PROVIDER_TRACK'` | New table (no); `LoadCarrier` JSON (no index by reference) |
| D-AO12 | Prefs control | Always-visible 28 px row, three selects + Save/Reset, effective read-out | Single chip that expands inline (needs reserved height or reflows) |
| D-AO13 | Map default state | Expanded, 260 px, remembered | Collapsed by default on screens < 820 px high |
| D-AO14 | No key / key rejected | SVG outline fallback with pins, route and dots + caption | Blank "Map unavailable" only |
| D-AO15 | Full-page tab | Same panel; `TrackingDetailMap` deleted | Keep both |
| D-AO16 | Write pings to `Load.lastKnown*` | No | A throttled (30 min) patch from a Lambda that may write Load — only `tms-tracking-actions` can; revisit if the board column matters |
| D-AO17 | Clean cutover | Delete popover, popover test, `TrackingDetailMap`, `.tms-prefs-*`, `.tms-detail-map*` | — |
| D-AO18 | Geocode gate (`looksLikePlace`) | On | Off (every text ≥ 3 chars geocoded, as today) |
| D-AO19 | Provider polling | Off (no `poll` caller exists; a LIVE port may add it to the 5-min `tracking-automation` sweep) | Add a poll pass now (nothing to poll) |

**Questions that need Ryne (none block the build):** **Q1** Is the value of `VITE_GOOGLE_MAPS_API_KEY` the same key as `GOOGLE_PLACES_API_KEY`, and is "Maps JavaScript API" enabled on it for the dev branch origin? **Q2** Will you enable **Routes API** on the server key `GOOGLE_MAPS_API_KEY` (Cloud console)? **Q3** Does the consent wording (§6.1) match your driver agreements? **Q4** Which provider first (MacroPoint needs the carrier's DOT; Trucker Tools needs a driver phone), and can you share the credentials/webhook docs so a LIVE port can be planned?

---------------------------------------------------------------------------------------------------

## 16. Rollback and fallbacks
* **Feature flag:** none needed — everything is additive; the panel with no data is an empty state. If the map misbehaves in production, collapsing it (default via the `localStorage` key) hides the cost; deleting the panel mount line in `ShipmentTrackingView` removes it with no data migration.
* **Public page:** `share.everyMin` and `MAX_LINK_PINGS` are server values; a bad client can be neutralised by returning `share.active:false` (a hotfix of one line) — the page then stops watching.
* **Data model:** rows are keyed `load:` / `route:` and carry `ttlEpoch`; deleting them is a Query-by-prefix script and cannot touch Motive/BIT rows. Switching to a dedicated `TrackingPing` table later means changing `putPing` and `listLoadBreadcrumbs` (the two choke points) plus a one-off copy.
* **Template over budget:** §0.3 ladder.
* **Provider slot:** stays STUB with zero outbound calls until a live port and credentials exist; `STOP_PROVIDER_TRACKING` and revoking the link are the kill switches.

## 17. Not in this step
No Load.lastKnown writes from pings (D-AO16); no native/PWA background tracking; no live MacroPoint / Trucker Tools HTTP calls; no geofence arrival/departure automation from pings; no truck-specific (height/weight) routing — Routes API `DRIVE` is a car route and the ETA stays the existing `etaToStop`/`deliveryEtaAt` logic; no change to `routeMiles.ts` (legacy Distance Matrix); no change to the next-check-call reminder menu (still an absolute popover — only the tracking-prefs control moved inline).
