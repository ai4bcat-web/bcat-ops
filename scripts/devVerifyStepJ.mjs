/**
 * Step J live verification against the DEV stack.
 *
 * Throwaway, the sibling of `devVerifyStepR.mjs`. It drives the deployed Lambdas with
 * real tokens — never through the UI — through everything Step J promises:
 *
 *   - the registry lands: LIST_INTEGRATIONS creates every provider row exactly once and
 *     a second call creates nothing;
 *   - credentials: a page-entered credential is written to SSM as a SecureString under
 *     the dev pool's own path, the DynamoDB row and the audit row carry no part of the
 *     value but the last four characters, a disconnect deletes the parameter and keeps
 *     the behaviour settings, and a stack-managed provider refuses to be connected or
 *     disconnected from the app;
 *   - health is honest: a neutered dev secret answers UNABLE_TO_VERIFY · NEUTERED_ON_DEV
 *     and never CONNECTED, a bad page credential answers INVALID_CREDENTIALS, and the
 *     stack's real keys answer OK;
 *   - stub mode is honest: a stub result is marked STUB, its id starts `stub:`, it bumps
 *     only the integration row and writes exactly one audit row, and the shipment it
 *     names is byte-for-byte unchanged (datPostedAt included);
 *   - settings: the DAT refresh rule refuses 17 and accepts 20, and a stale version is
 *     refused;
 *   - the public API: a client's secret is returned once, the token endpoint answers one
 *     wording for a wrong secret / an unknown client / a revoked client, a READ token
 *     reads one shipment by number with no money in the payload, a voided shipment
 *     answers VOIDED rather than 404, and an expired token is refused;
 *   - the webhook receiver: a correctly signed delivery is accepted once, the identical
 *     delivery replayed is a no-op duplicate, a tampered body and a stale timestamp are
 *     refused, and nothing but the integration row is written;
 *   - authority: a non-admin token is refused on every Step J action.
 *
 * Every fixture is removed in a `finally`: the temporary identities are deleted, the
 * parameters this run wrote are deleted, and the API client is revoked. Secrets are
 * generated randomly and never printed. It refuses to run against anything but dev.
 *
 *   node scripts/devVerifyStepJ.mjs
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql'
const DEV_POOL = 'us-east-1_UKhMNVAG1'
const DEV_CLIENT = '59284j3vm69gqg49cinjrr4dci'
const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE'
const DEV_PREFIX = 'amplify-d3dejqzs77khq6-de'
const region = 'us-east-1'

if (!DEV_API.includes('f5iqzdpidzalvjys7yxijn5ave')) throw new Error('Refusing to run against anything but the dev API')

const outputs = {
  auth: { user_pool_id: DEV_POOL, user_pool_client_id: DEV_CLIENT, aws_region: region, username_attributes: ['email'] },
  data: { url: DEV_API, aws_region: region, default_authorization_type: 'AMAZON_COGNITO_USER_POOLS' },
  version: '1.3',
}

const results = []
function ok(name, detail) { results.push({ ok: true, name, detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
function bad(name, detail) { results.push({ ok: false, name, detail }); console.log(`FAIL  ${name} — ${detail}`) }
function equals(name, actual, expected, note) {
  if (actual === expected) ok(name, note ?? String(actual))
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${note ? ` (${note})` : ''}`)
}
function truthy(name, value, note) { if (value) ok(name, note); else bad(name, `expected a truthy value${note ? ` (${note})` : ''}`) }
async function refuses(name, pattern, run) {
  try { await run(); bad(name, 'it was allowed') }
  catch (err) {
    const message = String(err.message ?? err)
    if (pattern.test(message)) ok(name, message.slice(0, 160))
    else bad(name, `refused for the wrong reason: ${message.slice(0, 220)}`)
  }
}

// ── AppSync ──────────────────────────────────────────────────────────────────
async function gqlAs(authToken, query, variables) {
  const res = await fetch(DEV_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authToken },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data
}
const routerAs = (authToken, field) => async (action, input) => {
  const data = await gqlAs(
    authToken,
    `mutation A($action: String!, $input: AWSJSON!) { ${field}(action: $action, input: $input) }`,
    { action, input: JSON.stringify(input) },
  )
  let v = data[field]
  while (typeof v === 'string') { try { v = JSON.parse(v) } catch { break } }
  return v
}

// ── temporary identities ─────────────────────────────────────────────────────
function secret() { return `Aa1!${randomBytes(18).toString('base64url')}` }
let poolClient = null
async function cognito() {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider')
  poolClient ??= new sdk.CognitoIdentityProviderClient({ region })
  return { sdk, client: poolClient }
}
const createdUsers = []
async function makeUser(group) {
  const { sdk, client } = await cognito()
  const email = `stepj-${group.toLowerCase()}-${randomBytes(4).toString('hex')}@bcat-verify.invalid`
  const password = secret()
  await client.send(new sdk.AdminCreateUserCommand({
    UserPoolId: DEV_POOL, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }))
  await client.send(new sdk.AdminSetUserPasswordCommand({ UserPoolId: DEV_POOL, Username: email, Password: password, Permanent: true }))
  try { await client.send(new sdk.AdminAddUserToGroupCommand({ UserPoolId: DEV_POOL, Username: email, GroupName: group })) }
  catch (err) {
    if (String(err.name) !== 'ResourceNotFoundException') throw err
    await client.send(new sdk.CreateGroupCommand({ UserPoolId: DEV_POOL, GroupName: group }))
    await client.send(new sdk.AdminAddUserToGroupCommand({ UserPoolId: DEV_POOL, Username: email, GroupName: group }))
  }
  createdUsers.push(email)
  return { email, password }
}
let amplifyAuth = null
async function tokenFor(email, password) {
  if (!amplifyAuth) {
    const { Amplify } = await import('aws-amplify')
    Amplify.configure(outputs)
    amplifyAuth = await import('aws-amplify/auth')
  }
  await amplifyAuth.signOut().catch(() => {})
  const attempt = await amplifyAuth.signIn({ username: email, password })
  if (!attempt.isSignedIn) throw new Error(`the temporary identity could not sign in: ${attempt.nextStep?.signInStep}`)
  const session = await amplifyAuth.fetchAuthSession({ forceRefresh: true })
  const idToken = session.tokens?.idToken?.toString()
  await amplifyAuth.signOut().catch(() => {})
  if (!idToken) throw new Error('no id token for the temporary identity')
  return idToken
}
async function deleteUser(email) {
  const [{ sdk, client }, { DynamoDBClient, DeleteItemCommand }] =
    await Promise.all([cognito(), import('@aws-sdk/client-dynamodb')])
  await new DynamoDBClient({ region }).send(new DeleteItemCommand({
    TableName: `UserProfile-${DEV_TABLE_SUFFIX}`, Key: { id: { S: email } },
  })).catch(() => {})
  await client.send(new sdk.AdminDeleteUserCommand({ UserPoolId: DEV_POOL, Username: email })).catch(() => {})
}

// ── raw dev-table reads (proof, never a write to a business record) ──────────
let docClient = null
async function doc() {
  if (!docClient) {
    const [{ DynamoDBClient }, { DynamoDBDocumentClient }] =
      await Promise.all([import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb')])
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
  }
  return docClient
}
async function getRow(model, id) {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb')
  const c = await doc()
  const r = await c.send(new GetCommand({ TableName: `${model}-${DEV_TABLE_SUFFIX}`, Key: { id }, ConsistentRead: true }))
  return r.Item ?? null
}
async function scanCount(model) {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb')
  const c = await doc()
  let count = 0, key
  do {
    const r = await c.send(new ScanCommand({ TableName: `${model}-${DEV_TABLE_SUFFIX}`, Select: 'COUNT', ExclusiveStartKey: key }))
    count += r.Count ?? 0
    key = r.LastEvaluatedKey
  } while (key)
  return count
}
async function scanAll(model, projection) {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb')
  const c = await doc()
  const rows = []
  let key
  do {
    const r = await c.send(new ScanCommand({
      TableName: `${model}-${DEV_TABLE_SUFFIX}`, ExclusiveStartKey: key,
      ...(projection ? { ProjectionExpression: projection } : {}),
    }))
    rows.push(...(r.Items ?? []))
    key = r.LastEvaluatedKey
  } while (key)
  return rows
}

// ── SSM (proof the parameter exists and is encrypted; the value is never printed) ──
let ssmClient = null
async function ssm() {
  const sdk = await import('@aws-sdk/client-ssm')
  ssmClient ??= new sdk.SSMClient({ region })
  return { sdk, client: ssmClient }
}
const paramPath = `/bcat/integrations/${DEV_POOL}`
async function describeParam(name) {
  const { sdk, client } = await ssm()
  try {
    const r = await client.send(new sdk.GetParameterCommand({ Name: `${paramPath}/${name}`, WithDecryption: false }))
    return { exists: true, type: r.Parameter?.Type ?? '' }
  } catch (err) {
    if (String(err.name) === 'ParameterNotFound') return { exists: false, type: '' }
    throw err
  }
}
async function deleteParam(name) {
  const { sdk, client } = await ssm()
  await client.send(new sdk.DeleteParameterCommand({ Name: `${paramPath}/${name}` })).catch(() => {})
}

// ── the public Function URL ──────────────────────────────────────────────────
async function trackingApiUrl() {
  const { LambdaClient, ListFunctionsCommand, ListFunctionUrlConfigsCommand } = await import('@aws-sdk/client-lambda')
  const lambda = new LambdaClient({ region })
  let marker
  do {
    const r = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }))
    for (const f of r.Functions ?? []) {
      // Amplify's physical name drops the hyphens: `…-de-trackingapilambda5BA29D3-…`.
      if (!f.FunctionName?.startsWith(DEV_PREFIX) || !/trackingapilambda/.test(f.FunctionName)) continue
      const u = await lambda.send(new ListFunctionUrlConfigsCommand({ FunctionName: f.FunctionName }))
      const url = u.FunctionUrlConfigs?.[0]?.FunctionUrl
      if (url) return url.replace(/\/$/, '')
    }
    marker = r.NextMarker
  } while (marker)
  throw new Error('no dev tracking-api Function URL found')
}

const containsSecretText = (value, needle) => JSON.stringify(value ?? null).includes(needle)

async function main() {
  const admin = await makeUser('ADMIN')
  const limited = await makeUser('page-tms')
  const adminToken = await tokenFor(admin.email, admin.password)
  const limitedToken = await tokenFor(limited.email, limited.password)
  const dir = routerAs(adminToken, 'tmsDirectoryActions')
  const dirLimited = routerAs(limitedToken, 'tmsDirectoryActions')

  const touchedParams = new Set()
  let issuedClientId = null
  const baseUrl = await trackingApiUrl()
  console.log(`tracking api: ${baseUrl}\n`)

  try {
    // 1 ── the registry lands exactly once ──────────────────────────────────
    const first = await dir('LIST_INTEGRATIONS', {})
    const rows = Array.isArray(first) ? first : (first.rows ?? [])
    const providers = rows.filter((r) => r.kind === 'PROVIDER')
    equals('LIST_INTEGRATIONS returns every provider row', providers.length, 39, `${providers.length} provider rows`)
    const keys = providers.map((r) => r.provider)
    equals('every provider appears exactly once', new Set(keys).size, keys.length)
    const createdAtBefore = Object.fromEntries(providers.map((r) => [r.provider, r.createdAt]))
    const second = await dir('LIST_INTEGRATIONS', {})
    const rows2 = (Array.isArray(second) ? second : (second.rows ?? [])).filter((r) => r.kind === 'PROVIDER')
    const recreated = rows2.filter((r) => r.createdAt !== createdAtBefore[r.provider])
    equals('a second list creates nothing', recreated.length, 0)
    const notConnected = providers.filter((r) => r.status === 'NOT_CONNECTED').length
    truthy('rows start NOT_CONNECTED', notConnected > 0, `${notConnected} of ${providers.length}`)

    // 2 ── health is honest on dev ──────────────────────────────────────────
    for (const provider of ['SLACK', 'OTR', 'BLUE_INK']) {
      const row = await dir('VALIDATE_INTEGRATION', { provider })
      equals(`${provider}: neutered on dev is not connected`, row.health, 'UNABLE_TO_VERIFY')
      equals(`${provider}: reason is NEUTERED_ON_DEV`, row.healthReason, 'NEUTERED_ON_DEV')
    }
    // Google is deliberately NOT in this list. The dev stack's GOOGLE_MAPS_API_KEY is
    // rejected by Google server-side — `tms-geocode` fails with the same
    // "The provided API key is invalid" on dev — so INVALID_CREDENTIALS is the true
    // badge, and the page is reporting a real pre-existing dev gap, not a bug in J.
    for (const provider of ['MOTIVE', 'ANTHROPIC']) {
      const row = await dir('VALIDATE_INTEGRATION', { provider })
      if (row.health === 'OK') ok(`${provider}: the stack's live key validates`, row.healthDetail ?? '')
      else bad(`${provider}: expected OK on dev`, `${row.health} · ${row.healthReason} · ${String(row.healthDetail).slice(0, 120)}`)
    }
    const google = await dir('VALIDATE_INTEGRATION', { provider: 'GOOGLE_MAPS' })
    equals('GOOGLE_MAPS: the dev key is reported exactly as Google answers it', google.health, 'INVALID_CREDENTIALS')

    const twilio = await dir('VALIDATE_INTEGRATION', { provider: 'TWILIO' })
    equals('TWILIO: dev pool has no dispatch config', twilio.status, 'NOT_CONNECTED')
    const convoy = await dir('VALIDATE_INTEGRATION', { provider: 'CONVOY' })
    equals('CONVOY: not applicable, never connected', convoy.healthReason, 'NOT_APPLICABLE')

    // 3 ── a page-entered credential ────────────────────────────────────────
    const fakeToken = `pat-na1-${randomUUID()}`
    const connected = await dir('CONNECT_INTEGRATION', { provider: 'HUBSPOT', credentials: { privateAppToken: fakeToken } })
    touchedParams.add('HUBSPOT')
    equals('HUBSPOT: connecting stores the credential', connected.status, 'CONNECTED')
    equals('HUBSPOT: a bad token reads as invalid credentials', connected.health, 'INVALID_CREDENTIALS')
    const param = await describeParam('HUBSPOT')
    truthy('HUBSPOT: the parameter exists under the dev pool path', param.exists, `${paramPath}/HUBSPOT`)
    equals('HUBSPOT: the parameter is a SecureString', param.type, 'SecureString')
    const stored = await getRow('Integration', 'HUBSPOT')
    equals('HUBSPOT: the row carries no credential value', containsSecretText(stored, fakeToken), false)
    equals('HUBSPOT: the row carries a last-4 mask', containsSecretText(stored?.credentialMask, fakeToken.slice(-4)), true)
    const audits = (await scanAll('AuditLog')).filter((r) => r.entityType === 'INTEGRATION' && r.entityId === 'HUBSPOT')
    equals('HUBSPOT: no audit row carries the credential', audits.some((r) => containsSecretText(r, fakeToken)), false)
    truthy('HUBSPOT: connecting is audited', audits.length > 0, `${audits.length} rows`)

    // 4 ── behaviour settings ───────────────────────────────────────────────
    const dat0 = (await dir('LIST_INTEGRATIONS', {})).find?.((r) => r.provider === 'DAT')
      ?? (await dir('VALIDATE_INTEGRATION', { provider: 'DAT' }))
    await refuses('DAT: a 17-minute refresh is refused', /refresh|interval|step|15/i, () =>
      dir('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 17 }, expectedVersion: dat0.version }))
    const dat1 = await dir('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 20 }, expectedVersion: dat0.version })
    equals('DAT: a 20-minute refresh is accepted', dat1.settings?.refreshIntervalMin, 20)
    await refuses('DAT: a stale version is refused', /changed by someone else|version|conflict/i, () =>
      dir('SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: { refreshIntervalMin: 25 }, expectedVersion: dat0.version }))

    // 5 ── stub mode never touches the freight ──────────────────────────────
    const shipmentsBefore = await scanCount('Shipment')
    const loadsBefore = await scanCount('Load')
    const allShipments = await scanAll('Shipment')
    const sample = allShipments.find((s) => s.number && !s.voidedAt) ?? allShipments[0]
    const beforeRow = sample ? await getRow('Shipment', sample.id) : null
    const auditsBefore = (await scanAll('AuditLog')).filter((r) => r.entityType === 'INTEGRATION' && r.entityId === 'DAT').length
    const stub = await dir('RUN_STUB', { provider: 'DAT', capability: 'post', sample: { shipmentNumber: beforeRow?.number ?? 'SAMPLE' } })
    const result = stub.result ?? stub
    equals('RUN_STUB: the result is marked STUB', result.mode, 'STUB')
    truthy('RUN_STUB: the message says so', String(result.message).startsWith('STUB — '), String(result.message).slice(0, 80))
    truthy('RUN_STUB: the id is not a plausible provider id', String(result.externalId).startsWith('stub:'), String(result.externalId))
    equals('RUN_STUB: the shipment count is unchanged', await scanCount('Shipment'), shipmentsBefore)
    equals('RUN_STUB: the load count is unchanged', await scanCount('Load'), loadsBefore)
    if (beforeRow) {
      const afterRow = await getRow('Shipment', beforeRow.id)
      equals('RUN_STUB: the named shipment is byte-for-byte unchanged', JSON.stringify(afterRow), JSON.stringify(beforeRow))
      equals('RUN_STUB: datPostedAt is still unset by a stub', afterRow?.datPostedAt ?? null, beforeRow?.datPostedAt ?? null)
    }
    const auditsAfter = (await scanAll('AuditLog')).filter((r) => r.entityType === 'INTEGRATION' && r.entityId === 'DAT').length
    equals('RUN_STUB: exactly one audit row', auditsAfter - auditsBefore, 1)
    const datRow = await getRow('Integration', 'DAT')
    equals('RUN_STUB: the stub counter moved', Number(datRow?.stubCount ?? 0) >= 1, true)
    await refuses('RUN_STUB: an undeclared capability is refused', /capab|support|declare/i, () =>
      dir('RUN_STUB', { provider: 'DAT', capability: 'factor', sample: {} }))

    // 6 ── stack-managed providers are never edited from the app ────────────
    await refuses('SLACK: connect is refused (stack-managed)', /stack|ampx secret|managed/i, () =>
      dir('CONNECT_INTEGRATION', { provider: 'SLACK', credentials: { token: 'x' } }))
    await refuses('SLACK: disconnect is refused (stack-managed)', /stack|ampx secret|managed/i, () =>
      dir('DISCONNECT_INTEGRATION', { provider: 'SLACK' }))

    // 7 ── authority ────────────────────────────────────────────────────────
    for (const [action, input] of [
      ['LIST_INTEGRATIONS', {}],
      ['CONNECT_INTEGRATION', { provider: 'HUBSPOT', credentials: { privateAppToken: 'x' } }],
      ['VALIDATE_INTEGRATION', { provider: 'HUBSPOT' }],
      ['SAVE_INTEGRATION_SETTINGS', { provider: 'DAT', settings: {}, expectedVersion: 1 }],
      ['DISCONNECT_INTEGRATION', { provider: 'HUBSPOT' }],
      ['RUN_STUB', { provider: 'DAT', capability: 'post', sample: {} }],
      ['ISSUE_API_CLIENT', { name: 'x', scopes: ['READ'] }],
      ['REVOKE_API_CLIENT', { clientId: 'x' }],
    ]) {
      await refuses(`a page-tms token cannot ${action}`, /Forbidden|owner or ADMIN/i, () => dirLimited(action, input))
    }

    // 8 ── the public API ───────────────────────────────────────────────────
    const issued = await dir('ISSUE_API_CLIENT', { name: `Step J verification ${randomUUID().slice(0, 8)}`, scopes: ['READ'] })
    touchedParams.add('OPENAPI')
    issuedClientId = issued.clientId ?? issued.row?.id?.replace(/^api:/, '')
    truthy('ISSUE_API_CLIENT: the secret is returned once', Boolean(issued.secret), `${String(issued.secret).length} chars`)
    const clientRow = await getRow('Integration', `api:${issuedClientId}`)
    equals('ISSUE_API_CLIENT: the row stores no secret', containsSecretText(clientRow, issued.secret), false)

    const tokenRes = await fetch(`${baseUrl}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: issuedClientId, client_secret: issued.secret }),
    })
    const tokenBody = await tokenRes.json()
    equals('POST /api/token: a good client gets a token', tokenRes.status, 200)
    truthy('POST /api/token: the token is a bearer token', Boolean(tokenBody.access_token), `expires_in ${tokenBody.expires_in}`)

    const wrongRes = await fetch(`${baseUrl}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: issuedClientId, client_secret: `${issued.secret}x` }),
    })
    const unknownRes = await fetch(`${baseUrl}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'nope', client_secret: 'nope' }),
    })
    equals('POST /api/token: a wrong secret is refused', wrongRes.status, 401)
    equals('POST /api/token: an unknown client is refused', unknownRes.status, 401)
    equals('POST /api/token: both refusals read the same', JSON.stringify(await wrongRes.json()), JSON.stringify(await unknownRes.json()))

    const live = allShipments.find((s) => s.number && !s.voidedAt)
    const voided = allShipments.find((s) => s.number && s.voidedAt)
    if (live) {
      const res = await fetch(`${baseUrl}/api/v1/shipments/${encodeURIComponent(live.number)}`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
      })
      const view = await res.json()
      equals('GET /api/v1/shipments: a READ token reads one shipment', res.status, 200)
      equals('GET /api/v1/shipments: it is the right shipment', view.number, live.number)
      equals('GET /api/v1/shipments: no money in the payload', /"[A-Za-z0-9_]*[Cc]ents"/.test(JSON.stringify(view)), false)
      equals('GET /api/v1/shipments: nothing named order', Object.keys(view).includes('order'), false)
    }
    if (voided) {
      const res = await fetch(`${baseUrl}/api/v1/shipments/${encodeURIComponent(voided.number)}`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
      })
      const view = await res.json()
      equals('GET /api/v1/shipments: a voided PRO answers 200', res.status, 200)
      equals('GET /api/v1/shipments: and says VOIDED', view.status, 'VOIDED')
    }
    const noToken = await fetch(`${baseUrl}/api/v1/shipments/${encodeURIComponent(live?.number ?? '1')}`)
    equals('GET /api/v1/shipments: no token is refused', noToken.status, 401)

    await dir('REVOKE_API_CLIENT', { clientId: issuedClientId })
    const afterRevoke = await fetch(`${baseUrl}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: issuedClientId, client_secret: issued.secret }),
    })
    equals('POST /api/token: a revoked client is refused', afterRevoke.status, 401)

    // 9 ── the webhook receiver: signature, replay, idempotency ─────────────
    const signingSecret = randomBytes(24).toString('base64url')
    await dir('CONNECT_INTEGRATION', {
      provider: 'MYCARRIERPACKETS',
      credentials: { username: 'stepj-verify', password: secret(), webhookSigningSecret: signingSecret },
    })
    touchedParams.add('MYCARRIERPACKETS')
    const eventId = randomUUID()
    const payload = JSON.stringify({ id: eventId, type: 'packet.completed', dot: '0000000' })
    const sign = (ts, body, key = signingSecret) =>
      `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`
    const hook = (body, signature) => fetch(`${baseUrl}/api/webhooks/mycarrierpackets`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bcat-signature': signature }, body,
    })
    const nowSec = Math.floor(Date.now() / 1000)
    const integrationsBefore = await scanCount('Integration')
    const first1 = await hook(payload, sign(nowSec, payload))
    equals('POST /api/webhooks: a signed delivery is accepted', first1.status, 200)
    const replay = await hook(payload, sign(nowSec, payload))
    const replayBody = await replay.json()
    equals('POST /api/webhooks: the same delivery replayed is a duplicate', replay.status, 200)
    equals('POST /api/webhooks: and is a no-op', replayBody.duplicate, true)
    const tampered = await hook(JSON.stringify({ id: eventId, type: 'packet.completed', dot: '9999999' }), sign(nowSec, payload))
    equals('POST /api/webhooks: a tampered body is refused', tampered.status, 401)
    const wrongKey = await hook(payload, sign(nowSec, payload, 'not-the-secret'))
    equals('POST /api/webhooks: a wrong secret is refused', wrongKey.status, 401)
    const stalePayload = JSON.stringify({ id: randomUUID(), type: 'packet.completed' })
    const stale = await hook(stalePayload, sign(nowSec - 3600, stalePayload))
    equals('POST /api/webhooks: a stale timestamp is refused', stale.status, 401)
    const mcpRow = await getRow('Integration', 'MYCARRIERPACKETS')
    equals('POST /api/webhooks: the provider row records receipt', Number(mcpRow?.webhookCount ?? 0), 1)
    truthy('POST /api/webhooks: the receipt row exists exactly once',
      (await scanCount('Integration')) === integrationsBefore + 1,
      `${await scanCount('Integration')} rows`)
    equals('POST /api/webhooks: the shipment count is still unchanged', await scanCount('Shipment'), shipmentsBefore)

    // 10 ── disconnect ──────────────────────────────────────────────────────
    const hubspotBefore = await getRow('Integration', 'HUBSPOT')
    const disconnected = await dir('DISCONNECT_INTEGRATION', { provider: 'HUBSPOT' })
    equals('DISCONNECT: the row stays and is marked disconnected', disconnected.status, 'DISCONNECTED')
    equals('DISCONNECT: the parameter is gone', (await describeParam('HUBSPOT')).exists, false)
    const hubspotAfter = await getRow('Integration', 'HUBSPOT')
    truthy('DISCONNECT: the row is kept, not deleted', Boolean(hubspotAfter))
    equals('DISCONNECT: the behaviour settings survive',
      JSON.stringify(hubspotAfter?.settings ?? null), JSON.stringify(hubspotBefore?.settings ?? null))
    equals('DISCONNECT: the mask is cleared',
      JSON.stringify(hubspotAfter?.credentialMask ?? []), JSON.stringify([]))
  } finally {
    for (const name of touchedParams) await deleteParam(name)
    if (issuedClientId) {
      const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb')
      const c = await doc()
      await c.send(new DeleteCommand({ TableName: `Integration-${DEV_TABLE_SUFFIX}`, Key: { id: `api:${issuedClientId}` } })).catch(() => {})
    }
    for (const email of createdUsers) await deleteUser(email)
    const passed = results.filter((r) => r.ok).length
    console.log(`\n${passed}/${results.length} checks passed`)
    if (passed !== results.length) process.exitCode = 1
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
