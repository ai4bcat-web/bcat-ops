# Driver app build log

## 2026-11-06 — production batch (branch `feat/driver-app-nov6`, cut from `main`)

Spec: `Docs/driver-app/2026-11-06-driver-app-production-batch.md`. Seven items from Ryne.

### Commits

| Commit | Item |
|---|---|
| `4ba88991` | 7. Fleet maintenance: explicit **Save** for the DOT date and document expiry dates (`DraftDateField`); `null` clears; the toast reports the real result |
| `5a83f8bc` | test fix: `handler.test.ts` "recent loads" fixture was pinned to September dates against the real clock; clock pinned |
| `9bcb321b` | 5 + 6. **Your trailer** line (`TrailerLine`) next to every Your truck; change any time incl. bobtail; `Driver.bobtail`; admin shows "Bobtail" / "No trailer set"; **PTO eligible** switch in `DriverDrawer`, `ptoEligible` + `bobtail` through `updateDriver` |
| `030be57b` | 3. Load order: dispatch order wins, driver drag/Up-Down reorder, `POST /paperwork/reorder`, audit line per moved load |
| `9a97eb2e` | 4. Location notes on every stop (Location created from the stop, deduped by address), admin Driver notes column, staff Remove (`REMOVE_DRIVER_NOTE`) |
| `fe9fb7c2` | 1 + 2. Time-off requests in hours, Requests panel on `/time-off`, PTO as an 8-hour request that lands on the clock, year-to-date counts |

### What changed, per item

**7 — DOT date Save.** `src/features/files/DraftDateField.tsx` holds the draft; Save awaits `updateEquipment` directly (`EntityFilePanel` now calls the API, then patches the store), Cancel restores, clearing sends `null`. `Equipment.dotInspectionDate` is `string | null`; `TrucksPage` sends `null` on clear. Document expiry dates use the same field. Tests: partial typing does not write, Save writes once, failed write shows the error and keeps the draft.

**5 + 6 — trailer.** `POST /me/trailer` writes `bobtail = !trailerId`; `/me` returns `trailer` and `bobtail` (a trailer on file always beats a stale flag). Phone: `TrailerLine` on Dashboard, Account and Hours (Hours shows it on or off the clock), optimistic `useDriverTrailer().setTrailer`. Admin: `unitLine` ("Truck 3114 · Bobtail"), Files panel/list/packet, DriverDrawer select (picking a trailer clears bobtail).

**3 — load order.** Why it drifted: (a) `orderOpenStops` lifted any load with freight on board above loads not started, which overrode the calendar order as soon as a driver did one pickup early; now only the stop the driver is **on site at** floats. (b) the order key was a zero-padded string, so 1.5 sorted after 2 and 10 before 9 (`sortOrder` is a float); now numeric, in `daySheet.ts` and the admin `driverSchedule.ts`. Null `sortOrder` goes after ordered loads, by appointment. `POST /paperwork/reorder {date, loadIds[]}` checks every load is the driver's with a stop of theirs on that date, then re-deals the values those loads already hold (`src/lib/loadReorder.ts`) so other drivers' loads on the shared day line never move. The phone applies the same values locally, so the schedule-changed check sees an equal fingerprint (and ignores reads that began before the reorder landed). dnd-kit pinned: core 6.3.1, sortable 10.0.0, utilities 3.2.2.

**4 — location notes.** `POST /paperwork/location-note` takes `stopId`; with no `locationId` on the stop it matches an existing Location (normalized street address, else name + city; same normalization as `tms-directory-actions`) or creates one, links `Stop.locationId` (compare-and-set on `Load.updatedAt`), then appends the note. Lambda role gets `PutItem` on the Location table. Phone: "Location notes (check-in, dock, gate…)" box on every stop, newest note pinned in the card header. Admin `/locations`: Driver notes count + newest date; `LocationDetail` Remove per note via the new `REMOVE_DRIVER_NOTE` action (page-locations / page-customers / page-loads / ADMIN). LoadDrawer already showed the last 3 per stop.

