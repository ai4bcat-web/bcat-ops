// ── Factoring Email Bridge ───────────────────────────────────────────────────
// Standalone additive Apps Script for the existing BCAT Intake Bridge project.
// Polls Gmail every 5 min for messages delivered to ivanfactoring@bcatcorp.com and
// POSTs a minimal payload to the factoring-intake Lambda Function URL.
//
// Dedup is per-Gmail-message-id in PropertiesService (namespaced), so a new
// forward landing in an already-seen thread is still processed. A durable
// cursor sweeps older pages in the background while every run always checks
// sequential newest pages first so a burst of new mail cannot block behind
// backlog.

const FACTORING_RECIPIENT = 'ivanfactoring@bcatcorp.com';
const FACTORING_NEEDS_REVIEW_LABEL = 'factoring-needs-review';
const FACTORING_PROCESS_FN = 'processFactoringEmails';
const FACTORING_PROP_NS = 'factoring:msg:';
const FACTORING_CURSOR_PROP = 'factoring:cursor';
const FACTORING_PAGE_SIZE = 25;
const FACTORING_MAX_RUNTIME_MS = 5 * 60 * 1000 - 30000; // 30 s headroom

/**
 * Run once after pasting into the project. Validates config, creates the review
 * label, and installs exactly one every-5-minutes trigger. Does not touch other
 * triggers or existing bridges.
 */
function setupFactoringEmailBridge() {
  const cfg = factoringGetConfig_();
  if (!cfg.url) throw new Error('Set script property FACTORING_WEBHOOK_URL');
  if (!cfg.secret) throw new Error('Set script property FACTORING_WEBHOOK_SECRET or define WEBHOOK_SECRET constant');

  GmailApp.getUserLabelByName(FACTORING_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(FACTORING_NEEDS_REVIEW_LABEL);

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === FACTORING_PROCESS_FN;
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger(FACTORING_PROCESS_FN).timeBased().everyMinutes(5).create();
  }

  console.log('Factoring email bridge setup complete');
}

/**
 * Main trigger handler. One invocation at a time (ScriptLock). Processes
 * sequential newest pages while they contain newly-arrived matching messages,
 * then resumes the durable older-page cursor.
 */
function processFactoringEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('[Factoring] another instance is running; skipping');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  let cursor = factoringParseCursor_(props.getProperty(FACTORING_CURSOR_PROP));
  let mainError = null;

  try {
    const cfg = factoringGetConfig_();
    if (!cfg.url || !cfg.secret) {
      throw new Error('[Factoring] FACTORING_WEBHOOK_URL and FACTORING_WEBHOOK_SECRET required');
    }

    const startTime = Date.now();
    const PAGE_SIZE = FACTORING_PAGE_SIZE;

    // Head sweep: process sequential newest pages while the previous page
    // contained newly-arrived matching messages. This prevents a backlog from
    // starving brand-new forwards.
    let headStart = 0;
    let lastHeadStart = 0;
    let lastHeadNewMatches = 0;
    let lastHeadComplete = true;

    do {
      lastHeadStart = headStart;
      const page = factoringProcessThreadPage_(headStart, PAGE_SIZE, cfg, props, startTime);
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
      const older = factoringProcessThreadPage_(cursor, PAGE_SIZE, cfg, props, startTime);
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
    console.error('[Factoring] run failed:', e);
  }

  let cursorSaveError = null;
  try {
    props.setProperty(FACTORING_CURSOR_PROP, String(cursor));
  } catch (e) {
    cursorSaveError = e;
    console.error('[Factoring] failed to save cursor:', e);
  } finally {
    lock.releaseLock();
  }

  if (mainError) throw mainError;
  if (cursorSaveError) throw cursorSaveError;
}

// ── Config ───────────────────────────────────────────────────────────────────

function factoringGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: props.getProperty('FACTORING_WEBHOOK_URL'),
    secret: props.getProperty('FACTORING_WEBHOOK_SECRET') || factoringGlobalSecret_(),
  };
}

function factoringGlobalSecret_() {
  // Pick up the shared secret constant from the existing BCAT Intake Bridge
  // project without redeclaring it (which would cause a duplicate const error).
  return typeof WEBHOOK_SECRET !== 'undefined' ? WEBHOOK_SECRET : '';
}

// ── Gmail search & pagination ────────────────────────────────────────────────

function factoringBuildGmailQuery_() {
  // Explicit operators cover To/Cc/Delivered-To/List-ID; the quoted address
  // fallback catches X-Original-To and any other indexed header. Never uses
  // is:unread / is:unseen so archived/read mail is included.
  const email = FACTORING_RECIPIENT;
  const listId = email.replace('@', '.');
  return [
    'to:' + email,
    'cc:' + email,
    'deliveredto:' + email,
    'list:' + listId,
    '"' + email + '"',
  ].join(' OR ') + ' -in:trash -in:spam';
}

