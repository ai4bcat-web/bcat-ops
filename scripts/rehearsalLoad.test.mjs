import { describe, it, expect } from 'vitest'
import {
  rehearsalSuffix,
  assertBackupPath,
  assertFilesBucket,
  branchIsDevStack,
  parseLine,
  chunk,
  batchPut,
  parseArgv,
  PROD_BUCKET,
  DEV_BUCKET,
} from './rehearsalLoad.mjs'

describe('guards', () => {
  it('refuses production and dev api ids and malformed ids', () => {
    expect(() => rehearsalSuffix('5ucwdyvwivelbo4k4jomvrwel4')).toThrow(/PRODUCTION/)
    expect(() => rehearsalSuffix('nc3jsnxdmjhkpequimypiatkma')).toThrow(/DEV/)
    expect(() => rehearsalSuffix('Load-5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow()
    expect(rehearsalSuffix('abcdefghij0123456789abcd12')).toBe('abcdefghij0123456789abcd12-NONE')
  })
  it('accepts only paths that resolve under ~/bcat-ops-backups', () => {
    const rp = (p) => p
    expect(assertBackupPath('/h/bcat-ops-backups/x/tables-main', '/h', rp)).toBe('/h/bcat-ops-backups/x/tables-main')
    expect(() => assertBackupPath('/h/other/tables-main', '/h', rp)).toThrow(/under/)
    expect(() => assertBackupPath('/h/bcat-ops-backups/../other', '/h', rp)).toThrow(/under/)
    expect(() => assertBackupPath('/h/bcat-ops-backups', '/h', rp)).toThrow(/under/)
    expect(() => assertBackupPath('/nope', '/h', () => { throw new Error('ENOENT') })).toThrow(/does not exist/)
  })
  it('refuses prod and dev files buckets', () => {
    expect(() => assertFilesBucket(PROD_BUCKET)).toThrow(/PRODUCTION/)
    expect(() => assertFilesBucket(DEV_BUCKET)).toThrow(/DEV/)
    expect(assertFilesBucket('amplify-d3dejqzs77khq6-re-bcatrateconfirmsbucketf4-abc')).toMatch(/-re-/)
  })
  it('requires BCAT_DEV_STACK to be exactly "true"', () => {
    expect(branchIsDevStack({ BCAT_DEV_STACK: 'true' })).toBe(true)
    expect(branchIsDevStack({ BCAT_DEV_STACK: 'false' })).toBe(false)
    expect(branchIsDevStack(undefined)).toBe(false)
  })
})

describe('parseLine', () => {
  it('parses bare and Item-wrapped DynamoDB JSON, skips blanks, rejects non-DynamoDB JSON', () => {
    expect(parseLine('{"id":{"S":"1"},"n":{"N":"2"}}')).toEqual({ id: { S: '1' }, n: { N: '2' } })
    expect(parseLine('{"Item":{"id":{"S":"1"}}}')).toEqual({ id: { S: '1' } })
    expect(parseLine('  ')).toBeNull()
    expect(() => parseLine('{"id":"plain"}')).toThrow(/DynamoDB-JSON/)
    expect(() => parseLine('{bad')).toThrow(/malformed/)
    expect(() => parseLine('{}')).toThrow(/empty/)
  })
})

describe('batching', () => {
  it('chunks by 25', () => {
    expect(chunk(Array.from({ length: 60 }, (_, i) => i)).map((c) => c.length)).toEqual([25, 25, 10])
  })
  it('retries unprocessed items with backoff and reports leftovers as failed', async () => {
    const items = [{ id: { S: 'a' } }, { id: { S: 'b' } }, { id: { S: 'c' } }]
    const sleeps = []
    const calls = []
    const send = async (cmd) => {
      const reqs = cmd.input.RequestItems.T
      calls.push(reqs.length)
      return calls.length === 1 ? { UnprocessedItems: { T: reqs.slice(1) } } : {}
    }
    const r = await batchPut(send, 'T', items, { sleep: async (ms) => sleeps.push(ms) })
    expect(r).toEqual({ written: 3, failed: 0 })
    expect(calls).toEqual([3, 2])
    expect(sleeps).toEqual([100])

    const stuck = async (cmd) => ({ UnprocessedItems: { T: cmd.input.RequestItems.T } })
    const r2 = await batchPut(stuck, 'T', items, { maxAttempts: 3, sleep: async () => {} })
    expect(r2).toEqual({ written: 0, failed: 3 })
  })
})

describe('parseArgv', () => {
  it('defaults to dry run and parses lists', () => {
    expect(parseArgv(['--api-id', 'x', '--tables', 'A,B']).apply).toBe(false)
    expect(parseArgv(['--apply']).apply).toBe(true)
    expect(parseArgv(['--tables', 'A, B']).tables).toEqual(['A', 'B'])
    expect(() => parseArgv(['--wat'])).toThrow(/unknown/)
  })
})
