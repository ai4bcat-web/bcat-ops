# BCAT Ops — Email Intake Setup Guide

This guide walks through configuring Gmail, Google Apps Script, and Amplify so that emails forwarded from
`ivanloads@bcatcorp.com` and `bcatloads@bcatcorp.com` automatically appear in the app's Intake queue.

---

## Prerequisites

- Access to the Gmail account **ai4bcat@gmail.com**
- Access to the Amplify Console for this app
- The webhook Lambda Function URL (obtained after the Amplify backend deploy — see Section 5)

---

## Section 1 — Set the Amplify Webhook Secret

Before deploying, the webhook secret must be stored as an Amplify secret (it is never committed to git).

> **This file used to contain the live production secret in plaintext, in four places (removed
> 2026-09-30).** Anyone with repo history still has that value, and it guards the intake endpoints.
>
> **`INTAKE_WEBHOOK_SECRET` is shared by every intake Lambda** — gmail-task, vendor-ap, factoring,
> fuel-import, amazon-dispute, and driver-app-api (loads) each alias it under their own env var
> name. Rotating it re-keys all of them at once: each one 401s on every poll until the
> `WEBHOOK_SECRET` constant is updated inside its Apps Script project (reachable only from the
> Google account that owns it — see Troubleshooting, "Apps Script shows 401"). Set the new value in
> Amplify, then update every Apps Script in the same sitting. Never paste it back into this file.

**To generate a replacement:**
```bash
openssl rand -hex 32
```

