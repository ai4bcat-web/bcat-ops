// ── Agent Email Bridge (the four workflow inboxes) ───────────────────────────
// Standalone additive Apps Script for the existing BCAT Intake Bridge project.
// Polls Gmail every 5 min for messages delivered to any of the four AI-agent
// inboxes and forwards each one to the workflow-agent Function URL via the same
// two-phase protocol the vendor-AP bridge uses (prepare -> presigned S3 PUT ->
// commit).
//
// Phase separation keeps Gmail attachment bytes out of the Lambda Function URL
// request body, avoiding the 6 MiB sync invoke limit.
//
// ── ONE SCRIPT, FOUR ROLES ───────────────────────────────────────────────────
// The role is decided by WHICH address the message was delivered to, not by its
// content:
//   quotes@bcatcorp.com          -> QUOTE
//   tenders@bcatcorp.com         -> TENDER
//   carrierinvoices@bcatcorp.com -> AP
//   trucks@bcatcorp.com          -> CAPACITY
// Each address is overridable by a script property (AGENT_INBOX_QUOTE,
// AGENT_INBOX_TENDER, AGENT_INBOX_AP, AGENT_INBOX_CAPACITY) because the Google
// Groups may end up named differently. Set a property to an empty string and
// that role is skipped entirely: it is never searched for and never posted, so
// the bridge runs correctly with one, some or all four provisioned.
//
// ── NO URL IN THIS FILE, DELIBERATELY ────────────────────────────────────────
// Unlike vendorApEmailBridge.gs there is no hard-coded fallback URL here. Step K
// is dev-only and the workflow-agent Function URL is a deploy output that changes
// with the sandbox/dev stack, so baking one in would mean posting invoices at a
// URL that no longer exists. WORKFLOW_AGENT_URL must be set as a script property;
// without it setup and every run throw a setup error instead of guessing.
//
// ── INSTALL (a human has to do this once) ────────────────────────────────────
//  1. Open the Apps Script project that already hosts vendorApEmailBridge.gs and
//     loadsEmailBridge.gs — it is owned by the account that RECEIVES the group
//     forwards, so GmailApp.search() can see the mail. Do NOT create a new
//     project: this file is additive and reuses the project's WEBHOOK_SECRET.
//  2. Paste this whole file in as a new script file (agentEmailBridge.gs).
//  3. Project Settings -> Script properties, add:
//       WORKFLOW_AGENT_URL    = the workflow-agent Lambda Function URL from the
//                               dev stack outputs. Required.
//       WORKFLOW_AGENT_SECRET = the INTAKE_WEBHOOK_SECRET value (optional — omit
//                               it and the project's existing WEBHOOK_SECRET
//                               constant is used instead).
//       AGENT_INBOX_QUOTE / AGENT_INBOX_TENDER / AGENT_INBOX_AP /
//       AGENT_INBOX_CAPACITY  = optional address overrides; empty string means
//                               that inbox does not exist yet.
//  4. Run setupAgentEmailBridge() once. It validates the config, creates the
//     'agent-inbox-needs-review' label, and installs exactly one every-5-minutes
//     trigger for processAgentInboxEmails. It touches no other trigger, so the
//     factoring, loads and vendor-AP bridges keep running.
//
// Dedup is per-Gmail-message-id in PropertiesService (namespaced 'agentinbox:'),
// so a new message landing in an already-seen thread is still processed.

const AGENT_INBOX_ROLES = [
  { role: 'QUOTE', property: 'AGENT_INBOX_QUOTE', defaultEmail: 'quotes@bcatcorp.com' },
  { role: 'TENDER', property: 'AGENT_INBOX_TENDER', defaultEmail: 'tenders@bcatcorp.com' },
  { role: 'AP', property: 'AGENT_INBOX_AP', defaultEmail: 'carrierinvoices@bcatcorp.com' },
  { role: 'CAPACITY', property: 'AGENT_INBOX_CAPACITY', defaultEmail: 'trucks@bcatcorp.com' },
];

