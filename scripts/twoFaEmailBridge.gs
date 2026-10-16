// ── 2FA Email Bridge (Google Voice text forwards → Slack #2fa) ───────────────
// Additive Apps Script for the existing BCAT Intake Bridge project (the one
// that hosts loadsEmailBridge.gs etc., owned by ai4bcat@gmail.com).
//
// Google Voice, with "Forward messages to email" on, mails every text to the
// Gmail inbox as "New text message from (989) 601-2969" from
// voice-noreply@google.com. This polls for those every minute and POSTs each
// one to the twofa-intake Lambda, which posts the code to Slack.
//
// ── INSTALL (once) ───────────────────────────────────────────────────────────
//  1. Google Voice (voice.google.com, signed in as ai4bcat@gmail.com):
//     Settings → Messages → "Forward messages to email" ON.
//  2. Paste this file into the Intake Bridge Apps Script project.
//  3. Project Settings → Script properties:
//       TWOFA_WEBHOOK_URL = the twofa-intake Function URL (see the Amplify
//                           stack output TwofaIntakeFunctionUrl, or
//                           aws lambda get-function-url-config --function-name <twofa-intake fn>)
//     (or run setTwoFaWebhookUrl() below). The shared WEBHOOK_SECRET constant
//     of the project is used as the secret.
//  4. Run setupTwoFaBridge() once; authorize Gmail read + external requests.
//     It installs exactly one every-minute trigger for processTwoFaEmails.

const TWOFA_QUERY = 'from:voice-noreply@google.com subject:"New text message from" newer_than:2d';
const TWOFA_PROP_NS = 'twofa:msg:';
const TWOFA_PROCESS_FN = 'processTwoFaEmails';

function twofaConfig_() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('TWOFA_WEBHOOK_URL') || '').replace(/\/+$/, '');
  const secret = props.getProperty('TWOFA_WEBHOOK_SECRET') || (typeof WEBHOOK_SECRET === 'string' ? WEBHOOK_SECRET : '');
  return { url: url, secret: secret };
}

function setupTwoFaBridge() {
  const cfg = twofaConfig_();
  if (!cfg.url) throw new Error('Set script property TWOFA_WEBHOOK_URL');
  if (!cfg.secret) throw new Error('No WEBHOOK_SECRET available');
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === TWOFA_PROCESS_FN; });
  if (!has) ScriptApp.newTrigger(TWOFA_PROCESS_FN).timeBased().everyMinutes(1).create();
  console.log('2FA bridge ready; posting to ' + cfg.url);
}

function processTwoFaEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const cfg = twofaConfig_();
    if (!cfg.url || !cfg.secret) throw new Error('TWOFA_WEBHOOK_URL / secret missing');
    const props = PropertiesService.getScriptProperties();
    const threads = GmailApp.search(TWOFA_QUERY, 0, 20);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        const id = msg.getId();
        const key = TWOFA_PROP_NS + id;
        if (props.getProperty(key)) return;
        const payload = {
          secret: cfg.secret,
          messageId: id,
          subject: msg.getSubject(),
          body: msg.getPlainBody(),
          receivedAt: msg.getDate().toISOString(),
        };
        const res = UrlFetchApp.fetch(cfg.url, {
          method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
        });
        const code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          props.setProperty(key, new Date().toISOString());
        } else {
          console.warn('[2FA] webhook ' + code + ': ' + res.getContentText().slice(0, 200));
        }
      });
    });
  } finally {
    lock.releaseLock();
  }
}

// If the editor hides "Script properties" (Project Settings → Script Properties
// → "Edit script properties"), run this once instead, then run setupTwoFaBridge().
function setTwoFaWebhookUrl() {
  PropertiesService.getScriptProperties().setProperty(
    'TWOFA_WEBHOOK_URL',
    'https://6izy5uwx53awpbzcwnsuf2tl540pylkv.lambda-url.us-east-1.on.aws/'
  );
  console.log('TWOFA_WEBHOOK_URL saved');
}
