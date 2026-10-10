#!/usr/bin/env node
/**
 * One-time (and safely re-runnable) setup for the Dispatch page's Twilio number.
 *
 *   node scripts/dispatchTwilioSetup.mjs [--number +12242221305] [--webhook https://…lambda-url…] \
 *        [--pool us-east-1_IbPKPNJC9] [--messaging-service MG…] [--auth-token]
 *
 * What it does, in order, skipping anything already done:
 *   1. Reads the Twilio API key from the charles-outreach-engine Railway project (the
 *      working copy of the key; the SSM copy under /outreach-engine is stale) unless
 *      TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET are in the env.
 *   2. Stores them under SSM /bcat/dispatch/<pool>/ where the two dispatch Lambdas read.
 *   3. Buys the number (default: the first SMS+voice+MMS number in the Elk Grove rate
 *      center) unless the account already owns one named "BCAT Ops Dispatch".
 *   4. Adds it to the Messaging Service that carries the verified 10DLC campaign.
 *   5. Points the number's SMS and voice webhooks at the deployed Lambda URL, found
 *      from the CloudFormation outputs when --webhook is not given.
 *   6. Stores DISPATCH_NUMBER and a WEBHOOK_SECRET (kept if one exists) in SSM.
 *
 * Nothing here prints a credential.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
  return acc
}, []))

const POOL = args.pool ?? 'us-east-1_IbPKPNJC9'
const PARAM_PATH = `/bcat/dispatch/${POOL}`
const MESSAGING_SERVICE = args['messaging-service'] ?? 'MG5a211ecd4944170ffb98c45c777310ea'   // "Mixed A2P" service, campaign QE2c68… VERIFIED
const FRIENDLY = 'BCAT Ops Dispatch'
const APP_STACK_PREFIX = 'amplify-d3dejqzs77khq6-main-'

const aws = (...a) => execFileSync('aws', a, { encoding: 'utf8' })
const log = (m) => console.log(`• ${m}`)

// ── 1. credentials ──────────────────────────────────────────────────────────
function loadCreds() {
  const env = process.env
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return { sid: env.TWILIO_ACCOUNT_SID, key: env.TWILIO_API_KEY_SID, secret: env.TWILIO_API_KEY_SECRET, authToken: env.TWILIO_AUTH_TOKEN ?? '' }
  }
  const raw = execFileSync('railway', ['variables', '--json'], { cwd: `${process.env.HOME}/outreach-engine`, encoding: 'utf8' })
  const v = JSON.parse(raw)
  if (!v.TWILIO_ACCOUNT_SID || !v.TWILIO_API_KEY_SID || !v.TWILIO_API_KEY_SECRET) throw new Error('Railway project has no TWILIO_* variables')
  return { sid: v.TWILIO_ACCOUNT_SID, key: v.TWILIO_API_KEY_SID, secret: v.TWILIO_API_KEY_SECRET, authToken: v.TWILIO_AUTH_TOKEN ?? '' }
}
const creds = loadCreds()
const auth = 'Basic ' + Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
async function tw(method, url, form) {
  const res = await fetch(url, { method, headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url.replace(/\?.*/, '')} → ${res.status} ${json.message ?? ''}`)
  return json
}
const API = `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}`

// ── 2. SSM creds ────────────────────────────────────────────────────────────
function putParam(name, value, secure = true) {
  aws('ssm', 'put-parameter', '--name', `${PARAM_PATH}/${name}`, '--type', secure ? 'SecureString' : 'String', '--overwrite', '--value', value)
}
function getParam(name) {
  try { return aws('ssm', 'get-parameter', '--name', `${PARAM_PATH}/${name}`, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text').trim() } catch { return '' }
}

async function main() {
  const owned = (await tw('GET', `${API}/IncomingPhoneNumbers.json?PageSize=100`)).incoming_phone_numbers
  log(`Twilio key works; account owns ${owned.length} numbers`)

  putParam('TWILIO_ACCOUNT_SID', creds.sid)
  putParam('TWILIO_API_KEY_SID', creds.key)
  putParam('TWILIO_API_KEY_SECRET', creds.secret)
  putParam('TWILIO_MESSAGING_SERVICE_SID', MESSAGING_SERVICE, false)
  if (args['auth-token'] && creds.authToken) putParam('TWILIO_AUTH_TOKEN', creds.authToken)
  log(`Stored Twilio credentials under ${PARAM_PATH}/`)

  // ── 3. the number ───────────────────────────────────────────────────────
  let number = owned.find((n) => n.friendly_name === FRIENDLY) ?? (args.number ? owned.find((n) => n.phone_number === args.number) : null)
  if (number) {
    log(`Already own ${number.phone_number} (${number.friendly_name})`)
  } else {
    let candidates = []
    if (args.number) candidates = [args.number]
    else {
      const avail = await tw('GET', `${API}/AvailablePhoneNumbers/US/Local.json?InLocality=Elk%20Grove&InRegion=IL&SmsEnabled=true&VoiceEnabled=true&MmsEnabled=true&PageSize=10`)
      candidates = avail.available_phone_numbers.map((n) => n.phone_number)
      if (candidates.length === 0) {
        const fallback = await tw('GET', `${API}/AvailablePhoneNumbers/US/Local.json?AreaCode=224&SmsEnabled=true&VoiceEnabled=true&MmsEnabled=true&PageSize=10`)
        candidates = fallback.available_phone_numbers.map((n) => n.phone_number)
      }
    }
    if (candidates.length === 0) throw new Error('No numbers available near Elk Grove right now')
    for (const pn of candidates) {
      try {
        number = await tw('POST', `${API}/IncomingPhoneNumbers.json`, { PhoneNumber: pn, FriendlyName: FRIENDLY })
        log(`Bought ${number.phone_number}`)
        break
      } catch (err) {
        console.warn(`  could not buy ${pn}: ${err.message}`)
      }
    }
    if (!number) throw new Error('Every candidate number was taken; run again')
  }

  // ── 4. messaging service / 10DLC campaign ───────────────────────────────
  const inService = (await tw('GET', `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE}/PhoneNumbers?PageSize=100`)).phone_numbers.some((p) => p.sid === number.sid)
  if (inService) log(`${number.phone_number} is already in messaging service ${MESSAGING_SERVICE}`)
  else {
    await tw('POST', `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE}/PhoneNumbers`, { PhoneNumberSid: number.sid })
    log(`Added ${number.phone_number} to messaging service ${MESSAGING_SERVICE} (10DLC campaign)`)
  }
  const campaigns = (await tw('GET', `https://messaging.twilio.com/v1/Services/${MESSAGING_SERVICE}/Compliance/Usa2p`)).compliance ?? []
  for (const c of campaigns) log(`Campaign ${c.sid}: ${c.campaign_status} (${c.us_app_to_person_usecase})`)

  // ── 5. webhooks ─────────────────────────────────────────────────────────
  let webhook = args.webhook
  if (!webhook) {
    const stacks = JSON.parse(aws('cloudformation', 'describe-stacks', '--query', `Stacks[?starts_with(StackName, '${APP_STACK_PREFIX}')].Outputs[]`, '--output', 'json'))
    webhook = stacks.find((o) => o?.OutputKey === 'DispatchTwilioWebhookFunctionUrl')?.OutputValue
    if (!webhook) throw new Error('Could not find DispatchTwilioWebhookFunctionUrl in CloudFormation outputs; is the deploy finished? Pass --webhook <url>.')
  }
  webhook = webhook.replace(/\/+$/, '')
  const secret = getParam('WEBHOOK_SECRET') || randomBytes(24).toString('base64url')
  const q = `?t=${encodeURIComponent(secret)}`
  await tw('POST', `${API}/IncomingPhoneNumbers/${number.sid}.json`, {
    FriendlyName: FRIENDLY,
    SmsUrl: `${webhook}/sms${q}`, SmsMethod: 'POST',
    VoiceUrl: `${webhook}/voice${q}`, VoiceMethod: 'POST',
    StatusCallback: `${webhook}/status${q}`, StatusCallbackMethod: 'POST',
  })
  log(`Webhooks on ${number.phone_number} → ${webhook}/{sms,voice,status}`)

  // ── 6. the rest of the config ───────────────────────────────────────────
  putParam('DISPATCH_NUMBER', number.phone_number, false)
  putParam('WEBHOOK_SECRET', secret)
  log(`Stored DISPATCH_NUMBER and WEBHOOK_SECRET`)

  console.log(`\nDone. Dispatch number: ${number.phone_number}. Open https://ops.bcatcorp.com/dispatch and text it from a driver's phone.`)
}

main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1) })
