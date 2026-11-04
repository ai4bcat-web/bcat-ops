/**
 * Read-only guard shared by the verification harnesses (CUTOVER_PLAN NB-7).
 *
 * The post-cutover smoke test runs against PRODUCTION and may only READ. This module is the enforcement:
 *   - GraphQL: every request document is parsed; any operation of type mutation throws and is counted, except a
 *     router "mutation" whose `action` is a read verb (the app drives reads of several tables through
 *     `mutation tmsXActions(action: GET_* | LIST_* ...)` because AppSync custom operations cannot be queries; the same
 *     classification the app itself uses, src/lib/apiClient.ts READ_ROUTER_ACTION + the verified extras below). Counted as `routerReads`.
 *   - AWS SDK clients: allow-list of read verbs on DynamoDB and S3 only. Every other service (Cognito, SSM, Lambda...)
 *     and every other verb (Put/Update/Delete/Batch*Write/Transact*Write/ExecuteStatement/Admin*) throws and is counted.
 *   - Browser: decideBrowserRequest() classifies a paused request for cdpBrowser.intercept().
 *   - Final assertion: `mutations === 0` is printed and fails the run when violated, even when a caller swallowed the throw.
 *
 * The prod AppSync URL is NEVER defaulted: it comes from `--prod-url=` (the runbook). The auth is an EXISTING read-only
 * smoke user's tokens supplied by env; this guard never mints or changes an identity. Token values are never printed.
 */
import { topLevelFields } from './perfProbe.mjs'

/** A customer-managed domain is refused: only a plain AppSync `<id>.appsync-api.<region>.amazonaws.com/graphql` URL. */
export const APPSYNC_URL = /^https:\/\/[a-z0-9]{10,40}\.appsync-api\.[a-z0-9-]+\.amazonaws\.com\/graphql$/
export const MIN_TOKEN_MINUTES = 5

export class ReadOnlyViolation extends Error {
  constructor(message) {
    super(`READ-ONLY VIOLATION: ${message}`)
    this.name = 'ReadOnlyViolation'
  }
}

export const isReadOnlyRun = (argv = process.argv) => argv.includes('--read-only')

// ───────────────────────────── GraphQL ─────────────────────────────
/** Operation types of every definition at document depth 0 (comments, strings and block strings skipped). */
export function operationTypes(doc) {
  const types = []
  let depth = 0
  let pending = null // keyword seen for the definition being read
  for (let i = 0; i < doc.length;) {
    const c = doc[i]
    if (c === '#') { while (i < doc.length && doc[i] !== '\n') i += 1; continue }
    if (doc.startsWith('"""', i)) { const end = doc.indexOf('"""', i + 3); i = end < 0 ? doc.length : end + 3; continue }
    if (c === '"') {
      i += 1
      while (i < doc.length && doc[i] !== '"') i += doc[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '{' || c === '(') {
      if (depth === 0 && c === '{') { types.push(pending === 'fragment' ? null : (pending ?? 'query')); pending = 'body' }
      depth += 1
      i += 1
      continue
    }
    if (c === '}' || c === ')') {
      depth -= 1
      if (depth === 0 && c === '}') pending = null
      i += 1
      continue
    }
    if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < doc.length && /[A-Za-z0-9_]/.test(doc[j])) j += 1
      const word = doc.slice(i, j)
      if (pending == null && (word === 'query' || word === 'mutation' || word === 'subscription' || word === 'fragment')) pending = word
      i = j
      continue
    }
    i += 1
  }
  return types.filter(Boolean)
}

/** src/lib/apiClient.ts READ_ROUTER_ACTION (the app's own read classification of `mutation Tms*Actions`). */
const READ_ROUTER_ACTION = /^(?:SPOT_|CRM_|CS_|AP_INBOX_)?(GET|LIST|SEARCH|FIND|READ|COUNT|PREVIEW|CHECK|LOOKUP|STATUS)(_|$)/
/** Read actions whose verb is not first; each handler read for this list (list/scan/describe only, no write). */
const READ_ROUTED_EXTRA = new Set([
  'tmsAljexImport:IMPORT_LIST', 'tmsDataSafety:DATA_STATUS', 'tmsDataSafety:EXPORT_LIST',
  'managePods:list', 'managePods:status', 'manageDispatch:status',
])
/**
 * WRITES the app fires by itself on page load (found by the dev proof run): a real UpdateItem per expired quote on every
 * open of the Rates pages. The browser interceptor blocks them and REPORTS them (`pageLoadWritesBlocked`, a finding for the
 * lead); they never reach the server so they do not count as mutations. Harness code that tries one still throws.
 */
