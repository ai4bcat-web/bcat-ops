// ── Shipment Email Bridge (replies on a shipment's e-mail thread) ────────────
// Standalone additive Apps Script for the existing BCAT Intake Bridge project (the one owned by the account that
// holds the thread mailbox, ai4bcat@gmail.com). Polls Gmail every 5 minutes for messages that belong to a shipment thread
// and posts each one to the shipment-email-intake Function URL, which files it on the shipment's Tracking > E-mail thread.
//
// What counts as "on a shipment thread" (the Lambda does the real routing, this only decides what to send):
//   - sent to / copied to  ai4bcat+tracking.<shipmentId>@gmail.com  (the Reply-To the rate con and tracking e-mails carry), or
//   - carries the stable  [ref shp-...]  token in its subject (a reply keeps it), or
//   - is a reply in a Gmail thread that already holds such a message.
// A message the Lambda cannot route (HTTP 422) is not an error: it is remembered and skipped.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// Nothing was posting to the production shipment-email-intake URL (its log group does not even exist), so a reply to a rate
// confirmation, or an e-mail sent on a shipment thread, never reached the Tracking e-mail thread.
//
// ── INSTALL (a human has to do this once) ────────────────────────────────────
//  1. Open the Apps Script project that already hosts vendorApEmailBridge.gs / loadsEmailBridge.gs. Do NOT create a new project.
//  2. Paste this whole file in as a new script file (shipmentEmailBridge.gs).
//  3. Project Settings -> Script properties, add:
//       SHIPMENT_EMAIL_URL     = the shipment-email-intake Function URL. For production (Amplify app d3dejqzs77khq6, us-east-1):
//                                  aws lambda get-function-url-config --region us-east-1 \
//                                    --function-name amplify-d3dejqzs77khq6-ma-shipmentemailintakelambd-CfplnQE3o5Wj
//       SHIPMENT_EMAIL_SECRET  = the INTAKE_WEBHOOK_SECRET value (optional: omit it and the project's WEBHOOK_SECRET constant is used).
//       SHIPMENT_THREAD_MAILBOX = optional, default ai4bcat@gmail.com (the thread mailbox the plus-addresses hang off).
//       SHIPMENT_LOOKBACK_DAYS  = optional, default 3 (1 to 60): how far back each run looks.
//  4. Run setupShipmentEmailBridge() once. It validates the config and installs exactly one every-5-minutes trigger for
//     processShipmentEmails. It touches no other trigger.
//
// Dedup is per Gmail message id in PropertiesService (namespace 'shipmsg:'), so a new reply in an already-seen thread is still sent.

const SHIPMENT_PROCESS_FN = 'processShipmentEmails';
const SHIPMENT_PROP_NS = 'shipmsg:msg:';
const SHIPMENT_PAGE_SIZE = 25;
const SHIPMENT_MAX_RUNTIME_MS = 5 * 60 * 1000 - 30000; // 30 s headroom
const SHIPMENT_MAX_BODY_CHARS = 50000;
const SHIPMENT_MAX_ATTACHMENTS = 10;
const SHIPMENT_MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // base64 rides in the request body (6 MiB Function URL limit)
const SHIPMENT_DEFAULT_MAILBOX = 'ai4bcat@gmail.com';

function setupShipmentEmailBridge() {
  const cfg = shipmentGetConfig_();
  if (!cfg.url) throw new Error('Set script property SHIPMENT_EMAIL_URL');
  if (!cfg.secret) throw new Error('Set script property SHIPMENT_EMAIL_SECRET or define the WEBHOOK_SECRET constant');
  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === SHIPMENT_PROCESS_FN;
  });
  if (!hasTrigger) ScriptApp.newTrigger(SHIPMENT_PROCESS_FN).timeBased().everyMinutes(5).create();
  console.log('Shipment email bridge setup complete; mailbox=' + cfg.mailbox + ' lookback=' + cfg.lookbackDays + 'd');
}

function processShipmentEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('[ShipmentMail] another instance is running; skipping');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  let mainError = null;
  try {
    const cfg = shipmentGetConfig_();
    if (!cfg.url || !cfg.secret) throw new Error('[ShipmentMail] SHIPMENT_EMAIL_URL and SHIPMENT_EMAIL_SECRET required');
    const startTime = Date.now();
    let start = 0;
    for (;;) {
      const page = shipmentProcessThreadPage_(start, SHIPMENT_PAGE_SIZE, cfg, props, startTime);
      if (!page.complete || page.threadCount < SHIPMENT_PAGE_SIZE) break;
      start += SHIPMENT_PAGE_SIZE;
    }
  } catch (e) {
    mainError = e;
    console.error('[ShipmentMail] run failed:', e);
  } finally {
    lock.releaseLock();
  }
  if (mainError) throw mainError;
}

