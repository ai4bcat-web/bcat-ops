/**
 * The one place that holds the Square access token and talks to Square.
 *
 * Why it lives behind `tms-shipment-actions` and not in the finance Lambda that decides what to send: both Lambdas sit in the
 * data stack, whose CloudFormation template is within a few hundred bytes of the 1,000,000-byte cap. The shipment router already
 * holds everything this needs (the Integration row, the integration parameter path and its SSM read), so the finance Lambda asks it
 * over the existing system-caller door instead of being granted a second copy. The token never leaves this module: the finance side
 * only ever receives the non-secret context (environment, location ID, switches) and the status and JSON of each Square answer.
 *
 * Only the handful of Square endpoints the auto shipper flow uses are reachable, and every body goes through the same leak guard
 * the finance side uses, so even a bug upstream cannot send carrier pay, cost or margin to Square or use this as a general proxy.
 */
import {
  SQUARE_API_VERSION,
  squareBaseUrl,
  squareBodyLeaks,
  type AcceptedMethods,
  type SquareEnvironment,
} from '../../../src/lib/squareInvoicing'
import { redactSecrets } from '../../../src/lib/integrations/secrets'

type Row = Record<string, unknown>

export interface SquareApiDeps {
  /** The Integrations page's SQUARE row (settings live on it), or null. */
  getIntegrationRow: () => Promise<Row | null>
  /** The stored credential object for SQUARE (token and location per environment), or null. */
  readCredentials: () => Promise<Record<string, string> | null>
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

/** What the finance Lambda may know: never the token. */
export type SquareContext =
  | { connected: true; environment: SquareEnvironment; locationId: string; enabled: boolean; methods: AcceptedMethods }
  | { connected: false; environment: SquareEnvironment; reason: string }

const TIMEOUT_MS = 15_000

function asJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T } catch { return null }
  }
  return typeof value === 'object' ? (value as T) : null
}

interface Resolved {
  context: SquareContext
  token: string | null
}

async function resolve(deps: SquareApiDeps): Promise<Resolved> {
  const settings = asJson<Record<string, unknown>>((await deps.getIntegrationRow())?.settings) ?? {}
  const environment: SquareEnvironment = settings.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX'
  const creds = (await deps.readCredentials()) ?? {}
  const prefix = environment === 'PRODUCTION' ? 'production' : 'sandbox'
  const token = (creds[`${prefix}AccessToken`] ?? '').trim()
  const locationId = (creds[`${prefix}LocationId`] ?? '').trim()
  const lower = environment.toLowerCase()
  if (!token || token === 'disabled-on-dev') {
    return { token: null, context: { connected: false, environment, reason: `Square is not connected for ${environment}: enter the ${lower} access token on Integrations → Square` } }
  }
  if (!locationId) {
    return { token: null, context: { connected: false, environment, reason: `Square has no ${lower} location ID: enter it on Integrations → Square` } }
  }
  return {
    token,
    context: {
      connected: true,
      environment,
      locationId,
      enabled: settings.autoShipperInvoicing === true,
      methods: { bankTransfer: settings.acceptBankTransfer === true, cashApp: settings.acceptCashApp === true },
    },
  }
}

/** The endpoints the flow uses, and nothing else: customers, orders, invoices (+ publish, cancel). */
const ALLOWED: Array<{ method: 'GET' | 'POST' | 'DELETE'; path: RegExp }> = [
  { method: 'POST', path: /^\/v2\/customers$/ },
  { method: 'POST', path: /^\/v2\/orders$/ },
  { method: 'GET', path: /^\/v2\/orders\/[A-Za-z0-9_-]{1,64}$/ },
  { method: 'POST', path: /^\/v2\/invoices$/ },
  // A Square invoice id carries a colon ("inv:0-ChAr..."), which no other Square id does.
  { method: 'GET', path: /^\/v2\/invoices\/[A-Za-z0-9_:-]{1,64}$/ },
  { method: 'DELETE', path: /^\/v2\/invoices\/[A-Za-z0-9_:-]{1,64}\?version=\d{1,9}$/ },
  { method: 'POST', path: /^\/v2\/invoices\/[A-Za-z0-9_:-]{1,64}\/(publish|cancel)$/ },
]

export function squareCallAllowed(method: string, path: string): boolean {
  return ALLOWED.some((rule) => rule.method === method && rule.path.test(path))
}

/**
 * `op: 'CONTEXT'` answers the non-secret configuration; `op: 'CALL'` makes one allowed Square request and answers its status and
 * JSON. A transport failure answers `status: 0` and a redacted `error`; Square's own refusals keep their status and body.
 */
export async function runSquareApi(input: Row, deps: SquareApiDeps): Promise<Row> {
  const resolved = await resolve(deps)
  if (input.op === 'CONTEXT') return resolved.context as unknown as Row
  if (input.op !== 'CALL') throw new Error('SQUARE_API: unknown op')

  const method = String(input.method ?? '')
  const path = String(input.path ?? '')
  if (!squareCallAllowed(method, path)) throw new Error(`SQUARE_API: ${method} ${path.split('?')[0]} is not an allowed Square call`)
  if (input.body !== undefined && input.body !== null) {
    const hit = squareBodyLeaks(input.body)
    if (hit) throw new Error(`Refusing to send ${hit} to Square: carrier pay, cost and margin never go on a customer invoice`)
  }
  if (!resolved.token || !resolved.context.connected) throw new Error(resolved.context.connected ? 'Square is not connected' : resolved.context.reason)

  const token = resolved.token
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${squareBaseUrl(resolved.context.environment)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(input.body !== undefined && input.body !== null ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    })
    // Whatever Square says is read as text, scrubbed of the token, and only then parsed: the token cannot ride out inside a body.
    const text = redactSecrets(await res.text(), [token])
    let json: Row = {}
    try { json = text ? (JSON.parse(text) as Row) : {} } catch { /* a non-JSON body is reported by status */ }
    return { status: res.status, json, ...(text && Object.keys(json).length === 0 ? { text: text.slice(0, 300) } : {}) }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    return {
      status: 0,
      error: name === 'AbortError' ? 'Square did not answer in time; try again' : `Could not reach Square: ${redactSecrets(err instanceof Error ? err.message : String(err), [token])}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