export const KNOWN_PAGE_LOAD_WRITES = new Set(['tmsShipmentActions:SWEEP_EXPIRED_QUOTES'])
/** `field:action` of a router call: is it a read? */
export const isReadRouted = (field, action) => !!action && (READ_ROUTER_ACTION.test(action) || READ_ROUTED_EXTRA.has(`${field}:${action}`))

const literalAction = (args) => args.match(/\baction:\s*"([A-Za-z0-9_]+)"/)?.[1] ?? null

/**
 * Classify one request body (a JSON string).
 * @returns {{ queries: number, routerReads: string[], mutations: string[] }} `mutations` non-empty = refuse.
 */
export function classifyGraphqlBody(body) {
  const out = { queries: 0, routerReads: [], mutations: [] }
  let parsed
  try { parsed = JSON.parse(body) } catch { out.mutations.push('(unparseable body)'); return out }
  const docs = Array.isArray(parsed) ? parsed : [parsed]
  for (const doc of docs) {
    if (typeof doc?.query !== 'string') { out.mutations.push('(no query document: persisted or lambda request)'); continue }
    const types = operationTypes(doc.query)
    if (types.length === 0) { out.mutations.push('(no operation found)'); continue }
    const nonQuery = types.filter((t) => t !== 'query')
    if (nonQuery.length === 0) { out.queries += types.length; continue }
    // mutation or subscription document: only a router whose action is a read verb passes, every field of it
    if (types.length > 1) { out.mutations.push('(multi-operation document containing a non-query)'); continue }
    const fields = topLevelFields(doc.query)
    for (const field of fields) {
      const action = typeof doc.variables?.action === 'string' && /\$action\b/.test(field.args) ? doc.variables.action : literalAction(field.args)
      const isRead = types.every((t) => t === 'mutation' || t === 'query') && isReadRouted(field.name, action)
      if (isRead) out.routerReads.push(`${field.name}:${action}`)
      else out.mutations.push(action ? `${field.name}:${action}` : field.name)
    }
    if (fields.length === 0) out.mutations.push('(mutation without fields)')
  }
  return out
}

// ───────────────────────────── SDK ─────────────────────────────
const READ_VERB = /^(Get|List|Describe|Query|Scan|BatchGet|TransactGet|Head)/
const ALLOWED_SERVICES = /dynamodb|s3/i
const commandName = (command) => String(command?.constructor?.name ?? '').replace(/Command$/, '')
const serviceOf = (client) => String(client?.config?.serviceId ?? client?.constructor?.name ?? '')

