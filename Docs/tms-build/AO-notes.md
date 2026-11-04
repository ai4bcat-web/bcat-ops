# Step AO: driver GPS map in the Load Tracking drawer (dev branch only, not deployed from here)

Plan: `AO-plan.md`. Harness: `scripts/devVerifyAO.mjs` (runs only after the lead deploys; `--inventory` is offline). Nothing here claims a deploy, a main merge or a live provider call.

## 1. Where a position comes from (sources)

Every position of a load ends up as a `TrackingFix` (`src/lib/trackingPings.ts`); the drawer (`useLoadTracking`), the strip, the customer page and the route-progress maths read that one list.

| Source | Stored as | Written by | Consent basis |
| --- | --- | --- | --- |
| `motive`, `blueink` | `TruckLocationHistory` row, `truckId` = Equipment id, no `ttlEpoch` | the ELD sync Lambdas (unchanged, never copied) | BCAT's own fleet |
| `link` (driver page, tap-to-share) | `truckId='load:<loadId>'`, `ttlEpoch` = fix + 90 d | `tracking-api` `POST /l/<token>/ping` | driver ticks "I agree" on the page; `TrackingLink.consentAt` (server clock, set once) + `consentVersion` `ao-1` in the first check call's note |
| `sms-share` (a shared pin in a text: Apple / Google Maps URL, raw coordinates, vCard) | load-keyed row, exact | `tms-tracking-actions` `ingestShipmentMessage` | the driver sent it |
| `sms-geocode` (a place name in a text, "just passed Gary IN") | load-keyed row, `approx=true`, `accuracyM` = radius (2-50 km) | same, via the server geocoder; gated by `looksLikePlace` (so "Thanks" costs no geocoder call) | the driver sent it |
| `provider:<key>` (MacroPoint, Trucker Tools, ...) | load-keyed row, `refId` = the provider's event id | `POST /api/webhooks/<provider>` -> `consumeTrackingDelivery` -> `ingestProviderDelivery` | the carrier's agreement with the provider |
| `manual` | staff check call with coordinates | the existing check-call path | n/a |

`Load.lastKnown*` is not written by pings (D-AO16): the drawer and strip read the timeline first; the board's "Last location" column can lag for a link-tracked load.

## 2. Trust order

`trustRank`: motive / blueink 100 > provider 90 > link 80 > sms-share 70 > manual 60 > sms-geocode 10 (an approximate fix is always 10). Two fixes inside 1 s from the same source collapse; different sources never collapse.

**Current marker = the newest fix, with one exception (D-AO8):** a newer *approximate* fix does not replace a *precise* fix younger than 4 h; it is drawn as an overlay circle beside the precise marker (`CurrentFix.overlay`, the orange "approx." badge). Tone: fresh < 15 min, aging 15-60 min, stale > 60 min. The map warns when two fixes within 30 min are more than 500 mi apart.

## 3. Retention

| Data | Kept | How |
| --- | --- | --- |
| Load pings (`load:<id>` rows) | 90 days | `ttlEpoch` seconds on every row; DynamoDB TTL on `TruckLocationHistory` (`backend.ts`, one append-only Step AO block) |
| Cached route rows (`route:<sha1>` rows, `locatedAt='route'`) | 30 days (`ROUTES_API` / legacy), 1 day for an `ESTIMATE`, `NONE` is not cached | `ttlEpoch` |
| Motive / Blue Ink rows | unchanged (no `ttlEpoch`, never touched by the TTL) | n/a |
| `TrackingLink` rows | unchanged (expiry is an application rule, `linkExpiry`) | n/a |

TTL deletion is lazy (up to ~48 h after `ttlEpoch`); the readers also ignore expired route rows. Rows without `ttlEpoch` are never expired, so enabling TTL on the 65k+ existing Motive rows deletes nothing. DynamoDB allows one TTL change per hour per table: the first deploy that carries the spec is the only one that changes it.

## 4. Privacy and consent

