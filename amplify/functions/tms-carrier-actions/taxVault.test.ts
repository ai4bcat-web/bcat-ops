/**
 * Tax-ID vault: handler + _shared/taxVault.ts behaviour (Docs/tms-build/AW_TAXID_DESIGN.md §4, §7).
 *
 * DynamoDB and KMS are fakes behind the real SDK clients' `send`. The fake KMS enforces the encryption context the
 * way KMS does (Decrypt with a different context fails) and records every call in one ordered log, so "audit row
 * BEFORE decrypt" is an assertion on that log. Every value used here comes from src/test/syntheticTaxIds.ts.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { KMSClient } from '@aws-sdk/client-kms'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { SYNTHETIC_EINS, SYNTHETIC_SSNS } from '../../../src/test/syntheticTaxIds'

type Row = Record<string, unknown>

vi.hoisted(() => {
  process.env.CARRIER_TABLE_NAME = 'Carrier-testapi-NONE'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-testapi-NONE'
})

const CARRIER = 'Carrier-testapi-NONE'
const AUDIT = 'AuditLog-testapi-NONE'
const VAULT = 'CarrierTaxVault-testapi'
const KEY_ALIAS = 'alias/bcat-tax-vault-testapi'
const MAC_ALIAS = 'alias/bcat-tax-vault-mac-testapi'

// ── Fake stores ──────────────────────────────────────────────────────────────

const tables = new Map<string, Map<string, Row>>()
const calls: string[] = []            // ordered: 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateMac', 'ddb:Put:<table>' ...
let kmsEncryptContexts: Array<Record<string, string>> = []
let kmsDecryptContexts: Array<Record<string, string>> = []
let kmsKeyIds: string[] = []
let failDecrypt = false

const tbl = (name: string): Map<string, Row> => {
  let t = tables.get(name)
  if (!t) tables.set(name, (t = new Map()))
  return t
}
const pkOf = (table: string): string => (table === VAULT ? 'carrierId' : 'id')

function cancel(reasons: string[]): Error {
  const e = new Error('Transaction cancelled')
  e.name = 'TransactionCanceledException'
  Object.assign(e, { CancellationReasons: reasons.map((Code) => ({ Code })) })
  return e
}
function conditional(): Error {
  const e = new Error('The conditional request failed')
  e.name = 'ConditionalCheckFailedException'
  return e
}

function project(item: Row, expr: unknown, names: Record<string, string>): Row {
  if (typeof expr !== 'string') return item
  const keep = expr.split(',').map((p) => p.trim()).map((p) => names[p] ?? p)
  return Object.fromEntries(Object.entries(item).filter(([k]) => keep.includes(k)))
}

function ddbSend(command: { constructor: { name: string }; input: Record<string, unknown> }): unknown {
  const input = command.input
  const name = command.constructor.name
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
  const vals = input.ExpressionAttributeValues ? (unmarshall(input.ExpressionAttributeValues as never) as Row) : {}
  switch (name) {
    case 'GetItemCommand': {
      const table = String(input.TableName)
      const key = unmarshall(input.Key as never) as Row
      const item = tbl(table).get(String(key[pkOf(table)]))
      return { Item: item ? marshall(project(item, input.ProjectionExpression, names), { removeUndefinedValues: true }) : undefined }
    }
    case 'PutItemCommand': {
      const table = String(input.TableName)
      calls.push(`ddb:Put:${table}`)
      const row = unmarshall(input.Item as never) as Row
      tbl(table).set(String(row[pkOf(table)]), row)
      return {}
    }
    case 'QueryCommand': {
      const table = String(input.TableName)
      const index = String(input.IndexName)
      const field = index === 'byFingerprint' ? 'fingerprint' : index === 'carriersByMcNumber' ? 'mcNumber' : index === 'carriersByDotNumber' ? 'dotNumber' : 'normalizedName'
      const rows = [...tbl(table).values()].filter((r) => r[field] !== undefined && (r[field] === vals[':f'] || r[field] === vals[':v']))
      const out = index === 'byFingerprint' ? rows.map((r) => ({ carrierId: r.carrierId, fingerprint: r.fingerprint })) : rows
      return { Items: out.map((r) => marshall(r, { removeUndefinedValues: true })) }
    }
    case 'ScanCommand': {
      const table = String(input.TableName)
      let rows = [...tbl(table).values()]
      if (String(input.FilterExpression ?? '').includes('attribute_exists(einNumber)')) rows = rows.filter((r) => r.einNumber != null)
      return { Items: rows.map((r) => marshall(r, { removeUndefinedValues: true })) }
    }
    case 'UpdateItemCommand': {
      const table = String(input.TableName)
      const key = unmarshall(input.Key as never) as Row
      const id = String(key[pkOf(table)])
      const expr = String(input.UpdateExpression)
      const row = tbl(table).get(id)
      if (expr.startsWith('ADD')) {
        const count = Number(row?.count ?? 0)
        if (row && count >= Number(vals[':max'])) throw conditional()
        tbl(table).set(id, { [pkOf(table)]: id, count: count + 1, ttlEpoch: vals[':ttl'] })
        return {}
      }
      if (expr === 'REMOVE einNumber') {
        if (row) delete row.einNumber
        return {}
      }
      throw new Error(`fake ddb: unhandled UpdateExpression ${expr}`)
    }
    case 'TransactWriteItemsCommand': {
      const items = input.TransactItems as Array<Record<string, Record<string, unknown>>>
      const reasons = items.map((it) => {
        const op = it.Put ?? it.Update ?? it.Delete
        const table = String(op.TableName)
        const key = it.Put ? (unmarshall(op.Item as never) as Row) : (unmarshall(op.Key as never) as Row)
        const id = String(key[pkOf(table)])
        const existing = tbl(table).get(id)
        const cond = String(op.ConditionExpression ?? '')
        const v = op.ExpressionAttributeValues ? (unmarshall(op.ExpressionAttributeValues as never) as Row) : {}
        if (cond === 'attribute_exists(id)' || cond === 'attribute_exists(carrierId)') return existing ? 'None' : 'ConditionalCheckFailed'
        if (cond.includes('version = :v')) return !existing || existing.version === v[':v'] ? 'None' : 'ConditionalCheckFailed'
        return 'None'
      })
      if (reasons.some((r) => r !== 'None')) throw cancel(reasons)
      for (const it of items) {
        if (it.Put) {
          const table = String(it.Put.TableName)
          calls.push(`ddb:Transact:Put:${table}`)
          const row = unmarshall(it.Put.Item as never) as Row
          tbl(table).set(String(row[pkOf(table)]), row)
        } else if (it.Delete) {
          const table = String(it.Delete.TableName)
          tbl(table).delete(String((unmarshall(it.Delete.Key as never) as Row)[pkOf(table)]))
        } else if (it.Update) {
          const table = String(it.Update.TableName)
          const id = String((unmarshall(it.Update.Key as never) as Row)[pkOf(table)])
          const row = tbl(table).get(id) ?? {}
          const v = it.Update.ExpressionAttributeValues ? (unmarshall(it.Update.ExpressionAttributeValues as never) as Row) : {}
          const expr = String(it.Update.UpdateExpression)
          if (expr.startsWith('SET')) Object.assign(row, { taxIdLast4: v[':l'], taxIdType: v[':t'], taxIdOnFileAt: v[':a'] })
          else for (const f of ['taxIdLast4', 'taxIdType', 'taxIdOnFileAt']) delete row[f]
        }
      }
      return {}
    }
    default:
      throw new Error(`fake ddb: unhandled ${name}`)
  }
}

/** Encrypt = reversible but unreadable-as-text; carries the context so Decrypt can enforce it. */
function kmsSend(command: { constructor: { name: string }; input: Record<string, unknown> }): unknown {
  const input = command.input
  switch (command.constructor.name) {
    case 'GenerateMacCommand': {
      calls.push('kms:GenerateMac')
      kmsKeyIds.push(String(input.KeyId))
      return { Mac: createHmac('sha256', 'test-mac-key').update(Buffer.from(input.Message as Uint8Array)).digest() }
    }
    case 'EncryptCommand': {
      calls.push('kms:Encrypt')
      kmsKeyIds.push(String(input.KeyId))
      kmsEncryptContexts.push(input.EncryptionContext as Record<string, string>)
      const plain = Buffer.from(input.Plaintext as Uint8Array).toString('utf8')
      const blob = Buffer.from(JSON.stringify({ c: input.EncryptionContext, p: [...plain].reverse().map((d) => String.fromCharCode(d.charCodeAt(0) + 40)).join('') }))
      return { CiphertextBlob: blob, KeyId: 'arn:aws:kms:us-east-1:000000000000:key/test-key' }
    }
    case 'DecryptCommand': {
      calls.push('kms:Decrypt')
      kmsKeyIds.push(String(input.KeyId))
      kmsDecryptContexts.push(input.EncryptionContext as Record<string, string>)
      if (failDecrypt) throw new Error('KMS is unavailable')
      const parsed = JSON.parse(Buffer.from(input.CiphertextBlob as Uint8Array).toString('utf8')) as { c: Record<string, string>; p: string }
      if (JSON.stringify(parsed.c) !== JSON.stringify(input.EncryptionContext)) {
        const e = new Error('The ciphertext refers to a customer master key that does not exist')
        e.name = 'InvalidCiphertextException'
        throw e
      }
      return { Plaintext: Buffer.from([...parsed.p].reverse().map((d) => String.fromCharCode(d.charCodeAt(0) - 40)).join(''), 'utf8') }
    }
    default:
      throw new Error('fake kms: unhandled command')
  }
}

