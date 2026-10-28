# TMS build log

One entry per unit of work (newest first). Decisions needed from Ryne go under **Decision needed**.

## 2026-10-27 — Step A implementation in progress (not shipped)

- Fable architecture plan: `Docs/tms-build/A-plan.md`; additive Customer/TmsSettings extension, status/credit actions, typed client and customer board/profile. Lead corrections retain all legacy exposure, forbid inferred invoicing/payment, and include markup and contact/quoting defaults.
- Shared types/math/client slice landed in six files. Lead fixed legacy-name matching when normalizedName is absent and strengthened the attribution fixture. Lead ran `npx vitest run src/lib/customerCredit.test.ts`: **47 passed**. Backend/schema and UI slices are still completing their scoped proof; full integration gate waits for them to land.
- No feature commit or deployment yet. A–I remain incomplete. Next: finish integration, required typecheck/lint/test, final Fable review, commit/push dev, deployed schema and browser behavior verification, then B.
- Baseline: existing ahead commit `5f8aeb6` contains only brief/log. Amplify dev job `6`, commit `37de60b`, reached `SUCCEED`. Count-only dev scans confirmed 98 copied customers and 890 loads; no refresh needed.
- Runtime verification prepared: authenticated dev browser displays Customers 98 and Loads 890; authenticated dev AppSync schema introspection succeeded against the dev API. A temporary suppressed-invite dev test identity is retained only for smoke checks and will be removed afterward. No production writes or PII-file access.
- **Decision needed:** harness has no registered `plan` agent. Main approved the same Fable model through `reviewer` with a planning-only assignment; continue that mapping. Customer hard-delete/merge and historical paid status are not inferred; keep inactive records and conservative exposure pending explicit evidence.
