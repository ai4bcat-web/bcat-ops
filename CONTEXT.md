# BCAT Ops — Platform Context

> Auto-generated context file for handing to Claude Desktop / other tools.
> Last updated: 2026-07-17

## What it is
Internal operations dashboard for BCAT dispatch — calendar scheduling, load management, driver schedules, fleet/equipment registry, live truck tracking, maintenance, maintenance invoices, expense/fuel tracking, weekly fleet profitability, finances, driver pay (Amazon + box-truck), Amazon driver disputes, email/Slack intake, DOT compliance & driver onboarding, a Best Care Auto Transport vehicle-quote emailer, and audit logging.

## Where it lives
| | |
|---|---|
| **Local dev URL** | http://localhost:5173 (run `npm run dev`) |
| **Local path** | `/Users/adminoid/bcat-ops` |
| **Live (prod)** | https://ops.bcatcorp.com (canonical, per README) |
| **Repo deploy** | AWS Amplify — auto-deploys every push to `main` (~2 min) |

> Note: This is a different project from the WordPress site `bestcareautotransport.com` and from the Python `MultiAgent_Operations` folder. bcat-ops is the React/AWS dispatch app.

## Tech Stack
**Frontend:** React 19 · TypeScript (strict) · Vite · Tailwind v4 · shadcn/ui (Radix primitives) · Zustand · React Router v7 · FullCalendar v6 (resource-timeline) · TanStack Table · react-hook-form + Zod · Recharts · `@vis.gl/react-google-maps` (dashboard truck map) · d3-geo / topojson-client / us-atlas (US map geometry) · jsPDF + jspdf-autotable (driver pay statement PDFs) · sonner · date-fns

**Backend (AWS Amplify Gen 2):** AppSync GraphQL API · Cognito auth (userPool) · DynamoDB (via `a.model`) · S3 (confirmation/compliance docs) · Lambda functions · SES (onboarding/escalation email)

## Routes / Pages
| Route | Feature |
|---|---|
| `/dashboard` | Operational metrics (KPIs, fuel widget, open tasks, live truck map, weekly fleet profitability, month-over-month comparison widget) |
| `/calendar` | FullCalendar resource-timeline scheduler |
| `/loads` | Load grid (legacy `/grid` redirects here) |
| `/drivers` | Driver management + avatars |
| `/trucks` | Truck/equipment registry (Fleet) |
| `/truck-docs` | Truck document tracking (insurance, IFTA, IRP, DOT inspection) — shares the compliance backend |
| `/maintenance` | Maintenance tasks |
| `/invoices` | Maintenance invoices |
| `/fuel` | Fuel transaction tracking, EFS report upload (legacy `/expenses` redirects here) |
| `/finances` | Profitability + fleet/Amazon P&L, combined monthly profit, fleet expenses |
| `/schedule` | Driver schedule view |
| `/time-off` | Driver time-off / availability management |
| `/driver-pay` | Amazon driver weekly (7-day) trip-based pay + statement PDFs/email |
| `/driver-pay-box-trucks` | Box-truck (Ivan Cartage) biweekly shipment-based pay |
| `/disputes` | Amazon driver disputes (underpaid/owed trips) — Google Form ingest + manual entry |
| `/audit-log` | Audit trail (legacy `/audit` redirects) |
| `/intake` | Email/Slack intake queue |
| `/tasks` | Task/todo board |
| `/users` | User management (admin-only) |
| `/vehicle-quote` | Best Care Auto Transport vehicle-quote emailer |
| `/compliance` | DOT compliance dashboard (drivers & trucks) |
| `/compliance/review` | Compliance document review queue |
| `/compliance/driver/:driverId` | Per-driver compliance detail |
| `/compliance/truck/:truckId` | Truck onboarding wizard |
| `/onboard/:token` | Public tokenized driver onboarding portal (outside the authenticated app shell) |

## Data Models (GraphQL / DynamoDB)
**Dispatch & fleet:** `Load` · `Driver` · `Equipment` (trucks/trailers; `fleetGroup` LOCAL/AMAZON is the source of truth for profitability membership) · `MaintenanceTask` · `MaintenanceInvoice` · `DriverAvailability`

**Driver pay:** `DriverPayPeriod` (biweekly gross pay, Paychex seam) · `AmazonTrip` (weekly trip-based Amazon pay lines) · `AmazonPayMaster` (archive of uploaded master CSVs, raw file in S3) · `BoxTruckTrip` (biweekly box-truck shipment lines) · `DriverPaySetting` (per-driver pay model: %, expense timing, fuel card, fixed deductions) · `DriverPayDeduction` (per-week one-off charges)

