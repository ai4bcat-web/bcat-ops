// ── Vendor AP Email Bridge ──────────────────────────────────────────────────
// Standalone additive Apps Script for the existing BCAT Intake Bridge project.
// Polls Gmail every 5 min for messages delivered to vendorpayments@bcatcorp.com and
// forwards original invoice attachments to the vendor-ap-intake Lambda via a
// two-phase protocol (prepare -> presigned S3 PUT -> commit).
//
// Phase separation keeps Gmail attachment bytes out of the Lambda Function URL
// request body, avoiding the 6 MiB sync invoke limit.

const VENDOR_AP_RECIPIENT = 'vendorpayments@bcatcorp.com';
const VENDOR_AP_NEEDS_REVIEW_LABEL = 'vendor-ap-needs-review';
const VENDOR_AP_PROCESS_FN = 'processVendorApEmails';
const VENDOR_AP_PROP_NS = 'vendorap:msg:';
const VENDOR_AP_CURSOR_PROP = 'vendorap:cursor';
const VENDOR_AP_PAGE_SIZE = 25;
const VENDOR_AP_MAX_RUNTIME_MS = 5 * 60 * 1000 - 30000; // 30 s headroom
const VENDOR_AP_MAX_BODY_CHARS = 50000;
const VENDOR_AP_BODY_TRUNCATION_INDICATOR = '\n\n[truncated]';
// The production intake URL. A script property overrides it, but this project already
// holds more than 50 properties (one ack per processed email), which makes the settings
// page read-only — so the URL ships in the file rather than depend on a property write.
const VENDOR_AP_DEFAULT_URL = 'https://lf3reflylo37vreepaw2dg63cq0wgvvc.lambda-url.us-east-1.on.aws/';

/**
 * Run once after pasting into the project. Validates config, creates the review
 * label, and installs exactly one every-5-minutes trigger. Does not touch other
 * triggers or existing bridges.
 */
function setupVendorApEmailBridge() {
  const cfg = vendorApGetConfig_();
  if (!cfg.url) throw new Error('Set script property VENDOR_AP_WEBHOOK_URL');
  if (!cfg.secret) throw new Error('Set script property VENDOR_AP_WEBHOOK_SECRET or define WEBHOOK_SECRET constant');

  GmailApp.getUserLabelByName(VENDOR_AP_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(VENDOR_AP_NEEDS_REVIEW_LABEL);

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === VENDOR_AP_PROCESS_FN;
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger(VENDOR_AP_PROCESS_FN).timeBased().everyMinutes(5).create();
  }

  console.log('Vendor AP email bridge setup complete');
}

/**
 * Main trigger handler. One invocation at a time (ScriptLock). Processes
 * sequential newest pages while they contain newly-arrived matching messages,
 * then resumes the durable older-page cursor.
 */
function processVendorApEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('[VendorAP] another instance is running; skipping');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  let cursor = vendorApParseCursor_(props.getProperty(VENDOR_AP_CURSOR_PROP));
  let mainError = null;

  try {
    const cfg = vendorApGetConfig_();
    if (!cfg.url || !cfg.secret) {
      throw new Error('[VendorAP] VENDOR_AP_WEBHOOK_URL and VENDOR_AP_WEBHOOK_SECRET required');
    }

    const startTime = Date.now();
    const PAGE_SIZE = VENDOR_AP_PAGE_SIZE;

    let headStart = 0;
    let lastHeadStart = 0;
    let lastHeadNewMatches = 0;
    let lastHeadComplete = true;

    do {
      lastHeadStart = headStart;
      const page = vendorApProcessThreadPage_(headStart, PAGE_SIZE, cfg, props, startTime);
      lastHeadNewMatches = page.newMatches;
      lastHeadComplete = page.complete;
      headStart += PAGE_SIZE;
    } while (lastHeadNewMatches > 0 && lastHeadComplete);

    if (cursor === 0) {
      cursor = lastHeadComplete ? headStart : lastHeadStart;
    }

    if (cursor > 0) {
      const older = vendorApProcessThreadPage_(cursor, PAGE_SIZE, cfg, props, startTime);
      if (older.complete) {
        if (older.threadCount < PAGE_SIZE) {
          cursor = 0;
        } else {
          cursor += PAGE_SIZE;
        }
      }
    }
  } catch (e) {
    mainError = e;
    console.error('[VendorAP] run failed:', e);
  }

  let cursorSaveError = null;
  try {
    props.setProperty(VENDOR_AP_CURSOR_PROP, String(cursor));
  } catch (e) {
    cursorSaveError = e;
    console.error('[VendorAP] failed to save cursor:', e);
  } finally {
    lock.releaseLock();
  }

  if (mainError) throw mainError;
  if (cursorSaveError) throw cursorSaveError;
}

// ── Config ──────────────────────────────────────────────────────────────────

function vendorApGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: props.getProperty('VENDOR_AP_WEBHOOK_URL') || VENDOR_AP_DEFAULT_URL,
    secret: props.getProperty('VENDOR_AP_WEBHOOK_SECRET') || vendorApGlobalSecret_(),
  };
}

