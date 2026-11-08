# Step AM: cover flow and carrier assignment ladder (dev only)

## Ladder (src/lib/carrierAssignment.ts)
`ASSIGNED_SETUP_PENDING -> ASSIGNED_SETUP_COMPLETE -> RATE_CON_SENT -> RATE_CON_SIGNED -> DRIVER_INFO_ENTERED`.
The rung is derived from facts and only moves up: setup = directory Carrier `ACTIVE` (MyCarrierPackets only); rate con status SENT/OPENED/SIGNED; four driver fields (name, phone, truck #, trailer #). Stored on `LoadCarrier.assignmentStatus` + `assignmentTimes` (JSON map status -> first ISO time) and mirrored to `Shipment.carrierAssignmentStatus` and `Load.carrierAssignmentStatus` (read-only to clients). Additive attributes only; data template 967,607 -> 970,712 bytes (`measureDataTemplate.mjs --branch dev`).

## Actions (tms-shipment-actions)
| Action | Rule |
| --- | --- |
| `COVER_CARRIER` | BOOK_CARRIER + MCP rules. UNACCEPTABLE blocks; MODERATE needs ack key `MCP_MODERATE`. Carrier ACTIVE => full booking gate, rung COMPLETE. Not ACTIVE => only PENDING/REVIEW, only after the setup packet was sent (`mcpInvitedAt` or packet started), paperwork findings not judged yet, rung PENDING. Load BOOKED = board "Covered". |
| `SEND_RATE_CON` | now also refuses unless the Carrier is ACTIVE; the driver is no longer required to send (it is the last rung). -> RATE_CON_SENT |
| `MARK_RATE_CON_SIGNED {loadCarrierId, documentId}` | document = committed ShipmentDocument type RATE_CON, PDF, ACTIVE, on this shipment; rate con must be SENT/OPENED/EXPIRED. -> RATE_CON_SIGNED |
| `ENTER_DRIVER_INFO` | all four mandatory, carrier must be ACTIVE. -> DRIVER_INFO_ENTERED. Audit keeps key names only. |
| `DISPATCH_LOAD` | refuses until the carrier is ACTIVE and the four fields are on the assignment (dispatch-box values do not count). |
| `REMOVE_LOAD_CARRIER` | + `repostToDat` (default false): after removal the load is SOURCING/OPEN, mirrors cleared, retired row keeps its rung; true => POST_LOAD DAT, a failed repost is returned as `repost:{ok,message}` and never undoes the removal. |
| `UPDATE_LOAD_CARRIER_DETAILS` | filling the last driver field earns DRIVER_INFO_ENTERED. |
| public signing (`rate-con-sign-api`) | `get` returns `driverInfo` + `requiredFields` (the still-empty driver four plus settings extras); `submit` with the fields signs and enters the driver in one call. Audit keeps field keys only (the old audit stored values). |

## No rogue carriers
Carrier.status rules and `MCP_SEND_INVITE ensureCarrier` are in `MCP_INTEGRATION.md` ("Cover flow and Carrier.status"). `UPSERT_CARRIER` create is ADMIN-only data fix.

## Deviations / notes
- Remove keeps the existing action name `REMOVE_LOAD_CARRIER` (BOUNCED/TONU + reason), not a new REMOVE_CARRIER.
- Ladder never regresses: a lapse after signing flips Carrier INACTIVE but the rung stays; legacy typed (`ASSIGN_CARRIER`) assignments have no ladder rung.
- The ladder is not advanced when MCP flips a carrier INACTIVE (no demotion); dispatch/send are blocked by the carrier status itself.
- `MCP_ADD_CARRIER` action remains (MCP-sourced), only its UI entry point is removed.

## UI (AMUI)
- **Cover dialog:** `src/features/carriers/cover/CoverCarrierDialog.tsx` + pure `coverModel.ts` (gate, route, directory lookup). Entry points: Carrier Sales Needs-cover `Cover`, Carrier tab empty state, Overview `Cover...`, board row menu `Cover...` (only where `needsCover`). Rate is typed in the dialog (`carrierRateCents` is required by COVER_CARRIER).
- **Ladder:** `carrierLadder.ts` (chip rule, `ladderActions`, `dispatchBlock`), `CarrierLadderCard` on the Carrier tab, `DriverInfoDialog`, `MarkSignedDialog` (PDF -> PREPARE/COMMIT as RATE_CON -> `MARK_RATE_CON_SIGNED`), Remove dialog with `Re-post to DAT` (default off, `repostToDat`).
- **Chip rule:** the ladder label shows until driver info is entered AND the shipment status is past booking; then the shipment status shows. The header shows the chip only while the ladder owns it (the status badge is already beside it).
- **Columns:** `carrierAssignment` in `BOARD_COLUMNS` / `BOARD_COLUMN_KEYS` / `ALJEX_COLUMN_KEYS` (after Carrier), tracking grid `carrierAssignment` default column, Carrier Sales Covered tab column + filter. Filters are the rung, even where the cell shows the shipment status.
- **Rogue carriers removed from the UI:** Find & Invite "Add to carriers"; Carriers `+ Carrier` for non-admins (admin data fix remains, relabelled); Overview "Assign carrier (name only)" for non-admins; manual `Active` in the carrier status dialog until MCP reports the packet complete.
- **Deviations:** the Send rate con button scrolls to the existing rate-con panel (the PDF build + recipient picker live there) instead of sending blind; the Bounce / TONU buttons remain beside the ladder's Remove carrier (same dialog, outcome picked by the button); the Aljex default board layout gained the column (saved per-user layouts keep their own columns until changed).
- **Harness:** `scripts/devVerifyAM.mjs` (`--inventory` default; `--walk` after the deploy seeds ZZ carriers / LoadCarrier rows by guarded DynamoDB writes, photographs the dialog and each rung to `Docs/tms-build/screenshots/am/`; `--mcp-preview` opt-in because it calls PreviewCarrier). Not run beyond `--inventory`.

