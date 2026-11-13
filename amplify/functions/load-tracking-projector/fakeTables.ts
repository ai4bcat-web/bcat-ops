import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { Row } from '../_shared/shipmentStore'

/**
 * The projector talks to DynamoDB and nothing else, so the fake is the table set:
 * every read the shipment store does is served from it and every write is recorded,
 * which is what lets a test say "this record wrote nothing at all".
 */
export const TABLES = {
  shipment: 'Shipment-test',
  order: 'Order-test',
  load: 'Load-test',
  loadCarrier: 'LoadCarrier-test',
  loadFinancials: 'LoadFinancials-test',
  loadCharge: 'LoadCharge-test',
  // The projector has no ShipmentDocument grant, so a bundle it reads has no documents.
  shipmentDocument: '',
}
export const CHECK_CALL_TABLE = 'LoadCheckCall-test'
export const DRIVER_TABLE = 'Driver-test'
export const NOW = '2026-10-28T12:00:00.000Z'

export interface Write { op: 'put' | 'update'; table: string; id: string }

function conditionFailed(): Error {
  const err = new Error('ConditionalCheckFailedException: the conditional request failed')
  err.name = 'ConditionalCheckFailedException'
  return err
}

export class FakeDynamo {
  readonly rows = new Map<string, Map<string, Row>>()
  readonly writes: Write[] = []
  scans = 0

  table(name: string): Map<string, Row> {
    let t = this.rows.get(name)
    if (!t) { t = new Map(); this.rows.set(name, t) }
    return t
  }

  seed(name: string, ...rows: Row[]): void {
    for (const row of rows) this.table(name).set(String(row.id), row)
  }

  get(name: string, id: string): Row | undefined {
    return this.table(name).get(id)
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input
    const name = command.constructor.name
    const tableName = String(input.TableName ?? '')
    switch (name) {
      case 'GetItemCommand': {
        const key = unmarshall(input.Key as Record<string, never>)
        const row = this.get(tableName, String(key.id))
        return { Item: row ? marshall(row, { removeUndefinedValues: true }) : undefined }
      }
      case 'QueryCommand': {
        const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
        const key = names['#k'] ?? 'shipmentId'
        const items = [...this.table(tableName).values()].filter((r) => r[key] === values[':v'])
        return { Items: items.map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'BatchGetItemCommand': {
        const requested = input.RequestItems as Record<string, { Keys: Record<string, never>[] }>
        const Responses: Record<string, unknown[]> = {}
        for (const [table, spec] of Object.entries(requested)) {
          Responses[table] = spec.Keys
            .map((k) => this.get(table, String(unmarshall(k).id)))
            .filter((r): r is Row => !!r)
            .map((r) => marshall(r, { removeUndefinedValues: true }))
        }
        return { Responses }
      }
      case 'ScanCommand': {
        this.scans += 1
        return { Items: [...this.table(tableName).values()].map((r) => marshall(r, { removeUndefinedValues: true })) }
      }
      case 'PutItemCommand': {
        const item = unmarshall(input.Item as Record<string, never>)
        const id = String(item.id)
        if (String(input.ConditionExpression ?? '').includes('attribute_not_exists(id)') && this.table(tableName).has(id)) {
          throw conditionFailed()
        }
        this.table(tableName).set(id, item)
        this.writes.push({ op: 'put', table: tableName, id })
        return {}
      }
      case 'UpdateItemCommand':
        this.applyUpdate(input)
        return {}
      case 'TransactWriteItemsCommand': {
        for (const entry of (input.TransactItems ?? []) as Array<{ Update?: Record<string, unknown> }>) {
          if (entry.Update) this.applyUpdate(entry.Update)
        }
        return {}
      }
      default:
        throw new Error(`FakeDynamo: unexpected ${name}`)
    }
  }

  /** Only the `SET #k = :k` shape the projector and the shipment store build. */
  private applyUpdate(input: Record<string, unknown>): void {
    const tableName = String(input.TableName ?? '')
    const id = String(unmarshall(input.Key as Record<string, never>).id)
    const row = this.get(tableName, id) ?? { id }
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
    const values = unmarshall(input.ExpressionAttributeValues as Record<string, never>)
    const condition = String(input.ConditionExpression ?? '')
    if (':casExpectedUpdatedAt' in values) {
      // The shipment store's compare-and-swap: '' stands for "never written".
      const expected = values[':casExpectedUpdatedAt']
      if ((expected === '' ? row.updatedAt !== undefined : row.updatedAt !== expected)) throw conditionFailed()
    } else {
      if (condition.includes(':expectedUpdatedAt') && row.updatedAt !== values[':expectedUpdatedAt']) throw conditionFailed()
      if (condition.includes('attribute_not_exists(updatedAt)') && row.updatedAt !== undefined) throw conditionFailed()
    }
    if (condition.includes('attribute_not_exists(#deliveredAt)') && row.deliveredAt !== undefined && row.deliveredAt !== null) throw conditionFailed()
    for (const [, nameRef, valueRef] of String(input.UpdateExpression ?? '').matchAll(/(#\w+) = (:\w+)/g)) {
      row[names[nameRef] ?? nameRef.slice(1)] = values[valueRef]
    }
    this.table(tableName).set(id, row)
    this.writes.push({ op: 'update', table: tableName, id })
  }
}
