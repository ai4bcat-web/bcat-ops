// ── Loads Email Bridge (ivanloads@bcatcorp.com) ──────────────────────────────
// Standalone additive Apps Script for the existing BCAT Intake Bridge project.
// Polls Gmail every 5 min for messages delivered to ivanloads@bcatcorp.com and
// forwards the rate-con attachments to the driver-app-api Lambda via its
// two-phase protocol (POST /email-intake/prepare -> presigned S3 PUT ->
// POST /email-intake/commit). Each accepted message becomes a DriverSubmission
// (source EMAIL, kind RATECON) through the SAME completeSubmission path the
// driver PWA uses, which posts to Slack #intake-ivan and emails dispatch.
//
// Phase separation keeps Gmail attachment bytes out of the Function URL request
// body, avoiding the 6 MiB sync-invoke limit — a 20 MB rate con is uploaded
// straight to S3 with the presigned PUT handed back by prepare.
//
// ── INSTALL (a human has to do this once) ────────────────────────────────────
//  1. Open the Apps Script project that already hosts factoringEmailBridge.gs
//     and vendorApEmailBridge.gs. It is owned by the Google account that
//     RECEIVES the ivanloads@bcatcorp.com forwards — today that is
//     ai4bcat@gmail.com. The ivanloads@ Google Group delivers there, so
//     GmailApp.search() can see the mail. Do NOT create a new project: this
//     file is additive and reuses the project's WEBHOOK_SECRET constant.
//  2. Paste this whole file in as a new script file (e.g. loadsEmailBridge.gs).
//  3. Project Settings -> Script properties, add:
//       LOADS_WEBHOOK_URL     = the driver-app-api Lambda Function URL, with or
//                               without a trailing slash and WITHOUT the
//                               /email-intake/... path. For production
//                               (Amplify app d3dejqzs77khq6, us-east-1) that is
//                               https://a5trb7hgy3lpohdcky5msmaq2y0iqeuz.lambda-url.us-east-1.on.aws
//                               Re-read it any time with:
//                                 aws lambda get-function-url-config --region us-east-1 \
//                                   --function-name amplify-d3dejqzs77khq6-ma-driverappapilambda665E2D-U31WM0kM1L82
//       LOADS_WEBHOOK_SECRET  = the INTAKE_WEBHOOK_SECRET value (optional —
//                               omit it and the project's existing
//                               WEBHOOK_SECRET constant is used instead).
//     NOTE on the secret name: the Lambda env var is LOADS_INTAKE_SECRET but it
//     is `secret('INTAKE_WEBHOOK_SECRET')` in
//     amplify/functions/driver-app-api/resource.ts — the one shared intake
//     secret. `ampx sandbox secret set LOADS_INTAKE_SECRET` sets nothing.
//  4. Run setupLoadsEmailBridge() once. It validates the two config values,
//     creates the 'loads-needs-review' label, and installs exactly one
//     every-5-minutes trigger for processLoadsEmails. It touches no other
//     trigger, so the factoring and vendor-AP bridges keep running.
//  5. Authorize the scopes Apps Script prompts for (Gmail read + external
//     requests). Then check Executions: the first run sweeps the backlog in
//     5-minute slices and acks each message in PropertiesService.
//
// ── WHAT GETS SKIPPED (and why that is not a bug) ────────────────────────────
//  • Messages with no usable attachment. /email-intake/prepare requires at
//    least one attachment, so a bare "plz build and add to calendar" note can
//    never become a submission. Those threads get the 'loads-needs-review'
//    label and are acked, instead of being retried forever.
//  • Our own notification mail. completeSubmission emails the finished load
//    back to ivanloads@, i.e. into this very mailbox. The Lambda's loop guard
//    rejects it (from onboarding@bcatcorp.com / subject "New load from …") and
//    answers {skipped:true, reason:'self-sent'|'own-notification'} — acked here
//    so the loop terminates on the first pass.
//  • reason:'in-flight' is deliberately NOT acked: another invocation is
//    mid-flight for the same message and may still fail, so the message stays
//    eligible for a later poll.
//
// Dedup is per-Gmail-message-id in PropertiesService (namespaced), so a new
// forward landing in an already-seen thread is still processed. A durable
// cursor sweeps older pages in the background while every run always checks
// sequential newest pages first so a burst of new mail cannot block behind
// backlog.

