import { defineStorage } from '@aws-amplify/backend'

// Cognito group members assume their GROUP role (e.g. amplifyAuthADMINGroupRole), which
// does NOT inherit `allow.authenticated` storage grants — so group users were denied S3
// access (e.g. ADMIN blocked from s3:PutObject on driver-pay-masters/* when archiving a
// master CSV). Mirror every authenticated grant to the ADMIN + DISPATCHER groups so
// logged-in staff keep full access regardless of which role they assume.
const STAFF_GROUPS = ['ADMIN', 'DISPATCHER']

export const storage = defineStorage({
  name: 'bcatRateConfirms',
  access: (allow) => ({
    'rate-confirms/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    /*
     * Documents that came in ON a Slack tender — usually the rate confirmation itself.
     * Written by the intake webhook (via its own IAM role, not these rules) and read here
     * so building a load can attach one without copying the bytes to a second key.
     */
    'intake-attachments/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read', 'delete']),
    ],
    // Dispatch: pictures drivers text in (in/), pictures the office sends (out/), and
    // voicemails (vm/). Inbound files are written by the webhook Lambda's own role.
    'dispatch-media/*': [
      allow.authenticated.to(['read', 'write']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    'driver-photos/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Archived Amazon driver-pay master CSV uploads.
    'driver-pay-masters/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Intake PDFs uploaded by the webhook Lambda; authenticated users can read (for preview)
    'intake-pdfs/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
    // Appointment-confirmation screenshots (E2Open update + email confirmation),
    // pasted/uploaded per stop from the Appts page. Keyed appt-proofs/{loadId}/{stopId}/…
    'appt-proofs/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // DOT compliance documents (driver + truck). Internal staff read/write/delete.
    // The driver portal uploads via a presigned PUT from the onboarding-portal-api
    // Lambda (Phase 3) using the bucket's IAM grant, so no guest access is exposed here.
    'compliance/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Amazon driver-dispute proof uploads from the public dispute portal.
    // Guests PUT via a presigned URL; authenticated staff/users can read to review.
    // No public read or delete is granted here.
    'dispute-proofs/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
    // Amazon's reply to a dispute, screenshotted/uploaded by staff from /disputes.
    // Keyed dispute-responses/{disputeId}/… — staff own these, so unlike the driver
    // uploads above they can be replaced and removed.
    'dispute-responses/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    // Staff manual dispute proof uploads (create/edit from /disputes).
    // Keyed dispute-staff-proofs/{disputeId}/… — staff own these and can replace/remove.
    'dispute-staff-proofs/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    /*
     * Rate confirmations and PODs uploaded by drivers via the driver-app-api Lambda
     * presigned-PUT flow, and by staff uploading on a driver's behalf. Drivers never hold
     * S3 credentials — they are in their own user pool and reach the bucket only through
     * that Lambda — so everyone holding credentials here is staff.
     *
     * `allow.authenticated` is NOT redundant with the group grant below, and leaving it
     * off is what broke this prefix: staff whose only Cognito groups are the `page-*`
     * permission groups have no group ROLE attached, so Cognito falls back to the plain
     * authenticated role — which had no grant here at all. The result was an
     * AccessDenied on s3:GetObject when someone outside ADMIN/DISPATCHER opened a POD,
     * even though the app had already decided they could see the page it was on. Every
     * other prefix in this file grants authenticated; this one was the outlier, and the
     * outlier was the bug.
     *
     * Delete stays with the staff groups. Nothing in the browser deletes these objects —
     * removing a POD clears the DynamoDB rows and deliberately leaves the file as the
     * record of what arrived at a dock — so there is no flow to widen it for.
     */
    'driver-docs/*': [
      allow.authenticated.to(['read', 'write']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    /*
     * Carrier paperwork (Step C): authority, COIs, W9, the signed agreement, and
     * every rate confirmation we generate or get back signed. Staff upload with
     * a presigned PUT from tms-carrier-actions; the public signing Lambda writes
     * the countersigned PDF with its own role.
     *
     * No delete for authenticated: DELETE_DOCUMENT removes the row and leaves
     * the object, so what a carrier actually sent us survives a mis-click.
     */
    'carrier-docs/*': [
      allow.authenticated.to(['read', 'write']),
      allow.groups(STAFF_GROUPS).to(['read', 'write', 'delete']),
    ],
    /*
     * Shipment paperwork (Step E): BOLs, PODs, load summaries, lumper receipts and
     * whatever else a shipment collects, keyed shipment-docs/{shipmentId}/…
     *
     * Read only from the browser, deliberately. Every byte that lands here arrives
     * through a presigned PUT the Lambda signed — pinned to a content type and a
     * length it already validated — so there is no path for a logged-in page to put
     * an arbitrary object next to a shipment's documents, and no delete at all:
     * voiding a document marks the row and keeps the file as the record of what
     * actually arrived.
     */
    'shipment-docs/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
    /*
     * Issued invoice PDFs (Step F), keyed invoices/{customerId}/{number}-v{n}.pdf.
     *
     * Written only by tms-finance-actions, with its own role, from bytes it rendered
     * itself; the browser reads and never writes. Nothing is ever deleted — a voided
     * invoice keeps its PDF, because somebody out there already has a copy of it.
     */
    'invoices/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
    /*
     * Remittance advices (Step G), keyed remittances/{carrierId}/{paymentId}-v{n}.pdf.
     *
     * Written only by tms-finance-actions from bytes it rendered itself; the browser
     * reads and never writes, and nothing is ever deleted — a reversed payment keeps
     * the advice the carrier was sent.
     */
    'remittances/*': [
      allow.authenticated.to(['read']),
      allow.groups(STAFF_GROUPS).to(['read']),
    ],
  })
})
