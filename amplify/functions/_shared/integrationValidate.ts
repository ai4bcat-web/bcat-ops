/**
 * Step J — the one read call that proves a credential.
 *
 * `VALIDATE_INTEGRATION` dispatches on the descriptor's `validateHow.liveCheck`
 * and nothing else: a provider with no live check answers SKIPPED with a reason,
 * never a cheerful OK. No new provider client is written here — the two that
 * exist (`otrClient`) are reused.
 *
 * Three rules this file exists to keep:
 *  1. Every call has a 10-second budget. A hung provider must not hold a 30-second
 *     Lambda open while an admin watches a spinner.
 *  2. Every message leaves through `redactSecrets`. A provider that echoes the key
 *     back in its error body is common enough to plan for.
 *  3. A neutered or missing credential makes NO HTTP call at all. `disabled-on-dev`
 *     is not an invalid credential, it is a credential that was deliberately taken
 *     away, and calling the provider with it would be both noise and a lie.
 */
import { OtrClient, OTR_STAGING_BASE } from './otrClient'
import { redactSecrets } from '../../../src/lib/integrations/secrets'
// `healthFrom` is the only consumer of what this returns, so its outcome type is
// the contract — duplicating it here is how the two would quietly drift apart.
export type { ValidateOutcome } from '../../../src/lib/integrations/health'
import type { ValidateOutcome } from '../../../src/lib/integrations/health'
import type { ProviderDescriptor } from '../../../src/lib/integrations/types'

const TIMEOUT_MS = 10_000

type FetchLike = typeof fetch

/** A short, redacted sentence. Provider bodies can be megabytes of HTML. */
function summarize(text: string, secrets: Array<string | null | undefined>): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const clipped = flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
  return redactSecrets(clipped, secrets)
}

interface CallResult {
  status: number
  body: string
}

/**
 * One HTTP call with a hard deadline. The AbortController is the deadline; the
 * timer is always cleared so a Lambda container is not held open by a pending one.
 */
async function call(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<CallResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    const body = await res.text()
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The same 10-second budget for a provider client that owns its own fetch and
 * cannot be handed an AbortSignal. Named AbortError so `errorOutcome` reports it
 * as a timeout, exactly as an aborted `call` does.
 */
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`No answer within ${TIMEOUT_MS / 1000}s.`)
      err.name = 'AbortError'
      reject(err)
    }, TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function missing(keys: string[]): ValidateOutcome {
  return {
    kind: 'SKIPPED',
    reason: 'NO_CREDENTIALS',
    message: `Nothing to check yet: ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} not set.`,
  }
}

const NEUTERED: ValidateOutcome = {
  kind: 'SKIPPED',
  reason: 'NEUTERED_ON_DEV',
  message: 'Live on main — the secret is pinned to disabled-on-dev on this stack, so nothing was called.',
}

const NO_ENDPOINT: ValidateOutcome = {
  kind: 'SKIPPED',
  reason: 'NO_VALIDATE_ENDPOINT',
  message: 'This provider has no read call to prove a credential with.',
}

/** The dev stack pins side-effecting secrets to this literal (backend.ts). */
function neutered(value: string | null | undefined): boolean {
  return value === 'disabled-on-dev'
}

/**
 * Gather the named credentials, or say which are missing / neutered.
 *
 * Returns the values in the order asked for so a caller can destructure them.
 */
function requireCreds(
  creds: Record<string, string | null | undefined>,
  keys: string[],
): { ok: true; values: string[] } | { ok: false; outcome: ValidateOutcome } {
  const values: string[] = []
  const absent: string[] = []
  for (const key of keys) {
    const value = creds[key]
    if (neutered(value)) return { ok: false, outcome: NEUTERED }
    if (typeof value !== 'string' || !value.trim()) absent.push(key)
    else values.push(value.trim())
  }
  if (absent.length > 0) return { ok: false, outcome: missing(absent) }
  return { ok: true, values }
}

/**
 * A 2xx body is kept OUT of the outcome on purpose.
 *
 * `healthFrom` puts the message into `healthDetail` and into the events list,
 * both of which any signed-in reader of the Integration table can see. Motive's
 * `/users/me` is the account holder's name, e-mail and phone; HubSpot's contact
 * list is a real person; QBO's companyinfo is the company record. A successful
 * check needs to say "it worked", not who it worked as. A non-2xx body IS the
 * diagnostic, so that one is kept (redacted).
 */