const LOADS_RECIPIENT = 'ivanloads@bcatcorp.com';
const LOADS_NEEDS_REVIEW_LABEL = 'loads-needs-review';
const LOADS_PROCESS_FN = 'processLoadsEmails';
const LOADS_PROP_NS = 'loads:msg:';
const LOADS_CURSOR_PROP = 'loads:cursor';
const LOADS_PAGE_SIZE = 25;
const LOADS_MAX_RUNTIME_MS = 5 * 60 * 1000 - 30000; // 30 s headroom
const LOADS_MAX_BODY_CHARS = 50000;
const LOADS_BODY_TRUNCATION_INDICATOR = '\n\n[truncated]';
// Mirrors MAX_PAGES / MAX_UPLOAD_BYTES / EMAIL_ACCEPTED_CONTENT_TYPES in
// amplify/functions/driver-app-api/handler.ts. Filtering here turns a
// guaranteed 400 into a reviewable label.
const LOADS_MAX_ATTACHMENTS = 12;
const LOADS_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const LOADS_ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/**
 * Run once after pasting into the project. Validates config, creates the review
 * label, and installs exactly one every-5-minutes trigger. Does not touch other
 * triggers or existing bridges.
 */
function setupLoadsEmailBridge() {
  const cfg = loadsGetConfig_();
  if (!cfg.baseUrl) throw new Error('Set script property LOADS_WEBHOOK_URL');
  if (!cfg.secret) throw new Error('Set script property LOADS_WEBHOOK_SECRET or define WEBHOOK_SECRET constant');

  GmailApp.getUserLabelByName(LOADS_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(LOADS_NEEDS_REVIEW_LABEL);

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === LOADS_PROCESS_FN;
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger(LOADS_PROCESS_FN).timeBased().everyMinutes(5).create();
  }

  console.log('Loads email bridge setup complete; prepare=' + loadsPrepareUrl_(cfg));
}

/**
 * Main trigger handler. One invocation at a time (ScriptLock). Processes
 * sequential newest pages while they contain newly-arrived matching messages,
 * then resumes the durable older-page cursor.
 */
function processLoadsEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('[Loads] another instance is running; skipping');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  let cursor = loadsParseCursor_(props.getProperty(LOADS_CURSOR_PROP));
  let mainError = null;

  try {
    const cfg = loadsGetConfig_();
    if (!cfg.baseUrl || !cfg.secret) {
      throw new Error('[Loads] LOADS_WEBHOOK_URL and LOADS_WEBHOOK_SECRET required');
    }

    const startTime = Date.now();
    const PAGE_SIZE = LOADS_PAGE_SIZE;

    // Head sweep: process sequential newest pages while the previous page
    // contained newly-arrived matching messages. This prevents a backlog from
    // starving brand-new forwards.
    let headStart = 0;
    let lastHeadStart = 0;
    let lastHeadNewMatches = 0;
    let lastHeadComplete = true;

    do {
      lastHeadStart = headStart;
      const page = loadsProcessThreadPage_(headStart, PAGE_SIZE, cfg, props, startTime);
      lastHeadNewMatches = page.newMatches;
      lastHeadComplete = page.complete;
      headStart += PAGE_SIZE;
    } while (lastHeadNewMatches > 0 && lastHeadComplete);

    // If the durable cursor was idle, seed it just past the completed head
    // sweep, or at the incomplete head page so it is retried.
    if (cursor === 0) {
      cursor = lastHeadComplete ? headStart : lastHeadStart;
    }

    // Resume durable backlog sweep.
    if (cursor > 0) {
      const older = loadsProcessThreadPage_(cursor, PAGE_SIZE, cfg, props, startTime);
      if (older.complete) {
        if (older.threadCount < PAGE_SIZE) {
          cursor = 0; // reached the end; reset for a full sweep next cycle
        } else {
          cursor += PAGE_SIZE;
        }
      }
      // If the older page did not complete, keep the cursor so the same page
      // is retried; do not advance past unprocessed items.
    }
  } catch (e) {
    mainError = e;
    console.error('[Loads] run failed:', e);
  }

  let cursorSaveError = null;
  try {
    props.setProperty(LOADS_CURSOR_PROP, String(cursor));
  } catch (e) {
    cursorSaveError = e;
    console.error('[Loads] failed to save cursor:', e);
  } finally {
    lock.releaseLock();
  }

  if (mainError) throw mainError;
  if (cursorSaveError) throw cursorSaveError;
}