import { handler } from './handler'
import { importTaxIds, normalizeTaxId, redactTaxIds, revealTaxId, setTaxId, vaultNamesFor, PRODUCTION_API_ID, type VaultDeps } from '../_shared/taxVault'

// ── Console capture ──────────────────────────────────────────────────────────

let logged: string[] = []
beforeEach(() => {
  tables.clear()
  calls.length = 0
  kmsEncryptContexts = []
  kmsDecryptContexts = []
  kmsKeyIds = []
  failDecrypt = false
  logged = []
  vi.spyOn(DynamoDBClient.prototype, 'send').mockImplementation(((c: never) => Promise.resolve(ddbSend(c))) as never)
  vi.spyOn(KMSClient.prototype, 'send').mockImplementation(((c: never) => Promise.resolve().then(() => kmsSend(c))) as never)
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) })
  }
  tbl(CARRIER).set('c1', { id: 'c1', name: 'One Trucking', mcNumber: 'MC111', dotNumber: '1001', aljexCode: 'ALJ1' })
  tbl(CARRIER).set('c2', { id: 'c2', name: 'Two Trucking', mcNumber: 'MC222', dotNumber: '2002', aljexCode: 'ALJ2' })
  tbl(CARRIER).set('c3', { id: 'c3', name: 'Three Trucking', mcNumber: 'MC333', dotNumber: '3003', aljexCode: 'ALJ3' })
})
afterEach(() => vi.restoreAllMocks())