function httpOutcome(result: CallResult, secrets: string[]): ValidateOutcome {
  if (result.status >= 200 && result.status < 300) {
    return { kind: 'HTTP', statusCode: result.status }
  }
  return {
    kind: 'HTTP',
    statusCode: result.status,
    message: summarize(result.body, secrets),
  }
}

function errorOutcome(err: unknown, secrets: string[]): ValidateOutcome {
  const name = err instanceof Error ? err.name : 'Error'
  const raw = err instanceof Error ? err.message : String(err)
  return {
    kind: 'ERROR',
    errorName: name === 'AbortError' || name === 'TimeoutError' ? 'TimeoutError' : name,
    message:
      name === 'AbortError' || name === 'TimeoutError'
        ? `No answer within ${TIMEOUT_MS / 1000}s.`
        : summarize(raw, secrets),
  }
}

/**
 * Run the descriptor's one read call.
 *
 * `creds` carries whatever the credential source yielded: the page parameter's
 * JSON, or the stack secret values under their secret names.
 */
export async function validateProvider(
  descriptor: ProviderDescriptor,
  creds: Record<string, string | null | undefined>,
  fetchImpl: FetchLike = fetch,
): Promise<ValidateOutcome> {
  const check = descriptor.validateHow.liveCheck
  if (!check) {
    if (descriptor.applicability === 'NOT_APPLICABLE') {
      return {
        kind: 'SKIPPED',
        reason: 'NOT_APPLICABLE',
        message: descriptor.notApplicableReason ?? 'Not applicable to BCAT.',
      }
    }
    return NO_ENDPOINT
  }

  try {
    switch (check) {
      case 'MOTIVE_USERS_ME': {
        const got = requireCreds(creds, ['MOTIVE_API_KEY'])
        if (!got.ok) return got.outcome
        const [key] = got.values
        return httpOutcome(
          await call(fetchImpl, 'https://api.gomotive.com/v1/users/me', {
            method: 'GET',
            headers: { 'X-API-Key': key, Accept: 'application/json' },
          }),
          [key],
        )
      }

      case 'BLUE_INK_VEHICLES': {
        const got = requireCreds(creds, ['BLUE_INK_TECH_API_KEY'])
        if (!got.ok) return got.outcome
        const [key] = got.values
        return httpOutcome(
          await call(fetchImpl, 'https://members.blueinktech.com/api/v1/vehicles', {
            method: 'GET',
            headers: { 'x-api-key': key, Accept: 'application/json' },
          }),
          [key],
        )
      }

      case 'GOOGLE_GEOCODE': {
        const got = requireCreds(creds, ['GOOGLE_MAPS_API_KEY'])
        if (!got.ok) return got.outcome
        const [key] = got.values
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
        url.searchParams.set('address', '1200 Lively Blvd, Elk Grove Village, IL')
        url.searchParams.set('key', key)
        const result = await call(fetchImpl, url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
        // Google answers a rejected key with HTTP 200 and status REQUEST_DENIED.
        // Taking the 200 at face value would badge a dead key as Connected.
        if (result.status === 200) {
          const status = googleStatus(result.body)
          if (status === 'REQUEST_DENIED' || status === 'INVALID_REQUEST') {
            return {
              kind: 'HTTP',
              statusCode: 401,
              message: summarize(result.body, [key]),
            }
          }
        }
        return httpOutcome(result, [key])
      }

      case 'ANTHROPIC_MODELS': {
        const got = requireCreds(creds, ['ANTHROPIC_API_KEY'])
        if (!got.ok) return got.outcome
        const [key] = got.values
        return httpOutcome(
          await call(fetchImpl, 'https://api.anthropic.com/v1/models', {
            method: 'GET',
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
          }),
          [key],
        )
      }

      case 'SLACK_AUTH_TEST': {
        const got = requireCreds(creds, ['SLACK_BOT_TOKEN'])
        if (!got.ok) return got.outcome
        const [token] = got.values
        const result = await call(fetchImpl, 'https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        // Slack answers a bad token with HTTP 200 and { ok: false, error: 'invalid_auth' }.
        if (result.status === 200 && !slackOk(result.body)) {
          return { kind: 'HTTP', statusCode: 401, message: summarize(result.body, [token]) }
        }
        return httpOutcome(result, [token])
      }

      case 'TWILIO_ACCOUNT': {
        const got = requireCreds(creds, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'])
        if (!got.ok) return got.outcome
        const [sid, token] = got.values
        const basic = Buffer.from(`${sid}:${token}`, 'utf8').toString('base64')
        return httpOutcome(
          await call(fetchImpl, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
            method: 'GET',
            headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
          }),
          [sid, token, basic],
        )
      }

      case 'QBO_COMPANY_INFO': {
        const got = requireCreds(creds, ['accessToken', 'realmId'])
        if (!got.ok) return got.outcome
        const [accessToken, realmId] = got.values
        const base = creds.sandbox === 'true'
          ? 'https://sandbox-quickbooks.api.intuit.com'
          : 'https://quickbooks.api.intuit.com'
        return httpOutcome(
          await call(
            fetchImpl,
            `${base}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}`,
            {
              method: 'GET',
              headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            },
          ),
          [accessToken],
        )
      }

      case 'HUBSPOT_CONTACTS': {
        const got = requireCreds(creds, ['privateAppToken'])
        if (!got.ok) return got.outcome
        const [token] = got.values
        return httpOutcome(
          await call(fetchImpl, 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          }),
          [token],
        )
      }

      case 'OTR_BROKER_CHECK': {
        const got = requireCreds(creds, ['OTR_USERNAME', 'OTR_PASSWORD', 'OTR_SUBSCRIPTION_KEY'])
        if (!got.ok) return got.outcome
        const [username, password, subscriptionKey] = got.values
        const client = new OtrClient({
          baseUrl: process.env.OTR_BASE_URL || OTR_STAGING_BASE,
          uploadBaseUrl: process.env.OTR_UPLOAD_BASE_URL || undefined,
          clientDot: process.env.OTR_CLIENT_DOT || undefined,
          subscriptionKey,
          username,
          password,
          fetchImpl,
        })
        // BCAT's own MC: a read that proves the token without touching an invoice.
        // `OtrClient` owns its own fetch and knows nothing of this function's
        // deadline, so the budget is imposed from outside — a hung OTR endpoint
        // must fail the same way every other provider does, not hold the Lambda
        // for its whole 30 seconds and surface as a generic AppSync error.
        const mc = process.env.OTR_VALIDATE_MC || '1083544'
        const checked = await withDeadline(client.brokerCheck({ brokerMc: mc }))
        // The decision only — never the reply text, which carries a broker's name.
        return { kind: 'HTTP', statusCode: 200, message: `Broker check: ${checked.decision}` }
      }

      case 'PAYCHEX_TOKEN': {
        const got = requireCreds(creds, ['PAYCHEX_CLIENT_ID', 'PAYCHEX_CLIENT_SECRET'])
        if (!got.ok) return got.outcome
        const [clientId, clientSecret] = got.values
        return httpOutcome(
          await call(fetchImpl, 'https://api.paychex.com/auth/oauth/v2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: clientId,
              client_secret: clientSecret,
            }).toString(),
          }),
          [clientId, clientSecret],
        )
      }

      case 'BRIDGE_LAST_INBOUND':
        // Health for an inbound bridge is the newest row it wrote, which the page
        // reads itself from tables it is already allowed to read. No call here.
        return {
          kind: 'SKIPPED',
          reason: 'NO_VALIDATE_ENDPOINT',
          message: 'Inbound only — health is the last message this bridge delivered.',
        }

      case 'OPENAPI_SELF':
        return {
          kind: 'SKIPPED',
          reason: 'OK',
          message: 'BCAT issues these credentials; there is nothing outside to ask.',
        }

      default:
        return NO_ENDPOINT
    }
  } catch (err) {
    const secrets = Object.values(creds).filter((v): v is string => typeof v === 'string')
    return errorOutcome(err, secrets)
  }
}

/** Google's `status` field, when the body is the JSON it promises. */
function googleStatus(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'status' in parsed && typeof parsed.status === 'string') {
      return parsed.status
    }
  } catch {
    return null
  }
  return null
}

/** Slack's `ok` field. A body that is not JSON is not an ok. */
function slackOk(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return !!parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === true
  } catch {
    return false
  }
}
