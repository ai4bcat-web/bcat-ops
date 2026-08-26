# BCAT Ops — Platform Context

> Auto-generated context file for handing to Claude Desktop / other tools.
> Last updated: 2026-08-26

## What it is
Internal operations dashboard for BCAT dispatch — calendar scheduling, load management, driver schedules, fleet/equipment registry, live truck tracking, maintenance, maintenance invoices, expense/fuel tracking, insurance premium tracking, weekly fleet profitability, a fleet-manager dashboard (PM/DOT-due tracking), finances, a manual weekly cash-flow forecast, an appointment-booking queue (stops flagged NEED or still pending a time), driver pay (Amazon + box-truck), Amazon driver disputes, email/Slack intake, DOT compliance & driver onboarding, a Files hub (the driver roster plus everything on file per driver/truck, downloadable as one PDF packet), driver documents with tokenized e-signature, Best Care Auto Transport vehicle-quote and booking-confirmation emailers, a Reddit reply queue (marketing), and audit logging. Access is per-page: every route is gated by `RequirePage` on Cognito `page-<key>` groups (allowlist — a non-admin with no page groups sees everything; granting any group restricts them to those pages).

## Where it lives
| | |
|---|---|
| **Local dev URL** | http://localhost:5173 (run `npm run dev`) |
| **Local path** | `/Users/adminoid/bcat-ops` |
| **Live (prod)** | https://ops.bcatcorp.com (canonical, per README) |
| **Repo deploy** | AWS Amplify — auto-deploys every push to `main` (~2 min) |

> Note: This is a different project from the WordPress site `bestcareautotransport.com` and from the Python `MultiAgent_Operations` folder. bcat-ops is the React/AWS dispatch app.

## Tech Stack
**Frontend:** React 19 · TypeScript (strict) · Vite · Tailwind v4 · shadcn/ui (Radix primitives) · Zustand · React Router v7 · FullCalendar v6 (resource-timeline) · TanStack Table · react-hook-form + Zod · Recharts · `@vis.gl/react-google-maps` (dashboard truck map) · d3-geo / topojson-client / us-atlas (US map geometry) · jsPDF + jspdf-autotable (driver pay statement PDFs) · pdf-lib (Files hub packet PDFs — merges stored documents into one file) · sonner · date-fns · Vitest + Testing Library (render tests, `npm run test`)

**Backend (AWS Amplify Gen 2):** AppSync GraphQL API · Cognito auth (userPool) · DynamoDB (via `a.model`) · S3 (confirmation/compliance docs) · Lambda functions · SES (onboarding/escalation email) · Anthropic Claude via `@anthropic-ai/sdk` (trip-screenshot parsing Lambda)