**To set in Amplify Console (production):**
1. Open [Amplify Console](https://console.aws.amazon.com/amplify/)
2. Select your app → **Hosting** → **Environment variables**
3. Under the **Secrets** section, click **Manage secrets**
4. Click **Add secret** → Name: `INTAKE_WEBHOOK_SECRET` → Value: *(paste secret above)*
5. Click **Save**

**To set locally (sandbox):**
```bash
npx ampx sandbox secret set INTAKE_WEBHOOK_SECRET
# paste the secret when prompted
```

---

## Section 2 — Email Provider Forwarding

> **We need to know what email provider hosts `ivanloads@bcatcorp.com` and `bcatloads@bcatcorp.com`
> to give exact steps.** Common providers and their forwarding locations:
>
> - **Google Workspace**: Admin Console → Gmail → Routing → Add default routing rule → forward to `ai4bcat@gmail.com`
> - **Microsoft 365**: Admin Center → Exchange → Mail flow → Rules → forward to `ai4bcat@gmail.com`
> - **cPanel / Zoho / other**: Account settings → Email forwarding → add `ai4bcat@gmail.com` as destination
>
> Once forwarding is confirmed, the emails will arrive at Gmail with the original `To:` header preserved,
> which is what the Gmail filters in Section 3 key off.

---

## Section 3 — Gmail Filter Setup

Sign in to **ai4bcat@gmail.com** and create two filters:

### Filter 1 — Ivan Cartage

1. Open Gmail → ⚙️ Settings → **See all settings** → **Filters and Blocked Addresses**
2. Click **Create a new filter**
3. Set **To:** field to `ivanloads@bcatcorp.com`
4. Click **Create filter**
5. Check:
   - ✅ Apply the label → **New label...** → `ivan-intake`
   - ✅ Mark as read
   - ✅ Skip the Inbox (Archive it) *(optional — keeps inbox clean)*
6. Click **Create filter**

### Filter 2 — BCAT Logistics

Repeat the steps above with:
- **To:** `bcatloads@bcatcorp.com`
- Label: `bcat-intake`

> **Note:** If the forwarding provider rewrites the `To:` header, use the **From:** field instead
> (e.g. `From: ivanloads@bcatcorp.com`). Test by forwarding a real email and checking which
> headers Gmail receives.

---

## Section 4 — Apps Script Setup

1. Go to [script.google.com](https://script.google.com) and sign in as **ai4bcat@gmail.com**
2. Click **New project** → rename it **BCAT Intake Bridge**
3. Replace the default code with the script below
4. Fill in `WEBHOOK_URL` (from Section 5) and `WEBHOOK_SECRET` (from Section 1)
5. Click **Run** → select `setup` → approve the OAuth consent screen (Gmail access)
6. Click **Triggers** (clock icon) → **Add Trigger**:
   - Function: `processIntakeEmails`
   - Event source: **Time-driven**
   - Type: **Minutes timer**
   - Interval: **Every 5 minutes**
7. Click **Save**

### Test the connection

Send a test email to `ai4bcat@gmail.com` with the subject containing "TEST", then:
- Manually label it `ivan-intake` in Gmail
- In Apps Script: **Run** → `processIntakeEmails`
- Check the Execution log for `[200]` response
- Open the app → Intake page → confirm the item appears

---

## Section 5 — Lambda Function URL

After the Amplify backend deploys:

No function named `intake-webhook-*` exists, and no stack exports `IntakeWebhookFunctionUrl` — those
names are from an earlier design. The live intake Lambdas are named after their feature:
`*-gmailtaskintakelambda*`, `*-factoringintakelambda*`, `*-vendorapintakelambda*`,
`*-amazondisputeintakelambda*`, `*-slackintakewebhooklambda*`, `*-driverappapilambda*`. List them
with their URLs:

```bash
for f in $(aws lambda list-functions --region us-east-1 \
    --query 'Functions[].FunctionName' --output text | tr '\t' '\n'); do
  u=$(aws lambda get-function-url-config --function-name "$f" \
       --region us-east-1 --query FunctionUrl --output text 2>/dev/null)
  [ -n "$u" ] && echo "$f -> $u"
done
```

Each Amplify environment has its own copy: `amplify-bcatops-tmsp1-san-*` is the sandbox,
`amplify-d3dejqzs77khq6-ma-*` is `main`. Paste the URL for the environment you are wiring into the
Apps Script `WEBHOOK_URL` constant.

> **The URL hardcoded in Sections 6 and 7 below is dead.** `odpxmuebxwqrc2kwxtarvf5btu0evziw`
> does not exist in account 273354631837 (verified 2026-09-30 by enumerating every live Function
> URL). Whatever is running today points somewhere else, so treat the literal URL in those code
> blocks as a placeholder and always re-copy it from the console.

---

## Section 6 — Apps Script Code

```javascript
// Apps Script: BCAT Intake Bridge
// Polls Gmail every 5 min for labeled emails and POSTs to our webhook
//
// FIX (2025-05): Tracks processed state per MESSAGE ID (PropertiesService),
// not per thread label. The old thread-label approach silently dropped any
// email that arrived in an already-processed thread (reply, forward chain).

const WEBHOOK_URL    = 'https://odpxmuebxwqrc2kwxtarvf5btu0evziw.lambda-url.us-east-1.on.aws/';
const WEBHOOK_SECRET = '<INTAKE_WEBHOOK_SECRET — copy from Amplify Console → Secrets, never from this file>';
const LABELS         = ['ivan-intake', 'bcat-intake'];

function processIntakeEmails() {
  const props = PropertiesService.getScriptProperties();

  LABELS.forEach(labelName => {
    const label = GmailApp.getUserLabelByName(labelName);
    if (!label) return;

    const threads = label.getThreads(0, 20);
    threads.forEach(thread => {
      thread.getMessages().forEach(message => {
        const msgId = message.getId();

        // Skip if this specific message was already processed
        if (props.getProperty(msgId)) return;

        const attachments = message.getAttachments()
          .filter(a => a.getContentType() === 'application/pdf')
          .map(a => ({
            filename:    a.getName(),
            contentType: a.getContentType(),
            base64:      Utilities.base64Encode(a.getBytes()),
          }));

        const payload = {
          secret:          WEBHOOK_SECRET,
          gmailMessageId:  msgId,
          label:           labelName,
          from:            message.getFrom(),
          subject:         message.getSubject(),
          bodyText:        message.getPlainBody(),
          bodyHtml:        message.getBody(),
          receivedAt:      message.getDate().toISOString(),
          attachments:     attachments,
        };

        try {
          const response = UrlFetchApp.fetch(WEBHOOK_URL, {
            method:           'post',
            contentType:      'application/json',
            payload:          JSON.stringify(payload),
            muteHttpExceptions: true,
          });
          const code = response.getResponseCode();
          if (code === 200) {
            // Mark this message ID as processed so we never re-send it
            props.setProperty(msgId, new Date().toISOString());
            console.log('Processed:', message.getSubject(), '→', response.getContentText());
          } else {
            console.error('Webhook failed:', code, response.getContentText());
          }
        } catch (e) {
          console.error('Error processing message:', e);
        }
      });
    });
  });
}

function setup() {
  // Run once to authorize Gmail access
  GmailApp.getUserLabelByName('ivan-intake');
  GmailApp.getUserLabelByName('bcat-intake');
  console.log('Setup complete — Gmail access authorized');
}
```

---

## Section 7 — End-to-End Test (curl)

After deploy, verify the webhook works without Apps Script:

```bash
curl -X POST https://odpxmuebxwqrc2kwxtarvf5btu0evziw.lambda-url.us-east-1.on.aws/ \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "<INTAKE_WEBHOOK_SECRET — copy from Amplify Console → Secrets, never from this file>",
    "gmailMessageId": "test-msg-001",
    "label": "ivan-intake",
    "from": "test@example.com",
    "subject": "Test Load #12345",
    "bodyText": "Please find the load details attached.",
    "bodyHtml": "<p>Please find the load details attached.</p>",
    "receivedAt": "2025-01-01T12:00:00Z",
    "attachments": []
  }'
```

Expected response: `{"status":"created","id":"<uuid>"}`

Then open the app → **Intake** → Dennis tab → confirm the item appears.

---

---

## Section 8 — EFS Fuel Report Auto-Import

EFS sends a daily email to **ai4bcat@gmail.com** containing a link to download the transaction report.
The setup below automatically detects that email, fetches the report, and inserts new fuel transactions
into the app (duplicate-safe).

### 8a — Gmail Filter

1. Open Gmail → ⚙️ Settings → **See all settings** → **Filters and Blocked Addresses**
2. Click **Create a new filter**
3. Set **From:** to the EFS sender address (e.g. `no-reply@efsglobal.com` or `reports@wexfleet.com` — check an existing report email for the exact address)
4. Click **Create filter**
5. Check:
   - ✅ Apply the label → **New label...** → `efs-report`
   - ✅ Mark as read
   - ✅ Skip the Inbox (Archive it)
6. Click **Create filter**

### 8b — Lambda Function URL

After the Amplify backend deploys:

1. Open AWS CloudFormation → find the Amplify stack → **Outputs** tab
2. Copy the value of **FuelImportFunctionUrlOutput**

OR go to Lambda Console → `fuel-import-*` function → **Configuration** → **Function URL**.

Paste the URL as `FUEL_IMPORT_WEBHOOK_URL` in the Apps Script below.

### 8c — Apps Script additions

The existing **BCAT Intake Bridge** Apps Script needs two additions:

1. Add `FUEL_IMPORT_WEBHOOK_URL` constant at the top
2. Add the `processFuelReportEmails` function
3. Add a new time-driven trigger for `processFuelReportEmails` (every 30 minutes is fine)

**Add to the top of the script (alongside existing constants):**
```javascript
const FUEL_IMPORT_WEBHOOK_URL = 'https://xutbpfi7se725wneassdl7dqfm0kkqmm.lambda-url.us-east-1.on.aws/';
const EFS_LABEL               = 'efs-report';
const EFS_PROCESSED_LABEL     = 'efs-processed';
```

**Add this function to the script:**
```javascript
function processFuelReportEmails() {
  const efsLabel = GmailApp.getUserLabelByName(EFS_LABEL);
  if (!efsLabel) { console.log('Label efs-report not found — skipping'); return; }

  const processedLabel = GmailApp.getUserLabelByName(EFS_PROCESSED_LABEL)
    || GmailApp.createLabel(EFS_PROCESSED_LABEL);

  const threads = efsLabel.getThreads(0, 10);
  threads.forEach(function(thread) {
    const threadLabels = thread.getLabels().map(function(l) { return l.getName(); });
    if (threadLabels.includes(EFS_PROCESSED_LABEL)) return;

    thread.getMessages().forEach(function(message) {
      const msgId   = message.getId();
      const subject = message.getSubject();
      const bodyText = message.getPlainBody() || '';
      const bodyHtml = message.getBody() || '';

      // ── DIAGNOSTIC: log body ──────────────────────────────────────────
      console.log('[EFS] Processing message id=' + msgId + ' subject=' + subject);
      console.log('[EFS] bodyText length=' + bodyText.length + ' bodyHtml length=' + bodyHtml.length);
      console.log('[EFS] bodyText preview (first 1500):', bodyText.slice(0, 1500));

      // ── Read attachments ──────────────────────────────────────────────
      const attachments = message.getAttachments();
      console.log('[EFS] attachment count:', attachments.length);

      let attachmentText = '';
      attachments.forEach(function(att) {
        const name     = att.getName();
        const mimeType = att.getContentType();
        const size     = att.getSize();
        console.log('[EFS] attachment: name=' + name + ' mimeType=' + mimeType + ' size=' + size);

        // Read text-like attachments (EFS reports are .txt or plain text)
        if (!attachmentText && (name.endsWith('.txt') || mimeType.startsWith('text/'))) {
          try {
            const content = att.getDataAsString();
            console.log('[EFS] attachment content preview (first 1500):', content.slice(0, 1500));
            attachmentText = content;
          } catch (e) {
            console.error('[EFS] failed to read attachment ' + name + ':', e);
          }
        }
      });

      // ── Build payload ─────────────────────────────────────────────────
      const payload = {
        secret:         WEBHOOK_SECRET,
        gmailMessageId: msgId,
        subject:        subject,
        bodyText:       bodyText,
        bodyHtml:       bodyHtml,
        attachmentText: attachmentText,
        receivedAt:     message.getDate().toISOString(),
      };
      console.log('[EFS] Sending payload — bodyTextLen=' + bodyText.length
        + ' attachmentTextLen=' + attachmentText.length);

      // ── POST to Lambda ────────────────────────────────────────────────
      try {
        const response = UrlFetchApp.fetch(FUEL_IMPORT_WEBHOOK_URL, {
          method:             'post',
          contentType:        'application/json',
          payload:            JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        const code = response.getResponseCode();
        const body = response.getContentText();
        console.log('[EFS] Lambda response:', code, body);
        // Only mark processed on HTTP 200
        if (code === 200) {
          thread.addLabel(processedLabel);
          console.log('[EFS] Thread marked efs-processed');
        } else {
          console.error('[EFS] Fuel webhook failed [' + code + ']:', body);
        }
      } catch (e) {
        console.error('[EFS] fetch error:', e);
      }
    });
  });
}

function setupEfs() {
  GmailApp.createLabel('efs-report');
  GmailApp.createLabel('efs-processed');
  console.log('EFS labels created');
}
```

**Add a trigger:**
1. In Apps Script → **Triggers** (clock icon) → **Add Trigger**
2. Function: `processFuelReportEmails`
3. Event source: **Time-driven** → **Minutes timer** → **Every 30 minutes**
4. Click **Save**

### 8d — Test the EFS import

```bash
curl -X POST https://xutbpfi7se725wneassdl7dqfm0kkqmm.lambda-url.us-east-1.on.aws/ \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "<INTAKE_WEBHOOK_SECRET — copy from Amplify Console → Secrets, never from this file>",
    "gmailMessageId": "test-fuel-001",
    "subject": "EFS Transaction Report",
    "bodyText": "Your report is ready: https://PASTE_REAL_EFS_REPORT_URL_HERE",
    "receivedAt": "2026-05-19T12:00:00Z"
  }'
```

Expected response:
```json
{ "status": "ok", "parsed": 11, "added": 11, "skipped": 0, "errors": 0 }
```

---

## Section 9 — Tasks Email Intake (tasks@ → dashboard task + #intake-ivan)

Emails to **tasks@bcatcorp.com** (seen in the **ai4bcat@gmail.com** inbox) become a task
in the dashboard **Open Tasks** + the **Tasks** page, and post a message to the Slack
**#intake-ivan** channel. Handled by the `gmail-task-intake` Lambda.

### 9a — Forwarding + Gmail filter
1. Forward **tasks@bcatcorp.com → ai4bcat@gmail.com** (in the distro / Google Group settings).
2. Gmail → **Settings → Filters → Create**: `To: tasks@bcatcorp.com` → **Apply label** `tasks-intake`.

### 9b — Lambda Function URL + env var
1. After the deploy, copy the **`GmailTaskIntakeFunctionUrl`** output (CloudFormation → Outputs, or the deploy log).
2. Amplify Console → the app's environment variables → add **`INTAKE_IVAN_CHANNEL_ID`** = the #intake-ivan channel ID
   (Slack → channel → **View channel details** → bottom shows the `C…` ID), then redeploy so the Lambda picks it up.
3. Confirm the existing secrets are set: **`SLACK_BOT_TOKEN`** (bot needs `chat:write`, and must be invited to #intake-ivan)
   and **`INTAKE_WEBHOOK_SECRET`** (the shared secret from Section 1).

### 9c — Apps Script additions
Add to the **BCAT Intake Bridge** Apps Script (alongside the existing constants/functions):

```javascript
const TASK_INTAKE_WEBHOOK_URL = 'PASTE_GmailTaskIntakeFunctionUrl_HERE';
const TASK_LABEL              = 'tasks-intake';
const TASK_PROCESSED_LABEL    = 'tasks-processed';

function processTaskEmails() {
  const label = GmailApp.getUserLabelByName(TASK_LABEL);
  if (!label) { console.log('Label tasks-intake not found — skipping'); return; }
  const processed = GmailApp.getUserLabelByName(TASK_PROCESSED_LABEL)
    || GmailApp.createLabel(TASK_PROCESSED_LABEL);

  label.getThreads(0, 15).forEach(function (thread) {
    if (thread.getLabels().map(function (l) { return l.getName(); }).includes(TASK_PROCESSED_LABEL)) return;
    thread.getMessages().forEach(function (message) {
      const payload = {
        secret:     WEBHOOK_SECRET,                 // same shared secret as the other bridges
        messageId:  message.getId(),
        subject:    message.getSubject(),
        from:       message.getFrom(),
        body:       message.getPlainBody() || '',
        receivedAt: message.getDate().toISOString(),
      };
      try {
        const res  = UrlFetchApp.fetch(TASK_INTAKE_WEBHOOK_URL, {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify(payload), muteHttpExceptions: true,
        });
        const code = res.getResponseCode();
        console.log('[TASKS] Lambda response:', code, res.getContentText());
        if (code === 200) thread.addLabel(processed);
      } catch (e) { console.error('[TASKS] fetch error:', e); }
    });
  });
}
```

Add a **time-driven trigger** for `processTaskEmails` → **Every 5 minutes**.

### 9d — Test
```bash
curl -X POST 'PASTE_GmailTaskIntakeFunctionUrl_HERE' \
  -H "Content-Type: application/json" \
  -d '{ "secret": "PASTE_INTAKE_WEBHOOK_SECRET", "messageId": "test-task-001",
        "subject": "Call back the broker on PRO 12345", "from": "ops@bcatcorp.com",
        "body": "Follow up before EOD" }'
```
Expected: `{ "ok": true, "id": "gmailtask-…" }`, a task in **Open Tasks**, and a **#intake-ivan** message.
Re-running the same `messageId` returns `{ "ok": true, "duplicate": true }` (dedup).

---

## Section 10 — Factoring Email Queue (ivanfactoring@ → one row per PRO)

The backend and `/factoring` page deploy through the normal Amplify pipeline. Gmail activation is a separate one-time step:

1. In Google Workspace, ensure `ivanfactoring@bcatcorp.com` delivers **each email** to the existing automation mailbox `ai4bcat@gmail.com`. Do not change the domain MX or remove other distribution-list members.
2. Signed in as `ai4bcat@gmail.com`, open the existing **BCAT Intake Bridge** Apps Script project. Add `scripts/factoringEmailBridge.gs` as a new script file; leave all existing bridge functions/triggers intact. No Gmail filter is required.
3. Under **Project Settings → Script properties**, set `FACTORING_WEBHOOK_URL` to `https://qck3jq2ret5kakp6i27viybmuy0gngqg.lambda-url.us-east-1.on.aws/` (the **FactoringIntakeFunctionUrl** CloudFormation output of the `data` stack; it changes only if the Function URL is recreated). Set `FACTORING_WEBHOOK_SECRET` to the existing Amplify `INTAKE_WEBHOOK_SECRET`, or reuse the project's existing `WEBHOOK_SECRET` constant. Never put secret values in logs or a committed script.
4. Run `setupFactoringEmailBridge()` once and authorize Gmail/external-request access. It adds the `factoring-needs-review` label and one `processFactoringEmails` five-minute trigger without modifying other jobs.
5. In BCAT Ops **Users**, grant **Factoring Queue** to the staff who should work it. The owner and the Cognito ADMIN group have access automatically.
6. Forward an invoice with subject `Invoice for PRO #12345` to `ivanfactoring@bcatcorp.com`. Run `processFactoringEmails()` manually for an immediate check, or allow five minutes for the trigger and 30 seconds for the page poll. Verify PRO `12345` appears once with **Need to factor**. Change to **Pending with OTR**, forward it again, and confirm the same row retains that status. Finally mark it **Factored**.

Mail is selected by recipient/List-ID, not unread state. Archived and read messages are included; trash/spam are excluded. A newer message in an old thread is processed independently. Older pages are swept in the background, not abandoned after the first page. A successful webhook acknowledgement is persisted per message; network/auth/server failures remain retriable and fail the trigger visibly. Subject errors receive `factoring-needs-review` rather than a fabricated PRO: forward the email again with a corrected subject.

The queue does not submit invoices to OTR or import attachment contents. Its three statuses are **Need to factor**, **Pending with OTR**, and **Factored**. Confirm actual forwarded-email delivery before calling the Google integration active.

## Section 11 — Vendor AP Queue (vendorpayments@ → one row per emailed invoice)

The backend and `/vendor-ap` page deploy through the normal Amplify pipeline. Maintenance invoices need no Google setup: the send icon on an unpaid Invoices row creates the AP row immediately. Gmail activation for forwarded vendor invoices is a separate one-time step:

1. In Google Workspace, ensure the `vendorpayments@bcatcorp.com` distribution group delivers **each email** to the existing automation mailbox `ai4bcat@gmail.com`. Do not change the domain MX or remove other distribution-list members.
2. Signed in as `ai4bcat@gmail.com`, open the existing **BCAT Intake Bridge** Apps Script project. Add `scripts/vendorApEmailBridge.gs` as a new script file; leave all existing bridge functions/triggers intact.
3. Under **Project Settings → Script properties**, set `VENDOR_AP_WEBHOOK_URL` to the **VendorApIntakeFunctionUrl** CloudFormation output of the `data` stack. Set `VENDOR_AP_WEBHOOK_SECRET` to the existing Amplify `INTAKE_WEBHOOK_SECRET`, or reuse the project's existing `WEBHOOK_SECRET` constant. Never put secret values in logs or a committed script.
4. Run `setupVendorApEmailBridge()` once and authorize Gmail/external-request access. It adds the `vendor-ap-needs-review` label and one `processVendorApEmails` five-minute trigger without modifying other jobs.
5. In BCAT Ops **Users**, grant **Vendor AP Queue** to the staff who should work it. The owner and the Cognito ADMIN group have access automatically.
6. Forward a vendor invoice with its PDF to `vendorpayments@bcatcorp.com`. Run `processVendorApEmails()` manually for an immediate check, or allow five minutes for the trigger and 30 seconds for the page poll. Open the row: the original email text and its attachments must be there. Fill in vendor / invoice # / amount, then **Mark done** with the payment method and date.

Attachments are copied to S3 under `intake-pdfs/vendor-ap/` before the row is created (presigned PUT, then a commit that verifies every object), so a queue row never exists without its files. Malformed messages get the `vendor-ap-needs-review` label instead of being dropped; network/auth/server failures remain retriable and fail the trigger visibly.

## Section 12 — PODs (JobsDone proof-of-delivery images → shipments)

The `/pods` page and the `pod-actions` backend deploy through the normal Amplify pipeline. No Google setup is involved; the only one-time step is connecting the JobsDone account, and no secret is ever committed or entered outside the app:

1. Ask the JobsDone team (Lopie Dev) for a **third-party API key** and confirm BCAT's **JobsDone client ID** (the tenant whose text-message photos should appear). The key grants full access to every JobsDone customer, so it is only ever stored server-side.
2. In BCAT Ops, open **PODs → Configure** (owner or Cognito `ADMIN` only), paste the client ID and API key, and save. The backend verifies the pair against JobsDone before storing it as a SecureString SSM parameter named `/bcat/pods/<user pool id>/connection` (one per stack — production and each sandbox connect separately). Rotating the key is the same step; changing to a different client ID is refused so a tenant cannot be swapped silently.
3. In **Users**, grant **PODs** to the staff who match documents to shipments. The owner and `ADMIN` group have access automatically; every signed-in user can still see the PODs already linked to a load in the load drawer.
4. Saving the connection queues an import of the **last 7 days** of the feed immediately, and from then on a 15-minute schedule walks the feed on AWS — nothing depends on anyone having the page open. **Scan past 7 days** on the PODs page queues the same walk on demand (the page confirms it was queued; results appear as each image finishes). Each image is archived unchanged under S3 `pods/<id>/original`, then a scanned copy (`pods/<id>/enhanced.jpg`) is produced automatically for JPEG/PNG photos: the page is cropped and perspective-squared when the crop is proven not to lose any readable text, turned upright by reading it at all four rotations, and shadows/background are removed. A copy the scanner could not vouch for (no readable text, no clean page boundary, ambiguous orientation) is still produced but the card shows an amber **Review scan** reason — check it against the original. PDFs and other formats stay original-only and say so. The schedule runs in isolated preview stacks (`BCAT_ISOLATED_PREVIEW`) too, so imports continue automatically while previewing.
5. On a row, **Assign** first lists that sender's recent loads (matched by texting phone or full name) and keeps the full load list searchable underneath. Assignment is explicit — nothing is guessed — and the POD then appears in that load's drawer. Unassign/reassign asks for confirmation; two people editing the same document get a "changed, please review" error instead of a silent overwrite.

Deletion is intentionally absent: a mismatched POD is reassigned, and the JobsDone source is never written to.


## Section 13 — Loads Rate Cons (ivanloads@ → DriverSubmission + #intake-ivan)

A rate confirmation **forwarded by email** takes the same path as one a driver uploads from the
PWA: the attachments land in S3 under the driver's own prefix, `DriverSubmission` +
`DriverSubmissionDoc` rows are written, and the load is posted to Slack and emailed to
`ivanloads@bcatcorp.com`. The email path adds no OCR, no AI extraction, and no load creation —
it is the same `completeSubmission` the PWA calls, not a copy.

Unlike every other section here, this bridge uploads bytes **directly to S3**, so a 20 MB rate con
is not a problem: Lambda Function URLs cap a request body at 6 MiB, and base64 inflates by a third.
It is a two-phase protocol, the same one `vendorpayments@` uses.

### Endpoint

This runs on the existing **driver-app-api** Lambda, not a new one. Get its URL from Lambda Console
→ `*-driverappapilambda*` → **Configuration** → **Function URL**, or:

```bash
aws lambda get-function-url-config --region us-east-1 \
  --function-name $(aws lambda list-functions --region us-east-1 \
    --query "Functions[?contains(FunctionName,'driverappapilambda')].FunctionName" --output text) \
  --query FunctionUrl --output text
```

The Lambda env var is `LOADS_INTAKE_SECRET`, but it is **not** a secret of that name: it is
`secret('INTAKE_WEBHOOK_SECRET')` (see `amplify/functions/driver-app-api/resource.ts`), the same
shared value every intake Lambda uses — gmail-task, vendor-ap, factoring, fuel-import, and
amazon-dispute all alias it under their own env var name. `ampx sandbox secret set
LOADS_INTAKE_SECRET` sets nothing; the name to set is `INTAKE_WEBHOOK_SECRET`.

Consequence for rotation: changing that one value re-keys **every** bridge at once, loads included,
so all of the Apps Script projects must be updated in the same sitting (Section 1).

The handler **fails closed**: if the secret is missing or empty on the Lambda, every request is
rejected.

### Gmail setup

1. In the `ivanloads@bcatcorp.com` mailbox (or whichever account receives the forwards), create the
   label **`loads-intake`**.
2. Create a filter that applies it. Forwarding usually destroys the original `To:` header, so match
   on the forwarder instead — e.g. `from:(ivan@bcatcorp.com) has:attachment`.
3. **The driver's name must appear in the email body.** The PWA resolves the driver from a verified
   Cognito token; email has no token, so the typed name is the only signal. The matcher is
   whole-word and normalized (case, accents, punctuation), and it requires **exactly one** active
   driver to match. Zero or multiple matches are flagged `DRIVER NOT MATCHED` in the Slack post and
   email rather than silently guessed — a misspelled name never quietly swallows a rate con.

### Apps Script

```javascript
// BCAT Loads Bridge — forwarded rate cons → DriverSubmission
// Two-phase: prepare (metadata) → presigned PUT per attachment → commit (verify + notify).
// Processed state is tracked per MESSAGE id, never per thread: a forward landing in an
// already-processed thread must not be dropped.

const LOADS_API_URL = 'https://REPLACE-ME.lambda-url.us-east-1.on.aws';
const LOADS_SECRET  = 'REPLACE-ME';          // Amplify secret INTAKE_WEBHOOK_SECRET
const LOADS_LABEL   = 'loads-intake';
const MAX_ATTACH    = 50;

function processLoadEmails() {
  const props = PropertiesService.getScriptProperties();
  const label = GmailApp.getUserLabelByName(LOADS_LABEL);
  if (!label) { console.error('Missing Gmail label: ' + LOADS_LABEL); return; }

  label.getThreads(0, 20).forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (props.getProperty(msgId)) return;   // already processed this exact message

      // Read each attachment's bytes ONCE. getBytes() materializes the whole blob every call, so
      // re-reading it per phase turns a 20 MB rate con into 80 MB and hits Apps Script's memory
      // and 6-minute execution limits well before the endpoint's own 50 MB ceiling.
      const files = message.getAttachments()
        .filter(a => ['application/pdf', 'image/jpeg', 'image/png'].indexOf(a.getContentType()) !== -1)
        .slice(0, MAX_ATTACH)
        .map(a => ({ name: a.getName(), type: a.getContentType(), bytes: a.getBytes() }));
      if (files.length === 0) { props.setProperty(msgId, 'no-attachments'); return; }

      try {
        // Phase 1 — prepare: creates the submission, resolves the driver, returns presigned PUTs.
        const prep = post('/email-intake/prepare', {
          secret:         LOADS_SECRET,
          gmailMessageId: msgId,
          from:           message.getFrom(),
          subject:        message.getSubject(),
          body:           message.getPlainBody(),
          attachments:    files.map(f => ({
            fileName:    f.name,
            contentType: f.type,
            byteSize:    f.bytes.length,
          })),
        });
        if (prep.code !== 200) { console.error('prepare failed', prep.code, prep.text); return; }

        if (prep.json.skipped) {
          // Two very different meanings share this flag, and only one retires the message:
          //   'duplicate' / auto-skip — finished or deliberately ignored: never look again.
          //   'in-flight'             — another call owns this message RIGHT NOW. If it dies
          //                             before commit, the next poll must still find this message,
          //                             so do NOT mark it; prepare will resume it then.
          if (prep.json.reason === 'in-flight') {
            console.log('In flight elsewhere, retrying next run:', message.getSubject());
            return;
          }
          props.setProperty(msgId, 'skipped:' + prep.json.reason);
          console.log('Skipped:', message.getSubject(), '→', prep.json.reason);
          return;
        }
        if (prep.json.resumed) {
          console.log('Resuming interrupted submission', prep.json.submissionId);
        }

        // Phase 2 — upload each attachment straight to S3. Bytes never pass through Lambda.
        // Pair by the `pageNumber` prepare returns, not by array position: if the two ever
        // diverge, positional pairing silently uploads the wrong bytes under the wrong key.
        // The presigned URL is signed with that attachment's ContentType, so the PUT must send
        // the exact value posted to prepare or S3 answers 403.
        const targets = prep.json.targets || [];
        const fileFor = (t) => files[t.pageNumber - 1];
        targets.forEach(t => {
          const f = fileFor(t);
          if (!f) throw new Error('no attachment for pageNumber ' + t.pageNumber);
          const res = UrlFetchApp.fetch(t.url, {
            method:             'put',
            contentType:        f.type,
            payload:            f.bytes,
            muteHttpExceptions: true,
          });
          if (res.getResponseCode() !== 200) {
            throw new Error('S3 PUT ' + res.getResponseCode() + ' for ' + f.name);
          }
        });

        // Phase 3 — commit: HEADs every key, persists the docs, posts Slack + email once.
        const done = post('/email-intake/commit', {
          secret:         LOADS_SECRET,
          gmailMessageId: msgId,
          submissionId:   prep.json.submissionId,
          attachments:    targets.map(t => ({
            fileName:    fileFor(t).name,
            contentType: fileFor(t).type,
            byteSize:    fileFor(t).bytes.length,
            s3Key:       t.s3Key,
          })),
        });
        if (done.code !== 200) { console.error('commit failed', done.code, done.text); return; }

        props.setProperty(msgId, new Date().toISOString());
        console.log('Loaded:', message.getSubject(), '→', done.text);
      } catch (e) {
        // Leave the message unmarked so the next run retries it. The retry is safe: prepare
        // returns `resumed:true` with fresh presigned targets for the SAME submission whenever
        // the previous attempt never committed, so a retry finishes the original submission
        // rather than creating a second one or stranding it at NEW.
        console.error('Error on "' + message.getSubject() + '":', e);
      }
    });
  });
}

function post(path, payload) {
  const res = UrlFetchApp.fetch(LOADS_API_URL + path, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
  return { code: res.getResponseCode(), text: text, json: json };
}

function setupLoads() {
  GmailApp.getUserLabelByName(LOADS_LABEL);
  console.log('Gmail access authorized for ' + LOADS_LABEL);
}
```

Add a time-driven trigger on `processLoadEmails` (every 5 minutes) once the constants are filled in.

### Why the loop guard matters

Commit emails the load **to `ivanloads@bcatcorp.com`** — the same mailbox being polled. Three
independent guards stop that from becoming an infinite loop that spams Slack and burns SES:
the sender is matched against `onboarding@bcatcorp.com`, the subject is matched against our own
`New load from …` prefix (a constant shared with `notify.ts` so the two cannot drift), and the
deterministic submission id `email:{gmailMessageId}` plus a conditional write makes a re-delivery a
no-op. A skipped message returns `200 {skipped:true}`, which the script records as done.


## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Apps Script shows 401 | Wrong WEBHOOK_SECRET — check it matches what's in Amplify Secrets |
| Items not appearing in app | Lambda not deployed yet, or TABLE_NAME env var not set |
| PDF preview blank | S3 presigned URL expired or wrong bucket name |
| Duplicate items | gmailMessageId dedup scan failed — check CloudWatch for DynamoDB errors |
| Emails not labeled | Gmail filter `To:` header didn't survive forwarding — try `From:` instead |
