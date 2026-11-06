# Employee hours: clear per-driver pay-period view + per-driver hourly rate (PRODUCTION)

Branch `feat/hours-view` (cut from main after PR 135 / job 711). Ryne, 2026-11-06:
> "can we change employee hours to be a better view so it's easier to see total hours and total pto and
> total holiday per driver in an easy way. it should display each driver and their total 2 week pay with
> the option to expand each driver to see the day by day time. Make it very clear."
> "Can we also input driver pay per driver somewhere so it populates in the employee hours page. Pay rate
> should never show in the ivan driver app."
> "push all to production once complete"

Page: `src/features/hours/HoursPage.tsx` (`/hours`). Math: `summarizePayPeriod`, `payPeriodDays`,
`rowMinutes` in `src/lib/timeClock.ts` (PTO and HOLIDAY rows = 480 min; no overtime). Keep corrections
(signed office edits), Motive gap flags, the driver filter and the PTO year count; change the layout.

## 1. The page (very clear)
- Top: pay-period picker (existing 2-week periods, newest first) and a **summary bar**: Drivers, Total
  hours, Total PTO, Total holiday, **Total pay** for the period.
- **One row per driver**, collapsed by default, sorted by name. Columns, big and aligned, hours as
  `h:mm` with decimal beneath or on hover: **Driver · Worked hrs · PTO hrs · Holiday hrs · Total hrs ·
  Rate ($/hr) · 2-week pay**. Total pay = total hours (worked + PTO + holiday) × rate; no overtime.
  A driver with no rate shows "Set rate" (link that opens the rate editor) and pay "—", never $0.
  Color-coded chips: worked (neutral), PTO (blue), holiday (amber). A warning chip when a day has a
  Motive gap or an open clock-in.
- **Expand** a driver (click row or chevron; "Expand all / Collapse all" control) to the 14-day table:
  Date, weekday, In/Out (or "—"), Worked, PTO, Holiday, Day total, Motive first/last move + gap flag,
  note, and the existing Edit control for signed corrections. Weekends/empty days dimmed; the two
  weeks separated by a Week 1 / Week 2 subtotal line. Day-level PTO/holiday rows labelled as such.
- Footer row: totals across drivers (same as the summary bar). Print-friendly (payroll prints this).
- Export CSV of the period summary (driver, worked, PTO, holiday, total, rate, pay) for payroll.
- Pay figures (rate and dollars) are visible only to staff who can already open `/hours`; the page
  hides the Rate and Pay columns for anyone without ADMIN/owner/`page-driverPay` (pick the existing
  pay-page gate so hours-only staff still see hours).

## 2. Entering the hourly rate per driver
- Schema (additive, optional) on `DriverPaySetting`: `hourlyRate` (float, dollars/hour) and
  `hourlyRateHistory` (json: dated windows `[{from, until, hourlyRate}]`, same pattern as `rateHistory`,
  so a raise never rewrites a paid period). Pay for a day uses the rate in effect on that day.
- Where to enter it: on `/hours`, the rate cell of each driver row is an inline editor (pencil →
  dollars/hr, **Effective from** date defaulting to the start of the current period, Save). Also a
  "Hourly rate" field in the existing driver pay settings modal (`DriverPayForms` SettingsModal) for
  LOCAL drivers. Both write the same fields; a change ends the old window and appends a new one with
  who/when (audit line). Create the DriverPaySetting row for a driver that has none (payGroup LOCAL,
  payPercent 0 placeholder if required by the model; do not alter percent-based settlement behaviour).
- Pay math lives in a pure, tested function (`src/lib/hoursPay.ts`): per-day minutes × rate in effect,
  period total, rounding to cents once at the period level; unit tests for a mid-period raise, no rate,
  PTO + worked on the same day, holiday, empty period.

## 3. Pay rate must NEVER appear in the driver app
- The driver Lambda (`amplify/functions/driver-app-api`) must not read `hourlyRate`/`hourlyRateHistory`
  anywhere, and no driver-facing response (`/timeclock`, `/me`, `/time-off`, `/paperwork`, `/settlement`
  for non-Ivan unchanged) may contain a rate or dollar pay for hours. Add a handler test that seeds a
  DriverPaySetting with an hourly rate and asserts the serialized JSON of `/timeclock`, `/me` and
  `/time-off` responses contains neither the rate value nor the keys. Audit the driver app's `src/features/driver-app/`
  for any import of the rate fields and for AppSync reads of DriverPaySetting; add a lint-style test
  (grep) that fails if `hourlyRate` appears under `src/features/driver-app/` or
  `amplify/functions/driver-app-api/` (other than the test).
- Confirm the Ivan driver Cognito pool cannot read DriverPaySetting over AppSync (the model uses
  `allow.authenticated()`; check how the driver pool is separated and document the answer in the log;
  if drivers *can* read it directly, tighten the model's auth to exclude the driver pool/group and say so).

## 4. Gate, ship, verify
- typecheck, lint (no new warnings), full `npm test`, build; tests for the page (collapsed/expanded,
  totals, no-rate state, hidden pay columns without the gate) and `hoursPay`.
- Commit in steps on `feat/hours-view`, push, and open a PR. **Ryne has said "push all to production once
  complete":** after the gate is green and the orchestrator's review passes, merge to main (production
  deploy). Orchestrator does the merge.
- After deploy: open `/hours` on production and confirm the summary bar and expand work with real data;
  do not enter any real driver's rate (Ryne enters rates himself); log in `Docs/driver-app/BUILD_LOG.md`.
