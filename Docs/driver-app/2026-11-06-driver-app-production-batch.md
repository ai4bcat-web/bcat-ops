# Driver app + fleet batch — PRODUCTION (branch `feat/driver-app-nov6` off `main`)

Ryne, 2026-11-06: "Let's make some changes to production BCAT ops." Seven items below, verbatim in the
quotes. This branch is cut from `main` (production, https://ops.bcatcorp.com), NOT from `dev`; nothing
from the TMS dev branch rides along. Work only in the worktree `/Users/adminoid/bcat-ops-driver`.

"The Ivan driver app" = `src/features/driver-app/` (PWA at `/driver/*`, PAPERWORK program), talking to
the `driver-app-api` Lambda through `src/features/driver-app/driverApi.ts`. Same Amplify app and build
as the dashboard; a push to `main` deploys both. Schema additions below are optional fields only.

## 1. Request time off (in hours) → approve on the admin Time Off page
> "Add a Section for requesting days off in hours on the driver app. It should trigger a request on the
> admin dashboard in the time off page where we can approve it."

- Extend `DriverAvailability` (amplify/data/resource.ts:1428): `status` (PENDING | APPROVED | DENIED;
  staff-entered rows default APPROVED, driver requests PENDING), `hours` (number, requested hours),
  `source` (DRIVER | STAFF), `reviewedBy`, `reviewedAt`, `reviewNote`. Add type `PTO` to the type list
  (see §2). Existing rows without `status` read as APPROVED.
- Lambda `driver-app-api`: grant + env for the DriverAvailability table (amplify/backend.ts:294-440);
  routes `GET /time-off` (own rows, newest first, with status) and `POST /time-off`
  `{type, startDate, endDate, hours, note}` → PENDING, source DRIVER, createdBy = driver. Reject
  overlapping PENDING/APPROVED rows for the same dates with a clear message.
- Phone: new **Time off** section on the Hours tab (TimeClockPage) with a request form (type: Day off /
  Early start / Late start / PTO; dates; hours, default 8 for a full day; note) and the list of the
  driver's requests with status badges Pending / Approved / Denied and the reviewer's note.
- Admin `/time-off` (TimeOffPage.tsx): a **Requests** panel at the top listing PENDING rows (driver,
  type, dates, hours, note, requested at) with **Approve** and **Deny** (deny takes an optional note).
  Approve/Deny write status, reviewedBy (signed-in user), reviewedAt. The calendar and the existing
  list show APPROVED only; PENDING appears only in the Requests panel; DENIED is hidden behind a
  "Show denied" toggle. Every other consumer of DriverAvailability (calendar PlannerView,
  GridCalendarView, DriverAvailabilityModal, CalendarPage, FleetManagerDashboardPage) must ignore
  PENDING and DENIED.
- Notify: approve/deny posts to the driver's existing notification path (driver-app-api `notify.ts`,
  push or SMS, whatever that module already does) with one line "Your time off for <dates> was
  approved/denied".

## 2. PTO day = 8 hours, stackable, with a year-to-date count
> "Add the ability for a driver in the Ivan driver app to choose PTO for a day. It should give them 8
> hours for that day, and they can add it on top of existing hours if they also worked a little that
> day. It should also track how many PTO days they've used so far this year."

Existing: `TimeClockEntry.kind = PTO` = 480 min, stacking already works (src/lib/timeClock.ts),
`POST /timeclock/punch` action PTO (today only), `Driver.ptoEligible` gate, "Use PTO for today" button.

- PTO becomes a **time-off request of type PTO** (§1) so it carries an approval. Driver picks the day
  (date picker: any day from 30 days back to 14 days ahead), hours fixed at 8. Approving a PTO request
  on the admin page **creates the `TimeClockEntry` PTO row (480 min, source STAFF/approval, workDate =
  that day)**; denying creates nothing. Staff can also add a PTO day directly on `/time-off`
  (TimeOffFormModal gets type PTO) which is APPROVED immediately and creates the row the same way.
  One PTO row per driver per day: approving a second PTO for the same day is refused with a message.
  Keep the existing "Use PTO for today" button but route it through the same request path (creates a
  PENDING PTO request for today), so nothing bypasses approval.