function factoringProcessThreadPage_(start, max, cfg, props, startTime) {
  const threads = GmailApp.search(factoringBuildGmailQuery_(), start, max);
  let processedCount = 0;
  let newMatches = 0;
  let retryCount = 0;
  let complete = true;

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (Date.now() - startTime > FACTORING_MAX_RUNTIME_MS) {
        console.log('[Factoring] approaching 6-minute deadline, pausing');
        complete = false;
        break;
      }

      const msgId = messages[j].getId();
      const ackKey = FACTORING_PROP_NS + msgId;
      const alreadyAcked = props.getProperty(ackKey);
      const isRecipient = factoringIsForQueue_(messages[j]);

      if (!alreadyAcked && isRecipient) newMatches++;
      if (alreadyAcked) {
        processedCount++;
        continue;
      }
      if (!isRecipient) continue;

      const result = factoringProcessMessageInternal_(messages[j], cfg, props, msgId);
      if (result === 'processed') processedCount++;
      else if (result === 'retry') retryCount++;
    }
    if (!complete) break;
  }

  if (retryCount > 0) {
    throw new Error('[Factoring] ' + retryCount + ' webhook failure(s); will retry');
  }

  return { threadCount: threads.length, processedCount: processedCount, newMatches: newMatches, complete: complete };
}

// ── Per-message processing ───────────────────────────────────────────────────

function factoringProcessMessage_(message, cfg, props) {
  const msgId = message.getId();
  const ackKey = FACTORING_PROP_NS + msgId;

  if (props.getProperty(ackKey)) return 'processed';
  if (!factoringIsForQueue_(message)) return 'skip';

  return factoringProcessMessageInternal_(message, cfg, props, msgId);
}

function factoringProcessMessageInternal_(message, cfg, props, msgId) {
  const subject = (message.getSubject() || '').trim();
  const from = message.getFrom() || '';
  const receivedAt = message.getDate().toISOString();

  const payload = {
    secret: cfg.secret,
    messageId: msgId,
    subject: subject,
    from: from,
    receivedAt: receivedAt,
  };

  const response = UrlFetchApp.fetch(cfg.url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code === 200) {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { parsed = {}; }
    if (parsed && parsed.ok === true) {
      if (factoringPersistAck_(props, FACTORING_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
        console.log('[Factoring] processed', parsed.proNumber || msgId);
        return 'processed';
      }
      return 'retry';
    }
  }

  if (code === 422) {
    // Backend rejected the subject as missing/ambiguous/non-invoice PRO.
    factoringApplyNeedsReviewLabel_(message);
    if (factoringPersistAck_(props, FACTORING_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
      console.log('[Factoring] labeled for review:', subject);
      return 'processed';
    }
    return 'retry';
  }

  console.error('[Factoring] webhook failed for', msgId, 'code', code, body);
  return 'retry';
}

function factoringIsForQueue_(message) {
  const emailHeaders = [
    message.getTo(),
    message.getCc(),
    message.getHeader('Delivered-To'),
    message.getHeader('X-Original-To'),
  ];
  for (let i = 0; i < emailHeaders.length; i++) {
    if (factoringHeaderContainsEmail_(emailHeaders[i], FACTORING_RECIPIENT)) return true;
  }

  const listId = message.getHeader('List-ID');
  if (listId && factoringHeaderContainsListId_(listId, FACTORING_RECIPIENT)) return true;

  return false;
}

function factoringHeaderContainsEmail_(headerValue, email) {
  if (!headerValue) return false;
  const target = email.toLowerCase();
  const addrs = factoringExtractAddresses_(String(headerValue));
  for (let i = 0; i < addrs.length; i++) {
    if (addrs[i].toLowerCase() === target) return true;
  }
  return false;
}

function factoringExtractAddresses_(headerValue) {
  const matches = headerValue.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) || [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    out.push(matches[i].replace(/^</, '').replace(/>$/, '').trim());
  }
  return out;
}

function factoringHeaderContainsListId_(headerValue, email) {
  // List-ID is typically "<list-id.example.com>" or "Name <list-id.example.com>".
  // Derive the expected RFC-style list id from the recipient email as well as
  // allowing the literal email address inside the header.
  const expectedIds = [email.toLowerCase(), email.toLowerCase().replace('@', '.')];
  const ids = String(headerValue).toLowerCase().match(/<([^>]+)>/g) || [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i].replace(/[<>]/g, '').trim();
    if (expectedIds.indexOf(id) !== -1) return true;
  }
  return false;
}

function factoringApplyNeedsReviewLabel_(message) {
  const label = GmailApp.getUserLabelByName(FACTORING_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(FACTORING_NEEDS_REVIEW_LABEL);
  message.getThread().addLabel(label);
}

// ── Properties helpers ───────────────────────────────────────────────────────

function factoringPersistAck_(props, key, value) {
  try {
    props.setProperty(key, value);
    return true;
  } catch (e) {
    console.error('[Factoring] PropertiesService set failed for', key, ':', e);
    return false;
  }
}

function factoringParseCursor_(raw) {
  const n = parseInt(raw || '0', 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
