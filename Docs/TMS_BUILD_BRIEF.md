# TMS build brief — for the OMP lead agent on the `dev` branch

You are building the MVMNT-style TMS into BCAT Ops. Read, in this order, before touching code:

1. `Docs/MVMNT_TMS_SPEC.md` — §6 is what MVMNT does (data model, workflows, status
   vocabularies); §7 is the build plan, steps A–I. This is the product spec.
2. `Docs/TMS_DESIGN.md` — the earlier Aljex-replacement design; its Phase 1 (Customer /
   Location / Division / TmsSettings / `tmsDirectoryActions` / `tmsGeocode`) is built and
   live. Reuse its models, GSIs guidance (§5) and access-control rules (§6).
3. `CONTEXT.md` — how the app is put together (routes, models, Lambdas, conventions).
4. `Docs/DEV_STACK.md` — where you build and test. You are on the `dev` branch; pushing
   `dev` deploys the dev stack (https://dev.d3dejqzs77khq6.amplifyapp.com, tables
   `*-nc3jsnxdmjhkpequimypiatkma-NONE`). `main` is production and is off limits.

## Goal

Steps A → M of `MVMNT_TMS_SPEC.md` §7 and §9, in order, each one usable on dev with the copied
production data before the next starts. Own-fleet work (Ivan Cartage, Amazon, box trucks,
the driver app, PODs, settlements, the factoring queue) must keep working unchanged
throughout — the TMS layer wraps it, it does not replace it. No driver downloads a new app;
no production infrastructure changes until Ryne merges `dev` → `main`.

## Hard rules

- Branch `dev` only. Never check out, merge into, or push `main`. Never run `git push origin main`.
- Never write to production: no DynamoDB tables with the `5ucwdyvwivelbo4k4jomvrwel4-NONE`
  suffix, no production S3 bucket, no SSM, no DNS, no Amplify `main` branch settings.
  `scripts/devStack.mjs copy-data` reads production and writes dev; that is the only
  production access allowed, and only when a dev table needs refreshing.
- Schema changes are additive: new models, new optional fields, new indexes. Never rename,
  remove or change the type of an existing field. Every new model uses
  `.disableOperations(['subscriptions'])` (CloudFormation resolver cap) and
  `allow.authenticated()` for reads; writes that must stay consistent go through a Lambda
  router (pattern: `amplify/functions/tms-directory-actions`), with the model read-only to
  the client where `TMS_DESIGN.md §6` says so.
- Money is integer cents in new fields (`…Cents`), never floats.
- The driver app API (`amplify/functions/driver-app-api`) keeps its request/response
  contract. Add, never change.
- Each unit of work: `npm run typecheck && npm run lint && npm run test` green, then commit
  on `dev` with a message that says what changed and why, then `git push origin dev`.
  Amplify runs one job per branch: before pushing again, wait until
  `aws amplify list-jobs --app-id d3dejqzs77khq6 --branch-name dev --max-results 1` is not
  RUNNING/PENDING (two concurrent deploys collide in CloudFormation). A failed deploy is
  yours to fix next, before any other work.
- Do not commit `invoice_extraction.json` or `invoice_ocr_raw.json` (customer PII).
- Do not add dependencies without a one-line reason in the commit message.
- Follow `Docs/STYLE.md` and the patterns already in `src/features/*` (Zustand store,
  poll-based hooks, `apiClient.ts` typed GraphQL strings, `src/lib/*.ts` pure functions
  with Vitest tests next to them).

## Working method (cost-aware)

- Plan each step with the `plan` role (Claude Fable) before editing: write the plan to
  `Docs/tms-build/<step>-plan.md` (schema diff, Lambda actions, UI, tests, migration/backfill
  script if any). Keep it under two pages.
- Implement with the default model; fan out independent, well-specified chunks to `task`
  subagents (Kimi) and mechanical edits/data collection to `sonic`/`scout` (DeepSeek).
  Keep your own context lean: use `scout` instead of reading many files yourself.
- Review the step's diff with `reviewer` (Claude Fable) once per step, fix real findings.
- Record progress in `Docs/tms-build/BUILD_LOG.md`: one dated entry per unit of work —
  what shipped, commit hash, deploy job id/result, what is next, and any **decision needed
  from Ryne** (write the question there and continue with the most reasonable default;
  do not stop the build to wait).
- When a step is done on dev (schema deployed, pages usable with the copied data, tests
  green, build log updated), start the next step immediately. Do not wait to be told.

## Step order and what "done" means

A. Customer v2 — Customers board (Leads / Active / Inactive) and profile tabs work on dev
   against the 98 copied customers; credit controls + required docs/refs + default charges +
   bill-to parties + contact types editable; credit-available computed from loads.
B. Shipment / Order / Load — shipments board + draft editor + submit (credit check) + stop
   cards + financial line items + status axes; existing loads appear as shipments with a
   single order and load (a backfill script run on dev, idempotent, documented).
C. Carriers & booking — carrier profiles; Book carrier gate; rate con PDF + e-sign link;
   Dispatch; Bounce / TONU; own fleet as the built-in carrier via the driver/truck picker.
D. Tracking & check calls — check-call log + next-check-call reminders; Tracking tab;
   SMS tracking link for outside carriers; public Customer Link page.
E. Documents & delivery — typed document sections; generated BOL/rate con/load summary;
   required-document gate; carrier upload portal; delivery notifications.
F. AR — Docs needed → Unbilled → Unpaid → Paid; generate/email/batch invoices; receive
   payment with allocations + credits; AR aging; Send to Factor via the existing OTR flow.
G. AP — Awaiting invoice → In review → To be paid → Paid; record/approve bills; AP
   payments + credits + remittance; own-driver loads post to settlements instead.
H. Quotes & rates — customer quotes with accept/counter/decline link; carrier offers;
   lane history.
I. Settings, roles, teams, commissions, reporting.
J. Integration framework + every provider settings page (spec §8.1, §9) — stub mode for all,
   live for providers BCAT has credentials for; list missing credentials in the build log.
K. Workflows page: Errors + AI Agents, WorkflowRun model, the four email-agent inbox roles,
   org/party AI memory (spec §8.2).
L. My Brokerage: every settings page in spec §8.3 not already built.
M. Academy: in-app help, glossary, FAQ, updates, training (spec §8.4).

Scope note (added 2026-10-27): Ryne wants all of MVMNT, including every integration, the
Workflows page, all of My Brokerage and the Academy — not only the core TMS.

Start with step A now.
