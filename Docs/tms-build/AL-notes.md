# Step AL — Carrier Sales inbound offers hub: runbook

Dev branch only; nothing here is deployed by a builder. Plan: `AL-plan.md`. Harness: `scripts/devVerifyAL.mjs` (runs only after the AL deploy).

## 1. How offers arrive (three doors, one pipeline)

| Door | What | Where |
|---|---|---|
| Mailbox poll | `tms-spot-quoter` `{poll:true}` event (rule `SpotQuoterPollRule`, every 5 min; auto-DISABLED on dev) runs `pollCarrierInbox` first (90 s budget), then the reps' Gmail quote inboxes. | `tms-spot-quoter/carrierInbox/poll.ts` |
| Manual poll / sim | AppSync `tmsSpotActions` `CS_POLL_NOW` (≤ 20 s slice, the UI loops until `done`); dev only `CS_SIM_INJECT_MAIL`, `CS_SIM_INJECT_CALL`. | `carrierInbox/actions.ts` |
| Voice webhook | Lambda Function URL on the spot Lambda, `POST <url>/carrier-call`. | `carrierInbox/voice.ts` |

Mail is read in stages: stage 1 headers only (addressed to a configured distribution address or carrying the Gmail label; bulk/list/auto-submitted/no-reply/own-mail dropped; board-relay domains kept), stage 2 body score (price signal plus a reference/MC/lane, or a reference plus a carrier cue), stage 3 one model call. Only offer, interest and withdrawal mail is stored; everything else is counted in the run digest and dropped. Filing is serial and in order through `tms-shipment-actions` `FILE_INBOUND_OFFER` (system caller `carrier-inbox` only, idempotent on `msg:cs:<sha1 of Message-ID | CallSid>`).

The mailbox is **read-only** (`gmail.readonly`, no send/draft/modify method exists on `GmailPort`). Counter-offers go out through the existing `COUNTER_OFFER` (SES, app address), never from the mailbox.

## 2. Matching and thresholds

Defaults (`src/lib/carrierInbox/settings.ts`, floors enforced server-side): auto-file score 0.85 (floor 0.80), suggestion score 0.50 (floor 0.30, at least 0.10 below auto), unmatched retention 30 days (7–90), 100 messages per run (≤ 300), 300 model calls per day (≤ 2 000; 0 = classify nothing), look-back 24 h on the first poll or after a reconnect.

Exact load reference in the subject 0.90, in the body 0.85, DAT/Truckstop posting reference 0.85, plus-address / reply-thread 0.95; lane + date alone is capped at 0.80 and **never auto-files**. `medium` extraction confidence caps at 0.84, `low` at 0.49. Outcomes: `FILED` (a BUY `Quote`, `offerSource` EMAIL / PHONE / BOARD), `THREAD_ONLY` (interest or withdrawal), `COVERED_LATE` (load already covered: message on the thread, no Quote), `SUGGESTED` / `UNMATCHED` (Unmatched bucket), `DUPLICATE`. Nothing auto-accepts, auto-counters or auto-rejects: a filed offer is a row a rep still acts on.

## 3. Unmatched bucket and retention

