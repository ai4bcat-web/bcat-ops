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
