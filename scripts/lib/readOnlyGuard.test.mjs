import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createReadOnlyGuard, classifyGraphqlBody, operationTypes, parseReadOnlyConfig, blockWhenReadOnly, refuseReadOnlyFlag,
  buildBrowserStorage, ReadOnlyViolation,
} from './readOnlyGuard.mjs'

const URL_OK = 'https://abcdefghij1234567890klmnop.appsync-api.us-east-1.amazonaws.com/graphql'
const body = (query, variables = {}) => JSON.stringify({ query, variables })
const sdkClient = (serviceId) => ({ config: { serviceId }, send: vi.fn(async () => ({ ok: true })) })
const command = (name) => ({ constructor: { name: `${name}Command` } })
const guardWith = () => createReadOnlyGuard({ appsyncUrl: URL_OK, log: vi.fn() })

afterEach(() => { process.exitCode = 0 })

describe('fetch wrapper', () => {
  it('lets a query through and refuses a mutation before it reaches the network', async () => {
    const guard = guardWith()
    const fake = vi.fn(async () => ({ ok: true }))
    const f = guard.wrapFetch(fake)
    await f(URL_OK, { method: 'POST', body: body('query Q { listCustomers(limit: 1) { items { id } } }') })
    expect(fake).toHaveBeenCalledTimes(1)
    await expect(f(URL_OK, { method: 'POST', body: body('mutation M($i: UpdateLoadInput!) { updateLoad(input: $i) { id } }') })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(guard.stats.mutations).toBe(1)
  })

  it('a mutation hidden behind a query keyword, a comment or a second operation is still a mutation', () => {
    expect(classifyGraphqlBody(body('# query\nmutation { deleteLoad(input: {id: "1"}) { id } }')).mutations).toEqual(['deleteLoad'])
    expect(classifyGraphqlBody(body('query A { listLoads { items { id } } } mutation B { deleteLoad(input: {id: "1"}) { id } }')).mutations).toHaveLength(1)
    expect(operationTypes('query A($s: String = "mutation {") { a }')).toEqual(['query'])
  })

  it('allows a router mutation only when its action is a read verb', () => {
    const router = 'mutation($action:String!,$input:AWSJSON!){ tmsShipmentActions(action:$action,input:$input) }'
    expect(classifyGraphqlBody(body(router, { action: 'GET_SHIPMENT_BUNDLE' })).routerReads).toEqual(['tmsShipmentActions:GET_SHIPMENT_BUNDLE'])
    expect(classifyGraphqlBody(body(router, { action: 'VOID_SHIPMENT' })).mutations).toEqual(['tmsShipmentActions:VOID_SHIPMENT'])
    expect(classifyGraphqlBody(body(router, {})).mutations).toEqual(['tmsShipmentActions'])
  })

  it('classifies the app\'s own status/list reads as reads (CS_/AP_INBOX_ prefixes, verified extras) but not look-alike writes', () => {
    const router = (field) => `mutation($action:String!,$input:AWSJSON!){ ${field}(action:$action,input:$input) }`
    for (const [field, action] of [['tmsApInboxActions', 'AP_INBOX_STATUS'], ['tmsSpotActions', 'CS_STATUS'], ['tmsAljexImport', 'IMPORT_LIST'], ['tmsDataSafety', 'EXPORT_LIST']]) {
      expect(classifyGraphqlBody(body(router(field), { action })).mutations).toEqual([])
    }
    for (const [field, action] of [['tmsAljexImport', 'IMPORT_APPLY'], ['tmsDataSafety', 'EXPORT_NOW'], ['tmsApInboxActions', 'AP_INBOX_SYNC']]) {
      expect(classifyGraphqlBody(body(router(field), { action })).mutations).toEqual([`${field}:${action}`])
    }
  })

  it('refuses another host, a non-POST write method, and unparseable or persisted bodies', async () => {
    const guard = guardWith()
    const f = guard.wrapFetch(vi.fn(async () => ({})))
    await expect(f('https://example.com/x', { method: 'GET' })).rejects.toThrow(/refused/)
    await expect(f(URL_OK, { method: 'PUT', body: '{}' })).rejects.toThrow(/PUT/)
    await expect(f(URL_OK, { method: 'POST', body: 'not json' })).rejects.toThrow(/unparseable/)
    await expect(f(URL_OK, { method: 'POST', body: JSON.stringify({ extensions: { persistedQuery: {} } }) })).rejects.toThrow(/no query document/)
    expect(guard.stats.mutations).toBe(4)
  })

  it('the final assertion fails the run even when the caller swallowed the throw', async () => {
    const guard = guardWith()
    const f = guard.wrapFetch(vi.fn(async () => ({})))
    await f(URL_OK, { method: 'POST', body: body('mutation { createLoad(input: {}) { id } }') }).catch(() => {})
    expect(guard.assertZeroMutations()).toBe(false)
    expect(process.exitCode).toBe(1)
  })

  it('a clean run asserts mutations=0', () => {
    const guard = guardWith()
    expect(guard.assertZeroMutations()).toBe(true)
    expect(process.exitCode).toBe(0)
  })
})

describe('SDK clients', () => {
  it('a Cognito admin call throws and never reaches the client', async () => {
    const guard = guardWith()
    const raw = sdkClient('Cognito Identity Provider')
    await expect(guard.wrapSdkClient(raw).send(command('AdminCreateUser'))).rejects.toBeInstanceOf(ReadOnlyViolation)
    // a Cognito READ is refused too: read-only runs never touch the pool
    await expect(guard.wrapSdkClient(raw).send(command('ListUsers'))).rejects.toThrow(/Cognito/)
    expect(raw.send).not.toHaveBeenCalled()
    expect(guard.stats.mutations).toBe(2)
  })

  it('a DynamoDB PutItem throws; GetItem/Query/Scan pass', async () => {
    const guard = guardWith()
    const raw = sdkClient('DynamoDB')
    const ddb = guard.wrapSdkClient(raw)
    await expect(ddb.send(command('PutItem'))).rejects.toThrow(/not a read verb/)
    await expect(ddb.send(command('Put'))).rejects.toThrow(/not a read verb/)
    await expect(ddb.send(command('BatchWriteItem'))).rejects.toThrow()
    await expect(ddb.send(command('ExecuteStatement'))).rejects.toThrow()
    for (const name of ['GetItem', 'Query', 'Scan', 'BatchGetItem']) await ddb.send(command(name))
    expect(raw.send).toHaveBeenCalledTimes(4)
    expect(guard.stats.mutations).toBe(4)
  })

  it('S3 reads pass and PutObject / DeleteObject throw; SSM and Lambda are refused outright', async () => {
    const guard = guardWith()
    const s3 = guard.wrapSdkClient(sdkClient('S3'))
    await s3.send(command('GetObject'))
    await s3.send(command('ListObjectsV2'))
    await expect(s3.send(command('PutObject'))).rejects.toThrow()
    await expect(s3.send(command('DeleteObject'))).rejects.toThrow()
    await expect(guard.wrapSdkClient(sdkClient('SSM')).send(command('GetParameter'))).rejects.toThrow(/SSM/)
    await expect(guard.wrapSdkClient(sdkClient('Lambda')).send(command('Invoke'))).rejects.toThrow(/Lambda/)
  })

  it('blockWhenReadOnly makes a module-level Cognito client unusable only under --read-only', () => {
    const raw = sdkClient('Cognito Identity Provider')
    expect(blockWhenReadOnly(raw, ['node', 'x.mjs'])).toBe(raw)
    expect(() => blockWhenReadOnly(raw, ['node', 'x.mjs', '--read-only']).send(command('AdminGetUser'))).toThrow(ReadOnlyViolation)
  })

  it('writer harnesses refuse --read-only instead of ignoring it', () => {
    expect(() => refuseReadOnlyFlag('devVerifyR2.mjs', ['node', 'x', '--read-only'])).toThrow(/cannot run with --read-only/)
    expect(() => refuseReadOnlyFlag('devVerifyR2.mjs', ['node', 'x'])).not.toThrow()
  })
})

describe('browser interception verdicts', () => {
  const req = (over) => ({ method: 'POST', url: URL_OK, hasPostData: true, postData: body('query { listLoads { items { id } } }'), ...over })

  it('passes GETs and read queries, blocks and counts an AppSync mutation', () => {
    const guard = guardWith()
    expect(guard.decideBrowserRequest(req({ method: 'GET', url: 'https://x.example/app.js', postData: undefined }))).toEqual({ block: false })
    expect(guard.decideBrowserRequest(req({ method: 'OPTIONS' }))).toEqual({ block: false })
    expect(guard.decideBrowserRequest(req())).toEqual({ block: false })
    const v = guard.decideBrowserRequest(req({ postData: body('mutation { createShipment(input: {}) { id } }') }))
    expect(v.block).toBe(true)
    expect(guard.stats.mutations).toBe(1)
  })

  it('a write the app fires on page load is blocked and reported as a finding, not counted as a mutation; the same call from harness code still throws', async () => {
    const guard = guardWith()
    const sweep = body('mutation($action:String!,$input:AWSJSON!){ tmsShipmentActions(action:$action,input:$input) }', { action: 'SWEEP_EXPIRED_QUOTES', input: '{}' })
    expect(guard.decideBrowserRequest(req({ postData: sweep })).block).toBe(true)
    expect(guard.stats).toMatchObject({ mutations: 0, pageLoadWritesBlocked: 1 })
    expect(guard.assertZeroMutations()).toBe(true)
    await expect(guard.wrapFetch(vi.fn())(URL_OK, { method: 'POST', body: sweep })).rejects.toBeInstanceOf(ReadOnlyViolation)
    expect(guard.stats.mutations).toBe(1)
  })

  it('lets the session plumbing through (identity-pool credentials, refresh) but blocks any other AWS POST', () => {
    const guard = guardWith()
    const idp = (host, target, postData = '{}') => req({ url: `https://${host}.us-east-1.amazonaws.com/`, headers: { 'X-Amz-Target': target }, postData })
    expect(guard.decideBrowserRequest(idp('cognito-identity', 'AWSCognitoIdentityService.GetCredentialsForIdentity')).block).toBe(false)
    expect(guard.decideBrowserRequest(idp('cognito-idp', 'AWSCognitoIdentityProviderService.InitiateAuth', '{"AuthFlow":"REFRESH_TOKEN_AUTH"}')).block).toBe(false)
    expect(guard.decideBrowserRequest(idp('cognito-idp', 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken')).block).toBe(false)
    expect(guard.stats.mutations).toBe(0)
    expect(guard.decideBrowserRequest(idp('cognito-idp', 'AWSCognitoIdentityProviderService.InitiateAuth', '{"AuthFlow":"USER_PASSWORD_AUTH"}')).block).toBe(true)
    expect(guard.decideBrowserRequest(idp('cognito-idp', 'AWSCognitoIdentityProviderService.AdminCreateUser')).block).toBe(true)
    expect(guard.stats.mutations).toBe(2)
  })

  it('fails closed on an AppSync POST it cannot read, and on any AWS write; third-party beacons are blocked but not counted as mutations', () => {
    const guard = guardWith()
    expect(guard.decideBrowserRequest(req({ postData: undefined })).block).toBe(true)
    expect(guard.decideBrowserRequest(req({ url: 'https://cognito-idp.us-east-1.amazonaws.com/', postData: '{}' })).block).toBe(true)
    expect(guard.stats.mutations).toBe(2)
    expect(guard.decideBrowserRequest(req({ url: 'https://maps.googleapis.com/log', postData: '[]' })).block).toBe(true)
    expect(guard.stats.mutations).toBe(2)
    expect(guard.stats.blockedOther).toBe(1)
  })
})

describe('config', () => {
  const token = (over = {}, ageMin = 30) => {
    const payload = { token_use: 'id', exp: Math.floor(Date.now() / 1000) + ageMin * 60, iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_POOL', aud: 'client1', 'cognito:username': 'u1', 'cognito:groups': ['ADMIN'], ...over }
    return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
  }
  const argv = ['--read-only', `--prod-url=${URL_OK}`]

  it('never defaults the URL and refuses a non-AppSync host', () => {
    expect(() => parseReadOnlyConfig(['--read-only'], { BCAT_PROD_ID_TOKEN: token() })).toThrow(/never defaulted/)
    expect(() => parseReadOnlyConfig(['--read-only', '--prod-url=https://evil.example.com/graphql'], { BCAT_PROD_ID_TOKEN: token() })).toThrow(/plain/)
    expect(() => parseReadOnlyConfig(['--prod-url=' + URL_OK], { BCAT_PROD_ID_TOKEN: token() })).toThrow(/--read-only is required/)
  })

  it('needs an existing, unexpired ID token from env and optionally pins the pool', () => {
    expect(() => parseReadOnlyConfig(argv, {})).toThrow(/mints identities/)
    expect(() => parseReadOnlyConfig(argv, { BCAT_PROD_ID_TOKEN: token({}, 2) })).toThrow(/expires in/)
    expect(() => parseReadOnlyConfig(argv, { BCAT_PROD_ID_TOKEN: token({ token_use: 'access' }) })).toThrow(/ID token/)
    expect(() => parseReadOnlyConfig([...argv, '--expect-pool=us-east-1_OTHER'], { BCAT_PROD_ID_TOKEN: token() })).toThrow(/does not match/)
    const cfg = parseReadOnlyConfig([...argv, '--expect-pool=us-east-1_POOL'], { BCAT_PROD_ID_TOKEN: token() })
    expect(cfg.identity).toMatchObject({ pool: 'us-east-1_POOL', username: 'u1', groups: ['ADMIN'] })
    expect(JSON.stringify(cfg.identity)).not.toContain('h.')
  })

  it('browser storage needs all three tokens (Amplify treats a session without a refresh token as signed out)', () => {
    const cfg = parseReadOnlyConfig(argv, { BCAT_PROD_ID_TOKEN: token() })
    expect(() => buildBrowserStorage(cfg)).toThrow(/ACCESS_TOKEN/)
    expect(() => buildBrowserStorage({ ...cfg, accessToken: 'a.b.c' })).toThrow(/REFRESH_TOKEN/)
    const keys = Object.keys(buildBrowserStorage({ ...cfg, accessToken: 'a.b.c', refreshToken: 'r' }))
    expect(keys).toEqual(expect.arrayContaining(['CognitoIdentityServiceProvider.client1.u1.idToken', 'CognitoIdentityServiceProvider.client1.u1.refreshToken']))
  })
})
