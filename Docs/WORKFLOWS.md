# BCAT Ops Workflows

## How pages consume data
- Pages load data via custom hooks in `src/hooks/*`.
- Hooks call `src/lib/apiClient.ts`, which talks to the AppSync endpoint in `amplify_outputs.json`.
- Auth state flows from `AuthProvider` -> hooks -> pages.

## UI interaction conventions
- Forms use `react-hook-form` + `@hookform/resolvers` + Zod.
- Toasts use `sonner`.
- Tables use `@tanstack/react-table`.
- Calendar uses FullCalendar v6 with `resource-timeline` plugin.
- Modals use shadcn dialog/popover primitives.

## State decisions
- Local UI state: React state inside the page/component.
- Shared view state: Zustand in `src/store/useAppStore.ts`.
- Server-backed data: fetched from hooks when a page loads.
- Do not lift transient UI state into global stores unless reused by multiple pages.

## Failure behavior
- Auth errors redirect to `/login`.
- Data loading errors show a toast and render an empty state.
- Calendar errors preserve the last loaded date range.

## Acceptable change styles
- Add a feature in-place if it fits an existing folder.
- Add new files/folders only when the new domain is clearly separate.

## Repair invoice intake
- `scripts/ingestMaintenanceInvoice.mjs` writes emailed invoices as `PENDING`; staff post or archive them in the invoice Review Queue. Fleet spending excludes pending and archived records.
- Intake and the app invoice list follow every AppSync `nextToken` page. Intake fails closed on incomplete list/create responses.
- Numbered invoices retain the document-content `externalId` (date, normalized vendor, amount, normalized invoice number). Unnumbered invoices can supply `sourceDocumentId` to distinguish separate documents with equal totals. Source identity must be stable across retries.
- New emailed records use deterministic IDs. AppSync create conflicts count as duplicates only after retrieving the existing record and verifying its immutable `externalId`. Reviewed and archived rows remain in duplicate checks.
- `node scripts/dedupeMaintenanceInvoices.mjs` is a read-only preview; `--apply` archives only unambiguous extras. No records are deleted. Groups spanning different assigned units require manual review, since a legacy invoice may be split across trucks. Unnumbered records are not grouped by content alone.
- Do not use an invoice date cutoff to hide missing historical invoices, or email Seen status as proof of successful ingestion. Do not claim complete repairs-address coverage from the forwarded Gmail copy alone.

## Amazon mileage expenses
- In Amazon Driver Pay settings, add an expense or select an existing revision and choose Change, then Mileage calculation. Enter cost per mile, miles for the weekly expense, and an effective date. Apply the draft, then Save settings.
- Amount is calculated from cost per mile × entered miles and rounded once to cents; sub-cent per-mile rates are retained. These are entered miles, not an ELD feed or automatic trip-mile total.
- Both inputs are saved on each expense revision in the existing fixedExpenses JSON. Reopening a revision restores its calculation; changes retain previous amounts and formulas. Partial periods still prorate by calendar day.
- Mileage controls are enabled for Amazon settings only; box-truck fixed-amount entry is unchanged.
- A fixed expense is shared through the pay split by default (an after-expenses driver bears only their pay % of it); "Driver pays in full, after the split" is available per line for charges the driver owes outright. An optional company share on any line stays off the statement and is booked as a company cost in Finances (e.g. the company's half of a truck lease). Weekly lease mileage: on the settlement week, Add expense → **Miles × cost per mile** — the amount is computed, the basis is written into the description, and it is deducted before the split for that week only.
- Weekly mileage is entered per settlement week on the driver's card: the Deductions block carries blank Miles and $/mi inputs, shows the computed total, and Add writes a one-off `Lease mileage — N mi @ $R/mi` deduction for that week only (`mileageDeductionLine` in `src/lib/mileageDeduction.ts`, shared with the Add expense sheet). Inputs are blank on every week and driver; a saved row is removed with its trash button. Use this, not a fixed-expense revision, when the miles change week to week.

## Amazon disputes (driver portal)
- Drivers file disputes at `/amazon-disputes` (public, no login). The form requires the trip confirmation email (any image type - screenshot, photo, HEIC - or a PDF) and accepts up to 5 photos (any image type); files go to `dispute-proofs/{submissionId}/` via a presigned PUT, then the `dispute-portal-api` Lambda verifies each object and writes one `AmazonDispute` row (`source DRIVER_PORTAL`, `status PENDING`). Retrying a submission reuses its id, so a retry never creates a second row.
- The same page shows a shared status board: driver name, trip number, pay period, shipment date, status - for every dispute. Amounts, descriptions, uploads, and staff notes are never sent to the public endpoint.
- Staff work the queue at `/disputes`. The Proof cell opens a Files sheet: every upload has a thumbnail, Open, Download, and Download all — downloads fetch the presigned object and save a blob, so a screenshot never replaces the page you were working (see `src/lib/download.ts`).
- Changing the status chip on a row opens the update sheet with that status preselected; the speech-bubble button next to it opens the same sheet without changing status (blue once a response is on file). One save writes status, `amazonResponse`, `amazonResponseAt`/`By`, `resolvedAmount` (when Paid) and the evidence array. The Amazon screenshot is pasted (⌘V), dropped or browsed — image or PDF, 10 MB max — and uploads to `dispute-responses/{disputeId}/` before the row is written. The list polls every ~30 s because portal writes bypass AppSync subscriptions.
- Setting a dispute to Paid offers "Add to settlement week": a Sunday week (next week back through ten) plus the driver's pay account, prefilled by matching the typed portal name against the active roster. Saving writes an `AmazonTrip` on that week — `loadId` `DISPUTE <shipment date>`, freight = recovered amount, status Completed, the trip number in `notes` — so the recovery appears as an ordinary shipment labelled DISPUTE and pays at the driver's normal percentage. `settlementTripId`/`settlementPeriodStart`/`settlementDriverId` are stored on the dispute row.
- That trip id is what keeps a recovery from being paid twice: re-saving moves or re-prices the same row, choosing "Don't add" or leaving Paid deletes it. A row someone deleted on the settlement page is written fresh; any other write failure surfaces instead of creating a second row. A recovery with no amount keyed is refused. The dispute row shows the settlement week it was paid out on.
- Deleting a dispute deletes its settlement shipment first, and the edit sheet keeps an existing posting honest: a status that is no longer Paid drops the row, a re-keyed recovered amount re-prices it on the week it was posted to. Nothing can leave a `DISPUTE` row on a check with no dispute behind it.
- The driver's `dispute-proofs/` files are carried through every staff save untouched (`mergeDisputeEvidence` in `src/features/disputes/disputeEvidence.ts`) — staff have no write or delete grant on that prefix, and the row is the only index of those objects. Staff response screenshots live in their own prefix and can be removed; the S3 object is deleted only after the row stops referencing it.
- Deleting a dispute on `/disputes` removes the row only; its `dispute-proofs/{id}/` uploads are kept on purpose (a deleted row can be re-filed, and staff have no delete grant on that prefix). Clean up by hand with `aws s3 rm`, or add a bucket lifecycle rule if volume ever warrants it.
- The endpoint is published as `custom.disputePortalUrl` in `amplify_outputs.json`; `VITE_DISPUTE_PORTAL_API_URL` overrides it locally.