**1 + 2 — time off and PTO.** `DriverAvailability` gets `PTO` type, `status`, `hours`, `source`, `reviewedBy`, `reviewedAt`, `reviewNote` (all optional; a row with no status reads APPROVED — `statusOf` in `src/lib/timeOff.ts`). Driver routes `GET/POST /time-off` (own rows, PENDING, overlap and duplicate-PTO refusals, PTO window 30 days back to 14 ahead, eligible drivers only, hours forced to 8). Staff routes `POST /staff/time-off/review` (approve/deny, reviewer = the verified staff email; approving PTO writes the 480-minute `TimeClockEntry`, status flips first under a PENDING condition and reverts if the clock write fails) and `POST /staff/time-off/pto` (staff-entered PTO day, approved at once, same clock row). Both staff routes accept the owner, `ADMIN`, or `page-timeOff` (not the short impersonation list). One PTO row per driver per day is enforced everywhere. `punch` no longer accepts PTO; "Use PTO for today" files a PENDING request. `useDriverAvailability().availabilities` is APPROVED only for every existing consumer (calendar, planner, grid, availability modal, fleet dashboard); `all` feeds the Requests panel. Year-to-date PTO = TimeClockEntry PTO rows in the calendar year: phone Time off section, `/hours` per driver, DriverDrawer.

### Gate (final run, worktree)

`npm run typecheck` clean · `npm test` 296 files / 3325 tests pass · `npm run build` ok · `npm run lint`: 1 error + 3 warnings, all pre-existing on `main` (`LoadDriverDocs.tsx` rules-of-hooks, `ScanPage.tsx` exhaustive-deps, `DriverDrawer.tsx` and `GridPage.tsx` compiler skip); none are in code from this batch.

### Not done / decisions for the reviewer

- **Driver notification on approve/deny (item 1).** `driver-app-api/notify.ts` only posts to the office (Slack + SES); there is no driver push or SMS path in that Lambda. Nothing was invented: the driver sees the status badge and the reviewer's note in the Time off section. A text through the dispatch number would need the Twilio wiring that `ratecon-assigned-text` has; say if you want it.
- Deleting an approved PTO entry on `/time-off` does not remove its `TimeClockEntry` row (correct or delete it on `/hours`).
- `daySlot` (planner badge): when every load in a reorder has its own slot, the slots are re-dealt with the order; otherwise slots are left alone.
- Requests the Lambda writes do not fire AppSync subscriptions: `/time-off` re-reads every minute and on tab focus.
- A stale browser tab open across the deploy may fail to render an approved PTO row until reloaded (unknown enum in its old type map).

### Production verification (after the orchestrator confirms the deploy)

Pending: Amplify job number, DOT Save on `/truck-docs`, Requests panel, test-driver round trip, and the Jason PTO day for 2026-11-05 (read-only driver lookup first; stop and report if not exactly one Jason).

## 2026-11-06 — Employee hours view and hourly rates (branch `feat/hours-view`, cut from `main` after PR 135)

Spec: `Docs/driver-app/2026-11-06-employee-hours-view.md`.

**The page (`/hours`).** `HoursPage` now loads and gates; `HoursPeriodView` lays out: a summary bar (Drivers, Total hours, Worked, Total PTO, Total holiday, Total pay), one collapsible row per driver sorted by name (Worked / PTO / Holiday / Total hours as `h:mm` with decimal beneath, Rate, 2-week pay), a footer total row (the same `totalsOf` as the bar), Expand all / Collapse all, Export CSV (`periodCsv`) and Print. Expanding a driver shows the 14 days: In/Out, Worked, PTO, Holiday, Day total, Motive first/last move, note, the signed Edit correction, Week 1 / Week 2 subtotals, empty days dimmed. Warning chip per day (`dayWarning`): still on the clock, or the clock more than 60 minutes from the truck's first/last move. Kept: corrections, Motive column wording, the driver filter, PTO used this year.