const ADMIN = { sub: 'a', username: 'ryne@bcatcorp.com', claims: { email: 'ryne@bcatcorp.com' }, sourceIp: ['203.0.113.9'] }
const ADMIN_GROUP = { sub: 'g', username: 'jenny@bcatcorp.com', claims: { email: 'jenny@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
const CARRIER_USER = { sub: 'u', username: 'dispatch@bcatcorp.com', claims: { email: 'dispatch@bcatcorp.com', 'cognito:groups': ['page-carriers'] } }

const call = (action: string, input: Row, identity: unknown = ADMIN): Promise<Row> =>
  handler({ arguments: { action, input: JSON.stringify(input) }, identity } as never)
const internal = (event: Row): Promise<Row> => handler(event as never)

const EIN = SYNTHETIC_EINS[0]!
const EIN2 = SYNTHETIC_EINS[1]!
const SSN = SYNTHETIC_SSNS[0]!
const digits = (v: string): string => v.replace(/\D/g, '')

/** Every string reachable in every non-Binary attribute of every stored item (plus everything logged). */
function everythingVisible(): string {
  const parts: string[] = [...logged]
  for (const t of tables.values()) {
    for (const row of t.values()) {
      for (const [k, v] of Object.entries(row)) {
        if (v instanceof Uint8Array) continue
        parts.push(k, typeof v === 'string' ? v : JSON.stringify(v))
      }
    }
  }
  return parts.join('\n')
}
const expectNoValue = (...values: string[]): void => {
  const haystack = everythingVisible()
  for (const v of values) {
    expect(haystack).not.toContain(v)
    expect(haystack).not.toContain(digits(v))
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

describe('normalizeTaxId', () => {
  // A valid-prefix EIN/SSN built at runtime: no tax-shaped literal lives in this file.
  const realShapedEin = `${'10'}${'0000001'}`
  const realShapedSsn = `${'123'}${'45'}${'6789'}`

  it('classifies by punctuation, or by the type given, and strips non-digits', () => {
    expect(normalizeTaxId(EIN, undefined, { allowSynthetic: true })).toMatchObject({ digits: digits(EIN), type: 'EIN' })
    expect(normalizeTaxId(SSN, undefined, { allowSynthetic: true })).toMatchObject({ digits: digits(SSN), type: 'SSN' })
    expect(normalizeTaxId(realShapedEin, 'EIN')).toMatchObject({ type: 'EIN', synthetic: false })
    expect(normalizeTaxId(realShapedSsn, 'SSN')).toMatchObject({ type: 'SSN', synthetic: false })
  })
  it('needs a type when the punctuation does not say', () => {
    expect(() => normalizeTaxId(realShapedEin)).toThrow('type (EIN or SSN) is required')
  })
  it('refuses a type that contradicts the punctuation, wrong length, and never-issued prefixes', () => {
    expect(() => normalizeTaxId(EIN, 'SSN', { allowSynthetic: true })).toThrow('does not match')
    expect(() => normalizeTaxId('12-34567', 'EIN')).toThrow('9 digits')
    expect(() => normalizeTaxId(`${'17'}${'0000001'}`, 'EIN')).toThrow('not a valid EIN')
    expect(() => normalizeTaxId(`${'123'}${'00'}${'6789'}`, 'SSN')).toThrow('not a valid SSN')
    expect(() => normalizeTaxId(`${'123'}${'45'}${'0000'}`, 'SSN')).toThrow('not a valid SSN')
  })
  it('accepts the IRS-impossible synthetic prefixes only when allowed', () => {
    expect(() => normalizeTaxId(EIN)).toThrow('not a valid EIN')
    expect(() => normalizeTaxId(SSN)).toThrow('not a valid SSN')
    expect(normalizeTaxId(EIN, undefined, { allowSynthetic: true }).synthetic).toBe(true)
  })
  it('error messages never carry the value', () => {
    for (const bad of [EIN, `${EIN}9`, SSN]) {
      try { normalizeTaxId(bad) } catch (e) { expect(String((e as Error).message)).not.toMatch(/\d{4}/) }
    }
  })
  it('redacts every tax-id shape from free text', () => {
    expect(redactTaxIds(`for ${EIN} and ${SSN} and ${digits(EIN)}`)).toBe('for [redacted] and [redacted] and [redacted]')
  })
})

describe('production refuses synthetic IDs', () => {
  it('setTaxId on the production API id rejects the synthetic prefixes before any KMS call', async () => {
    const deps: VaultDeps = {
      dynamo: { send: ((c: never) => Promise.resolve(ddbSend(c))) as never },
      kms: { send: ((c: never) => Promise.resolve(kmsSend(c))) as never },
      carrierTable: 'Carrier-x-NONE', auditTable: AUDIT, names: vaultNamesFor(`Carrier-${PRODUCTION_API_ID}-NONE`),
    }
    await expect(setTaxId(deps, { carrierId: 'c1', value: EIN, source: 'MANUAL', setBy: 'x' })).rejects.toThrow('not a valid EIN')
    expect(calls).toEqual([])
  })
})

// ── SET ─────────────────────────────────────────────────────────────────────

describe('SET_TAX_ID', () => {
  it('encrypts under the exact context, stores ciphertext + masked mirror, and leaks the value nowhere', async () => {
    const out = await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    expect(out).toEqual({ ok: true, last4: digits(EIN).slice(-4), type: 'EIN', unchanged: false })
    expect(kmsEncryptContexts).toEqual([{ carrierId: 'c1', field: 'taxId', api: 'testapi' }])
    expect(kmsKeyIds).toEqual([MAC_ALIAS, KEY_ALIAS])

    const vault = tbl(VAULT).get('c1')!
    expect(vault).toMatchObject({ carrierId: 'c1', type: 'EIN', last4: digits(EIN).slice(-4), source: 'MANUAL', setBy: 'ryne@bcatcorp.com', version: 1 })
    expect(vault.ciphertext).toBeInstanceOf(Uint8Array)
    expect(vault.fingerprint).toEqual(expect.any(String))
    expect(tbl(CARRIER).get('c1')).toMatchObject({ taxIdLast4: digits(EIN).slice(-4), taxIdType: 'EIN', taxIdOnFileAt: expect.any(String) })
    expect(tbl(CARRIER).get('c1')).not.toHaveProperty('einNumber')

    const audit = [...tbl(AUDIT).values()].find((r) => r.action === 'TAX_ID_SET')!
    expect(audit).toMatchObject({ entityType: 'CARRIER', entityId: 'c1', user: 'ryne@bcatcorp.com' })
    expect(JSON.parse(String(audit.changes))).toEqual({ last4: digits(EIN).slice(-4), type: 'EIN', source: 'MANUAL', previousLast4: null })
    expectNoValue(EIN)
    expect(JSON.stringify(out)).not.toContain(digits(EIN))
  })

  it('is ADMIN-only: a page-carriers user is refused before any KMS or vault call', async () => {
    await expect(call('SET_TAX_ID', { carrierId: 'c1', value: EIN }, CARRIER_USER)).rejects.toThrow('Forbidden')
    expect(calls).toEqual([])
    expect(tbl(VAULT).size).toBe(0)
  })

  it('accepts the ADMIN group, not only the owner', async () => {
    await expect(call('SET_TAX_ID', { carrierId: 'c1', value: SSN }, ADMIN_GROUP)).resolves.toMatchObject({ ok: true, type: 'SSN' })
  })

  it('refuses an invalid value with a fixed sentence and stores nothing', async () => {
    await expect(call('SET_TAX_ID', { carrierId: 'c1', value: '12-345' })).rejects.toThrow('Tax ID must have 9 digits')
    await expect(call('SET_TAX_ID', { carrierId: 'c1', value: digits(EIN) })).rejects.toThrow('type (EIN or SSN) is required')
    expect(calls.filter((c) => c.startsWith('kms:'))).toEqual([])
    expect(tbl(VAULT).size).toBe(0)
  })

  it('a malformed JSON body gets a fixed error, not the parser message that quotes the input', async () => {
    const body = `{"carrierId":"c1","value":"${EIN}"`   // truncated
    await expect(handler({ arguments: { action: 'SET_TAX_ID', input: body }, identity: ADMIN } as never)).rejects.toThrow(/^Invalid input$/)
  })

  it('refuses a number already on another carrier, naming the carrier and never the value', async () => {
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    const out = await call('SET_TAX_ID', { carrierId: 'c2', value: EIN })
    expect(out).toEqual({ ok: false, duplicateOf: 'c1' })
    expect(tbl(VAULT).has('c2')).toBe(false)
    expect(tbl(CARRIER).get('c2')).not.toHaveProperty('taxIdLast4')
    expectNoValue(EIN)
  })

  it('the same value again on the same carrier is unchanged and makes no Encrypt call', async () => {
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    calls.length = 0
    const out = await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    expect(out).toMatchObject({ ok: true, unchanged: true })
    expect(calls).not.toContain('kms:Encrypt')
  })

  it('a changed value bumps the version and records previousLast4', async () => {
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN2 })
    expect(tbl(VAULT).get('c1')!.version).toBe(2)
    const audits = [...tbl(AUDIT).values()].filter((r) => r.action === 'TAX_ID_SET').map((r) => JSON.parse(String(r.changes)))
    expect(audits[audits.length - 1]).toMatchObject({ previousLast4: digits(EIN).slice(-4), last4: digits(EIN2).slice(-4) })
    expectNoValue(EIN, EIN2)
  })

  it('a missing carrier writes no vault item', async () => {
    await expect(call('SET_TAX_ID', { carrierId: 'nope', value: EIN })).rejects.toThrow('Carrier not found')
    expect(tbl(VAULT).size).toBe(0)
  })

  it('a KMS failure surfaces a generic error, never the value', async () => {
    vi.mocked(KMSClient.prototype.send).mockImplementation((() => Promise.reject(new Error(`boom ${EIN}`))) as never)
    const err = await call('SET_TAX_ID', { carrierId: 'c1', value: EIN }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Tax ID store unavailable')
    expectNoValue(EIN)
  })
})

// ── STATUS ──────────────────────────────────────────────────────────────────

describe('GET_TAX_ID_STATUS', () => {
  it('serves any carrier-page user the masked facts with no KMS call and no ciphertext', async () => {
    expect(await call('GET_TAX_ID_STATUS', { carrierId: 'c1' }, CARRIER_USER)).toMatchObject({ onFile: false, last4: null })
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    calls.length = 0
    const out = await call('GET_TAX_ID_STATUS', { carrierId: 'c1' }, CARRIER_USER)
    expect(out).toEqual({ onFile: true, last4: digits(EIN).slice(-4), type: 'EIN', setAt: expect.any(String), source: 'MANUAL' })
    expect(calls).toEqual([])
    expect(JSON.stringify(out)).not.toContain('ciphertext')
  })
})

// ── REVEAL ──────────────────────────────────────────────────────────────────

describe('REVEAL_TAX_ID', () => {
  beforeEach(async () => {
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    calls.length = 0
    kmsDecryptContexts = []
  })

  it('returns the formatted value for 30 seconds, after an audit row that carries reason/last4/ip but not the value', async () => {
    const out = await call('REVEAL_TAX_ID', { carrierId: 'c1', reason: '1099 prep for the year' })
    expect(out).toEqual({ value: EIN, expiresInSeconds: 30 })
    const audit = [...tbl(AUDIT).values()].find((r) => r.action === 'TAX_ID_REVEALED')!
    expect(audit).toMatchObject({ entityId: 'c1', user: 'ryne@bcatcorp.com' })
    expect(JSON.parse(String(audit.changes))).toEqual({ reason: '1099 prep for the year', last4: digits(EIN).slice(-4), type: 'EIN', ip: '203.0.113.9' })
    expect(JSON.stringify([...tbl(AUDIT).values()])).not.toContain(digits(EIN))
    expectNoValue(EIN)
  })

  it('writes the audit row BEFORE Decrypt, and decrypts with the exact encryption context and key', async () => {
    await call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'factor setup call' })
    expect(calls.indexOf(`ddb:Put:${AUDIT}`)).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf(`ddb:Put:${AUDIT}`)).toBeLessThan(calls.indexOf('kms:Decrypt'))
    expect(kmsDecryptContexts).toEqual([{ carrierId: 'c1', field: 'taxId', api: 'testapi' }])
    expect(kmsKeyIds[kmsKeyIds.length - 1]).toBe(KEY_ALIAS)
  })

  it('leaves the audit row even when Decrypt throws, and the error is generic', async () => {
    failDecrypt = true
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'factor setup call' })).rejects.toThrow('Tax ID store unavailable')
    expect([...tbl(AUDIT).values()].some((r) => r.action === 'TAX_ID_REVEALED')).toBe(true)
  })

  it('does not decrypt when the audit row cannot be written', async () => {
    const real = ddbSend
    void real
    vi.mocked(DynamoDBClient.prototype.send).mockImplementation(((c: { constructor: { name: string }; input: Record<string, unknown> }) =>
      c.constructor.name === 'PutItemCommand' ? Promise.reject(new Error('audit down')) : Promise.resolve(ddbSend(c))) as never)
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'factor setup call' })).rejects.toThrow('Audit log write failed')
    expect(calls).not.toContain('kms:Decrypt')
  })

  it('refuses a missing or short reason before any KMS or vault call', async () => {
    for (const reason of [undefined, '', '   ', 'short']) {
      await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason })).rejects.toThrow('reason of at least 8')
    }
    expect(calls).toEqual([])
  })

  it('refuses a page-carriers user and a non-admin before any KMS call', async () => {
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'curious about it' }, CARRIER_USER)).rejects.toThrow('Forbidden')
    expect(calls).toEqual([])
  })

  it('is rate limited to 20 per admin per hour: the 21st is refused with no Decrypt and no audit row', async () => {
    for (let i = 0; i < 20; i++) await call('REVEAL_TAX_ID', { carrierId: 'c1', reason: `routine check ${i}` })
    const decrypts = calls.filter((c) => c === 'kms:Decrypt').length
    const audits = [...tbl(AUDIT).values()].filter((r) => r.action === 'TAX_ID_REVEALED').length
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'one more please' })).rejects.toThrow('Reveal limit reached')
    expect(calls.filter((c) => c === 'kms:Decrypt').length).toBe(decrypts)
    expect([...tbl(AUDIT).values()].filter((r) => r.action === 'TAX_ID_REVEALED').length).toBe(audits)
    // another admin has their own budget
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c1', reason: 'second admin check' }, ADMIN_GROUP)).resolves.toMatchObject({ value: EIN })
    const rl = [...tbl(VAULT).values()].find((r) => String(r.carrierId).startsWith('rl#ryne@bcatcorp.com#'))!
    expect(rl.count).toBe(20)
    expect(rl.ttlEpoch).toEqual(expect.any(Number))
  })

  it('a ciphertext moved to another carrier does not decrypt (context mismatch) and reveals nothing', async () => {
    tbl(VAULT).set('c2', { ...tbl(VAULT).get('c1')!, carrierId: 'c2' })
    const err = await call('REVEAL_TAX_ID', { carrierId: 'c2', reason: 'checking the copy' }).catch((e: Error) => e)
    expect((err as Error).message).toBe('Tax ID store unavailable')
    expect(JSON.stringify(err)).not.toContain(digits(EIN))
    expect(kmsDecryptContexts).toEqual([{ carrierId: 'c2', field: 'taxId', api: 'testapi' }])
  })

  it('redacts a number typed into the reason before it reaches the audit row', async () => {
    await call('REVEAL_TAX_ID', { carrierId: 'c1', reason: `customer said it is ${EIN} on the W-9` })
    const audit = [...tbl(AUDIT).values()].find((r) => r.action === 'TAX_ID_REVEALED')!
    expect(String(audit.changes)).toContain('[redacted]')
    expectNoValue(EIN)
  })

  it('says so when nothing is on file, without spending the rate limit', async () => {
    await expect(call('REVEAL_TAX_ID', { carrierId: 'c2', reason: 'checking for the file' })).rejects.toThrow('No tax ID on file')
    expect([...tbl(VAULT).keys()].some((k) => k.startsWith('rl#'))).toBe(false)
  })
})

