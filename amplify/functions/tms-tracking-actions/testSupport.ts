import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

export type Row = Record<string, unknown>

const INDEXES: Record<string, Record<string, readonly string[]>> = {
  ShipmentMessage: {
    shipmentMessagesByShipmentIdAndAt: ['shipmentId'],
    shipmentMessagesByThreadKeyAndAt: ['threadKey'],
    shipmentMessagesByMessageId: ['messageId'],
  },
  Load: {
    loadsByShipmentId: ['shipmentId'],
    loadsByCheckCallOpenAndNextCheckCallAt: ['checkCallOpen'],
    loadsByLoadCarrierId: ['activeLoadCarrierId'],
  },
  LoadCarrier: {
    loadCarriersByShipmentId: ['shipmentId'],
    loadCarriersByLoadId: ['loadId'],
  },
  TrackingLink: {
    trackingLinksByShipmentId: ['shipmentId'],
    trackingLinksByLoadId: ['loadId'],
  },
  ShipmentDocument: {
    shipmentDocumentsByShipmentIdAndUploadedAt: ['shipmentId', 'uploadedAt'],
  },
  LoadCheckCall: {
    loadCheckCallsByLoadIdAndAt: ['loadId'],
  },
  ShipmentPosting: {
    shipmentPostingsByShipmentId: ['shipmentId'],
    shipmentPostingsByStatusAndPostedAt: ['status', 'postedAt'],
  },
  Shipment: {
    // no secondary indexes used in this test suite
  },
}

export function gsiKeyAttributesFor(tableName: string): Set<string> {
  const attrs = new Set<string>()
  for (const keys of Object.values(INDEXES[baseName(tableName)] ?? {})) {
    for (const k of keys) attrs.add(k)
  }
  return attrs
}

export function validateNoNullGsiKeys(tableName: string, row: Row): void {
  for (const attr of gsiKeyAttributesFor(tableName)) {
    if (attr in row && row[attr] === null) {
      throw new Error(`Type mismatch for Index Key ${attr} Expected: S Actual: NULL`)
    }
  }
}

class ConditionalCheckFailedException extends Error {}

export class MemoryStore {
  private tables: Map<string, Map<string, Row>> = new Map()

  reset(): void {
    this.tables.clear()
  }

  table(name: string): Map<string, Row> {
    let t = this.tables.get(name)
    if (!t) {
      t = new Map()
      this.tables.set(name, t)
    }
    return t
  }

  seed(row: Row, tableName?: string): Row {
    const name = tableName ?? `${row.__typename as string}-test`
    const cleaned: Row = {}
    for (const [k, v] of Object.entries(row)) {
      if (v === null && gsiKeyAttributesFor(name).has(k)) continue
      cleaned[k] = v
    }
    this.table(name).set(String(cleaned.id ?? cleaned.key), cleaned)
    return cleaned
  }

  getById(tableName: string, id: string): Row | null {
    const row = this.table(tableName).get(id)
    return row ? { ...row } : null
  }

  queryIndex(tableName: string, indexName: string, keyName: string, keyValue: string): Row[] {
    const index = INDEXES[baseName(tableName)]?.[indexName]
    if (!index) throw new Error(`No index ${indexName} on ${tableName}`)
    if (!index.includes(keyName)) {
      throw new Error(`Index ${indexName} on ${tableName} does not include ${keyName}`)
    }
    return [...this.table(tableName).values()].filter((row) => row[keyName] === keyValue)
  }

  async transact(items: TransactWriteItem[]): Promise<void> {
    const snapshot = this.snapshot()
    try {
      for (const item of items) {
        if (item.Put) {
          this.applyPut(item.Put)
        } else if (item.Update) {
          this.applyUpdate(item.Update)
        } else if (item.Delete) {
          const key = unmarshall(item.Delete.Key as never) as Row
          this.table(item.Delete.TableName!).delete(String(key.id ?? Object.values(key)[0]))
        }
      }
    } catch (err) {
      this.restore(snapshot)
      throw err
    }
  }