## Routes / Pages
| Route | Feature |
|---|---|
| `/dashboard` | Operational metrics (KPIs incl. revenue vs-previous-period delta and Broker Covered card, fuel widget, repair-invoices widget with an "N awaiting review" heads-up linking to `/invoices?tab=queue`, open tasks, live truck map, weekly fleet profitability, month-over-month comparison widget) |
| `/calendar` | FullCalendar resource-timeline scheduler |
| `/loads` | Load grid (legacy `/grid` redirects here) |
| `/drivers` | → redirects to `/files` — the Drivers page is retired; the roster and the driver editor now live in the Files hub |
| `/fleet-dashboard` | Fleet Manager dashboard — repair spend, expiring truck docs, maintenance tasks, PM-due (25k-mi) and DOT-due widgets, driver time-off |
| `/trucks` | Truck/equipment registry (Fleet) — the compliance pill/chips, detail panel, sort and Compliance Alerts KPI judge insurance/IFTA/IRP via `effectiveExpiration()` in `src/lib/truckDocs.ts`: the certificate uploaded on Asset Documents/Files wins, the date typed into the equipment form is only the fallback, a WAIVED document means the requirement doesn't apply, and IFTA/IRP are never counted against trailers |
| `/truck-docs` | Asset Documents — truck/trailer document tracking (insurance, IFTA + IRP — trucks only, trailers are exempt — DOT inspection, inside-VIN / trailer-plate photos); shares the compliance backend and the Files hub's panel + catalog (`src/lib/truckDocs.ts`) |
| `/maintenance` | Maintenance tasks |
| `/invoices` | Maintenance invoices — list plus a Review Queue tab (`?tab=queue`) for emailed repairs, with edit/post/archive; one invoice can cover multiple units; KPI row includes an Unpaid card (count + total owed on posted invoices with no payment date, amber when non-zero) |
| `/fuel` | Fuel transaction tracking, EFS report upload, fuel price anomaly widget flagging transactions >15% above the per-fuel-type fleet average (`src/lib/fuelAnomalies.ts`) (legacy `/expenses` redirects here) |
| `/finances` | Profitability + fleet/Amazon P&L, combined monthly profit, fleet expenses |
| `/cash-flow` | Manual weekly cash-flow forecast for BCAT + IVAN — cash/AR/AP inputs typed in by hand (deliberately NOT wired to Load/Invoice/ExpenseRecord), runway projection, weekly snapshot log + trend chart |
| `/appts` | Appointments queue — loads with a pickup or delivery stop flagged NEED or still pending a time (FCFS/range stops excluded), ONE ROW PER SHIPMENT with separate PU Status / Del Status columns (and PU + delivery locations/drivers side by side), sectioned by pickup day (each day exportable as CSV), hides past stops, edit the scheduled PU/delivery times in place or book from the calendar (`src/lib/apptQueue.ts`) |
| `/insurance` | Insurance premiums — per-truck/trailer + workers' comp annual amounts by policy period, period-over-period compare, driver insurance-deduction recovery KPI; feeds per-truck insurance cost in profitability |
| `/schedule` | Driver schedule view (route only — not listed in the sidebar nav) |
| `/time-off` | Driver time-off / availability management |
| `/driver-pay` | Amazon driver weekly (7-day) trip-based pay + statement PDFs/email |
| `/driver-pay-box-trucks` | Box-truck (Ivan Cartage) biweekly shipment-based pay — settlement credits (detention/layover/bonus, paid at 100%), one-off deductions, and pushing a shipment forward to the next pay period |
| `/disputes` | Amazon driver disputes (underpaid/owed trips) — Google Form ingest + manual entry |
| `/driver-docs` | Driver Documents — send forms (e.g. WI IC-Status statement) for tokenized e-signature |
| `/files` | Files hub — the driver roster (status tabs All / Active / Onboarding / Inactive with counts, plus the full driver editor moved here from the retired Drivers page) and a per-driver / per-truck view of every document/photo on file: ready score (`N/M` slots), expiry state, upload/waive, per-document responsibility (Management vs Employee/contractor), admin-only "private" document types, onboarding progress + kickoff and driver-upload review inside the driver file, and a merged "packet" PDF download (IVAN CARTAGE branded, with a "Choose…" picker to subtract documents). Drivers are created invite-only (email + fleet → driver record + application link); reads and writes the same `ComplianceDocument` store as Compliance, Onboarding and Asset Documents (`src/lib/fileHub.ts`) |
| `/audit-log` | Audit trail (legacy `/audit` redirects) |
| `/intake` | Email/Slack intake queue |
| `/tasks` | Task/todo board |
| `/settings` | Company-wide settings — escalation rules, email kill switches, private/responsibility document lists (moved here when the Compliance pages were retired) |
| `/users` | User management (owner-only) — Cognito CRUD plus per-page access grants and the admin flag |
| `/vehicle-quote` | Best Care Auto Transport vehicle-quote emailer |
| `/vehicle-confirmation` | Best Care Auto Transport booking-confirmation emailer (cost, ZIPs, pickup/delivery dates, transport type) |
| `/reddit-queue` | Reddit reply queue — VA workflow for manually posting drafted replies (copy text, open thread, mark posted/skipped); reads drafts for JobsDone Labs / Best Care Auto from an external command-center API (`VITE_COMMAND_CENTER_URL`, same-origin in prod), not AppSync |
| `/compliance/*` | → ALL redirect to `/files` — the standalone Compliance/Onboarding pages are retired; compliance lives in the driver and truck files, and the global settings moved to `/settings` |
| `/onboard/:token` | Public tokenized driver onboarding portal (outside the authenticated app shell) |
| `/sign/:token` | Public tokenized document-signing page — driver fills + e-signs a Driver Documents form (outside the authenticated app shell) |

