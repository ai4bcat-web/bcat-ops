# N3 + N4 Plan — Rate-con/BOL email coverage and per-shipment tracking thread

## Goal

Close the gaps in Step N3 (rate confirmations and BOLs by email, with dev SES logging) and Step N4 (one email thread per shipment with inbound reply ingestion and POD attachment handling).

## Current state

Most of the infrastructure already exists from Step P:

- `SEND_RATE_CON` in `tms-shipment-actions` mints a token, saves the PDF, opens the shipment thread, and writes the first `ShipmentMessage` row.
- `EMAIL_DOCUMENTS` in `tms-tracking-actions` attaches documents (including generated BOLs) to an SES email via `deliverNotice`.
- `GeneratedDocumentDialog` / `EmailDocumentsDialog` live in the Documents tab; `RateConPanel` lives in the Carrier tab.
- `ShipmentThreadPanel` renders the thread on the Tracking tab and has a manual "Send check-call request" composer.
- `OPEN_SHIPMENT_THREAD`, `SEND_SHIPMENT_MESSAGE`, `INGEST_SHIPMENT_MESSAGE`, `LIST_SHIPMENT_THREAD` actions exist.

## Gaps to close

### N3

1. **Rate-con dev logging is incomplete.** On dev SES fails, but `SEND_RATE_CON` writes the `ShipmentMessage` with `status: 'SENT'` and only `console.error`s the failure. The exact raw message is not logged, and the row status lies.
2. **No dev-visible proof of the BOL email.** `EMAIL_DOCUMENTS` already returns downloads on `NOT_SENT`, but there is no test proving a generated BOL can be emailed to a customer end-to-end.

### N4

1. **`INGEST_SHIPMENT_MESSAGE` ignores attachments.** An inbound reply with a POD image/PDF is stored on the message row but never copied to S3 or turned into a `ShipmentDocument`, so it cannot satisfy the POD requirement.
2. **No inbound email intake endpoint.** The existing `gmail-task-intake` only creates `IntakeItem` rows. There is no Function-URL endpoint for the Gmail bridge (or SES inbound) to deliver `tracking+<shipmentId>@` replies directly into the thread.

## Schema changes

None required. `ShipmentMessage.attachments` is already `a.json()`. We will use `source: 'CARRIER_PORTAL'` for inbound email attachments (they need review just like portal uploads) and auto-review PODs so they can satisfy the gate.

## Backend changes

### N3

- `amplify/functions/tms-shipment-actions/handler.ts`
  - Change `sendRateConEmail` to return `{ status, error, raw }`.
  - In `sendRateCon`, set the `ShipmentMessage.status` to the actual outcome (`SENT` or `NOT_SENT`).
  - On dev/SES failure, `console.log` the full raw MIME message so CloudWatch has the exact message that would have been sent.
- Add/update tests in `handler.test.ts`.

### N4

- `amplify/functions/tms-tracking-actions/handler.ts`
  - Add `ingestAttachments(message, attachments, caller)`:
    - Save each base64 attachment to `shipment-docs/<shipmentId>/inbound/<msgId>/<filename>`.
    - Create a `ShipmentDocument` row (`CARRIER_PORTAL`, `PENDING`).
    - Re-cache `Order.docsMissing` / `LoadCarrier.docsMissing` in the same transaction.
    - If the inferred type is `POD`, call `reviewShipmentPod` so a good POD satisfies the gate automatically.
  - Wire it into the `INGEST_SHIPMENT_MESSAGE` case.
- `amplify/functions/shipment-email-intake/` (new Lambda)
  - Function URL, shared-secret auth (`INTAKE_WEBHOOK_SECRET`), follows `factoring-intake` pattern.
  - Accepts `{ messageId, to, cc, from, subject, body, attachments, receivedAt }`.
  - Routes to `shipmentId` from `tracking+<shipmentId>@` plus-address or from a known outbound `Message-ID`.
  - Invokes `tms-tracking-actions` with `INGEST_SHIPMENT_MESSAGE`.
  - On dev, if the invoke fails or the function name is unset, logs the parsed inbound message as proof.
- `amplify/backend.ts`
  - Define `shipmentEmailIntake` function, Function URL, table/query grants, `TMS_TRACKING_ACTIONS_FUNCTION_NAME` env var.
- Add unit tests for the new Lambda and the attachment ingestion path.

## Frontend changes

None. The existing dialogs and thread panel already expose the right actions. We only add tests to prove the backend paths.

## Verification

- `npm run test` — new + existing tests pass.
- `npx tsc --noEmit` — clean.
- `npx eslint .` — clean.
- Dev deploy via Amplify.
- Run a dev script or Lambda invoke that simulates: rate con send → thread opened → inbound reply with POD attachment → POD document created and accepted → release gate satisfied.

## Risks / decisions

- Auto-reviewing every inbound POD uses Anthropic credits. This matches the existing portal-upload auto-review design in `reviewShipmentPod`; bad PODs are re-requested up to two times then flagged.
- The new intake Lambda invokes `tms-tracking-actions` synchronously (`RequestResponse`) so the bridge gets a routing result. This requires `lambda:InvokeFunction` grant.