// ── Config ──────────────────────────────────────────────────────────────────

function shipmentGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  const days = parseInt(String(props.getProperty('SHIPMENT_LOOKBACK_DAYS') || ''), 10);
  return {
    url: (props.getProperty('SHIPMENT_EMAIL_URL') || '').trim(),
    secret: props.getProperty('SHIPMENT_EMAIL_SECRET') || (typeof WEBHOOK_SECRET !== 'undefined' ? WEBHOOK_SECRET : ''),
    mailbox: (props.getProperty('SHIPMENT_THREAD_MAILBOX') || SHIPMENT_DEFAULT_MAILBOX).trim().toLowerCase(),
    lookbackDays: isNaN(days) || days < 1 ? 3 : Math.min(days, 60),
  };
}

/** Threads that hold a shipment-thread message. The plus-address and the [ref] token are both searched; the Lambda routes. */
function shipmentBuildGmailQuery_(cfg) {
  const local = cfg.mailbox.split('@')[0];
  return '(subject:"ref shp-" OR "' + local + '+tracking" OR "' + local + '.tracking") -in:trash -in:spam newer_than:' + cfg.lookbackDays + 'd';
}

// ── One page of threads ─────────────────────────────────────────────────────

function shipmentProcessThreadPage_(start, max, cfg, props, startTime) {
  const threads = GmailApp.search(shipmentBuildGmailQuery_(cfg), start, max);
  let complete = true;
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (Date.now() - startTime > SHIPMENT_MAX_RUNTIME_MS) {
        console.log('[ShipmentMail] approaching the 6-minute deadline, pausing');
        return { threadCount: threads.length, complete: false };
      }
      const msg = messages[j];
      const key = SHIPMENT_PROP_NS + msg.getId();
      if (props.getProperty(key)) continue;
      // The mailbox's own sends are not replies; the app records what it sends itself.
      if (shipmentFromAddress_(msg).indexOf(cfg.mailbox) !== -1) {
        props.setProperty(key, 'own');
        continue;
      }
      const outcome = shipmentPost_(msg, cfg);
      if (outcome === 'retry') { complete = false; continue; }
      props.setProperty(key, outcome);
    }
  }
  return { threadCount: threads.length, complete: complete };
}

function shipmentFromAddress_(msg) {
  return String(msg.getFrom() || '').toLowerCase();
}

function shipmentAttachments_(msg) {
  const out = [];
  const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  for (let i = 0; i < atts.length && out.length < SHIPMENT_MAX_ATTACHMENTS; i++) {
    const a = atts[i];
    if (a.getSize() > SHIPMENT_MAX_ATTACHMENT_BYTES) continue;
    out.push({
      name: a.getName() || 'attachment-' + (i + 1),
      contentType: a.getContentType() || 'application/octet-stream',
      base64: Utilities.base64Encode(a.getBytes()),
    });
  }
  return out;
}

function shipmentPayload_(msg, cfg) {
  let body = msg.getPlainBody() || '';
  if (body.length > SHIPMENT_MAX_BODY_CHARS) body = body.slice(0, SHIPMENT_MAX_BODY_CHARS) + '\n\n[truncated]';
  const received = msg.getDate();
  return {
    secret: cfg.secret,
    messageId: msg.getHeader('Message-ID') || ('<gmail-' + msg.getId() + '@mail.gmail.com>'),
    to: msg.getTo() || '',
    cc: msg.getCc() || '',
    from: msg.getFrom() || '',
    subject: msg.getSubject() || '',
    body: body,
    inReplyTo: msg.getHeader('In-Reply-To') || '',
    references: msg.getHeader('References') || '',
    attachments: shipmentAttachments_(msg),
    receivedAt: received && received.toISOString ? received.toISOString() : '',
  };
}

/** 'done' = filed, 'unrouted' = the Lambda could not tie it to a shipment (not an error), 'retry' = try again next run. */
function shipmentPost_(msg, cfg) {
  let res;
  try {
    res = UrlFetchApp.fetch(cfg.url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(shipmentPayload_(msg, cfg)),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.error('[ShipmentMail] post failed:', e);
    return 'retry';
  }
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return 'done';
  if (code === 422) return 'unrouted';
  console.error('[ShipmentMail] intake answered ' + code + ': ' + String(res.getContentText()).slice(0, 200));
  return 'retry';
}
