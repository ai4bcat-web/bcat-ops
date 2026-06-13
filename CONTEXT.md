# BCAT Ops — Platform Context

> Auto-generated context file for handing to Claude Desktop / other tools.
> Last updated: 2026-06-13

## What it is
Internal operations dashboard for BCAT dispatch — calendar scheduling, load management, driver schedules, fleet/equipment registry, live truck tracking, maintenance, expense/fuel tracking, email/Slack intake, DOT compliance & driver onboarding, and audit logging.

## Where it lives
| | |
|---|---|
| **Local dev URL** | http://localhost:5173 (run `npm run dev`) |
| **Local path** | `/Users/adminoid/bcat-ops` |
| **Live (prod)** | https://ops.bcatcorp.com (canonical, per README) |
| **Repo deploy** | AWS Amplify — auto-deploys every push to `main` (~2 min) |

> Note: This is a different project from the WordPress site `bestcareautotransport.com` and from the Python `MultiAgent_Operations` folder. bcat-ops is the React/AWS dispatch app.

## Tech Stack
**Frontend:** React 19 · TypeScript (strict) · Vite · Tailwind v4 · shadcn/ui (Radix primitives) · Zustand · React Router v7 · FullCalendar v6 (resource-timeline) · TanStack Table · react-hook-form + Zod · Recharts · `@vis.gl/react-google-maps` (dashboard truck map) · sonner · date-fns

**Backend (AWS Amplify Gen 2):** AppSync GraphQL API · Cognito auth (userPool) · DynamoDB (via `a.model`) · S3 (confirmation/compliance docs) · Lambda functions · SES (onboarding/escalation email)

## Routes / Pages
| Route | Feature |
|---|---|
| `/dashboard` | Operational metrics (KPIs, fuel widget, open tasks, live truck map) |
| `/calendar` | FullCalendar resource-timeline scheduler |
| `/loads` | Load grid (legacy `/grid` redirects here) |
| `/drivers` | Driver management + avatars |
| `/trucks` | Truck/equipment registry |
| `/maintenance` | Maintenance tasks + invoices |
| `/expenses` | Expense + fuel tracking, EFS upload |
| `/schedule` | Driver schedule view |
| `/audit-log` | Audit trail (legacy `/audit` redirects) |
| `/intake` | Email/Slack intake queue |
| `/tasks` | Task/todo board |
| `/users` | User management (admin-only) |
| `/compliance` | DOT compliance dashboard (drivers & trucks) |
| `/compliance/review` | Compliance document review queue |
| `/compliance/driver/:driverId` | Per-driver compliance detail |
| `/compliance/truck/:truckId` | Truck onboarding wizard |
| `/onboard/:token` | Public tokenized driver onboarding portal (outside the authenticated app shell) |

## Data Models (GraphQL / DynamoDB)
**Dispatch & fleet:** `Load` · `Driver` · `Equipment` (trucks/trailers) · `MaintenanceTask` · `MaintenanceInvoice` · `DriverAvailability`

**Telematics (Motive):** `TruckConfig` · `TruckMileage` · `TruckLocation` · `TruckLocationHistory`

**Intake & audit:** `IntakeItem` · `AuditLog`

**Expenses & fuel:** `FuelTransaction` · `ExpenseType` · `TruckExpenseAllocation` · `ExpenseRecord` · `RecurringExpense`

**DOT compliance & onboarding:** `OnboardingInvite` · `DriverApplication` · `ComplianceDocument` · `OnboardingTask` · `ComplianceAlert` · `EscalationRule` · `EscalationEmailLog` · `ComplianceSettings`

**Custom mutations/queries:**
- `notifySlackStatusChange` (mutation) — posts to Slack when an IntakeItem status changes → `slackStatusNotifier`
- `manageUsers` (query) — admin-gated Cognito user CRUD → `userManagement`
- `sendOnboardingEmail` (mutation) — driver-facing onboarding email via SES (invite/rejected/complete), honors kill switch → `onboardingEmailer`

Models use `allow.authenticated()`; `AuditLog` is restricted to `create`+`read`. Default auth mode is Cognito `userPool`. The driver portal has no AppSync access — it goes through the `onboarding-portal-api` Lambda, which validates the invite token server-side.

## Lambda Functions (`amplify/functions/`)
- **slack-intake-webhook** — receives forwarded Slack/email messages → creates IntakeItem records
- **slack-status-notifier** — posts to Slack when an intake status changes
- **userManagement** — admin-gated Cognito user CRUD
- **motive-mileage-sync** — syncs per-truck mileage (WEEK/MONTH) from the Motive API
- **motive-location-sync** — syncs current truck location + breadcrumb history from Motive (powers the dashboard map)
- **fuel-import** — parses EFS transaction reports → FuelTransaction records
- **generate-recurring-expenses** — materializes RecurringExpense templates into monthly ExpenseRecords
- **compliance-scanner** — daily cron (6 AM America/Chicago): scans ComplianceDocuments, upserts ComplianceAlerts, transitions doc statuses, recomputes cached compliance status, and sends escalation emails (Phase 4)
- **onboarding-emailer** — sends driver onboarding emails (invite/rejected/complete) via SES
- **onboarding-portal-api** — Function URL backing the public driver portal; validates invite token, scopes all reads/writes to the invite's driverId

## Intake Pipeline
Forwarded messages (Slack channel posts, plus legacy Gmail) → **slack-intake-webhook** Lambda Function URL → `IntakeItem` created with status `NEW` (source `IVAN_CARTAGE` / `BCAT_LOGISTICS`, `externalSource` `slack`|`gmail`, deduped by `externalId`) → appears in the `/intake` queue. Status changes fire `notifySlackStatusChange` → **slack-status-notifier** posts back to Slack.

## DOT Compliance & Onboarding
Internal staff manage driver/truck compliance from `/compliance`. Drivers are invited via `OnboardingInvite` (crypto-random token, ~14-day expiry) and complete the 49 CFR 391.21 application + document uploads in the public `/onboard/:token` portal (served by `onboarding-portal-api`, no Cognito). The `compliance-scanner` cron tracks expirations and raises `ComplianceAlert`s; `EscalationRule`/`EscalationEmailLog`/`ComplianceSettings` govern email escalation (default PAUSED). Never store full SSNs (last 4 only) or full fuel card numbers (last 4 only).

## Code Conventions
- All UI in `src/features/<name>/` (self-contained) or `src/components/`
- Hooks in `src/hooks/*` → call `src/lib/apiClient.ts` → AppSync
- Shared logic in `src/lib/*`; Zod schemas in `src/lib/schemas.ts`; multi-stop loads in `src/lib/stops.ts`
- `@/` import alias; no `any` in new files; Conventional Commits
- Never manually edit `amplify_outputs.json` (injected by deploy)
- Reference docs: `Docs/WELCOME.md`, `ARCHITECTURE.md`, `WORKFLOWS.md`, `STYLE.md`, `POST-DEPLOY-RUNBOOK.md`, and `SES-ONBOARDING-DNS.md`