function vendorApGlobalSecret_() {
  // Pick up the shared secret constant from the existing BCAT Intake Bridge
  // project without redeclaring it (which would cause a duplicate const error).
  return typeof WEBHOOK_SECRET !== 'undefined' ? WEBHOOK_SECRET : '';
}

// ── Gmail search & pagination ───────────────────────────────────────────────

function vendorApBuildGmailQuery_() {
  // Explicit operators cover To/Cc/Delivered-To/List-ID; the quoted address
  // fallback catches X-Original-To and any other indexed header. Never uses
  // is:unread / is:unseen so archived/read mail is included.
  const email = VENDOR_AP_RECIPIENT;
  const listId = email.replace('@', '.');
  return [
    'to:' + email,
    'cc:' + email,
    'deliveredto:' + email,
    'list:' + listId,
    '"' + email + '"',
  ].join(' OR ') + ' -in:trash -in:spam';
}

function vendorApProcessThreadPage_(start, max, cfg, props, startTime) {
  const threads = GmailApp.search(vendorApBuildGmailQuery_(), start, max);
  let processedCount = 0;
  let newMatches = 0;
  let retryCount = 0;
  let complete = true;

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (Date.now() - startTime > VENDOR_AP_MAX_RUNTIME_MS) {
        console.log('[VendorAP] approaching 6-minute deadline, pausing');
        complete = false;
        break;
      }

      const msgId = messages[j].getId();
      const ackKey = VENDOR_AP_PROP_NS + msgId;
      const alreadyAcked = props.getProperty(ackKey);
      const isRecipient = vendorApIsForQueue_(messages[j]);

      if (!alreadyAcked && isRecipient) newMatches++;
      if (alreadyAcked) {
        processedCount++;
        continue;
      }
      if (!isRecipient) continue;

      const result = vendorApProcessMessageInternal_(messages[j], cfg, props, msgId);
      if (result === 'processed') processedCount++;
      else if (result === 'retry') retryCount++;
    }
    if (!complete) break;
  }

  if (retryCount > 0) {
    throw new Error('[VendorAP] ' + retryCount + ' webhook failure(s); will retry');
  }

  return { threadCount: threads.length, processedCount: processedCount, newMatches: newMatches, complete: complete };
}

// ── Per-message processing ──────────────────────────────────────────────────

function vendorApProcessMessage_(message, cfg, props) {
  const msgId = message.getId();
  const ackKey = VENDOR_AP_PROP_NS + msgId;

  if (props.getProperty(ackKey)) return 'processed';
  if (!vendorApIsForQueue_(message)) return 'skip';

  return vendorApProcessMessageInternal_(message, cfg, props, msgId);
}