Every authenticated route is wrapped in `RequirePage` (`src/components/RequirePage.tsx`) — the same allowlist as the sidebar nav, so hidden pages are also unreachable by URL. `/` lands on Dashboard, else the Fleet Manager Dashboard, else the first accessible page; `/users` requires the owner account.

## Data Models (GraphQL / DynamoDB)
**Dispatch & fleet:** `Load` · `Driver` · `Equipment` (trucks/trailers; `fleetGroup` LOCAL/AMAZON/BOX_TRUCK is the source of truth for profitability membership) · `MaintenanceTask` · `MaintenanceInvoice` · `DriverAvailability`

**Driver pay:** `DriverPayPeriod` (biweekly gross pay, Paychex seam) · `AmazonTrip` (weekly trip-based Amazon pay lines) · `AmazonPayMaster` (archive of uploaded master CSVs, raw file in S3) · `BoxTruckTrip` (biweekly box-truck shipment lines) · `DriverPaySetting` (per-driver pay model: %, expense timing, fuel card, fixed deductions) · `DriverPayDeduction` (per-week one-off charges) · `DriverPayCredit` (extra pay added to a settlement that didn't come from shipment gross profit — detention, layover, bonus, reimbursement; the pay % is NOT applied, `reasonCode` is a plain string so the list can grow without a redeploy — see `src/lib/payCredits.ts`)

**Disputes:** `AmazonDispute` (driver claims that Amazon underpaid/owes on a trip; Google Form → intake Lambda, source `GOOGLE_FORM`, plus `MANUAL`; workflow PENDING → POSTED → PAID | REJECTED)

**Telematics (Motive + Blue Ink Tech):** `TruckConfig` · `TruckMileage` · `TruckLocation` · `TruckLocationHistory` (BIT trucks write into the same mileage/location tables as Motive)

**Intake & audit:** `IntakeItem` · `AuditLog`

**Expenses & fuel:** `FuelTransaction` · `ExpenseType` · `TruckExpenseAllocation` · `ExpenseRecord` · `RecurringExpense`

**Insurance:** `InsurancePeriod` (policy year; `isCurrent` marks the one used for current insurance cost) · `InsuranceLineItem` (per-period annual premium in cents; kind TRUCK | TRAILER | WORKMANS_COMP, linked to Equipment for truck/trailer lines)

**Cash flow (STANDALONE):** `CashFlowInputs` (the current manual input set — cash, AR 30/120, AP buckets, recurring revenue/expenses, in cents; one `isCurrent` row, older rows kept for traceability) · `CashFlowWeekLog` (one appended row per week — snapshots the headline figures AND the projection they produced). Deliberately isolated: no relations, nothing else reads or writes them — do NOT wire them to Load/Invoice/ExpenseRecord; the page's premise is hand-entered numbers.

**DOT compliance & onboarding:** `OnboardingInvite` · `DocumentSignatureRequest` (a "send for signature" request for a Driver Documents form, e.g. WI IC-Status `ic_status_wi`; driver signs at `/sign/:token`, portal Lambda stores the signed PDF and flips status SENT → SIGNED) · `DriverApplication` · `ComplianceDocument` · `OnboardingTask` (supports phased templates via `phase`/`owner`/`templateId`) · `ComplianceAlert` · `EscalationRule` · `EscalationEmailLog` · `ComplianceSettings` · `OnboardingTemplateConfig` (editable phased-onboarding template stored as JSON, e.g. `amazon-driver-v1`; kickoff reads it instead of the code default so staff can edit the steps drivers see)

One document dataset: `ComplianceDocument` is the ONE store for every uploaded document/photo (drivers and trucks). Compliance, Onboarding, Driver Documents, Asset Documents and the Files hub all read it through the shared cache in `src/lib/complianceDocStore.ts`, which owns the single "which document is current" rule so those pages can't disagree about a doc's status. Document-type keys are shared across `src/lib/complianceRequirements.ts` (driver) and `src/lib/truckDocs.ts` (asset) — renaming one orphans every document already uploaded under it. A driver's file slots are DERIVED from `DRIVER_REQUIREMENTS` (every requirement with `requiresDocument`), so the DQ file, the portal and the onboarding checklist come from one list; only the fleet-specific agreement (employment vs lease) is added on top. Uploading a document in the Files hub also completes the onboarding task it satisfies (`findLinkedTask` in `src/hooks/useFileHub.ts`); a failure there logs rather than failing the upload.

Notable model fields: `Load` stops (and their legacy `pickupAppt*`/`deliveryAppt*` mirror fields) carry appointment windows and types (`appt`/`apptEnd`/`apptType`); stops flagged NEED or missing a time feed the `/appts` queue (FCFS and range stops are excluded — see `src/lib/apptQueue.ts`), and the transition INTO NEED fires the `notifyApptNeeded` Slack ping. `Driver.onboardingStatus` now includes `ARCHIVED` (candidate set aside, reversible) and `Driver.onboardingTemplateId` selects the phased template. `ComplianceSettings.privateDocumentTypes` (document types only admins may see — pay-term paperwork; presentation-level only, still readable via the API) and `ComplianceSettings.documentResponsibility` (documentType → `OFFICE` | `DRIVER`) let both lists change without a redeploy; the responsibility default comes from the catalog's `driverActionable` flag (`src/lib/fileHub.ts`). `Equipment.lastPmDate`/`lastPmMileage` feed the Fleet Manager dashboard's 25k-mi PM countdown. `MaintenanceInvoice.source` (`EMAIL` from the repairs@ pipeline | `MANUAL`), `status` (`PENDING` | `POSTED` | `ARCHIVED`) and `reviewedBy` drive the invoice review queue — effective state is computed in `src/lib/invoiceStatus.ts`, where a null status plus the `INVOICE_QUEUE_CUTOFF` timestamp keeps legacy and manual invoices POSTED (no back-fill needed) and only PENDING/ARCHIVED are excluded from the dashboard and P&L. `MaintenanceInvoice.externalId` is a hash of the SOURCE document (date + vendor + amount + invoice #) set once at ingest and deliberately excluding `equipmentId` — keying on the unit made reviewed/archived invoices reappear in the queue after staff re-assigned them (see `scripts/invoiceDedup.mjs`).

**Custom mutations/queries:**
- `notifySlackStatusChange` (mutation) — posts to Slack when an IntakeItem status changes → `slackStatusNotifier`
- `manageUsers` (query) — admin-gated Cognito user CRUD, including per-page access grants (`pages` → `page-<key>` Cognito groups) and the admin flag → `userManagement`
- `sendOnboardingEmail` (mutation) — driver-facing onboarding email via SES (invite/rejected/complete), honors kill switch → `onboardingEmailer`
- `sendDriverPayEmail` (mutation) — emails a driver their weekly pay statement PDF (built client-side, passed as base64) via SES → `driverPayEmailer`
- `parseTripScreenshot` (mutation) — reads an Amazon Relay trips-list screenshot (base64 image, downscaled client-side) into structured trip rows for the Driver Pay import, previewed before saving → `tripScreenshotParser`
- `notifyApptNeeded` (mutation) — posts to Slack #appts-ivan when a pickup/delivery is flagged NEED; fired by the client only on a TRANSITION (into NEED, or a time change on a stop already asked about), so re-saving an already-flagged load stays quiet. A `kind: 'updated'` call passes `threadTs` to reply inside the thread that asked (the returned `ts` is persisted on the stop as `apptThreadTs`), keeping one appointment's history in one Slack thread → `apptNeedNotifier`
- `sendVehicleQuoteEmail` (mutation) — sends Best Care Auto Transport branded HTML email (backs both the `/vehicle-quote` quote and the `/vehicle-confirmation` booking confirmation), from ruben@bcatcorp.com and always CC'd to cars@bcatcorp.com (visible to the customer; falls back to the legacy `BCC_ADDRESS` env var) → `vehicleQuoteEmailer`
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
- **trip-screenshot-parser** — custom AppSync mutation (`parseTripScreenshot`); uses the Anthropic SDK (Claude vision) to read an Amazon Relay trips-list screenshot into structured trip rows for the Driver Pay import
- **appt-need-notifier** — custom AppSync mutation (`notifyApptNeeded`); posts a "go book this appointment" message with load references to Slack #appts-ivan when a stop is flagged NEED
- **vehicle-quote-emailer** — custom AppSync mutation (`sendVehicleQuoteEmail`); sends the client-built Best Care Auto Transport quote HTML from ruben@bcatcorp.com, always CC'ing cars@bcatcorp.com
- **google-reviews** — custom AppSync query (`getGoogleReviews`); returns the live Google rating + review count for the Best Care listing, shown as a CTA in the quote email
- **amazon-dispute-intake** — Function URL called by the Google Form Apps Script bridge; writes each dispute-form submission into an `AmazonDispute` record (deduped by `externalId`, source `GOOGLE_FORM`)
- **broker-load-alert** — DynamoDB stream consumer on the Load table; when a load is assigned to the "Broker Need to Cover" driver, creates a deduped IntakeItem task for Arcie and posts a heads-up to the BCAT global Slack channel
- **compliance-scanner** — daily cron (6 AM America/Chicago): scans ComplianceDocuments, upserts ComplianceAlerts, transitions doc statuses, recomputes cached compliance status, and sends escalation emails (Phase 4)
- **onboarding-emailer** — sends driver onboarding emails (invite/rejected/complete) via SES
- **onboarding-portal-api** — Function URL backing the public driver portal; validates invite token, scopes all reads/writes to the invite's driverId

## Intake Pipeline
Forwarded messages (Slack channel posts, plus legacy Gmail) → **slack-intake-webhook** Lambda Function URL → `IntakeItem` created with status `NEW` (source `IVAN_CARTAGE` / `BCAT_LOGISTICS`, `externalSource` `slack`|`gmail`, deduped by `externalId`) → appears in the `/intake` queue. Status changes fire `notifySlackStatusChange` → **slack-status-notifier** posts back to Slack.

## DOT Compliance & Onboarding
The standalone `/compliance` pages are retired — staff manage driver/truck compliance from the Files hub (`/files`), and the company-wide controls (escalation rules, email kill switches, private/responsibility document lists) live at `/settings`. Drivers are invited via `OnboardingInvite` (crypto-random token, ~14-day expiry) and complete the 49 CFR 391.21 application + document uploads in the public `/onboard/:token` portal (served by `onboarding-portal-api`, no Cognito). The driver requirement catalog (`src/lib/complianceRequirements.ts`) covers the DOT Driver Qualification file (49 CFR 391.51), including the annual certification of violations (391.27) and the conditional SPE / medical-variance certificate (391.49); the completed employment application is itself a retained document. Action-only items (Clearinghouse queries, National Registry check, previous-employer inquiry) stay on the checklist and off the file. The `compliance-scanner` cron tracks expirations and raises `ComplianceAlert`s; `EscalationRule`/`EscalationEmailLog`/`ComplianceSettings` govern email escalation (default PAUSED). Never store full SSNs (last 4 only) or full fuel card numbers (last 4 only).

## Code Conventions
- All UI in `src/features/<name>/` (self-contained) or `src/components/`
- Hooks in `src/hooks/*` → call `src/lib/apiClient.ts` → AppSync
- Shared logic in `src/lib/*`; Zod schemas in `src/lib/schemas.ts`; multi-stop loads in `src/lib/stops.ts`; document slots/readiness in `src/lib/fileHub.ts` and packet PDFs in `src/lib/filePacketPdf.ts`; the carrier name/header used by every outgoing PDF lives in `src/lib/branding.ts`
- `@/` import alias; no `any` in new files; Conventional Commits
- Never manually edit `amplify_outputs.json` (injected by deploy)
- Reference docs: `Docs/WELCOME.md`, `ARCHITECTURE.md`, `WORKFLOWS.md`, `STYLE.md`, `POST-DEPLOY-RUNBOOK.md`, and `SES-ONBOARDING-DNS.md`