const AGENT_NEEDS_REVIEW_LABEL = 'agent-inbox-needs-review';
const AGENT_PROCESS_FN = 'processAgentInboxEmails';
const AGENT_PROP_NS = 'agentinbox:msg:';
const AGENT_CURSOR_PROP = 'agentinbox:cursor';
const AGENT_PAGE_SIZE = 25;
const AGENT_MAX_RUNTIME_MS = 5 * 60 * 1000 - 30000; // 30 s headroom
const AGENT_MAX_BODY_CHARS = 50000;
const AGENT_BODY_TRUNCATION_INDICATOR = '\n\n[truncated]';
// The agent caps the stored verdict at 1000 characters; cap it here so what the two
// phases post is identical to what gets stored.
const AGENT_MAX_AUTH_RESULT_CHARS = 1000;
// The agent's own limits, enforced here so an oversized attachment is skipped at
// the source instead of being uploaded and then rejected at commit.
const AGENT_MAX_ATTACHMENTS = 3;
const AGENT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const AGENT_ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];

/**
 * Run once after pasting into the project. Validates config, creates the review
 * label, and installs exactly one every-5-minutes trigger. Does not touch other
 * triggers or existing bridges.
 */
function setupAgentEmailBridge() {
  const cfg = agentGetConfig_();
  if (!cfg.url) throw new Error('Set script property WORKFLOW_AGENT_URL to the workflow-agent Function URL (a deploy output; none ships in this file)');
  if (!cfg.secret) throw new Error('Set script property WORKFLOW_AGENT_SECRET or define WEBHOOK_SECRET constant');
  if (!cfg.inboxes.length) throw new Error('No agent inbox configured: set at least one of AGENT_INBOX_QUOTE, AGENT_INBOX_TENDER, AGENT_INBOX_AP, AGENT_INBOX_CAPACITY');

  GmailApp.getUserLabelByName(AGENT_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(AGENT_NEEDS_REVIEW_LABEL);

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === AGENT_PROCESS_FN;
  });
  if (!hasTrigger) {
    ScriptApp.newTrigger(AGENT_PROCESS_FN).timeBased().everyMinutes(5).create();
  }

  console.log('Agent email bridge setup complete for', cfg.inboxes.map(function (i) {
    return i.role + '=' + i.email;
  }).join(', '));
}

/**
 * Main trigger handler. One invocation at a time (ScriptLock). Processes
 * sequential newest pages while they contain newly-arrived matching messages,
 * then resumes the durable older-page cursor.
 */
function processAgentInboxEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('[AgentInbox] another instance is running; skipping');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  let cursor = agentParseCursor_(props.getProperty(AGENT_CURSOR_PROP));
  let mainError = null;

  try {
    const cfg = agentGetConfig_();
    if (!cfg.url) {
      throw new Error('[AgentInbox] WORKFLOW_AGENT_URL script property required (dev deploy output; no default ships in this file)');
    }
    if (!cfg.secret) {
      throw new Error('[AgentInbox] WORKFLOW_AGENT_SECRET script property or WEBHOOK_SECRET constant required');
    }
    if (!cfg.inboxes.length) {
      throw new Error('[AgentInbox] no inbox address configured; set at least one AGENT_INBOX_* property');
    }

    const startTime = Date.now();
    const PAGE_SIZE = AGENT_PAGE_SIZE;

    let headStart = 0;
    let lastHeadStart = 0;
    let lastHeadNewMatches = 0;
    let lastHeadComplete = true;

    do {
      lastHeadStart = headStart;
      const page = agentProcessThreadPage_(headStart, PAGE_SIZE, cfg, props, startTime);
      lastHeadNewMatches = page.newMatches;
      lastHeadComplete = page.complete;
      headStart += PAGE_SIZE;
    } while (lastHeadNewMatches > 0 && lastHeadComplete);

    if (cursor === 0) {
      cursor = lastHeadComplete ? headStart : lastHeadStart;
    }

    if (cursor > 0) {
      const older = agentProcessThreadPage_(cursor, PAGE_SIZE, cfg, props, startTime);
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
    console.error('[AgentInbox] run failed:', e);
  }

  let cursorSaveError = null;
  try {
    props.setProperty(AGENT_CURSOR_PROP, String(cursor));
  } catch (e) {
    cursorSaveError = e;
    console.error('[AgentInbox] failed to save cursor:', e);
  } finally {
    lock.releaseLock();
  }

  if (mainError) throw mainError;
  if (cursorSaveError) throw cursorSaveError;
}