// ── CLEAR ───────────────────────────────────────────────────────────────────

describe('CLEAR_TAX_ID', () => {
  it('deletes the vault item, removes the mirror, audits, and is ADMIN-only with a reason', async () => {
    await call('SET_TAX_ID', { carrierId: 'c1', value: EIN })
    await expect(call('CLEAR_TAX_ID', { carrierId: 'c1', reason: 'carrier asked us to' }, CARRIER_USER)).rejects.toThrow('Forbidden')
    await expect(call('CLEAR_TAX_ID', { carrierId: 'c1', reason: 'x' })).rejects.toThrow('reason of at least 8')
    expect(await call('CLEAR_TAX_ID', { carrierId: 'c1', reason: 'carrier asked us to' })).toEqual({ ok: true, cleared: true })
    expect(tbl(VAULT).has('c1')).toBe(false)
    expect(tbl(CARRIER).get('c1')).not.toHaveProperty('taxIdLast4')
    expect(tbl(CARRIER).get('c1')).not.toHaveProperty('taxIdOnFileAt')
    const audit = [...tbl(AUDIT).values()].find((r) => r.action === 'TAX_ID_CLEARED')!
    expect(JSON.parse(String(audit.changes))).toMatchObject({ reason: 'carrier asked us to', previousLast4: digits(EIN).slice(-4) })
    expectNoValue(EIN)
  })
})

