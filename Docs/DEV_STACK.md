# The dev stack (`dev` branch → ops-dev.bcatcorp.com)

The `dev` branch is a long-lived, full working copy of BCAT Ops with its own backend
stack (own DynamoDB tables, Cognito pools, S3 bucket, Lambdas, AppSync API). It exists so
larger pieces of work — first the MVMNT-style TMS rebuild — can be built, used and
reviewed end to end on a real URL before anything reaches `main`, which is production
(ops.bcatcorp.com).

## How it differs from production

| | `main` (production) | `dev` |
|---|---|---|
| URL | https://ops.bcatcorp.com | https://ops-dev.bcatcorp.com |
| Amplify branch env | — | `BCAT_DEV_STACK=true` |
| EventBridge schedules | on | **all disabled** (`amplify/backend.ts`, dev stack guard) |
| Load-stream consumers (`broker-load-alert`, `ratecon-assigned-text`) | on | created disabled |
| SES (email) | on | **denied** on every Lambda |
| Slack, OTR Solutions, Paychex, Blue Ink | real credentials (shared SSM secrets) | a synth-time Aspect in `backend.ts` removes those names from each Lambda's `AMPLIFY_SSM_ENV_CONFIG` and pins the variables to `disabled-on-dev`, so the calls fail harmlessly |
| Twilio dispatch texting / calls | configured under `/bcat/dispatch/<prodPoolId>/` | inert — dev's pool has no config |
| Anthropic, Google Maps, Motive (read-only) | real | real (shared secrets) |
| Data | live | a point-in-time copy of production (see below); never synced back |

Every page and Lambda is callable on dev — the guard only removes the ways the stack can
act on the outside world by itself. The guard throws if `BCAT_DEV_STACK` is ever set on
`main`.

## Secrets

Amplify resolves `secret('X')` from `/amplify/d3dejqzs77khq6/dev/X` first, then
`/amplify/shared/d3dejqzs77khq6/X`, so dev reads the shared production values. The dev guard
neuters `SLACK_BOT_TOKEN`, `OTR_USERNAME`, `OTR_PASSWORD`, `OTR_SUBSCRIPTION_KEY`,
`PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET` and `BLUE_INK_TECH_API_KEY` in code (see the
table above); every other secret is the real one. A branch-level SSM parameter under
`/amplify/d3dejqzs77khq6/dev/` would be a second safety net if someone wants one.

## Identifiers (2026-10-27)

- Tables: `<Model>-nc3jsnxdmjhkpequimypiatkma-NONE` · staff pool `us-east-1_UKhMNVAG1` ·
  driver pool `us-east-1_nnJzcFvTY` · bucket `amplify-d3dejqzs77khq6-de-bcatrateconfirmsbucketf4-u2z3qq1ar9hf`
- Default URL https://dev.d3dejqzs77khq6.amplifyapp.com; `ops-dev` is in the bcatcorp.com domain association.
- `node scripts/devStack.mjs env` prints the current Function URLs and ids.

## Branch environment variables

Set on the `dev` branch in the Amplify console (branch values override app-level ones):

- `BCAT_DEV_STACK=true`
- `PORTAL_PROD_ORIGIN=https://ops-dev.bcatcorp.com`
- `VITE_ONBOARDING_API_URL` / `VITE_TRACKING_API_URL` — dev's own Function URLs (the
  app-level values point at production's). Read them from the dev stack's outputs after
  the first deploy; `scripts/devStack.mjs env` prints them.

## Data copy

`scripts/devStack.mjs copy-data` scans every production table (`*-5ucwdyvwivelbo4k4jomvrwel4-NONE`)
and batch-writes the rows into the matching dev table. It only ever reads production.
Re-run it to refresh dev from production (it overwrites rows by key, it does not delete
dev-only rows). S3 objects (rate confirmations, driver docs, PODs) are copied with
`aws s3 sync` from the production bucket to dev's — see the script's `copy-files` command.

## Promoting to production

Dev is a branch, so promotion is a merge: `git checkout main && git merge dev` (or a PR
from `dev` to `main`), then push — which deploys. Schema additions are additive, so the
production data stack migrates in place; any data backfill a feature needs is a script
run against production after that deploy, never a copy from dev.

## Logging in

Dev has its own staff user pool. Accounts are created from the Users page on dev (or
`aws cognito-idp admin-create-user` against the dev pool); production logins do not work
on dev and vice versa.
