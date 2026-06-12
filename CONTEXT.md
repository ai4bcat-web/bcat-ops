# BCAT Ops — Platform Context

> Auto-generated context file for handing to Claude Desktop / other tools.
> Last updated: 2026-06-11

## What it is
Internal operations dashboard for BCAT dispatch — calendar scheduling, load management, driver schedules, expense/fuel tracking, email intake, and audit logging.

## Where it lives
| | |
|---|---|
| **Local dev URL** | http://localhost:5173 (run `npm run dev`) |
| **Local path** | `/Users/adminoid/bcat-ops` |
| **Live (prod)** | https://ops.bcatcorp.com / https://operations.bcatcorp.com (docs reference both — confirm canonical) |
| **Repo deploy** | AWS Amplify — auto-deploys every push to `main` (~2 min) |

> Note: This is a different project from the WordPress site `bestcareautotransport.com` and from the Python `MultiAgent_Operations` folder. bcat-ops is the React/AWS dispatch app.

## Tech Stack
**Frontend:** React 19 · TypeScript (strict) · Vite · Tailwind v4 · shadcn/ui (Radix primitives) · Zustand · React Router v7 · FullCalendar v6 (resource-timeline) · TanStack Table · react-hook-form + Zod · Recharts · sonner · date-fns

**Backend (AWS Amplify Gen 2):** AppSync GraphQL API · Cognito auth (userPool) · DynamoDB (via `a.model`) · S3 (confirmation docs) · Lambda functions

## Routes / Pages
| Route | Feature |
|---|---|
| `/dashboard` | Operational metrics (KPIs, fuel widget, open tasks) |
| `/calendar` | FullCalendar resource-timeline scheduler |
| `/loads` | Load grid (legacy `/grid` redirects here) |
| `/drivers` | Driver management + avatars |
| `/trucks` | Truck/equipment registry |
| `/maintenance` | Maintenance tracking |
| `/expenses` | Expense + fuel tracking, EFS upload |
| `/schedule` | Driver schedule view |
| `/audit-log` | Audit trail (legacy `/audit` redirects) |
| `/intake` | Email intake queue |
| `/tasks` | Task/todo board |
| `/users` | User management (admin-only) |

## Data Models (GraphQL / DynamoDB)
`Load` · `Driver` · `IntakeItem` · `AuditLog` · `FuelTransaction` · `ExpenseType` · `TruckExpenseAllocation` · `ExpenseRecord` · `RecurringExpense` · `TruckConfig` · `TruckMileage` · `DriverAvailability`

**Custom mutations/queries:** `notifySlackStatusChange` (Slack ping on intake status change), `manageUsers` (admin Cognito user mgmt via Lambda)

All models use `allow.authenticated()` authorization; default auth mode is Cognito `userPool`.

## Lambda Functions (`amplify/functions/`)
- **slack-intake-webhook** — receives forwarded emails → creates Intake items
- **slack-status-notifier** — posts to Slack when intake status changes
- **userManagement** — admin-gated Cognito user CRUD
- **motive-mileage-sync** — syncs truck mileage from Motive API
- **fuel-import** — parses EFS transaction reports → FuelTransaction records
- **generate-recurring-expenses** — materializes recurring expenses

## Email Intake Pipeline
Emails to `ivanloads@bcatcorp.com` / `bcatloads@bcatcorp.com` → forwarded to `ai4bcat@gmail.com` → Gmail filters label them (`ivan-intake` / `bcat-intake`) → Google Apps Script ("BCAT Intake Bridge", 5-min trigger) → POSTs to Lambda Function URL (secret `INTAKE_WEBHOOK_SECRET`) → appears in `/intake` queue.

## Code Conventions
- All UI in `src/features/<name>/` (self-contained) or `src/components/`
- Hooks in `src/hooks/*` → call `src/lib/apiClient.ts` → AppSync
- Shared logic in `src/lib/*`; Zod schemas in `src/lib/schemas.ts`
- `@/` import alias; no `any` in new files; Conventional Commits
- Never manually edit `amplify_outputs.json` (injected by deploy)
- Reference docs: `Docs/WELCOME.md`, `ARCHITECTURE.md`, `WORKFLOWS.md`, `STYLE.md`, and `SETUP.md` (intake setup)
