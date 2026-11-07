# Step AW stage B: secrets and environment audit for the merged tree on `main`

Scope: merged tree (`merge/main-into-dev`, HEAD `9542b04c`) deployed on Amplify app `d3dejqzs77khq6`, branch `main`.
Compared to `origin/main` (`ff4489dd`). NAMES ONLY: no values were read. AWS reads used: `ssm describe-parameters`
(names and LastModified), `amplify get-branch` / `get-app` (`environmentVariables|keys(@)`), `lambda
get-function-configuration` (`keys(@)` of Environment.Variables and the key names inside `AMPLIFY_SSM_ENV_CONFIG`; plus the
non-secret `USER_POOL_ID` to identify main's Cognito pool), `cognito-idp list-user-pools` (ids and names). No
`ssm get-parameter`, no writes. Date of the AWS reads: 2026-11-07.

## Verdict

1. **Secrets that would FAIL the real deploy: none.**
   - Every `secret('X')` is a function-environment secret (grep of `amplify/**`: only `amplify/functions/*/resource.ts`;
     `auth`, `data`, `storage` define none). Amplify synthesizes it into `AMPLIFY_SSM_ENV_CONFIG` as a path pair whether or not the
     parameter exists; nothing resolves it at synth or deploy.
   - Runtime shim `node_modules/@aws-amplify/backend-function/lib/lambda-shims/resolve_ssm_params.js` ignores `InvalidParameters`:
     a missing secret is not an error, the env var just stays at its deployed value. `backend.ts` (the "Secret environment variables" block,
     ~L4143) ships `''` for every secret, so a missing one reads as unset.
   - Live proof: main's CURRENT deployed Lambdas (`amplify-d3dejqzs77khq6-ma-*`) already carry `GEOCODE_TOKEN_SECRET`
     (2 Lambdas) and `GOOGLE_MAPS_API_KEY` (1 Lambda) in `AMPLIFY_SSM_ENV_CONFIG`, and neither exists in SSM. Main deployed anyway.
   - Helper confirms it (below): "those Lambdas degrade at cold start (deploy does not fail)".
2. **Degrade-only (missing in SSM for main today): `GOOGLE_MAPS_API_KEY`, `GEOCODE_TOKEN_SECRET`.** Not new on the merged tree
   (same two names are already on main's deployed Lambdas, already degraded today); the merged tree widens the blast radius of
   `GOOGLE_MAPS_API_KEY` from 1 to 3 Lambdas.
3. **New secret NAMES on the merged tree vs `origin/main`: none.** The 14 distinct `secret()` names are identical. Only NEW USES
   (more Lambdas read an existing name). One `secret('ANTHROPIC_API_KEY')` user was dropped (`vendor-ap-extract`, replaced by `tms-ap-inbox`).
   No new `process.env` synth-time reads that need a value either: the only synth-time vars that exist in merged but not in
   main's `backend.ts` are `AWS_APP_ID`, `BCAT_DEV_STACK`, `CDK_CONTEXT_JSON`, `PORTAL_ORIGIN`, all defaulted/optional.

Other things that CAN fail the real deploy (not secrets, for completeness):
- `BCAT_DEV_STACK=true` or `BCAT_ISOLATED_PREVIEW=true` on branch `main` throws at synth (`backend.ts` L3566, L4122). Today
  main branch env keys are only `PAYCHEX_COMPANY_ID`, `VITE_ONBOARDING_API_URL`; app-level keys listed below. Neither flag is set on main (only on `dev`: `BCAT_DEV_STACK`). OK.
- Helper `--prod-shape` run (exit 0): data stack 968,579 bytes (cap 1,000,000, guard 995,000, headroom 26,421); 460 of 500 resources;
  biggest Lambda env `tmsdirectoryactionslambda` 3,495 est. bytes (limit 3,900, AWS hard cap 4,096). Passing, but thin margins; any added
  var/secret on `tms-directory-actions` (13 secrets, 23 vars) or data-stack resource can break the deploy.

## Helper output cited (read-only: `node scripts/measureDataTemplate.mjs --prod-shape`, exit 0)

Synthesizes as main (branch main, no dev flags), prod build-env lengths from `scripts/lib/prodBuildEnv.json`, and cross-checks against
`scripts/lib/prodSecretNames.json` (a static list captured 2026-11-04; I re-verified it live, see section 3):

```
secrets in AMPLIFY_SSM_ENV_CONFIG (14 distinct SSM parameters, 66 Lambda x secret pairs; shared SSM holds 12 names):
  present  ANTHROPIC_API_KEY  (9 Lambdas)
  present  BLUE_INK_TECH_API_KEY  (2 Lambdas)
  MISSING  GEOCODE_TOKEN_SECRET  (2 Lambdas)
  MISSING  GOOGLE_MAPS_API_KEY  (3 Lambdas)
  present  INTAKE_WEBHOOK_SECRET  (9 Lambdas)
  present  MOTIVE_API_KEY  (6 Lambdas)
  present  OTR_PASSWORD / OTR_SUBSCRIPTION_KEY / OTR_USERNAME  (3 Lambdas each)
  present  PAYCHEX_CLIENT_ID / PAYCHEX_CLIENT_SECRET  (2 Lambdas each)
  present  SLACK_BOT_TOKEN  (18 Lambdas)
  present  SLACK_CHANNEL_MAPPING / SLACK_SIGNING_SECRET  (2 Lambdas each)
note: GEOCODE_TOKEN_SECRET, GOOGLE_MAPS_API_KEY not in prod SSM; those Lambdas degrade at cold start (deploy does not fail)
```

The helper's "Lambda x secret pairs" count is 66 on the merged tree. Main's deployed Lambdas hold fewer pairs (e.g. SLACK_BOT_TOKEN 16, ANTHROPIC 3, GOOGLE_MAPS 1).

## 1. Amplify `secret()` names (resolved from `/amplify/d3dejqzs77khq6/main/X`, then `/amplify/shared/d3dejqzs77khq6/X`)

Branch path `/amplify/d3dejqzs77khq6/main/*` is EMPTY today (describe-parameters returns nothing). Every secret comes from the shared path.
Shared path today holds (LastModified): ANTHROPIC_API_KEY 2026-08-12; BLUE_INK_TECH_API_KEY 2026-06-14; INTAKE_WEBHOOK_SECRET 2026-05-19;
MOTIVE_API_KEY 2026-06-12; OTR_PASSWORD/OTR_SUBSCRIPTION_KEY/OTR_USERNAME 2026-10-05; PAYCHEX_CLIENT_ID 2026-06-22; PAYCHEX_CLIENT_SECRET 2026-06-25;
SLACK_BOT_TOKEN 2026-05-19; SLACK_CHANNEL_MAPPING 2026-05-19; SLACK_SIGNING_SECRET 2026-05-19. The shared path also holds Amplify-console
"secret" env entries: PAYCHEX_COMPANY_ID, PORTAL_PROD_ORIGIN, VITE_GOOGLE_MAPS_API_KEY, VITE_ONBOARDING_API_URL.

| Name | Used by (merged tree, resource.ts env var) | New vs main | Exists for main today | If missing | Action |
|---|---|---|---|---|---|
| `SLACK_BOT_TOKEN` | 18 Lambdas: appt-need-notifier, appt-report, broker-load-alert, cash-checkin-reminder, check-call-notifier, dispatch-actions, dispatch-nudge, dispatch-slack-bridge, dispatch-twilio-webhook, driver-app-api, gmail-task-intake, intake-reconcile, pay-credit-approval, ratecon-assigned-text, slack-intake-webhook, slack-status-notifier, tms-directory-actions, twofa-intake | name no; use +2 (check-call-notifier, tms-directory-actions; 16 on origin/main) | shared path | Deploy OK. Slack posts silently skipped | none |
| `INTAKE_WEBHOOK_SECRET` | 9: amazon-dispute-intake (DISPUTE_INTAKE_SECRET), driver-app-api (LOADS_INTAKE_SECRET), factoring-intake, fuel-import, gmail-task-intake, shipment-email-intake (SHIPMENT_EMAIL_INTAKE_SECRET), twofa-intake, vendor-ap-intake, workflow-agent (INBOX_SECRET) | name no; use +2 (shipment-email-intake, workflow-agent) | shared path | Deploy OK. Intake webhooks reject (empty secret) | none |
| `ANTHROPIC_API_KEY` | 9: pod-actions, ratecon-parser, tms-ap-inbox, tms-crm-actions, tms-directory-actions, tms-spot-quoter, tms-tracking-actions, trip-screenshot-parser, workflow-agent | name no; use +5 (tms-ap-inbox, tms-crm-actions, tms-spot-quoter, tms-tracking-actions, workflow-agent; vendor-ap-extract dropped) | shared path | Deploy OK. AI features (AP extract, CRM, quoting, tracking, agent) error at call time | none |
| `MOTIVE_API_KEY` | 6: driver-app-api, motive-fault-sync, motive-location-sync, motive-mileage-sync, motive-odometer-sync, tms-directory-actions | name no; use +1 (tms-directory-actions) | shared path | Deploy OK. Motive syncs fail at run | none |
| `OTR_USERNAME`, `OTR_PASSWORD`, `OTR_SUBSCRIPTION_KEY` | otr-actions, tms-directory-actions, otr-status-sync (3 Lambdas each) | name no; tms-directory-actions use | shared path (all 3, 2026-10-05) | Deploy OK. OTR factoring calls fail | none |
| `PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET` | paychex-pay-sync, tms-directory-actions | name no; tms-directory-actions use | shared path | Deploy OK. Paychex sync fails | none |
| `BLUE_INK_TECH_API_KEY` | blueink-sync, tms-directory-actions | name no; tms-directory-actions use | shared path | Deploy OK. BlueInk sync off | none |
| `SLACK_SIGNING_SECRET` | slack-intake-webhook, tms-directory-actions | name no; tms-directory-actions use | shared path | Deploy OK. Slack inbound requests rejected | none |
| `SLACK_CHANNEL_MAPPING` | slack-intake-webhook, tms-directory-actions | name no; tms-directory-actions use | shared path (and an app-level env var of the same name) | Deploy OK. Channel routing empty | none |
| **`GOOGLE_MAPS_API_KEY`** | tms-geocode, tms-tracking-actions, tms-directory-actions | name no; use +2 (tms-tracking-actions, tms-directory-actions); already on main's deployed tms-geocode | **NO** (not in branch path, not in shared path; only `VITE_GOOGLE_MAPS_API_KEY` exists, which is the browser key, a different name) | Deploy OK (proved: already deployed this way). Degrade: `tms-geocode` throws "GOOGLE_MAPS_API_KEY is not set" on every call; `tms-tracking-actions` reverse-geocode returns null (L2346) and map/geofence enrichments stay empty; `tms-directory-actions` route-miles/Distance Matrix returns no value | Ryne creates it: `npx ampx secret set GOOGLE_MAPS_API_KEY --branch main` or Amplify Console > Secrets (shared). Not created by this audit |
| **`GEOCODE_TOKEN_SECRET`** | tms-geocode (signs token), tms-directory-actions (verifies HMAC, L811) | name no; already on main's deployed Lambdas | **NO** | Deploy OK. Degrade: signed geocode tokens cannot be issued or verified ("Geocode token secret is not configured") so geocode-then-save flow in directory is off | Ryne creates it (any random 32+ byte string): `npx ampx secret set GEOCODE_TOKEN_SECRET`. Not created by this audit |

`tmsDirectoryActions` reads 13 `secret()` entries (the "12" in the brief plus `SLACK_SIGNING_SECRET`/`SLACK_CHANNEL_MAPPING`/`GOOGLE_MAPS_API_KEY`/`ANTHROPIC_API_KEY` etc.: GEOCODE_TOKEN_SECRET, OTR x3, MOTIVE, BLUE_INK_TECH, GOOGLE_MAPS, ANTHROPIC, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_MAPPING, PAYCHEX x2). Of these 13, 11 exist; only GEOCODE_TOKEN_SECRET and GOOGLE_MAPS_API_KEY do not. Helper reports the same 13 for it.

## 2. Synth-time environment (Amplify build environment) and Lambda wiring

Read by `amplify/backend.ts` at synth. All have defaults; none blocks the deploy. "Set for main" = present in `get-branch main` / `get-app` env KEYS, or the shared path.

| Name | Used by | New vs main | Set for main today | If missing | Action |
|---|---|---|---|---|---|
| `AWS_BRANCH`, `AWS_APP_ID` | Amplify build supplies; `AWS_APP_ID` defaults to `d3dejqzs77khq6`; branch origin builder; main guards | `AWS_APP_ID` read is new | provided by Amplify build | n/a | none |
| `BCAT_DEV_STACK` | dev-stack pinning/guards; throws if `AWS_BRANCH=main` | read is new in backend.ts | not set on main (set on `dev` only) | n/a; it MUST stay unset on main | none; never set on main |
| `BCAT_ISOLATED_PREVIEW` | disables schedules; throws on main | no | not set | n/a; must stay unset | none |
| `CDK_CONTEXT_JSON` | merged with minimizePolicies/suppressTemplateIndentation flags | new | not needed (defaults `{}`) | n/a | none |
| `PORTAL_PROD_ORIGIN` | CORS/public links | no | app-level env var + shared path | defaults to `https://ops.bcatcorp.com` | none |
| `PORTAL_ORIGIN` | CORS/public links (override) | read is new | not set | falls back to `PORTAL_PROD_ORIGIN` on main | none (must stay unset on main) |
| `GOOGLE_PLACES_API_KEY` | blueink-sync, google-reviews | no | app-level env var | `''`: blueink geocode/google-reviews off | none |
| `GOOGLE_PLACE_ID`, `GOOGLE_PLACE_QUERY`, `GOOGLE_REVIEWS_URL` | google-reviews | no | no (none of the three) | `''`: google-reviews off (unchanged from main today) | optional, Ryne |
| `PAYCHEX_COMPANY_ID` | paychex-pay-sync | no | branch-level env var + shared path | `''`: pay sync cannot call Paychex | none |
| `SLACK_GLOBAL_CHANNEL_ID` | appt-report, broker-load-alert | no | app-level env var | `''`: global channel posts skipped | none |
| `INTAKE_IVAN_CHANNEL_ID`, `INTAKE_PODS_CHANNEL_ID`, `LOADS_EMAIL_TO`, `SES_FROM_ADDRESS` | driver-app-api, gmail-task-intake | no | not set (defaults baked: `C0B4YJXLYM8`, `C0C6ZT55R0T`, `ivanloads@bcatcorp.com`, `onboarding@bcatcorp.com`; gmail-task-intake default `''`) | defaults used | none |
| `APPT_REQUEST_FROM_ADDRESS`, `APPTS_IVAN_CHANNEL_ID`, `TWO_FA_SLACK_CHANNEL`, `PAY_CREDIT_APPROVER_EMAIL`, `DRIVER_PAY_FROM_ADDRESS`, `QUOTE_FROM_ADDRESS`, `QUOTE_CC_ADDRESS`/`QUOTE_BCC_ADDRESS`, `BROKER_DRIVER_NAME`, `BROKER_DRIVER_ID` | various | no | not set | defaults used (`BROKER_DRIVER_ID` default `''`) | none |

Plain Lambda env set in `backend.ts` (table names, bucket, user pool ids, `WEBHOOK_URL`, `*_FUNCTION_NAME`, `*_PARAM_PATH`, etc.) are CDK tokens
resolved at synth, no manual input. Runtime-only reads that are NOT wired and are optional tuning: `OTR_ASCII_SAFE_PDF`, `OTR_VALIDATE_MC`, `PAYCHEX_API_BASE`,
`OTR_BASE_URL`, `OTR_CLIENT_DOT`, `OTR_UPLOAD_BASE_URL`, `POD_BACKGROUND_SYNC_ENABLED` (all have in-code defaults). `POD_SCAN_CACHE_PATH` is set in `amplify/podScanner.ts`.
`BCAT_DEV_STACK` is also added to Lambdas only on the dev stack.

Frontend build vars (`vite build`, set in Amplify console): VITE names read by `src`: `VITE_COMMAND_CENTER_API_KEY`, `VITE_COMMAND_CENTER_API_URL`,
`VITE_COMMAND_CENTER_URL`, `VITE_DISPUTE_PORTAL_API_URL`, `VITE_DRIVER_API_URL`, `VITE_FULLCALENDAR_LICENSE`, `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_MAP_ID`,
`VITE_ONBOARDING_API_URL`, `VITE_RATE_CON_SIGN_API_URL`, `VITE_TRACKING_API_URL`. Only `VITE_RATE_CON_SIGN_API_URL` is new vs main (code falls back to `amplify_outputs.json custom.rateConSignUrl`, so not required). Exist for main: `VITE_ONBOARDING_API_URL` (branch + app), `VITE_TRACKING_API_URL`, `VITE_FULLCALENDAR_LICENSE`, `VITE_GOOGLE_MAPS_API_KEY` (app-level). Missing for main: `VITE_GOOGLE_MAPS_MAP_ID` (the map components fall back to `'DEMO_MAP_ID'` in RouteMapView, other views show "Map not configured" note; same as main today), `VITE_COMMAND_CENTER_*` (reddit queue falls back to localhost; same as main), `VITE_DRIVER_API_URL`/`VITE_DISPUTE_PORTAL_API_URL` (outputs fallback). `amplify.yml` is identical to origin/main (no diff) and sets no env itself.
Env keys that exist on Amplify (names only). App: GOOGLE_PLACES_API_KEY, PORTAL_PROD_ORIGIN, SLACK_CHANNEL_MAPPING, SLACK_GLOBAL_CHANNEL_ID, VITE_FULLCALENDAR_LICENSE, VITE_GOOGLE_MAPS_API_KEY, VITE_ONBOARDING_API_URL, VITE_TRACKING_API_URL, _BUILD_TIMEOUT. Branch `main`: PAYCHEX_COMPANY_ID, VITE_ONBOARDING_API_URL. Branch `dev`: BCAT_DEV_STACK, PORTAL_PROD_ORIGIN, VITE_ONBOARDING_API_URL, VITE_TRACKING_API_URL. Branches: dev, main, rehearsal.

## 3. Runtime SSM namespaces read directly by handlers (`/bcat/*`)

Main's Cognito pool is `us-east-1_IbPKPNJC9` (read from main's tms-directory-actions `USER_POOL_ID`; `DISPATCH_PARAM_PATH` etc. are derived from it).
Existing `/bcat` names today: `/bcat/dispatch/IbPKPNJC9/{DISPATCH_NUMBER,TWILIO_ACCOUNT_SID,TWILIO_API_KEY_SECRET,TWILIO_API_KEY_SID,TWILIO_AUTH_TOKEN,TWILIO_MESSAGING_SERVICE_SID,WEBHOOK_SECRET}` (2026-10-10);
`/bcat/pods/IbPKPNJC9/connection` and `/bcat/pods/WjgBONrgI/connection`; `/bcat/integrations/UKhMNVAG1/{MYCARRIERPACKETS,MYCARRIERPACKETS/webhook}` (a different pool, not main's); `/bcat/integrations/jobsdone-sms/api-key`; `/bcat/tracking-actions/ab7f791936be5ce5/function-name`.

| SSM path | Used by | New vs main | Exists for main (pool IbPKPNJC9) | If missing | Action |
|---|---|---|---|---|---|
| `/bcat/dispatch/<pool>/` (5 required: DISPATCH_NUMBER, TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, WEBHOOK_SECRET) | dispatch-actions, dispatch-twilio-webhook, driver-app-api, ratecon-assigned-text, tms-directory-actions (read-only presence) | no | yes, all 5 present | feature off (SMS) | none |
| `/bcat/pods/<pool>/connection` | pod-actions | no | yes | POD sync off | none |
| `/bcat/tracking-actions/<hash>/function-name` | dispatch-twilio-webhook; written by the stack itself | no | yes (auto) | n/a, created at deploy | none |
| `/bcat/integrations/<pool>/MYCARRIERPACKETS` (+`/webhook`) | mcp-sync, tracking-api, tms-directory-actions (MCP integration, Step J) | no | **NO** for `IbPKPNJC9` (exists only under pool `UKhMNVAG1`) | mcp-sync returns "not configured"; MyCarrierPackets integration shows not LIVE; carrier invites/sync off. Deploy OK | Ryne enters it through the Integrations screen (writes SSM) or `aws ssm put-parameter` as admin. Not created by this audit |
| `/bcat/integrations/<pool>/OPENAPI` | tracking-api (OPENAPI_PARAM_NAME) | new vs main (tracking-api OpenAPI doc) | **NO** | OpenAPI doc route returns not configured; deploy OK | Ryne, if the tracking API doc is wanted |
| `/bcat/integrations/<pool>/GMAIL_REP_OAUTH`, `/bcat/gmail/<pool>/users/<userId>` | tms-spot-quoter, tms-ap-inbox (Gmail OAuth refresh tokens, `_shared/gmail/tokens.ts`) | new (both Lambdas new) | **NO** | Gmail-based AP inbox and spot-quote reply scanning stay off until each rep connects Gmail. Deploy OK | each rep via the app OAuth flow, plus Ryne for the OAuth client entry |
| `/bcat/integrations/<pool>/<PROVIDER>` (other registry providers) | tms-directory-actions `VALIDATE_INTEGRATION` | new framework (Step J) | none present for main | shows missing credentials | Ryne through the UI when needed |

## 4. Actions for Ryne (in priority order)

1. Before or right after the main deploy, to restore two already-degraded features: set `GOOGLE_MAPS_API_KEY` (server key, not the VITE browser key) and `GEOCODE_TOKEN_SECRET` (random) as Amplify secrets for the app (shared path or `main` branch path). The deploy does not need them, but Lambdas read them at cold start, so set before the deploy to avoid a warm-instance refresh.
2. Optional for the new TMS features: `/bcat/integrations/us-east-1_IbPKPNJC9/MYCARRIERPACKETS` (+ `OPENAPI`, `GMAIL_REP_OAUTH`) after cutover.
3. Keep `BCAT_DEV_STACK` / `BCAT_ISOLATED_PREVIEW` / `PORTAL_ORIGIN` unset on branch `main`.
4. Watch the two thin deploy margins: data template 968,579 / 1,000,000 bytes, and `tms-directory-actions` env 3,495 / 3,900 (est.).