- **PTO used this year**: count `TimeClockEntry` rows with kind PTO and workDate in the current
  calendar year (1 row = 1 day). Show it in the phone's Time off section ("PTO used in 2026: N days")
  via `GET /timeclock` or `GET /time-off`, on the admin `/hours` page per driver, and in the
  DriverDrawer next to the eligibility toggle.
- Add a **PTO eligible** toggle in DriverDrawer (next to ivanApp / timeClock, DriverDrawer.tsx:401-419)
  and carry `ptoEligible` through `updateDriver` (src/lib/apiClient.ts:393-410). Drivers who are not
  eligible can still request Day off / Early / Late, just not PTO (the option is hidden with a hint).

## 3. Load order follows dispatch; driver can drag to reorder; syncs back
> "Sometimes the loads don't arrange themselves in the correct order. Can we make it so it follows the
> order set in the admin dashboard but also allow the driver to drag the loads into the correct order
> if not correct and have it update on our side in the admin app."

Existing: `Load.sortOrder` (float), admin grid/planner write 1..N per day (src/lib/calendarOrder.ts),
phone `stopsForDay` sorts by sortOrder then appointment (paperwork/daySheet.ts:20-47), then
`orderOpenStops` floats on-site / freight-on-board stops to the top (:65-73).

- First find why the order drifts: reproduce with a day where loads have sortOrder set and check
  whether `orderOpenStops`, the server's deliveryAppt sort (handler.ts:2870), or loads with `null`
  sortOrder are overriding dispatch's order. Rule after the fix: when sortOrder is set, it wins;
  only the stop the driver is **currently on site at** floats to the top; loads with null sortOrder
  go after ordered ones, by appointment. Write a daySheet test for each case.
- Phone drag-to-reorder on TodayStops: add `@dnd-kit/core` + `@dnd-kit/sortable` (pinned exact
  versions, update package-lock.json; the pre-commit hook checks it) with touch sensors and a drag
  handle per load card; also Up/Down buttons as the no-drag fallback. Reorder is per **load** (a
  load's stops stay in route order).
- New route `POST /paperwork/reorder` `{date, loadIds[]}`: verify every load is assigned to this
  driver for that date, then write sortOrder 1..N **for this driver's loads only**, keeping any other
  driver's loads on that day untouched (check how GridCalendarView groups by driver row; if sortOrder
  is shared across drivers within a day, renumber only within the driver's set using values that keep
  their relative position, e.g. reuse the driver's existing sortOrder values re-assigned in the new
  order). Lambda already has UpdateItem on Load.
- The driver's own reorder must not trigger the "Your schedule changed" banner
  (scheduleFingerprint.ts:16): update the stored fingerprint after a successful reorder.
- Admin sees the new order immediately on dispatch DriverSchedulePanel, the calendar grid and planner
  (they already read sortOrder). Add an audit line on each moved load ("Reordered by driver <name>").

## 4. Driver notes on a location, visible on the admin side
> "Let's add a feature so drivers can add notes about a location, like where to check in etc. These
> locations should also get saved in the admin dashboard so we can see on our side."

Existing: `Location.driverNotes`, routes `/paperwork/location-note[-edit]`, phone `PlaceNotes`
(TodayStops.tsx:126-222), admin LocationDetail + LoadDrawer. Gap: notes only on stops that have a
`locationId`, so for many Ivan stops the box never appears, which is why it looks missing.

- Server: when a driver posts a note on a stop with no `locationId`, **create the Location** from the
  stop's name/address (dedupe by normalized address; reuse an existing Location when one matches),
  link `Stop.locationId`, then save the note. Every stop card shows the notes box.
- Phone: rename the box "Location notes (check-in, dock, gate…)" and pin the newest note on the stop
  card header so the driver sees it before arriving. Keep add/edit/remove of own notes.
- Admin: `/locations` directory list gets a "Driver notes" column (count, newest date); LocationDetail
  already lists them, add staff **Remove** per note (through tms-directory-actions or the existing
  Location write path); dispatch LoadDrawer keeps the last 3 per stop.

