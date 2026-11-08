/**
 * Step J — where a page-entered integration credential lives.
 *
 * One SecureString per provider at `${INTEGRATION_PARAM_PATH}/<PROVIDER>`, holding
 * the whole credential object as JSON. This is the `/bcat/pods/<pool>/connection`
 * precedent (`pod-actions/handler.ts`), scoped to the user pool id so the dev
 * stack's parameters are dev's by construction and the IAM resource ARN says so.
 *
 * Nothing here ever returns a credential to a caller that is not the validator:
 * the row stores a pointer and `[{ key, last4 }]`, and that is all the browser
 * ever sees.
 *
 * Amplify `secret()` values (`/amplify/*`) are a different thing entirely — they
 * arrive as environment variables, are read through `readStackSecret`, and are
 * never written from here.
 */
import {
  SSMClient,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm'

const ssm = new SSMClient({})

/** `/bcat/integrations/<userPoolId>` — no trailing slash. */
const INTEGRATION_PARAM_PATH = process.env.INTEGRATION_PARAM_PATH ?? ''
/** `/bcat/dispatch/<userPoolId>` — read-only, only to say whether Twilio is set up. */
const DISPATCH_PARAM_PATH = process.env.DISPATCH_PARAM_PATH ?? ''

/** Parameter Store throttles at 40 GetParameter/s account-wide. */
const CACHE_MS = 60_000

type Credentials = Record<string, string>

const cache: Record<string, { value: Credentials | null; expiresAt: number }> = {}

/** Test hook: forget every cached credential so each case reads its own SSM stub. */
export function resetIntegrationSecretsCache(): void {
  for (const key of Object.keys(cache)) delete cache[key]
}

export function parameterNameFor(provider: string): string {
  if (!INTEGRATION_PARAM_PATH) throw new Error('INTEGRATION_PARAM_PATH is not configured')
  const base = INTEGRATION_PARAM_PATH.endsWith('/')
    ? INTEGRATION_PARAM_PATH.slice(0, -1)
    : INTEGRATION_PARAM_PATH
  return `${base}/${provider.toUpperCase()}`
}

/**
 * The webhook signing secret lives in its OWN parameter, beneath the provider's.
 *
 * tracking-api serves a public Function URL and has to verify an inbound
 * signature, so it must be able to decrypt this value — and nothing else. Were
 * it stored beside the rest, granting that read would hand the one
 * Internet-facing Lambda the DAT password, the HubSpot token and the QuickBooks
 * refresh token as well. One key per blast radius.
 */
export function webhookParameterNameFor(provider: string): string {
  return `${parameterNameFor(provider)}/webhook`
}

/** The one key a webhook parameter holds. */
export const WEBHOOK_SECRET_KEY = 'webhookSigningSecret'

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name
  }
  return undefined
}

/** ES2020 lib lacks the ErrorOptions constructor; attach the cause explicitly. */
function wrapped(message: string, cause: unknown): Error {
  const error = new Error(message)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

function parseCredentials(raw: string): Credentials | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'not-configured') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Credentials = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** One parameter, cached. A throttle is rethrown, never read as "unconfigured". */
async function readParameter(name: string, provider: string): Promise<Credentials | null> {
  const hit = cache[name]
  if (hit && hit.expiresAt > Date.now()) return hit.value
  let value: Credentials | null
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    value = parseCredentials(result.Parameter?.Value ?? '')
  } catch (err) {
    if (errorName(err) === 'ParameterNotFound') {
      value = null
    } else {
      throw wrapped(`Could not read the stored credentials for ${provider}; try again`, err)
    }
  }
  cache[name] = { value, expiresAt: Date.now() + CACHE_MS }
  return value
}

async function putParameter(name: string, value: Credentials, provider: string): Promise<void> {
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: JSON.stringify(value),
        Type: 'SecureString',
        Overwrite: true,
      }),
    )
  } catch (err) {
    throw wrapped(`Could not store the credentials for ${provider}; try again`, err)
  }
  cache[name] = { value, expiresAt: Date.now() + CACHE_MS }
}

/**
 * Everything stored for this provider, or null when nothing has been entered.
 *
 * Two parameters are read and presented as one object: the provider's own, and
 * the webhook secret's, which is split out so the public Lambda can read the
 * second without being able to decrypt the first.
 *
 * A throttled or failing read is NOT "unconfigured": answering null there would
 * turn a transient SSM error into "this provider has no credentials", which is
 * the one lie this whole step exists to avoid.
 */
export async function readPageCredentials(provider: string): Promise<Credentials | null> {
  const main = await readParameter(parameterNameFor(provider), provider)
  const webhook = await readParameter(webhookParameterNameFor(provider), provider)
  if (!main && !webhook) return null
  return { ...(main ?? {}), ...(webhook ?? {}) }
}

/**
 * Merge the given fields into what is stored and write it back.
 *
 * A partial re-entry (the admin retypes one of three keys) must keep the other
 * two: the page sends only what was typed, because a masked field it did not
 * touch has no value to send. The webhook secret is routed to its own parameter
 * on the way through; the caller never has to know there are two.
 */