- **Explicit, versioned, server-recorded.** `GET /l/<token>` returns `share.consentRequired` and the exact `consentText` (`consentText()` in `src/lib/trackingLink.ts`, version `ao-1`); the page shows it verbatim with a required "I agree" box and calls no `navigator.geolocation` method before the tap. `POST /l/<token>/ping` without `consent:true` on a link with no `consentAt` is a 403 and writes **no** row of any kind (no breadcrumb, no counter move, no check call).
- **Purpose and audience:** dispatch staff, and the customer as a map position only (never the source, accuracy, speed, heading, `refId`, the carrier unless the link shows it, or the approximate radius). Customer view: 3 decimals (~110 m), one point per 15 min, at most 96 points, inside the tracking window (dispatch -> delivery + 2 h). `showPosition=false` links carry no `map` and no `position`.
- **Stopping:** the driver's Stop sharing (`clearWatch`), delivery (server 410 `done:true`, no write), link expiry, `REVOKE_TRACKING_LINK`, TTL 90 d. The page cannot track a backgrounded phone (browser limit [INFERENCE: standard iOS Safari / Android Chrome behaviour]); it says so and tells the driver dispatch can use the ELD.
- **Write protection:** `TruckLocationHistory` has no GraphQL create/update/delete (D-AO10): a signed-in user cannot forge a breadcrumb the customer would see. Only the Lambdas write it (SDK).
- **Logs:** coordinates are never logged by the Lambdas; the harness prints ids, counts and masked tokens (`abcd…`) and uses fictional I-80 coordinates only.
- **Open item (Q3):** Ryne to confirm the consent wording with whoever owns the driver agreements; a wording change is a `CONSENT_VERSION` bump.

## 5. Provider slot: STUB -> LIVE

Today (`src/lib/integrations/trackingProvider.ts`, `amplify/functions/tms-tracking-actions/providers.ts`): `MACROPOINT`, `TRUCKER_TOOLS` and `LOAD_MARKET` are registry rows with `track`; `trackingPortFor()` returns the **stub port** unless a live port is supplied *and* every credential is present and not `disabled-on-dev`. The stub `subscribe` answers `STUB — A live <label> connection would have started <label> tracking on this shipment.` and nothing leaves the Lambda; `parseDelivery` accepts only the documented SIM shape (`SIM_DELIVERY_SHAPE`), so the webhook consumer can be exercised end to end and a real provider body is rejected until a live port exists. `registry.ts` is unchanged and `liveCapabilitiesOf` still excludes `track` (a registry test pins that).