## 5 + 6. Change trailer any time (incl. bobtail) and show "Your trailer" like "Your truck"
> "Give drivers the ability to update the trailer they are connected to. It should also allow them to
> choose bobtail if they are starting their day bobtailing." / "Add a section for trailer you're
> currently attached to like how it shows we're in a certain truck."

Existing: `Driver.assignedTrailerId`, `GET /trailers`, `POST /me/trailer` (null = bobtail),
`TrailerPickerDialog` with "No trailer (bobtail)" (opens only at clock-in for ivanLocal), `TruckLine`
on Dashboard, Account and Hours.

- Add `Driver.bobtail: boolean` (optional). `POST /me/trailer` with null sets bobtail = true; with a
  trailer sets false. `/me` returns `trailer` and `bobtail`. Admin whereabouts
  (dispatch/driverWhereabouts.ts `trailerOnDriver`, DispatchPage, DriverDrawer, Files panels) shows
  "Bobtail" when true and "No trailer set" when neither.
- New `TrailerLine` component next to every `TruckLine` (PaperworkPage.tsx:160, AccountPage.tsx:63,
  TimeClockPage.tsx:209): "Your trailer · <unit> · Change" or "Bobtail · Change". Change opens
  `TrailerPickerDialog` any time, on or off the clock. Optimistic `setTrailer` like
  `useDriverTruck.setTruck`.
- Clock-in flow unchanged (truck → trailer → punch), still offering bobtail.

## 7. Fleet maintenance: DOT date edits don't save → explicit Save
> "In the fleet maint app just had issues saving changes, we updated the DOT dates and it won't save
> so we need the ability to click save when we make changes."

Cause (files/EntityFilePanel.tsx:209-214, 351-354, used by `/files` and `/truck-docs`): the date input
saves on every `onChange` through fire-and-forget `updateEquipment`, so partial years race and the
last write to land wins; errors only `console.error` while the success toast always shows; clearing
sends `undefined`, which is dropped, so a clear never saves.

- EntityFilePanel: hold the DOT date (and every other date/text field in that panel that saves on
  change) in local draft state; add a **Save** button (disabled until dirty) and a Cancel; Save awaits
  `api.updateEquipment` directly, sends `null` to clear, toasts on the real result (success or the
  error text), and only then updates the store. Same `null`-on-clear fix in TrucksPage.tsx:242.
- Unit test: typing a partial date does not write; Save writes once with the final value; a failed
  write shows the error and leaves the draft.

## Gates, deploy, verification
1. Gate in the worktree: `npm run typecheck`, `npm run lint` (0 warnings), `npm test`, `npm run build`.
   Tests next to the code for every new route and component.
2. Commit in small steps on `feat/driver-app-nov6`, push the branch. **Do not merge or push to `main`
   and do not touch `dev`**: the merge to main (production deploy) is done by the orchestrator after
   review. Do not run `ampx sandbox` against production tables; unit tests + typecheck are the gate.
3. After the production deploy (orchestrator will tell you), live-verify on https://ops.bcatcorp.com:
   DOT date Save on `/truck-docs`; Time Off Requests panel; a driver request round-trip with a test
   driver if one exists (never a real driver's phone).
4. **Ryne's demo item (production data, explicitly requested):** "put in a PTO day for Jason and mark
   it as approved so we can see how it shows up on our side and in his app for 11/5". After deploy,
   find the driver whose first name is Jason in the production Driver table (read-only lookup). If
   exactly one, create an APPROVED PTO time-off entry for **2026-11-05** through the admin Time Off
   page (source STAFF, reviewedBy Ryne@bcatcorp.com), which creates his 480-minute PTO TimeClockEntry
   for 11/5; confirm it shows on `/time-off`, `/hours` and in the driver app's Time off section.
   If there are zero or several Jasons, stop and report the names; do not guess.
5. Append a dated entry to `Docs/driver-app/BUILD_LOG.md` (create it) with commits, job number, and
   the verification results.