// ── Config ───────────────────────────────────────────────────────────────────

function loadsGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('LOADS_WEBHOOK_URL') || '';
  return {
    baseUrl: raw.replace(/\/+$/, '').replace(/\/email-intake(\/(prepare|commit))?$/, ''),
    secret: props.getProperty('LOADS_WEBHOOK_SECRET') || loadsGlobalSecret_(),
  };
}

function loadsGlobalSecret_() {
  // Pick up the shared secret constant from the existing BCAT Intake Bridge
  // project without redeclaring it (which would cause a duplicate const error).
  return typeof WEBHOOK_SECRET !== 'undefined' ? WEBHOOK_SECRET : '';
}

function loadsPrepareUrl_(cfg) { return cfg.baseUrl + '/email-intake/prepare'; }
function loadsCommitUrl_(cfg) { return cfg.baseUrl + '/email-intake/commit'; }

// ── Gmail search & pagination ────────────────────────────────────────────────

function loadsBuildGmailQuery_() {
  // Explicit operators cover To/Cc/Delivered-To/List-ID; the quoted address
  // fallback catches X-Original-To and any other indexed header. Never uses
  // is:unread / is:unseen so archived/read mail is included.
  const email = LOADS_RECIPIENT;
  const listId = email.replace('@', '.');
  return [
    'to:' + email,
    'cc:' + email,
    'deliveredto:' + email,
    'list:' + listId,
    '"' + email + '"',
  ].join(' OR ') + ' -in:trash -in:spam';
}

function loadsProcessThreadPage_(start, max, cfg, props, startTime) {
  const threads = GmailApp.search(loadsBuildGmailQuery_(), start, max);
  let processedCount = 0;
  let newMatches = 0;
  let retryCount = 0;
  let complete = true;

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (Date.now() - startTime > LOADS_MAX_RUNTIME_MS) {
        console.log('[Loads] approaching 6-minute deadline, pausing');
        complete = false;
        break;
      }

      const msgId = messages[j].getId();
      const ackKey = LOADS_PROP_NS + msgId;
      const alreadyAcked = props.getProperty(ackKey);
      const isRecipient = loadsIsForQueue_(messages[j]);

      if (!alreadyAcked && isRecipient) newMatches++;
      if (alreadyAcked) {
        processedCount++;
        continue;
      }
      if (!isRecipient) continue;

      const result = loadsProcessMessageInternal_(messages[j], cfg, props, msgId);
      if (result === 'processed') processedCount++;
      else if (result === 'retry') retryCount++;
    }
    if (!complete) break;
  }

  if (retryCount > 0) {
    throw new Error('[Loads] ' + retryCount + ' webhook failure(s); will retry');
  }

  return { threadCount: threads.length, processedCount: processedCount, newMatches: newMatches, complete: complete };
}

// ── Per-message processing ───────────────────────────────────────────────────

function loadsProcessMessage_(message, cfg, props) {
  const msgId = message.getId();
  const ackKey = LOADS_PROP_NS + msgId;

  if (props.getProperty(ackKey)) return 'processed';
  if (!loadsIsForQueue_(message)) return 'skip';

  return loadsProcessMessageInternal_(message, cfg, props, msgId);
}

