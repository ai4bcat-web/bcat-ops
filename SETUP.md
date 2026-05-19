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

**Generated secret (copy this value):**
```
855c91098ce19220095b1ddd3f605dafdf1719416f93f6dbe9a3c14aae5edd89
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

1. Open [AWS CloudFormation](https://console.aws.amazon.com/cloudformation/)
2. Find the stack for this Amplify app (name starts with `amplify-`)
3. Open the stack → **Outputs** tab
4. Copy the value of **IntakeWebhookFunctionUrl**

OR go directly to Lambda Console → `intake-webhook-*` function → **Configuration** → **Function URL**.

Paste the URL into the Apps Script `WEBHOOK_URL` constant below.

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
const WEBHOOK_SECRET = '855c91098ce19220095b1ddd3f605dafdf1719416f93f6dbe9a3c14aae5edd89';
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
    "secret": "855c91098ce19220095b1ddd3f605dafdf1719416f93f6dbe9a3c14aae5edd89",
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
  const efsLabel       = GmailApp.getUserLabelByName(EFS_LABEL);
  if (!efsLabel) { console.log('Label efs-report not found — skipping'); return; }

  const processedLabel = GmailApp.getUserLabelByName(EFS_PROCESSED_LABEL)
    || GmailApp.createLabel(EFS_PROCESSED_LABEL);

  const threads = efsLabel.getThreads(0, 10);
  threads.forEach(thread => {
    const threadLabels = thread.getLabels().map(l => l.getName());
    if (threadLabels.includes(EFS_PROCESSED_LABEL)) return;

    thread.getMessages().forEach(message => {
      const payload = {
        secret:         WEBHOOK_SECRET,
        gmailMessageId: message.getId(),
        subject:        message.getSubject(),
        bodyText:       message.getPlainBody(),
        bodyHtml:       message.getBody(),
        receivedAt:     message.getDate().toISOString(),
      };

      try {
        const response = UrlFetchApp.fetch(FUEL_IMPORT_WEBHOOK_URL, {
          method:             'post',
          contentType:        'application/json',
          payload:            JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        const code = response.getResponseCode();
        console.log('Fuel import response:', code, response.getContentText());
        if (code === 200) {
          thread.addLabel(processedLabel);
        } else {
          console.error('Fuel import webhook failed:', code, response.getContentText());
        }
      } catch (e) {
        console.error('Error processing EFS email:', e);
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
    "secret": "855c91098ce19220095b1ddd3f605dafdf1719416f93f6dbe9a3c14aae5edd89",
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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Apps Script shows 401 | Wrong WEBHOOK_SECRET — check it matches what's in Amplify Secrets |
| Items not appearing in app | Lambda not deployed yet, or TABLE_NAME env var not set |
| PDF preview blank | S3 presigned URL expired or wrong bucket name |
| Duplicate items | gmailMessageId dedup scan failed — check CloudWatch for DynamoDB errors |
| Emails not labeled | Gmail filter `To:` header didn't survive forwarding — try `From:` instead |