**Disputes:** `AmazonDispute` (driver claims that Amazon underpaid/owes on a trip; Google Form → intake Lambda, source `GOOGLE_FORM`, plus `MANUAL`; workflow PENDING → POSTED → PAID | REJECTED)

**Telematics (Motive + Blue Ink Tech):** `TruckConfig` · `TruckMileage` · `TruckLocation` · `TruckLocationHistory` (BIT trucks write into the same mileage/location tables as Motive)

**Intake & audit:** `IntakeItem` · `AuditLog`

**Expenses & fuel:** `FuelTransaction` · `ExpenseType` · `TruckExpenseAllocation` · `ExpenseRecord` · `RecurringExpense`

**DOT compliance & onboarding:** `OnboardingInvite` · `DriverApplication` · `ComplianceDocument` · `OnboardingTask` · `ComplianceAlert` · `EscalationRule` · `EscalationEmailLog` · `ComplianceSettings`

**Custom mutations/queries:**
- `notifySlackStatusChange` (mutation) — posts to Slack when an IntakeItem status changes → `slackStatusNotifier`
- `manageUsers` (query) — admin-gated Cognito user CRUD → `userManagement`
- `sendOnboardingEmail` (mutation) — driver-facing onboarding email via SES (invite/rejected/complete), honors kill switch → `onboardingEmailer`
- `sendDriverPayEmail` (mutation) — emails a driver their weekly pay statement PDF (built client-side, passed as base64) via SES → `driverPayEmailer`
- `sendVehicleQuoteEmail` (mutation) — emails a customer their Best Care Auto Transport vehicle quote as branded HTML, sent from ruben@bcatcorp.com and always BCC'd to cars@bcatcorp.com → `vehicleQuoteEmailer`
- `getGoogleReviews` (query) — live Google rating + review count for the Best Care Auto Transport listing (CTA in the quote email) → `googleReviews`

Models use `allow.authenticated()`; `AuditLog` is restricted to `create`+`read`. Default auth mode is Cognito `userPool`. The driver portal has no AppSync access — it goes through the `onboarding-portal-api` Lambda, which validates the invite token server-side.

## Lambda Functions (`amplify/functions/`)
- **slack-intake-webhook** — receives forwarded Slack/email messages → creates IntakeItem records
- **gmail-task-intake** — called by the Gmail Apps Script bridge for mail to the tasks@ distro → creates an IntakeItem (deduped by Gmail message id) and posts to #intake-ivan Slack
- **slack-status-notifier** — posts to Slack when an intake status changes
- **userManagement** — admin-gated Cognito user CRUD
- **motive-mileage-sync** — syncs per-truck mileage (WEEK/MONTH) from the Motive API
- **motive-location-sync** — syncs current truck location + breadcrumb history from Motive (powers the dashboard map)
- **blueink-sync** — pulls miles + location for Blue Ink Tech (BIT) ELD trucks and writes into the SAME TruckMileage/TruckLocation tables as Motive (location every 10 min, mileage daily); API key in the `BLUE_INK_TECH_API_KEY` Amplify secret
- **fuel-import** — parses EFS transaction reports → FuelTransaction records
- **generate-recurring-expenses** — materializes RecurringExpense templates into monthly ExpenseRecords
- **paychex-pay-sync** — pulls the latest closed Paychex pay period and writes ONE combined fleet driver-cost record into DriverPayPeriod (idempotent per period); feeds fleet driver cost in Finances
- **driver-pay-emailer** — custom AppSync mutation (`sendDriverPayEmail`); wraps the client-built pay-statement PDF in a MIME message and sends via SES
- **vehicle-quote-emailer** — custom AppSync mutation (`sendVehicleQuoteEmail`); sends the client-built Best Care Auto Transport quote HTML from ruben@bcatcorp.com, always BCC'ing cars@bcatcorp.com
- **google-reviews** — custom AppSync query (`getGoogleReviews`); returns the live Google rating + review count for the Best Care listing, shown as a CTA in the quote email
- **amazon-dispute-intake** — Function URL called by the Google Form Apps Script bridge; writes each dispute-form submission into an `AmazonDispute` record (deduped by `externalId`, source `GOOGLE_FORM`)
- **broker-load-alert** — DynamoDB stream consumer on the Load table; when a load is assigned to the "Broker Need to Cover" driver, creates a deduped IntakeItem task for Arcie and posts a heads-up to the BCAT global Slack channel
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