function loadsProcessMessageInternal_(message, cfg, props, msgId) {
  const attachments = loadsCollectAttachments_(message);
  if (attachments.length === 0) {
    // Nothing to upload: prepare would answer 400 on every poll forever.
    loadsApplyNeedsReviewLabel_(message);
    if (loadsPersistAck_(props, LOADS_PROP_NS + msgId, 'no-attachment:' + new Date().toISOString())) {
      console.log('[Loads] no usable attachment, labeled for review', msgId);
      return 'processed';
    }
    return 'retry';
  }

  const preparePayload = loadsBuildPreparePayload_(message, cfg, attachments);

  const prepareRes = loadsPost_(loadsPrepareUrl_(cfg), preparePayload);
  const prepareCode = prepareRes.getResponseCode();
  const prepareBody = prepareRes.getContentText();

  if (prepareCode !== 200) {
    if (prepareCode === 400 || prepareCode === 422) {
      loadsApplyNeedsReviewLabel_(message);
      if (loadsPersistAck_(props, LOADS_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
        console.log('[Loads] prepare rejected, labeled for review', msgId, prepareBody);
        return 'processed';
      }
      return 'retry';
    }
    console.error('[Loads] prepare failed for', msgId, 'code', prepareCode, prepareBody);
    return 'retry';
  }

  let parsed;
  try { parsed = JSON.parse(prepareBody); } catch (e) { parsed = null; }
  if (!parsed) {
    console.error('[Loads] prepare returned unparseable body for', msgId, prepareBody);
    return 'retry';
  }

  if (parsed.skipped === true) {
    // 'in-flight' means a concurrent run may still fail; leave the message
    // eligible for a later poll instead of acking it.
    if (parsed.reason === 'in-flight') {
      console.log('[Loads] in-flight elsewhere, will re-poll', msgId);
      return 'skip';
    }
    if (loadsPersistAck_(props, LOADS_PROP_NS + msgId, 'skipped-' + parsed.reason + ':' + new Date().toISOString())) {
      console.log('[Loads] skipped', msgId, parsed.reason);
      return 'processed';
    }
    return 'retry';
  }

  const submissionId = parsed.submissionId;
  const targets = parsed.targets || [];
  if (!submissionId || targets.length !== attachments.length) {
    console.error('[Loads] target count mismatch for', msgId,
      'expected', attachments.length, 'got', targets.length);
    return 'retry';
  }

  const committed = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const att = attachments[i];
    if (!loadsUploadAttachment_(target, att)) return 'retry';
    committed.push({
      fileName: att.fileName,
      contentType: att.contentType,
      byteSize: att.byteSize,
      s3Key: target.s3Key,
    });
  }

  const commitRes = loadsPost_(loadsCommitUrl_(cfg), {
    secret: cfg.secret,
    gmailMessageId: msgId,
    submissionId: submissionId,
    attachments: committed,
  });
  const commitCode = commitRes.getResponseCode();
  const commitBody = commitRes.getContentText();

  if (commitCode === 200) {
    let cParsed;
    try { cParsed = JSON.parse(commitBody); } catch (e) { cParsed = {}; }
    if (cParsed && cParsed.ok === true) {
      if (!cParsed.notified) {
        // Row and docs are saved; only Slack/SES failed. Label it so dispatch
        // still sees the load, then ack — re-committing cannot re-notify.
        loadsApplyNeedsReviewLabel_(message);
        console.error('[Loads] committed but not notified', msgId, cParsed.error || '');
      }
      if (loadsPersistAck_(props, LOADS_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
        console.log('[Loads] committed', msgId, 'driver', parsed.driverName,
          parsed.driverMatched === false ? '(UNMATCHED)' : '');
        return 'processed';
      }
      return 'retry';
    }
  }

  if (commitCode === 400 || commitCode === 403 || commitCode === 404 || commitCode === 422) {
    loadsApplyNeedsReviewLabel_(message);
    if (loadsPersistAck_(props, LOADS_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
      console.log('[Loads] commit rejected, labeled for review', msgId, commitBody);
      return 'processed';
    }
    return 'retry';
  }

  console.error('[Loads] commit failed for', msgId, 'code', commitCode, commitBody);
  return 'retry';
}

function loadsBuildPreparePayload_(message, cfg, attachments) {
  const rawSubject = (message.getSubject() || '').trim();
  const from = message.getFrom() || '';

  // The Lambda resolves the driver by scanning this body for a roster name
  // ("driver LEE please", "build chad as driver"), so send the full plain body,
  // not an excerpt. It truncates to 1000 chars for the stored note itself.
  const plainBody = message.getPlainBody() || '';
  let body = plainBody;
  if (plainBody.length > LOADS_MAX_BODY_CHARS) {
    const limit = LOADS_MAX_BODY_CHARS - LOADS_BODY_TRUNCATION_INDICATOR.length;
    body = plainBody.slice(0, Math.max(0, limit)) + LOADS_BODY_TRUNCATION_INDICATOR;
  }

  const attachmentMeta = attachments.map(function (att) {
    return { fileName: att.fileName, contentType: att.contentType, byteSize: att.byteSize };
  });

  return {
    secret: cfg.secret,
    gmailMessageId: message.getId(),
    subject: rawSubject,
    from: from,
    body: body,
    attachments: attachmentMeta,
  };
}

/**
 * Real, uploadable attachments only: skips inline images (signature logos),
 * zero-byte parts, anything over the Lambda's size cap, and anything whose type
 * the Lambda will not accept. Content type is normalised from the file
 * extension when Gmail reports a generic one, because the presigned PUT must
 * send back exactly the type prepare was given.
 */
function loadsCollectAttachments_(message) {
  const raw = message.getAttachments();
  const out = [];
  for (let i = 0; i < raw.length && out.length < LOADS_MAX_ATTACHMENTS; i++) {
    const att = raw[i];
    if (!att) continue;
    if (att.getContentDisposition() === 'inline') continue;
    const size = att.getSize();
    if (!size || size <= 0 || size > LOADS_MAX_ATTACHMENT_BYTES) continue;
    const fileName = att.getName() || 'attachment';
    const contentType = loadsNormalizeContentType_(att.getContentType(), fileName);
    if (!contentType) continue;
    out.push({ attachment: att, fileName: fileName, contentType: contentType, byteSize: size });
  }
  return out;
}

function loadsNormalizeContentType_(reported, fileName) {
  const base = String(reported || '').split(';')[0].trim().toLowerCase();
  if (LOADS_ACCEPTED_TYPES.indexOf(base) !== -1) return base;
  const name = String(fileName || '').toLowerCase();
  if (/\.pdf$/.test(name)) return 'application/pdf';
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.webp$/.test(name)) return 'image/webp';
  return null;
}

function loadsUploadAttachment_(target, att) {
  const blob = att.attachment.copyBlob();
  const res = UrlFetchApp.fetch(target.url, {
    method: 'put',
    contentType: att.contentType,
    payload: blob,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return true;
  console.error('[Loads] attachment upload failed', att.fileName, code, res.getContentText());
  return false;
}

function loadsPost_(url, payload) {
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function loadsIsForQueue_(message) {
  const emailHeaders = [
    message.getTo(),
    message.getCc(),
    message.getHeader('Delivered-To'),
    message.getHeader('X-Original-To'),
  ];
  for (let i = 0; i < emailHeaders.length; i++) {
    if (loadsHeaderContainsEmail_(emailHeaders[i], LOADS_RECIPIENT)) return true;
  }

  const listId = message.getHeader('List-ID');
  if (listId && loadsHeaderContainsListId_(listId, LOADS_RECIPIENT)) return true;

  return false;
}

function loadsHeaderContainsEmail_(headerValue, email) {
  if (!headerValue) return false;
  const target = email.toLowerCase();
  const addrs = loadsExtractAddresses_(String(headerValue));
  for (let i = 0; i < addrs.length; i++) {
    if (addrs[i].toLowerCase() === target) return true;
  }
  return false;
}

function loadsExtractAddresses_(headerValue) {
  const matches = headerValue.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) || [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    out.push(matches[i].replace(/^</, '').replace(/>$/, '').trim());
  }
  return out;
}

function loadsHeaderContainsListId_(headerValue, email) {
  // List-ID is typically "<list-id.example.com>" or "Name <list-id.example.com>".
  const expectedIds = [email.toLowerCase(), email.toLowerCase().replace('@', '.')];
  const ids = String(headerValue).toLowerCase().match(/<([^>]+)>/g) || [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i].replace(/[<>]/g, '').trim();
    if (expectedIds.indexOf(id) !== -1) return true;
  }
  return false;
}

function loadsApplyNeedsReviewLabel_(message) {
  const label = GmailApp.getUserLabelByName(LOADS_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(LOADS_NEEDS_REVIEW_LABEL);
  message.getThread().addLabel(label);
}

// ── Properties helpers ───────────────────────────────────────────────────────

function loadsPersistAck_(props, key, value) {
  try {
    props.setProperty(key, value);
    return true;
  } catch (e) {
    console.error('[Loads] PropertiesService set failed for', key, ':', e);
    return false;
  }
}

function loadsParseCursor_(raw) {
  const n = parseInt(raw || '0', 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