function vendorApProcessMessageInternal_(message, cfg, props, msgId) {
  const preparePayload = vendorApBuildPreparePayload_(message, cfg);

  const prepareRes = vendorApPost_(cfg.url, preparePayload);
  const prepareCode = prepareRes.getResponseCode();
  const prepareBody = prepareRes.getContentText();

  if (prepareCode === 200) {
    let parsed;
    try { parsed = JSON.parse(prepareBody); } catch (e) { parsed = {}; }
    if (parsed && parsed.ok === true) {
      if (parsed.duplicate === true) {
        if (vendorApPersistAck_(props, VENDOR_AP_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
          console.log('[VendorAP] duplicate, skipping', msgId);
          return 'processed';
        }
        return 'retry';
      }

      const uploadUrls = parsed.uploadUrls || [];
      const attachments = vendorApCollectAttachments_(message);
      if (uploadUrls.length !== attachments.length) {
        console.error('[VendorAP] upload URL count mismatch for', msgId,
          'expected', attachments.length, 'got', uploadUrls.length);
        return 'retry';
      }

      const committedAttachments = [];
      for (let i = 0; i < uploadUrls.length; i++) {
        const entry = uploadUrls[i];
        const att = attachments[i];
        const uploadResult = vendorApUploadAttachment_(entry, att);
        if (!uploadResult.ok) return 'retry';
        committedAttachments.push({
          s3Key: entry.s3Key,
          name: entry.name || att.getName(),
          contentType: entry.contentType,
          size: entry.size,
        });
      }

      const commitPayload = {
        secret: cfg.secret,
        action: 'commit',
        messageId: msgId,
        subject: preparePayload.subject,
        from: preparePayload.from,
        receivedAt: preparePayload.receivedAt,
        emailBody: preparePayload.emailBody,
        attachments: committedAttachments,
      };

      const commitRes = vendorApPost_(cfg.url, commitPayload);
      const commitCode = commitRes.getResponseCode();
      const commitBody = commitRes.getContentText();

      if (commitCode === 200) {
        let cParsed;
        try { cParsed = JSON.parse(commitBody); } catch (e) { cParsed = {}; }
        if (cParsed && cParsed.ok === true) {
          if (vendorApPersistAck_(props, VENDOR_AP_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
            console.log('[VendorAP] committed', msgId);
            return 'processed';
          }
          return 'retry';
        }
      }

      if (commitCode === 422 || commitCode === 400) {
        vendorApApplyNeedsReviewLabel_(message);
        if (vendorApPersistAck_(props, VENDOR_AP_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
          console.log('[VendorAP] commit rejected, labeled for review', msgId);
          return 'processed';
        }
        return 'retry';
      }

      console.error('[VendorAP] commit failed for', msgId, 'code', commitCode, commitBody);
      return 'retry';
    }
  }

  if (prepareCode === 422 || prepareCode === 400) {
    vendorApApplyNeedsReviewLabel_(message);
    if (vendorApPersistAck_(props, VENDOR_AP_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
      console.log('[VendorAP] prepare rejected, labeled for review', msgId);
      return 'processed';
    }
    return 'retry';
  }

  console.error('[VendorAP] prepare failed for', msgId, 'code', prepareCode, prepareBody);
  return 'retry';
}

function vendorApBuildPreparePayload_(message, cfg) {
  const rawSubject = (message.getSubject() || '').trim();
  const subject = rawSubject || 'no subject';
  const from = message.getFrom() || '';
  const receivedAt = message.getDate().toISOString();

  const plainBody = message.getPlainBody() || '';
  let emailBody = plainBody;
  if (plainBody.length > VENDOR_AP_MAX_BODY_CHARS) {
    const limit = VENDOR_AP_MAX_BODY_CHARS - VENDOR_AP_BODY_TRUNCATION_INDICATOR.length;
    emailBody = plainBody.slice(0, Math.max(0, limit)) + VENDOR_AP_BODY_TRUNCATION_INDICATOR;
  }

  const attachments = vendorApCollectAttachments_(message);
  const attachmentMeta = attachments.map(function (att) {
    return {
      name: att.getName() || 'attachment',
      contentType: att.getContentType() || 'application/octet-stream',
      size: att.getSize(),
    };
  });

  return {
    secret: cfg.secret,
    action: 'prepare',
    messageId: message.getId(),
    subject: subject,
    from: from,
    receivedAt: receivedAt,
    emailBody: emailBody,
    attachments: attachmentMeta,
  };
}

function vendorApCollectAttachments_(message) {
  // Real attachments only: inline images (signatures, logos) are excluded by Gmail here,
  // because GmailAttachment has no content-disposition accessor to check afterwards —
  // calling one threw on the very first invoice (9 Oct 2026) and nothing ever reached the queue.
  const raw = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const att = raw[i];
    if (!att) continue;
    const size = att.getSize();
    if (!size || size <= 0) continue;
    out.push(att);
  }
  return out;
}

function vendorApUploadAttachment_(entry, attachment) {
  const blob = attachment.copyBlob();
  const res = UrlFetchApp.fetch(entry.url, {
    method: 'put',
    contentType: entry.contentType,
    payload: blob,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true };
  console.error('[VendorAP] attachment upload failed', code, res.getContentText());
  return { ok: false };
}

function vendorApPost_(url, payload) {
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function vendorApIsForQueue_(message) {
  const emailHeaders = [
    message.getTo(),
    message.getCc(),
    message.getHeader('Delivered-To'),
    message.getHeader('X-Original-To'),
  ];
  for (let i = 0; i < emailHeaders.length; i++) {
    if (vendorApHeaderContainsEmail_(emailHeaders[i], VENDOR_AP_RECIPIENT)) return true;
  }

  const listId = message.getHeader('List-ID');
  if (listId && vendorApHeaderContainsListId_(listId, VENDOR_AP_RECIPIENT)) return true;

  return false;
}

function vendorApHeaderContainsEmail_(headerValue, email) {
  if (!headerValue) return false;
  const target = email.toLowerCase();
  const addrs = vendorApExtractAddresses_(String(headerValue));
  for (let i = 0; i < addrs.length; i++) {
    if (addrs[i].toLowerCase() === target) return true;
  }
  return false;
}

function vendorApExtractAddresses_(headerValue) {
  const matches = headerValue.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) || [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    out.push(matches[i].replace(/^</, '').replace(/>$/, '').trim());
  }
  return out;
}

function vendorApHeaderContainsListId_(headerValue, email) {
  const expectedIds = [email.toLowerCase(), email.toLowerCase().replace('@', '.')];
  const ids = String(headerValue).toLowerCase().match(/<([^>]+)>/g) || [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i].replace(/[<>]/g, '').trim();
    if (expectedIds.indexOf(id) !== -1) return true;
  }
  return false;
}

function vendorApApplyNeedsReviewLabel_(message) {
  const label = GmailApp.getUserLabelByName(VENDOR_AP_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(VENDOR_AP_NEEDS_REVIEW_LABEL);
  message.getThread().addLabel(label);
}

// ── Properties helpers ───────────────────────────────────────────────────────

function vendorApPersistAck_(props, key, value) {
  try {
    props.setProperty(key, value);
    return true;
  } catch (e) {
    console.error('[VendorAP] PropertiesService set failed for', key, ':', e);
    return false;
  }
}

function vendorApParseCursor_(raw) {
  const n = parseInt(raw || '0', 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
