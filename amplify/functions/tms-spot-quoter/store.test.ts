/**
 * The real DynamoDB store, against a recording DocumentClient: DynamoDB rejects an empty
 * or NULL value for an index key attribute, so no write may ever carry one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpotRequestRecord } from '../../../src/types/tms'

const sent = vi.hoisted(() => [] as Array<{ kind: string; input: Record<string, unknown> }>)

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const make = (kind: string) =>
    class {
      kind = kind
      input: Record<string, unknown>
      constructor(input: Record<string, unknown>) {
        this.input = input
      }
    }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: async (cmd: { kind: string; input: Record<string, unknown> }) => { sent.push(cmd); return { Attributes: {} } } }) },
    GetCommand: make('Get'), PutCommand: make('Put'), UpdateCommand: make('Update'),
    QueryCommand: make('Query'), ScanCommand: make('Scan'), DeleteCommand: make('Delete'),
  }
})

import { createDynamoStore, INDEX_KEY_ATTRS } from './store'

const manual = {
  id: 'sr:u:manual-1', userId: 'u', gmailMessageId: 'manual-1', gmailThreadId: '', receivedAt: '2026-11-04T12:00:00Z',
  status: 'NEW', ttlEpoch: 4_000_000_000, version: 1,
} as SpotRequestRecord

beforeEach(() => {
  sent.length = 0
})

describe('index key attributes', () => {
  it('a pasted request is put without its empty thread id', async () => {
    await createDynamoStore().putRequestIfAbsent(manual)
    const item = sent[0].input.Item as Record<string, unknown>
    for (const key of INDEX_KEY_ATTRS.SpotRequest) {
      if (key in item) expect(item[key] === '' || item[key] == null).toBe(false)
    }
    expect('gmailThreadId' in item).toBe(false)
    expect(item.userId).toBe('u')
  })

  it('an update that blanks an index key removes the attribute instead of writing it empty', async () => {
    await createDynamoStore().updateRequest('sr:u:manual-1', { gmailThreadId: '', status: 'DRAFTED' })
    const input = sent[0].input
    const values = Object.values(input.ExpressionAttributeValues as Record<string, unknown>)
    expect(values).not.toContain('')
    expect(String(input.UpdateExpression)).toMatch(/REMOVE/)
    expect(values).toContain('DRAFTED')
  })
})