**Rates.** `DriverPaySetting.hourlyRate` (float) and `hourlyRateHistory` (json windows `[{from, until, hourlyRate, endedBy, endedAt}]`), additive. `src/lib/hoursPay.ts`: `rateOn`, `withRateChange` (closes the old window with who/when; a rate may not start before the current one began; same date corrects in place; a first rate leaves earlier days unrated), `payForPeriod` (each day's paid minutes at that day's rate, rounded to cents once), `money` (a dash, never $0, for no rate). The rate cell on `/hours` has an inline editor (dollars/hour, Effective from defaulting to the period start); `useHourlyRates` creates a `LOCAL` pay setting (0% placeholder) for a driver with none, keeps the group of an existing row, and writes an AuditLog line. Rate and pay need `hasPageAccess('driverPay')` (owner, ADMIN or `page-driverPay`); without it the page is hours only, no pay column, no editor, and the pay settings are not even fetched.

**Not done on purpose:** the "Hourly rate" field in the existing driver pay settings modal. That modal (`DriverPayForms.SettingsModal`) is the Amazon percent model: it requires a percent and saves `payGroup: 'AMAZON'`, so using it for a LOCAL driver would flip their group. The `/hours` editor writes the same fields.

**Pay rate never reaches the driver app.** The driver Lambda does not read `hourlyRate` / `hourlyRateHistory`. Tests: `handler.test.ts` seeds both fields (and a history rate) on DriverPaySetting and asserts the serialized `/timeclock`, `/me`, `/time-off` (GET and POST), `/paperwork`, `/paperwork/weeks` responses contain neither the keys nor the values, and that a percent-paid driver's `/settlement` is byte-identical with and without an hourly rate; `src/lib/driverAppNoPayRate.test.ts` fails if `hourlyRate`, `hourlyRateHistory` or `hoursPay` appear under `src/features/driver-app/` or `amplify/functions/driver-app-api/`, or if the driver app imports the AppSync client.

**Can drivers read DriverPaySetting over AppSync? No.** The data API's only authorization mode is `userPool` (`defaultAuthorizationMode: 'userPool'`, `amplify/data/resource.ts`), which is the staff pool. The driver pool (`bcat-driver-pool`, `amplify/backend.ts`) is a separate CDK pool that is not an authorization provider on the API; driver tokens are verified only by the driver-app-api Lambda, and the driver app has no AppSync client (checked by the test above). No auth change was needed.

**Verification pending** (after the orchestrator says deploy is live): open `/hours` in production, confirm summary bar and expand against real data. No driver's rate was entered.

## 2026-11-06 — production verification of deploy 711 (batch PR 135, main `37a22a0c`)

Production = Amplify app `d3dejqzs77khq6`, branch `main`, active job `0000000711`; AppSync API `5ucwdyvwivelbo4k4jomvrwel4` (tag `amplify:branch-name=main`). Read-only checks only; nothing was written.

**Verified without a login**
- Schema: `DriverAvailability` in production has `status`, `hours`, `source`, `reviewedBy`, `reviewedAt`, `reviewNote` and type `PTO`. `Driver`/pay-setting fields from PR 136 (`hourlyRate`) are correctly not there yet.
- Driver Lambda `driverappapilambda…U31WM0kM1L82` (modified 2026-11-06T15:28Z) has `DRIVER_AVAILABILITY_TABLE_NAME`, `TIME_CLOCK_TABLE_NAME`, `STAFF_USER_POOL_ID`. Unauthenticated `GET /time-off`, `POST /time-off`, `POST /staff/time-off/pto` return 401 (routes exist, auth enforced), not 404.
- Served bundle (`ops.bcatcorp.com`, `index-DbUDTljF.js`) contains the new UI strings: "Show denied", "No requests waiting", "Driver notes".

**Jason lookup (production `Driver` table, read-only scan, 16 drivers):** exactly one driver whose name contains "Jason": `Jason Smith`, id `9f8266cd-d9ab-46ad-80b5-d62b5abfa70c`, active, `fleetGroup` LOCAL, **`ptoEligible` unset**. (The two Motive "Jason Smith" accounts are not Driver rows.)