export async function writePageCredentials(provider: string, values: Credentials): Promise<Credentials> {
  const incoming: Credentials = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) incoming[key] = trimmed
  }

  const mainName = parameterNameFor(provider)
  const webhookName = webhookParameterNameFor(provider)
  const heldMain = await readParameter(mainName, provider)
  const heldWebhook = await readParameter(webhookName, provider)

  const mergedMain: Credentials = { ...(heldMain ?? {}) }
  const mergedWebhook: Credentials = { ...(heldWebhook ?? {}) }
  let mainTouched = false
  let webhookTouched = false
  for (const [key, value] of Object.entries(incoming)) {
    if (key === WEBHOOK_SECRET_KEY) {
      mergedWebhook[key] = value
      webhookTouched = true
    } else {
      mergedMain[key] = value
      mainTouched = true
    }
  }
  if (mainTouched) await putParameter(mainName, mergedMain, provider)
  if (webhookTouched) await putParameter(webhookName, mergedWebhook, provider)
  return { ...mergedMain, ...mergedWebhook }
}

/**
 * The whole stored object, nesting and all.
 *
 * `readPageCredentials` keeps only string values because a credential field IS a
 * string; the OPENAPI parameter is the one that is not flat — it holds the token
 * signing key and a map of issued clients to their secret hashes, which is the
 * shape tracking-api's `/api/token` route reads.
 */
export async function readRawParameter(provider: string): Promise<Record<string, unknown> | null> {
  const name = parameterNameFor(provider)
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    const raw = (result.Parameter?.Value ?? '').trim()
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch (err) {
    if (errorName(err) === 'ParameterNotFound') return null
    if (err instanceof SyntaxError) return null
    throw wrapped(`Could not read the stored credentials for ${provider}; try again`, err)
  }
}

export async function writeRawParameter(provider: string, value: Record<string, unknown>): Promise<void> {
  const name = parameterNameFor(provider)
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: JSON.stringify(value),
        Type: 'SecureString',
        Overwrite: true,
      }),
    )
  } catch (err) {
    throw wrapped(`Could not store the credentials for ${provider}; try again`, err)
  }
  // The flat view of this parameter is no longer what is stored.
  delete cache[name]
}

/** Disconnect: both parameters go, the row and its settings stay. */
export async function deletePageCredentials(provider: string): Promise<void> {
  // The webhook secret is a second parameter; leaving it behind would let a
  // disconnected provider keep posting to the public receiver.
  for (const name of [parameterNameFor(provider), webhookParameterNameFor(provider)]) {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: name }))
    } catch (err) {
      if (errorName(err) !== 'ParameterNotFound') {
        throw wrapped(`Could not remove the stored credentials for ${provider}; try again`, err)
      }
    }
    delete cache[name]
  }
}

export interface StackSecret {
  /** The resolved environment value, or null when the name is not on this Lambda. */
  value: string | null
  /** The dev stack pins side-effecting secrets to this literal (backend.ts). */
  neutered: boolean
}

/**
 * An Amplify `secret()` value as this Lambda sees it. Never written, never echoed:
 * the page shows the NAME and the `npx ampx secret set` command.
 */
export function readStackSecret(name: string): StackSecret {
  const raw = process.env[name]
  const value = typeof raw === 'string' && raw.trim() ? raw : null
  return { value, neutered: value === 'disabled-on-dev' }
}

export interface TwilioStatus {
  configured: boolean
  /** Which of the expected parameter names the path holds — names only, no values. */
  present: string[]
  missing: string[]
}

const TWILIO_REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'DISPATCH_NUMBER',
  'WEBHOOK_SECRET',
]

/**
 * Whether the dispatch path is set up, said without reading a value out loud.
 *
 * `loadDispatchConfig` would hand back the credentials themselves, which this
 * action has no business holding: the page only needs to know whether
 * `scripts/dispatchTwilioSetup.mjs` has been run for this pool.
 */
export async function readTwilioStatus(): Promise<TwilioStatus> {
  if (!DISPATCH_PARAM_PATH) return { configured: false, present: [], missing: [...TWILIO_REQUIRED] }
  const prefix = DISPATCH_PARAM_PATH.endsWith('/') ? DISPATCH_PARAM_PATH : `${DISPATCH_PARAM_PATH}/`
  const present: string[] = []
  let next: string | undefined
  try {
    do {
      const page = await ssm.send(
        // WithDecryption is deliberately off: the names are the whole answer.
        new GetParametersByPathCommand({ Path: prefix, WithDecryption: false, NextToken: next }),
      )
      for (const param of page.Parameters ?? []) {
        if (param.Name) present.push(param.Name.slice(prefix.length))
      }
      next = page.NextToken
    } while (next)
  } catch (err) {
    if (errorName(err) === 'ParameterNotFound') {
      return { configured: false, present: [], missing: [...TWILIO_REQUIRED] }
    }
    throw wrapped('Could not read the dispatch configuration; try again', err)
  }
  const missing = TWILIO_REQUIRED.filter((name) => !present.includes(name))
  return { configured: missing.length === 0, present, missing }
}