// ── Config ──────────────────────────────────────────────────────────────────

function agentGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: (props.getProperty('WORKFLOW_AGENT_URL') || '').trim(),
    secret: props.getProperty('WORKFLOW_AGENT_SECRET') || agentGlobalSecret_(),
    inboxes: agentConfiguredInboxes_(props),
  };
}

/**
 * The inboxes that actually exist, in role order. A property that is present but
 * empty removes that role: Ryne may only have provisioned one group, and a
 * search for an address that does not exist would match nothing useful while
 * still costing a Gmail query clause.
 */
function agentConfiguredInboxes_(props) {
  const out = [];
  for (let i = 0; i < AGENT_INBOX_ROLES.length; i++) {
    const def = AGENT_INBOX_ROLES[i];
    const override = props.getProperty(def.property);
    const raw = override === null || override === undefined ? def.defaultEmail : override;
    const email = String(raw).trim().toLowerCase();
    if (!email) continue;
    out.push({ role: def.role, email: email });
  }
  return out;
}

function agentGlobalSecret_() {
  // Pick up the shared secret constant from the existing BCAT Intake Bridge
  // project without redeclaring it (which would cause a duplicate const error).
  return typeof WEBHOOK_SECRET !== 'undefined' ? WEBHOOK_SECRET : '';
}

// ── Gmail search & pagination ───────────────────────────────────────────────

function agentBuildGmailQuery_(inboxes) {
  // Explicit operators cover To/Cc/Delivered-To/List-ID; the quoted address
  // fallback catches X-Original-To and any other indexed header. Never uses
  // is:unread / is:unseen so archived/read mail is included. The whole OR set is
  // parenthesised because with several addresses the trailing -in:trash would
  // otherwise bind to the last clause only.
  const clauses = [];
  for (let i = 0; i < inboxes.length; i++) {
    const email = inboxes[i].email;
    const listId = email.replace('@', '.');
    clauses.push('to:' + email);
    clauses.push('cc:' + email);
    clauses.push('deliveredto:' + email);
    clauses.push('list:' + listId);
    clauses.push('"' + email + '"');
  }
  return '(' + clauses.join(' OR ') + ') -in:trash -in:spam';
}

function agentProcessThreadPage_(start, max, cfg, props, startTime) {
  const threads = GmailApp.search(agentBuildGmailQuery_(cfg.inboxes), start, max);
  let processedCount = 0;
  let newMatches = 0;
  let retryCount = 0;
  let complete = true;

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (Date.now() - startTime > AGENT_MAX_RUNTIME_MS) {
        console.log('[AgentInbox] approaching 6-minute deadline, pausing');
        complete = false;
        break;
      }

      const msgId = messages[j].getId();
      const ackKey = AGENT_PROP_NS + msgId;
      const alreadyAcked = props.getProperty(ackKey);
      const role = agentRoleFor_(messages[j], cfg.inboxes);

      if (!alreadyAcked && role) newMatches++;
      if (alreadyAcked) {
        processedCount++;
        continue;
      }
      if (!role) continue;

      const result = agentProcessMessageInternal_(messages[j], cfg, props, msgId, role);
      if (result === 'processed') processedCount++;
      else if (result === 'retry') retryCount++;
    }
    if (!complete) break;
  }

  if (retryCount > 0) {
    throw new Error('[AgentInbox] ' + retryCount + ' webhook failure(s); will retry');
  }

  return { threadCount: threads.length, processedCount: processedCount, newMatches: newMatches, complete: complete };
}

// ── Per-message processing ──────────────────────────────────────────────────

function agentProcessMessage_(message, cfg, props) {
  const msgId = message.getId();
  const ackKey = AGENT_PROP_NS + msgId;

  if (props.getProperty(ackKey)) return 'processed';
  const role = agentRoleFor_(message, cfg.inboxes);
  if (!role) return 'skip';

  return agentProcessMessageInternal_(message, cfg, props, msgId, role);
}