Moving one provider to LIVE (blocked on the provider's real contract and credentials; none is invented here, Q4):

1. Get from the provider: the subscription/start API (what it needs: MacroPoint wants the carrier DOT, Trucker Tools a driver phone), the callback payload schema, how the callback is authenticated (probably not BCAT's `x-bcat-signature` [INFERENCE]), and sandbox credentials.
2. Add a live port implementing `TrackingProviderPort` (`subscribe`, `unsubscribe`, `parseDelivery`, optional `poll`, plus its own `verifyDelivery` for the callback authentication) in `trackingProvider.ts`; map the provider payload to `ProviderFix[]` (`refId` = the provider's event id: replays then write nothing).
3. Register the live port where `trackingPortFor` is called (`providers.ts` start/stop, `api.ts` webhook consumer) and extend `liveCapabilities` for that provider **only once the port does the work**; update the registry test.
4. Store credentials the usual way (Integrations page -> SSM, `<PROVIDER>/webhook` secret for the callback; no hand-written SSM) and connect the provider on the Integrations page.
5. Point the provider's callback at `POST <tracking-api URL>/api/webhooks/<provider>`; confirm with `devVerifyAO` AO07 (STUB) and one real shipment; the "STUB" badge and the "Start ... (STUB)" menu label disappear when the port reports `mode:'LIVE'`.
6. Optional pull-style: implement `poll()` and call it from the 5-minute `tracking-automation` sweep (D-AO19; nothing calls `poll` today).

Kill switches: `STOP_PROVIDER_TRACKING`, revoking the `PROVIDER_TRACK` link, or not connecting the provider.

## 6. Maps keys

**Browser key (the map).** Amplify Hosting -> the branch -> Environment variables: `VITE_GOOGLE_MAPS_API_KEY` (a browser key) and `VITE_GOOGLE_MAPS_MAP_ID` (Cloud console -> Maps -> Map management, a vector Map ID; without one the code uses `DEMO_MAP_ID`, which Google restricts). Redeploy the branch after setting them.

- Enable **Maps JavaScript API** on the key's project (Q1: confirm it is the same key as `GOOGLE_PLACES_API_KEY`, or use a separate browser key).
- **Restrict the key by HTTP referrer** (Application restrictions -> Websites): the Amplify branch origin(s) and the production domain, e.g. `https://dev.d3dejqzs77khq6.amplifyapp.com/*`, `https://<production-domain>/*`, plus `http://localhost:5173/*` for development only. The key is compiled into the bundle, so the referrer list and an **API restriction to Maps JavaScript API** are the only protection; add a daily quota cap.
- No key, a rejected key (`gm_authFailure`) or a failed chunk degrades to the offline outline with a caption; the drawer never blanks. On dev the key is neutered on purpose, so Google-rendered markers cannot be screenshotted there (AO14 runs only with `DEV_VERIFY_MAPS=1` and a key valid for the origin).

**Server key and the Routes API (the planned route).** `GET_LOAD_ROUTE` (`tms-tracking-actions/route.ts`) calls `https://routes.googleapis.com/directions/v2:computeRoutes` with the Amplify secret `GOOGLE_MAPS_API_KEY` (the same server key the geocoder uses; a secret on the function, never an environment variable this repo prints). In Google Cloud console -> APIs & Services -> Library on that project, **enable "Routes API"** (Q2). Restrict the key to the APIs it needs (Geocoding + Routes) and, being a server key, by API only (Lambda egress IPs are not fixed). Field mask `routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration`, `TRAFFIC_UNAWARE`, `OVERVIEW` polyline: the cheapest SKU [INFERENCE: confirm pricing tiers in the console]. One call per distinct lane (waypoints rounded to 0.01 deg) per 30 days. If Routes is refused and the legacy Directions API is still enabled the server retries once against it; otherwise the result is a straight-line `ESTIMATE` with a visible reason and a dashed path ("Estimated path — no road route available"), cached for one day so enabling Routes is picked up the next day. Not enabling Routes is never an error.

## 7. Harness runbook (`scripts/devVerifyAO.mjs`)

Prerequisites: AWS credentials for the dev account (Cognito admin on the dev pool, DynamoDB on the dev tables), Chrome (`CHROME_BIN` or the macOS default), the lead's deploy of AO1-AO5 on dev.

```
node scripts/devVerifyAO.mjs --inventory         # offline gates (also runs first in a live run)
node scripts/devVerifyAO.mjs                     # all steps, 18 screenshots -> Docs/tms-build/screenshots/ao/ + index.txt
node scripts/devVerifyAO.mjs --only=AO03         # one step (needed fixtures are made on demand)
node scripts/devVerifyAO.mjs --no-dark
DEV_VERIFY_MAPS=1 node scripts/devVerifyAO.mjs --only=AO14   # Google branch, with a referrer-valid key
```

Steps: AO01 schema (new attributes, no GraphQL writes on the history table, TTL enabled, `PROVIDER_TRACK`), AO02 12 sim pings, AO03 public ping (403 / 200 / 429, counters, consent), AO04 shared SMS pins, AO05 check-call text, AO06 own-asset Motive rows, AO07 provider STUB (start / sim deliveries / revoke / refusals), AO08 cached route, AO09 customer JSON (thinning, rounding, no metadata, `showPosition:false`), AO10 drawer UI (+ collapse persistence, stale, provider badge, Tracking tab, blocked outline data), AO11 prefs row (panes top delta 0 px), AO12 driver page with Chrome geolocation emulation (`Emulation.setGeolocationOverride` via `setGeolocation()` in `scripts/lib/cdpBrowser.mjs`), AO13 customer page, AO14 Google branch (skips unless `DEV_VERIFY_MAPS=1`).

Cleanup (in `finally`): shipments voided, ZZ load-ping and Motive rows deleted by remembered key, SDK legs and the ZZ truck deleted, the customer archived, both temporary identities deleted and proven gone. Cached `route:` rows are shared by lane and expire by TTL.

## 8. Known limits of the harness

- Sim doors recompute `at` from the clock, so a *replay* of the same fix cannot be driven from the harness; replay idempotency (`putPing` duplicate, provider `refId`) is covered by the unit tests only.
- The dev server geocoder is neutered: AO05 accepts "no fix" for "just passed Gary IN" and says so; the approximate path is exercised by a sim `sms-geocode` fix.
- Google-rendered markers are not verifiable on dev (AO14 / a manual look on a key-valid origin).
- Browser geolocation stops when the page is backgrounded; the emulation proves the page flow, not background behaviour.