**Blocked, not done**
- Authenticated checks (DOT Save on `/truck-docs`, Requests panel on `/time-off`, `/hours`, the driver app's Time off section via View as driver) need a staff session. This machine has AWS root credentials but no ops.bcatcorp.com login, and no relay to a signed-in browser. Not worked around (no password reset or test user created in the production staff pool).
- Jason's PTO day for 2026-11-05 not created: `POST /staff/time-off/pto` needs a staff ID token (owner, ADMIN or `page-timeOff`) and refuses a driver who is not PTO eligible, which Jason is not. Setting his `ptoEligible` is a production write to a real driver's record that was not part of the request.

### Jason Smith PTO day for 2026-11-05 — NOT created (existing 11/5 availability row)

Ryne approved turning on `ptoEligible` for Jason and entering the day by direct writes to the production (main) tables, on condition that nothing already exists for him on 11/5. Read-only pre-check (production API `5ucwdyvwivelbo4k4jomvrwel4`):

- `Driver` `9f8266cd-d9ab-46ad-80b5-d62b5abfa70c` (Jason Smith, LOCAL, active): `ptoEligible` absent, `updatedAt` 2026-11-06T11:00:41.835Z.
- `TimeClockEntry` rows for Jason: 22, none on 2026-11-05, none of kind PTO (nearest: WORK on 11/4 and 11/6).
- `DriverAvailability` rows for Jason: 3. **One is on 2026-11-05**: id `241ccad2-deba-45a7-9455-a3db1bbccb8d`, type `FULL_DAY_OFF`, startDate = endDate = 2026-11-05, no status (reads APPROVED), createdBy `Ryne@bcatcorp.com`, createdAt 2026-11-02T17:49:23.725Z. (The other two are 6/26 and 9/23–9/25.)

Per the instruction "if one exists, change nothing and report", **no write was made**: not `ptoEligible`, not the availability row, not the clock row.

### Jason Smith PTO day for 2026-11-05 — CREATED (Ryne approved option 2: keep the day-off row, add PTO alongside)

Written 2026-11-06T17:17:36.433Z by direct DynamoDB writes to the production (main) tables, replicating `POST /staff/time-off/pto` (no staff login on the machine). Right before writing: no PTO availability and no clock row for Jason on 11/5; the existing FULL_DAY_OFF row `241ccad2-deba-45a7-9455-a3db1bbccb8d` left untouched (read back byte-identical).

1. `Driver` `9f8266cd-d9ab-46ad-80b5-d62b5abfa70c` only: `SET ptoEligible = true, updatedAt = 2026-11-06T17:17:36.433Z` (was: absent / 2026-11-06T11:00:41.835Z). Nothing else on the row changed.
2. `DriverAvailability` `460dee28-51fc-4035-a459-39695423947e` (conditional put, attribute_not_exists(id)): type PTO, startDate = endDate = 2026-11-05, hours 8, status APPROVED, source STAFF, createdBy and reviewedBy `Ryne@bcatcorp.com`, reviewedAt/createdAt/updatedAt 2026-11-06T17:17:36.433Z, note "PTO demo day entered at Ryne's request".
3. `TimeClockEntry` `ae0249ce-5157-49b1-b33d-4220c946adec` (conditional put): driverId Jason, workDate 2026-11-05, kind PTO, minutes 480, clockInAt/clockOutAt null, source STAFF, note "PTO approved by Ryne@bcatcorp.com", createdAt/updatedAt as above.

Verified by reading the rows back and running them through the project's own logic: `ptoDaysUsed(…, '2026')` = 1; `statusOf`/`isApproved` on 11/5 gives FULL_DAY_OFF/APPROVED and PTO/APPROVED; `summarizePayPeriod` for the 2026-10-26 period shows 11/5 as worked 0:00, **PTO 8:00**, holiday 0:00, day total 8:00 (period PTO 8:00, period total 79:52). Not checked in a browser (no staff login); no pay rate entered.