  private snapshot(): Map<string, Map<string, Row>> {
    const snap = new Map<string, Map<string, Row>>()
    for (const [name, t] of this.tables) snap.set(name, new Map(t))
    return snap
  }

  private restore(snap: Map<string, Map<string, Row>>): void {
    this.tables.clear()
    for (const [name, t] of snap) this.tables.set(name, new Map(t))
  }

  private applyPut(put: { TableName: string | undefined; Item: unknown; ConditionExpression?: string }): void {
    const row = unmarshall(put.Item as never) as Row
    const id = String(row.id ?? row.key)
    const table = this.table(put.TableName!)
    if (put.ConditionExpression?.includes('attribute_not_exists(id)') && table.has(id)) {
      throw new ConditionalCheckFailedException(`${put.TableName}/${id} already exists`)
    }
    validateNoNullGsiKeys(put.TableName!, row)
    table.set(id, row)
  }

  private applyUpdate(update: {
    TableName: string | undefined
    Key: unknown
    UpdateExpression: string | undefined
    ExpressionAttributeNames?: Record<string, string>
    ExpressionAttributeValues?: Record<string, unknown>
    ConditionExpression?: string
  }): void {
    const key = unmarshall(update.Key as never) as Row
    const id = String(key.id ?? Object.values(key)[0])
    const table = this.table(update.TableName!)
    const existing = table.get(id) ?? null

    const names = update.ExpressionAttributeNames ?? {}
    const values: Record<string, unknown> = update.ExpressionAttributeValues
      ? unmarshall(update.ExpressionAttributeValues as never)
      : {}
    const condition = update.ConditionExpression ?? ''

    if (condition.includes('attribute_exists(id)') && !existing) {
      throw new ConditionalCheckFailedException(`${update.TableName}/${id} does not exist`)
    }
    if (condition.includes('casExpectedUpdatedAt') && existing) {
      const expected = values[':casExpectedUpdatedAt']
      if (String(expected ?? '') !== String(existing.updatedAt ?? '')) {
        throw new ConditionalCheckFailedException(`CAS on ${update.TableName}/${id}`)
      }
    }

    const next: Row = existing ? { ...existing, id } : { id }
    const expr = update.UpdateExpression!
    const setMatch = /\bSET\b/i.exec(expr)
    const removeMatch = /\bREMOVE\b/i.exec(expr)
    const addMatch = /\bADD\b/i.exec(expr)

    const setEnd = removeMatch ? removeMatch.index : addMatch ? addMatch.index : expr.length
    const setClause = setMatch ? expr.slice(setMatch.index + 3, setEnd) : ''
    for (const assignment of setClause.split(',')) {
      const m = /^\s*#([\w]+)\s*=\s*(:\w+)\s*$/.exec(assignment)
      if (!m) continue
      const field = names[`#${m[1]}`] ?? m[1]
      if (field === 'id') {
        throw new Error('Cannot update attribute id. This attribute is part of the key')
      }
      next[field] = values[m[2]]
    }

    const removeEnd = addMatch ? addMatch.index : expr.length
    const removeClause = removeMatch ? expr.slice(removeMatch.index + 6, removeEnd) : ''
    for (const fieldRef of removeClause.split(',')) {
      const ref = fieldRef.trim()
      if (!ref) continue
      const field = ref.startsWith('#') ? (names[ref] ?? ref.slice(1)) : ref
      delete next[field]
    }

    if (addMatch) {
      const addClause = expr.slice(addMatch.index + 3)
      const am = /\s*#([\w]+)\s+(:\w+)\s*/.exec(addClause)
      if (am) {
        const field = names[`#${am[1]}`] ?? am[1]
        next[field] = Number(next[field] ?? 0) + Number(values[am[2]] ?? 0)
      }
    }

    validateNoNullGsiKeys(update.TableName!, next)
    table.set(id, next)
  }
}

function baseName(tableName: string): string {
  return tableName.replace(/-test$/, '')
}

if (baseName('ShipmentMessage-test') !== 'ShipmentMessage') throw new Error('test support baseName broken')