function agentProcessMessageInternal_(message, cfg, props, msgId, role) {
  const selection = agentSelectAttachments_(message);
  if (selection.skipped.length > 0) {
    // Never a silent drop: the thread is labelled and every skipped file is named
    // in the log, so a human can forward the one the agent could not read.
    agentReportSkippedAttachments_(message, msgId, selection.skipped);
  }

  const preparePayload = agentBuildPreparePayload_(message, cfg, role, selection.accepted);

  const prepareRes = agentPost_(cfg.url, preparePayload);
  const prepareCode = prepareRes.getResponseCode();
  const prepareBody = prepareRes.getContentText();

  if (prepareCode === 200) {
    let parsed;
    try { parsed = JSON.parse(prepareBody); } catch (e) { parsed = {}; }
    if (parsed && parsed.ok === true) {
      if (parsed.duplicate === true) {
        if (agentPersistAck_(props, AGENT_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
          console.log('[AgentInbox] duplicate, skipping', msgId);
          return 'processed';
        }
        return 'retry';
      }

      const uploadUrls = parsed.uploadUrls || [];
      const attachments = selection.accepted;
      if (uploadUrls.length !== attachments.length) {
        console.error('[AgentInbox] upload URL count mismatch for', msgId,
          'expected', attachments.length, 'got', uploadUrls.length);
        return 'retry';
      }

      const committedAttachments = [];
      for (let i = 0; i < uploadUrls.length; i++) {
        const entry = uploadUrls[i];
        const att = attachments[i];
        const uploadResult = agentUploadAttachment_(entry, att);
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
        role: role,
        messageId: msgId,
        subject: preparePayload.subject,
        fromEmail: preparePayload.fromEmail,
        fromName: preparePayload.fromName,
        receivedAt: preparePayload.receivedAt,
        bodyText: preparePayload.bodyText,
        // Read once in the prepare payload and reused here: the two phases must agree,
        // and re-reading the raw message would be a second Gmail call per commit.
        authResult: preparePayload.authResult,
        attachments: committedAttachments,
      };

      const commitRes = agentPost_(cfg.url, commitPayload);
      const commitCode = commitRes.getResponseCode();
      const commitBody = commitRes.getContentText();

      if (commitCode === 200) {
        let cParsed;
        try { cParsed = JSON.parse(commitBody); } catch (e) { cParsed = {}; }
        if (cParsed && cParsed.ok === true) {
          if (agentPersistAck_(props, AGENT_PROP_NS + msgId, 'ok:' + new Date().toISOString())) {
            console.log('[AgentInbox] committed', role, msgId);
            return 'processed';
          }
          return 'retry';
        }
      }

      if (commitCode === 422 || commitCode === 400) {
        agentApplyNeedsReviewLabel_(message);
        if (agentPersistAck_(props, AGENT_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
          console.log('[AgentInbox] commit rejected, labeled for review', msgId);
          return 'processed';
        }
        return 'retry';
      }

      console.error('[AgentInbox] commit failed for', msgId, 'code', commitCode, commitBody);
      return 'retry';
    }
  }

  if (prepareCode === 422 || prepareCode === 400) {
    agentApplyNeedsReviewLabel_(message);
    if (agentPersistAck_(props, AGENT_PROP_NS + msgId, 'reviewed:' + new Date().toISOString())) {
      console.log('[AgentInbox] prepare rejected, labeled for review', msgId);
      return 'processed';
    }
    return 'retry';
  }

  console.error('[AgentInbox] prepare failed for', msgId, 'code', prepareCode, prepareBody);
  return 'retry';
}

function agentBuildPreparePayload_(message, cfg, role, attachments) {
  const rawSubject = (message.getSubject() || '').trim();
  const subject = rawSubject || 'no subject';
  const from = agentSplitFrom_(message.getFrom() || '');
  const receivedAt = message.getDate().toISOString();

  const plainBody = message.getPlainBody() || '';
  let bodyText = plainBody;
  if (plainBody.length > AGENT_MAX_BODY_CHARS) {
    const limit = AGENT_MAX_BODY_CHARS - AGENT_BODY_TRUNCATION_INDICATOR.length;
    bodyText = plainBody.slice(0, Math.max(0, limit)) + AGENT_BODY_TRUNCATION_INDICATOR;
  }

  const attachmentMeta = attachments.map(function (att) {
    return {
      name: att.getName() || 'attachment',
      contentType: agentNormalizeType_(att.getContentType()),
      size: att.getSize(),
    };
  });

  return {
    secret: cfg.secret,
    action: 'prepare',
    role: role,
    messageId: message.getId(),
    subject: subject,
    fromEmail: from.email,
    fromName: from.name,
    receivedAt: receivedAt,
    bodyText: bodyText,
    authResult: agentAuthResult_(message),
    attachments: attachmentMeta,
  };
}

/**
 * The receiving server's own `Authentication-Results` verdict (SPF/DKIM/DMARC), raw.
 *
 * A From header is whatever the sender typed, and an exact-address match is the one
 * rule in the agent that establishes identity, so the verdict has to travel with the
 * message. The agent grades it; this function never interprets it.
 *
 * GmailMessage has no getHeader(), so the header block of getRawContent() is the only
 * place to read it from. The FIRST such header is the one this mail server added —
 * a sender can add their own, but theirs land below it. Continuation lines (a leading
 * space or tab) are part of the same header and are folded back in.
 *
 * Fetching the raw message costs a Gmail call and can fail; a failure here must never
 * stop a message being forwarded, so it degrades to '' — which the agent reads as
 * "no verdict available", exactly like a message that carried none.
 */
function agentAuthResult_(message) {
  try {
    const raw = message.getRawContent ? (message.getRawContent() || '') : '';
    if (!raw) return '';
    // Headers end at the first blank line; the body below it can contain anything,
    // including a forwarded message with a verdict of its own. Sliced rather than
    // split: the raw MIME carries every attachment base64-encoded, so splitting the
    // whole thing would allocate megabytes to read a few hundred bytes of header.
    const blank = raw.search(/\r?\n\r?\n/);
    const headerBlock = blank === -1 ? raw : raw.slice(0, blank);
    const lines = headerBlock.split(/\r?\n/);
    let value = '';
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^Authentication-Results:\s*(.*)$/i);
      if (!match) continue;
      value = match[1];
      for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j++) {
        value += ' ' + lines[j].trim();
      }
      break;
    }
    return value.trim().slice(0, AGENT_MAX_AUTH_RESULT_CHARS);
  } catch (e) {
    console.warn('[AgentInbox] could not read Authentication-Results for', message.getId(), e);
    return '';
  }
}