Unmatched rows are `ShipmentMessage` rows with `shipmentId = 'UNMATCHED'` and `ttlEpoch` = receipt + retention (default **30 days**; DynamoDB TTL on `ttlEpoch` of `ShipmentMessage`, in `backend.ts`). A rep assigns (`ASSIGN_INBOUND_OFFER`: row re-parented, `ttlEpoch` removed, Quote created under the rep's identity) or dismisses (`DISMISS_INBOUND_OFFER`: conditional delete, audit row has the id and reason, no content). Matched thread rows are permanent (part of the load record). Attachment bytes are never stored.

## 4. Connecting Gmail (`ai4bcat@gmail.com`)

1. Settings › Integrations › Google: enter the Google OAuth client (shared with the spot quoter). Until then `CS_STATUS.gmailProvider.mode` is `STUB` and Connect answers `NOT_CONFIGURED`.
2. Settings › Carrier Sales: add a mailbox (label, Google account `ai4bcat@gmail.com`, the distribution address, e.g. `loads@…`, and optionally a Gmail label when a forward/Group rewrites the headers), **Save**, then **Connect** and consent (`gmail.readonly` only, the callback is the one SPA path `/tms/rates/spot/callback`, state prefix `cs.<mailboxId>.`). The consent must be by `ai4bcat@gmail.com` itself: a different signed-in Google account is refused and nothing is written. The refresh token lands in SSM `/bcat/gmail/<pool>/users/cs-<mailboxId>` written by the app's own flow.
3. Switch **Listen for carrier offers** on and Save. A production deploy reads nothing until an admin does this.
4. **Consumer Gmail caveat:** `ai4bcat@gmail.com` is a consumer account, so the Google app is External. While the app is in **Testing** mode Google expires the refresh token after **7 days**: the mailbox goes `NEEDS_RECONNECT`, the Offers header and Settings page say "Mailbox needs reconnecting — offers by e-mail are not arriving", and the digest keeps the date of the last good poll. Reconnect (one click) or publish the Google app (a console action, not code). The AP inbox (AG) uses its own consent for the same account.

## 5. Voice webhook (Cowtown "Aiden" agent)

URL: the stack output **`CarrierCallFunctionUrl`** (the spot Lambda's Function URL, `authType NONE`; auth is the body secret). The Settings page shows the exact `…/carrier-call` URL after the first request. Secret: Settings › Carrier Sales › Voice agent › **Create / Rotate secret** (`CS_VOICE_ROTATE_SECRET`): 32 random bytes, shown **once**, stored as SHA-256 hex only (compared in constant time). Rotating invalidates the old secret at once; give the new one to whoever runs the agent, and enable **Accept calls from the voice agent**.

Contract (JSON, `content-type: application/json`, ≤ 256 KB):

```json
{ "secret": "<shown once>", "callSid": "CAxxxxxxxx", "callerNumber": "+13125550123",
  "startedAt": "2026-11-04T15:02:11Z", "endedAt": "2026-11-04T15:05:20Z", "durationSec": 189,
  "outcome": "TRANSFERRED | CALLBACK | VOICEMAIL | ABANDONED | <free text>",
  "transcript": "up to 20000 chars", "summary": "optional agent summary",
  "recordingUrl": "https://… (stored as a link, never fetched; https only)",
  "structured": { "loadId": "", "mc": "", "dot": "", "carrierName": "", "rate": 1850, "equipment": "", "origin": "", "destination": "", "pickupDate": "", "contactName": "" } }
```

Responses: `200 {ok:true, outcome}` · `200 {ok:true, duplicate:true}` (same `callSid`) · `400` invalid body · `401` wrong secret · `404` other path/method · `413` too large · `503` voice or Carrier Sales disabled, no secret created yet, or classification failed — **the agent must retry with the same `callSid`** (idempotent). `ABANDONED` calls and transcripts under 40 characters are dropped without a model call. `callSid` must match `[A-Za-z0-9_.:-]{3,80}`. A filed call becomes a `PHONE` offer plus a `VOICE` message. `structured` is passed to the model as hints; the transcript decides. Zero-infra fallback: the agent e-mails the summary to the distribution address with a `[CALL]` subject marker and the e-mail path files it as a phone offer.

The live call itself (reading the load, collecting the MC, warm transfer, voicemail hours) is the Cowtown service's logic; AL ingests only its result. The agent's blockers (OpenAI credit, Twilio A2P) are not part of this repo.

## 6. Dev proof

`node scripts/devVerifyAL.mjs --inventory` (no network), then after the deploy `node scripts/devVerifyAL.mjs` (optionally `CARRIER_CALL_URL=<function url>`). Dev uses the SIMULATED mailbox (`CS_CONNECT_SIMULATED`, S3 `spot-sim/cs-<id>/…`) and `devExtraction` in place of the model, so it is deterministic when Anthropic credit is exhausted; `AL02-model` SKIPs honestly then, `AL06-webhook` SKIPs without `CARRIER_CALL_URL`. Screenshots: `Docs/tms-build/screenshots/al/`.

## 7. Operating notes

* Kill switches: `carrierInbox.enabled`, `voice.enabled`, per-mailbox `paused`, the CAPACITY AI agent, `modelCallsPerDay`. All default off.
* A message that errors (model timeout, router failure) is not stored and holds the cursor for at most 3 runs, then is skipped and counted `abandoned`.
* `SpotSettings` row `id='carrier-sales'` holds config and state; nothing secret is in it (hashes only), so it is readable by signed-in staff by design.
* Never printed anywhere: tokens, the voice secret, mail content.
