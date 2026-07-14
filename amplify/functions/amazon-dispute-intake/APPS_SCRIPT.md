# Amazon Disputes — Google Form → bcat ops bridge

Driver dispute submissions flow:

```
Google Form  →  its linked Google Sheet  →  onFormSubmit Apps Script (below)
             →  POST JSON to the amazon-dispute-intake Lambda Function URL
             →  AmazonDispute row in DynamoDB  →  /disputes page in bcat ops
```

The Lambda authenticates with the **same** shared secret the existing fuel/intake bridge
uses (`INTAKE_WEBHOOK_SECRET`, already set in the Amplify Console), so there is no new
secret to create.

## One-time setup

1. **Deploy the backend** (`npx ampx sandbox` / pipeline). After deploy, copy the value of
   the `AmazonDisputeIntakeFunctionUrl` CloudFormation output (Amplify Console → the
   `data` stack → Outputs). This is `DISPUTE_WEBHOOK_URL` below.

2. Open the Google **Form → responses → the linked Sheet** (the spreadsheet the form
   writes to). In that Sheet: **Extensions → Apps Script**.

3. Paste the script below. Set the two Script Properties (⚙️ Project Settings → Script
   Properties), so the URL/secret aren't hard-coded:
   - `DISPUTE_WEBHOOK_URL` — the Function URL from step 1
   - `DISPUTE_WEBHOOK_SECRET` — the value of `INTAKE_WEBHOOK_SECRET`

4. Add an **installable trigger**: Triggers (clock icon) → Add Trigger →
   function `onDisputeFormSubmit`, event source **From spreadsheet**, event type
   **On form submit** → Save (authorize when prompted).

5. Submit a test response. It should appear on the **Amazon Disputes** page within a
   couple of seconds (status **Pending**). Re-running the same submission is de-duped.

## The script

`onFormSubmit` receives `e.namedValues` — a map of *question title* → *[answer]*. The
matcher below keys off distinctive words in each question, so small wording tweaks to the
form won't break it. Adjust the `pick(...)` keywords if you rename a question substantially.

```javascript
function onDisputeFormSubmit(e) {
  var props  = PropertiesService.getScriptProperties();
  var URL    = props.getProperty('DISPUTE_WEBHOOK_URL');
  var SECRET = props.getProperty('DISPUTE_WEBHOOK_SECRET');
  if (!URL || !SECRET) { throw new Error('Set DISPUTE_WEBHOOK_URL and DISPUTE_WEBHOOK_SECRET in Script Properties'); }

  var nv = e.namedValues || {};

  // Return the first answer whose question title contains ALL given keywords (case-insensitive).
  function pick() {
    var kws = Array.prototype.slice.call(arguments).map(function (k) { return k.toLowerCase(); });
    for (var q in nv) {
      var ql = q.toLowerCase();
      if (kws.every(function (k) { return ql.indexOf(k) !== -1; })) {
        var v = nv[q];
        return (v && v.length) ? String(v[0]).trim() : '';
      }
    }
    return '';
  }

  var timestamp = pick('timestamp') || (e.values && e.values[0]) || new Date().toISOString();

  var payload = {
    secret:          SECRET,
    submissionId:    String(timestamp),          // dedup key
    timestamp:       String(timestamp),
    tripNumber:      pick('trip', 'number'),
    shipmentDate:    pick('day', 'shipment'),
    amountPaid:      pick('paid', 'amazon'),
    amountRequested: pick('request', 'amazon'),
    description:     pick('describe') || pick('description') || pick('what', 'happened'),
    photoUrl:        pick('photo') || pick('proof') || pick('upload'),
    driverName:      pick('driver', 'name'),
    payPeriod:       pick('7 day') || pick('period')
  };

  var res = UrlFetchApp.fetch(URL, {
    method:            'post',
    contentType:       'application/json',
    payload:           JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('dispute intake %s: %s', res.getResponseCode(), res.getContentText());
}
```

## Backfilling existing rows (optional)

To push rows already in the Sheet, run this once from the editor (it replays every data
row through the same handler; the Lambda de-dupes, so it's safe to re-run):

```javascript
function backfillDisputes() {
  var sheet   = SpreadsheetApp.getActiveSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  for (var r = 1; r < data.length; r++) {
    var named = {};
    for (var c = 0; c < headers.length; c++) { named[headers[c]] = [data[r][c]]; }
    onDisputeFormSubmit({ namedValues: named, values: data[r] });
    Utilities.sleep(150);
  }
}
```

## Notes

- Photo uploads live in Google Drive; the form stores a Drive **link**, which the page
  shows as a "Proof" link — it does not copy the image into bcat ops.
- Amounts are parsed leniently (`$1,282.66`, `27$`, `175` all work).
- The Lambda only ever creates rows as **Pending / source GOOGLE_FORM**. Status changes
  (Posted / Paid / Rejected) are made by staff in bcat ops and are never overwritten by
  a re-submit, because dedup keys on the submission timestamp.
```