// ───────────────────────────── identity from env ─────────────────────────────
function decodeJwt(token) {
  const part = String(token).split('.')[1]
  if (!part) throw new Error('token is not a JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/**
 * Validate `--read-only --prod-url=<url> [--expect-pool=<id>]` + BCAT_PROD_ID_TOKEN [+ BCAT_PROD_ACCESS_TOKEN + BCAT_PROD_REFRESH_TOKEN
 * for the browser steps: Amplify treats a session without a refresh token as signed out].
 * Throws with a message naming what is missing. Never prints token values.
 * @returns {{ url: string, idToken: string, accessToken: string|null, refreshToken: string|null, identity: object }}
 */
export function parseReadOnlyConfig(argv = process.argv.slice(2), env = process.env, now = Date.now()) {
  if (!argv.includes('--read-only')) throw new Error('--read-only is required (this suite has no write mode)')
  const url = argv.find((a) => a.startsWith('--prod-url='))?.slice('--prod-url='.length)
  if (!url) throw new Error('--prod-url=<AppSync URL from the runbook> is required (it is never defaulted)')
  if (!APPSYNC_URL.test(url)) throw new Error('--prod-url must be a plain https://<id>.appsync-api.<region>.amazonaws.com/graphql URL')
  const idToken = env.BCAT_PROD_ID_TOKEN
  if (!idToken) throw new Error('BCAT_PROD_ID_TOKEN (an existing read-only smoke user\'s Cognito ID token) is required; this suite never mints identities')
  let payload
  try { payload = decodeJwt(idToken) } catch (err) { throw new Error(`BCAT_PROD_ID_TOKEN is not a usable JWT (${err.message})`) }
  if (payload.token_use !== 'id') throw new Error('BCAT_PROD_ID_TOKEN must be an ID token (token_use=id)')
  const minutes = (payload.exp * 1000 - now) / 60_000
  if (!(minutes > MIN_TOKEN_MINUTES)) throw new Error(`BCAT_PROD_ID_TOKEN expires in ${Math.floor(minutes)} min (need > ${MIN_TOKEN_MINUTES}); ask for a fresh one`)
  const pool = String(payload.iss ?? '').split('/').pop()
  const expectPool = argv.find((a) => a.startsWith('--expect-pool='))?.slice('--expect-pool='.length)
  if (expectPool && expectPool !== pool) throw new Error(`token pool ${pool} does not match --expect-pool=${expectPool}`)
  return {
    url,
    idToken,
    accessToken: env.BCAT_PROD_ACCESS_TOKEN ?? null,
    refreshToken: env.BCAT_PROD_REFRESH_TOKEN ?? null,
    identity: {
      pool,
      clientId: payload.aud,
      username: payload['cognito:username'],
      groups: payload['cognito:groups'] ?? [],
      expiresInMinutes: Math.floor(minutes),
    },
  }
}

/** localStorage entries Amplify reads for an already-issued session of the existing smoke user. */
export function buildBrowserStorage({ idToken, accessToken, refreshToken, identity }) {
  if (!accessToken || !refreshToken) throw new Error('browser steps need BCAT_PROD_ACCESS_TOKEN and BCAT_PROD_REFRESH_TOKEN too (Amplify treats a session without all three tokens as signed out)')
  const prefix = `CognitoIdentityServiceProvider.${identity.clientId}`
  return {
    [`${prefix}.LastAuthUser`]: identity.username,
    [`${prefix}.${identity.username}.refreshToken`]: refreshToken,
    [`${prefix}.${identity.username}.idToken`]: idToken,
    [`${prefix}.${identity.username}.accessToken`]: accessToken,
    [`${prefix}.${identity.username}.clockDrift`]: '0',
  }
}

// ───────────────────────────── guard ─────────────────────────────
/**
 * @param {{ appsyncUrl: string, log?: (line: string) => void }} options
 */
export function createReadOnlyGuard({ appsyncUrl, log = console.log } = {}) {
  if (!appsyncUrl || !APPSYNC_URL.test(appsyncUrl)) throw new Error('createReadOnlyGuard needs a plain AppSync URL')
  const stats = { queries: 0, routerReads: 0, sdkReads: 0, authReads: 0, pageLoadWritesBlocked: 0, mutations: 0, blockedOther: 0 }
  const violations = []
  const findings = [] // page-load writes the app attempted on its own and the interceptor blocked

  const violate = (what) => {
    stats.mutations += 1
    violations.push(what)
    throw new ReadOnlyViolation(what)
  }

  /** Throws ReadOnlyViolation for anything that is not a read; counts the reads. */
  function checkGraphqlBody(body) {
    const verdict = classifyGraphqlBody(String(body ?? ''))
    if (verdict.mutations.length) violate(`GraphQL mutation refused: ${verdict.mutations.join(', ')}`)
    stats.queries += verdict.queries
    stats.routerReads += verdict.routerReads.length
    return verdict
  }

  /** Wrap a fetch(): only POSTs to the AppSync URL with read documents (and GET/HEAD to it) go out. */
  function wrapFetch(fetchFn = globalThis.fetch) {
    return async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      const method = String(init.method ?? input?.method ?? 'GET').toUpperCase()
      if (url !== appsyncUrl) violate(`request to ${url.replace(/\?.*$/, '')} refused (only ${new URL(appsyncUrl).host} is allowed)`)
      if (method === 'POST') checkGraphqlBody(init.body)
      else if (method !== 'GET' && method !== 'HEAD') violate(`${method} ${new URL(url).host} refused`)
      return fetchFn(input, init)
    }
  }

  /** Wrap an AWS SDK v3 client (or DocumentClient): `send` throws on anything that is not a DynamoDB/S3 read. */
  function wrapSdkClient(client) {
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== 'send') return Reflect.get(target, prop, receiver)
        return async (command, ...rest) => {
          const name = commandName(command)
          const service = serviceOf(target)
          if (!ALLOWED_SERVICES.test(service)) violate(`${service || 'unknown'} client call ${name} refused (read-only mode allows DynamoDB/S3 reads only; no Cognito/SSM/Lambda)`)
          if (/^Admin/.test(name) || !READ_VERB.test(name)) violate(`${service} ${name} refused (not a read verb)`)
          stats.sdkReads += 1
          return target.send(command, ...rest)
        }
      },
    })
  }

  /**
   * Browser request verdict for cdpBrowser.intercept(): { block: false } or { block: true, reason }.
   * GET/HEAD/OPTIONS pass. A POST to the AppSync URL passes only with a read document. Any other non-GET to an
   * amazonaws.com host is a violation; a non-GET to a third party (maps/analytics beacons) is blocked and reported only.
   */
  function decideBrowserRequest({ method, url, postData, headers = {}, hasPostData }) {
    const m = String(method).toUpperCase()
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { block: false }
    if (url === appsyncUrl && m === 'POST') {
      if (!postData) {
        stats.mutations += 1
        violations.push(hasPostData ? 'AppSync POST body too large to inspect: blocked' : 'AppSync POST with no body: blocked')
        return { block: true, reason: 'uninspectable AppSync body' }
      }
      const verdict = classifyGraphqlBody(postData)
      if (verdict.mutations.length && verdict.mutations.every((x) => KNOWN_PAGE_LOAD_WRITES.has(x))) {
        stats.pageLoadWritesBlocked += 1
        findings.push(verdict.mutations.join(', '))
        return { block: true, reason: `known page-load write ${verdict.mutations.join(', ')}` }
      }
      if (verdict.mutations.length) {
        stats.mutations += 1
        violations.push(`browser GraphQL mutation blocked: ${verdict.mutations.join(', ')}`)
        return { block: true, reason: `mutation ${verdict.mutations.join(', ')}` }
      }
      stats.queries += verdict.queries
      stats.routerReads += verdict.routerReads.length
      return { block: false }
    }
    let host = ''
    try { host = new URL(url).host } catch { /* keep empty */ }
    // The signed-in app's own credential plumbing: identity-pool credentials (GetId / GetCredentialsForIdentity) and the
    // session's token refresh. They change no business data and the page cannot render without them.
    const target = String(Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-amz-target')?.[1] ?? '')
    if (m === 'POST' && /^cognito-identity\.[a-z0-9-]+\.amazonaws\.com$/.test(host) && /\.(GetId|GetCredentialsForIdentity)$/.test(target)) { stats.authReads += 1; return { block: false } }
    if (m === 'POST' && /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(host)
      && (/\.GetTokensFromRefreshToken$/.test(target) || (/\.InitiateAuth$/.test(target) && /REFRESH_TOKEN_AUTH/.test(postData ?? '')))) { stats.authReads += 1; return { block: false } }
    if (/amazonaws\.com$|amplifyapp\.com$/.test(host) || host === new URL(appsyncUrl).host) {
      stats.mutations += 1
      violations.push(`browser ${m} ${host} blocked`)
      return { block: true, reason: `${m} ${host}` }
    }
    stats.blockedOther += 1
    return { block: true, reason: `third-party ${m} ${host}` }
  }

  /** Print the final assertion line; returns true when no mutation was attempted. Sets process.exitCode = 1 otherwise. */
  function assertZeroMutations() {
    const ok = stats.mutations === 0
    log(`READ-ONLY ASSERT mutations=${stats.mutations} (${ok ? 'PASS' : 'FAIL'}) queries=${stats.queries} routerReads=${stats.routerReads} sdkReads=${stats.sdkReads} sessionAuthCalls=${stats.authReads} pageLoadWritesBlocked=${stats.pageLoadWritesBlocked} thirdPartyWritesBlocked=${stats.blockedOther}`)
    const counted = {}
    for (const f of findings) counted[f] = (counted[f] ?? 0) + 1
    for (const [f, n] of Object.entries(counted)) log(`  FINDING (blocked before the server, not a mutation): the app fires ${f} on page load x${n}; on prod it would write`)
    if (!ok) {
      for (const v of violations) log(`  violation: ${v}`)
      process.exitCode = 1
    }
    return ok
  }

  return { stats, violations, findings, checkGraphqlBody, wrapFetch, wrapSdkClient, decideBrowserRequest, assertZeroMutations }
}

/**
 * For modules that create their own SDK clients at import time (devIdentity's Cognito client): in a `--read-only` run the
 * client is replaced by one whose every call throws, so no harness can mint, change or delete an identity.
 */
export function blockWhenReadOnly(client, argv = process.argv) {
  if (!isReadOnlyRun(argv)) return client
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'send') return (command) => { throw new ReadOnlyViolation(`${serviceOf(target)} ${commandName(command)} refused: --read-only runs never call Cognito`) }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** For writer harnesses: refuse `--read-only` instead of silently ignoring it. */
export function refuseReadOnlyFlag(script, argv = process.argv) {
  if (isReadOnlyRun(argv)) {
    throw new ReadOnlyViolation(`${script} creates fixtures and cannot run with --read-only; use scripts/smokeProdReadOnly.mjs (steps list: scripts/lib/smokeSteps.json)`)
  }
}