/**
 * `"Dispatch Team" <ops@carrier.com>` -> the two fields the agent stores
 * separately: the address drives party matching, the display name is only a
 * weak name candidate.
 */
function agentSplitFrom_(raw) {
  const header = String(raw).trim();
  const angled = header.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { email: angled[2].trim(), name: name };
  }
  return { email: header, name: '' };
}

function agentNormalizeType_(raw) {
  // Gmail hands back `application/pdf; name="x.pdf"` often enough that the
  // parameters have to come off: the Lambda compares the committed content type
  // against the one S3 recorded for the PUT.
  const type = String(raw || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';
  return type || 'application/octet-stream';
}

/**
 * PDF and PNG/JPEG only, at most AGENT_MAX_ATTACHMENTS of them, at most
 * AGENT_MAX_ATTACHMENT_BYTES each — the agent's own limits. Everything else is
 * returned in `skipped` with the reason, never dropped quietly.
 */
function agentSelectAttachments_(message) {
  // Real attachments only: inline images (signatures, logos) are excluded by Gmail here,
  // because GmailAttachment has no content-disposition accessor to check afterwards.
  const raw = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  const accepted = [];
  const skipped = [];

  for (let i = 0; i < raw.length; i++) {
    const att = raw[i];
    if (!att) continue;
    const size = att.getSize();
    if (!size || size <= 0) continue;

    const name = att.getName() || 'attachment';
    const type = agentNormalizeType_(att.getContentType());

    if (AGENT_ALLOWED_TYPES.indexOf(type) === -1) {
      skipped.push({ name: name, reason: 'unsupported type ' + type + ' (PDF, PNG and JPEG only)' });
      continue;
    }
    if (size > AGENT_MAX_ATTACHMENT_BYTES) {
      skipped.push({ name: name, reason: 'over the ' + (AGENT_MAX_ATTACHMENT_BYTES / (1024 * 1024)) + ' MB limit (' + size + ' bytes)' });
      continue;
    }
    if (accepted.length >= AGENT_MAX_ATTACHMENTS) {
      skipped.push({ name: name, reason: 'over the ' + AGENT_MAX_ATTACHMENTS + '-attachment limit' });
      continue;
    }
    accepted.push(att);
  }

  return { accepted: accepted, skipped: skipped };
}

function agentReportSkippedAttachments_(message, msgId, skipped) {
  const named = skipped.map(function (s) { return s.name + ' (' + s.reason + ')'; }).join('; ');
  console.warn('[AgentInbox] attachment(s) skipped for', msgId, '-', named);
  agentApplyNeedsReviewLabel_(message);
}

function agentUploadAttachment_(entry, attachment) {
  const blob = attachment.copyBlob();
  const res = UrlFetchApp.fetch(entry.url, {
    method: 'put',
    contentType: entry.contentType,
    payload: blob,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true };
  console.error('[AgentInbox] attachment upload failed', code, res.getContentText());
  return { ok: false };
}

function agentPost_(url, payload) {
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// ── Role resolution ─────────────────────────────────────────────────────────

/**
 * Which desk this message belongs to, or null when it is not for any configured
 * inbox. Table order decides when a message was sent to two of them at once —
 * one message becomes exactly one run.
 */
function agentRoleFor_(message, inboxes) {
  const emailHeaders = [
    message.getTo(),
    message.getCc(),
    message.getHeader('Delivered-To'),
    message.getHeader('X-Original-To'),
  ];
  const listId = message.getHeader('List-ID');

  for (let i = 0; i < inboxes.length; i++) {
    const email = inboxes[i].email;
    for (let j = 0; j < emailHeaders.length; j++) {
      if (agentHeaderContainsEmail_(emailHeaders[j], email)) return inboxes[i].role;
    }
    if (listId && agentHeaderContainsListId_(listId, email)) return inboxes[i].role;
  }

  return null;
}

function agentHeaderContainsEmail_(headerValue, email) {
  if (!headerValue) return false;
  const target = email.toLowerCase();
  const addrs = agentExtractAddresses_(String(headerValue));
  for (let i = 0; i < addrs.length; i++) {
    if (addrs[i].toLowerCase() === target) return true;
  }
  return false;
}

function agentExtractAddresses_(headerValue) {
  const matches = headerValue.match(/<([^>]+)>|[^\s,<>]+@[^\s,<>]+/g) || [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    out.push(matches[i].replace(/^</, '').replace(/>$/, '').trim());
  }
  return out;
}

function agentHeaderContainsListId_(headerValue, email) {
  const expectedIds = [email.toLowerCase(), email.toLowerCase().replace('@', '.')];
  const ids = String(headerValue).toLowerCase().match(/<([^>]+)>/g) || [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i].replace(/[<>]/g, '').trim();
    if (expectedIds.indexOf(id) !== -1) return true;
  }
  return false;
}

function agentApplyNeedsReviewLabel_(message) {
  const label = GmailApp.getUserLabelByName(AGENT_NEEDS_REVIEW_LABEL)
    || GmailApp.createLabel(AGENT_NEEDS_REVIEW_LABEL);
  message.getThread().addLabel(label);
}

// ── Properties helpers ───────────────────────────────────────────────────────

function agentPersistAck_(props, key, value) {
  try {
    props.setProperty(key, value);
    return true;
  } catch (e) {
    console.error('[AgentInbox] PropertiesService set failed for', key, ':', e);
    return false;
  }
}

function agentParseCursor_(raw) {
  const n = parseInt(raw || '0', 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