// ── IMPORT (internal) ───────────────────────────────────────────────────────

describe('IMPORT_TAX_IDS', () => {
  const rows = () => [
    { aljexCarrierId: 'A1', mcNumber: 'MC111', dotNumber: '', value: EIN },            // by MC
    { aljexCarrierId: 'A2', mcNumber: '', dotNumber: '2002', value: SSN },            // by DOT
    { aljexCarrierId: 'ALJ3', mcNumber: '', dotNumber: '', value: EIN2 },             // by Aljex code
    { aljexCarrierId: 'A4', mcNumber: 'MC999', dotNumber: '', value: SYNTHETIC_EINS[2]! },  // unmatched
    { aljexCarrierId: 'ALJ1', mcNumber: '', dotNumber: '', value: '12-345' },         // invalid (matches c1)
  ]

  it('sets, counts, and returns counts and ids only: no value, no last four, nothing logged', async () => {
    const out = await internal({ internal: 'IMPORT_TAX_IDS', rows: rows() })
    expect(out).toEqual({ set: 3, unchanged: 0, duplicates: [], invalidFormat: 1, unmatched: ['A4'], failed: 0, firstErrorName: null })
    expect(tbl(VAULT).get('c1')).toMatchObject({ source: 'ALJEX', setBy: 'aljex-import' })
    const text = JSON.stringify(out)
    for (const v of [EIN, SSN, EIN2]) {
      expect(text).not.toContain(digits(v))
      expect(text).not.toContain(digits(v).slice(-4))
    }
    expectNoValue(EIN, SSN, EIN2, SYNTHETIC_EINS[2]!)
    expect(logged).toEqual([])
    expect(kmsEncryptContexts.map((c) => c.carrierId).sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('is idempotent: a re-run is all unchanged and encrypts nothing', async () => {
    await internal({ internal: 'IMPORT_TAX_IDS', rows: rows() })
    kmsEncryptContexts = []
    const out = await internal({ internal: 'IMPORT_TAX_IDS', rows: rows().slice(0, 3) })
    expect(out).toMatchObject({ set: 0, unchanged: 3 })
    expect(kmsEncryptContexts).toEqual([])
  })

  it('reports a number found on two carriers as a duplicate, by id, and writes only the first', async () => {
    const out = await internal({ internal: 'IMPORT_TAX_IDS', rows: [
      { aljexCarrierId: 'A1', mcNumber: 'MC111', dotNumber: '', value: EIN },
      { aljexCarrierId: 'A2', mcNumber: 'MC222', dotNumber: '', value: EIN },
    ] })
    expect(out).toMatchObject({ set: 1, duplicates: [{ carrierId: 'c2', duplicateOfCarrierId: 'c1' }] })
    expect(tbl(VAULT).has('c2')).toBe(false)
  })

  it('counts KMS failures without a message', async () => {
    vi.mocked(KMSClient.prototype.send).mockImplementation((() => Promise.reject(Object.assign(new Error(`denied ${EIN}`), { name: 'AccessDeniedException' }))) as never)
    const out = await internal({ internal: 'IMPORT_TAX_IDS', rows: rows().slice(0, 2) })
    expect(out).toMatchObject({ set: 0, failed: 2, firstErrorName: 'AccessDeniedException' })
    expect(JSON.stringify(out)).not.toContain(digits(EIN))
  })

  it('takes at most 100 rows per call', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ aljexCarrierId: `X${i}`, mcNumber: '', dotNumber: '', value: EIN }))
    await expect(internal({ internal: 'IMPORT_TAX_IDS', rows: many })).rejects.toThrow('At most 100 rows')
  })

  it('is not reachable through AppSync: an AppSync-shaped event never takes the internal path', async () => {
    await expect(handler({ arguments: { action: 'IMPORT_TAX_IDS', input: '{}' }, identity: ADMIN, internal: 'IMPORT_TAX_IDS', rows: rows() } as never)).rejects.toThrow()
    expect(tbl(VAULT).size).toBe(0)
  })

  it('importTaxIds validates through the same path the actions use (pure call, injected resolver)', async () => {
    const deps: VaultDeps = {
      dynamo: { send: ((c: never) => Promise.resolve(ddbSend(c))) as never },
      kms: { send: ((c: never) => Promise.resolve(kmsSend(c))) as never },
      carrierTable: CARRIER, auditTable: AUDIT, names: vaultNamesFor(CARRIER),
    }
    const out = await importTaxIds(deps, [{ aljexCarrierId: 'A1', mcNumber: '', dotNumber: '', value: EIN }], async () => 'c1')
    expect(out.set).toBe(1)
  })
})

// ── MIGRATE_EIN_FIELD ───────────────────────────────────────────────────────

describe('MIGRATE_EIN_FIELD', () => {
  beforeEach(() => {
    tbl(CARRIER).get('c1')!.einNumber = EIN
    tbl(CARRIER).get('c2')!.einNumber = EIN              // duplicate of c1
    tbl(CARRIER).get('c3')!.einNumber = 'not a number'
  })

  it('a dry run counts and changes nothing', async () => {
    const out = await internal({ internal: 'MIGRATE_EIN_FIELD', dryRun: true })
    expect(out).toMatchObject({ withEin: 3, migrated: 0, removed: 0, dryRun: true })
    expect(tbl(CARRIER).get('c1')!.einNumber).toBe(EIN)
    expect(calls).toEqual([])
  })

  it('moves every clear value into the vault and leaves no einNumber on any Carrier row', async () => {
    const out = await internal({ internal: 'MIGRATE_EIN_FIELD' })
    expect(out).toMatchObject({ withEin: 3, migrated: 1, duplicateDropped: 1, invalidDropped: 1, failed: 0, removed: 3 })
    for (const c of tbl(CARRIER).values()) expect(c).not.toHaveProperty('einNumber')
    expect(tbl(CARRIER).get('c1')).toMatchObject({ taxIdLast4: digits(EIN).slice(-4), taxIdType: 'EIN' })
    expect(tbl(VAULT).get('c1')).toMatchObject({ source: 'MANUAL', setBy: 'ein-migration' })
    expect(JSON.stringify(out)).not.toContain(digits(EIN))
    expectNoValue(EIN)
  })

  it('refuses to run against the production API', async () => {
    vi.resetModules()
    const prev = process.env.CARRIER_TABLE_NAME
    process.env.CARRIER_TABLE_NAME = `Carrier-${PRODUCTION_API_ID}-NONE`
    try {
      // dynamic: the handler reads CARRIER_TABLE_NAME at module load, so a fresh module is the only way to test the production id
      const fresh = await import('./handler')
      await expect(fresh.handler({ internal: 'MIGRATE_EIN_FIELD' } as never)).rejects.toThrow('dev and rehearsal only')
    } finally {
      process.env.CARRIER_TABLE_NAME = prev
    }
  })
})

// ── The Carrier row stays clean ─────────────────────────────────────────────

describe('UPSERT_CARRIER no longer carries a tax ID', () => {
  it('ignores a stray einNumber in the input: it is not written and not logged', async () => {
    const out = await call('UPSERT_CARRIER', { name: 'Fresh Freight', type: 'TL', einNumber: EIN })
    expect(out).not.toHaveProperty('einNumber')
    const stored = [...tbl(CARRIER).values()].find((r) => r.name === 'Fresh Freight')!
    expect(stored).not.toHaveProperty('einNumber')
    expectNoValue(EIN)
  })
})

describe('revealTaxId (library): reason length bound', () => {
  it('refuses an oversized reason', async () => {
    const deps: VaultDeps = {
      dynamo: { send: ((c: never) => Promise.resolve(ddbSend(c))) as never },
      kms: { send: ((c: never) => Promise.resolve(kmsSend(c))) as never },
      carrierTable: CARRIER, auditTable: AUDIT, names: vaultNamesFor(CARRIER),
    }
    await expect(revealTaxId(deps, { carrierId: 'c1', reason: 'x'.repeat(501), user: 'a@b.c' })).rejects.toThrow('too long')
  })
})
