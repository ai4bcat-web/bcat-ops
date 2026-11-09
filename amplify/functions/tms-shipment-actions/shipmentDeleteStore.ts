import { randomUUID } from 'node:crypto'
import { BatchGetItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, ScanCommand, TransactWriteItemsCommand, type DynamoDBClient, type AttributeValue } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { DeleteStore } from './shipmentDelete'
import type { Row } from '../_shared/shipmentStore'


export function shipmentDeleteStore(db: DynamoDBClient, s3: S3Client, tables: Record<string, string>, bucket: string): DeleteStore {
  const snapshots = new Map<string, Row>()
  const scans = new Map<string, Promise<Row[]>>()
  function remember(model: string, rows: Row[]): Row[] {
    for (const row of rows) snapshots.set(`${model}:${String(row.id)}`, row)
    return rows
  }
  function guardedDelete(model: string, row: Row) {
    const fields = Object.entries(row).filter(([, value]) => value !== undefined)
    return { TableName: table(model), Key: marshall({ id: row.id }),
      ConditionExpression: fields.map((_, i) => `#f${i} = :v${i}`).join(' AND '),
      ExpressionAttributeNames: Object.fromEntries(fields.map(([field], i) => [`#f${i}`, field])),
      ExpressionAttributeValues: marshall(Object.fromEntries(fields.map(([, value], i) => [`:v${i}`, value])), { removeUndefinedValues: true }),
    }
  }
  function table(model: string): string {
    if (!tables[model]) throw new Error(`Delete table not configured: ${model}`)
    return tables[model]
  }
  function requireBucket(): string {
    if (!bucket) throw new Error('Delete export bucket is not configured')
    return bucket
  }
  return {
    isOwner: (caller) => caller.email.trim().toLowerCase() === 'ryne@bcatcorp.com',
    now: () => new Date().toISOString(), randomId: randomUUID,
    async getRow(model, id) {
      const result = await db.send(new GetItemCommand({ TableName: table(model), Key: marshall({ id }), ConsistentRead: true }))
      return result.Item ? remember(model, [unmarshall(result.Item)])[0] : null
    },
    async queryByShipment(model, shipmentId) {
      // GSIs are eventually consistent: a just-created child must not escape a hard delete.
      // Cache one strongly consistent table scan per request, not one scan per selected shipment.
      if (!scans.has(model)) scans.set(model, (async () => {
        const rows: Row[] = []
        let key: Record<string, AttributeValue> | undefined
        do {
          const result = await db.send(new ScanCommand({ TableName: table(model), ConsistentRead: true, ExclusiveStartKey: key }))
          rows.push(...(result.Items ?? []).map((row) => unmarshall(row)))
          key = result.LastEvaluatedKey
        } while (key)
        return rows
      })())
      return remember(model, (await scans.get(model)!).filter((row) => row.shipmentId === shipmentId))
    },
    async getRows(model, ids) {
      const rows: Row[] = []
      const unique = [...new Set(ids)]
      for (let i = 0; i < unique.length; i += 100) {
        let keys = unique.slice(i, i + 100).map((id) => marshall({ id }))
        for (let attempt = 0; keys.length && attempt < 5; attempt++) {
          const name = table(model)
          const result = await db.send(new BatchGetItemCommand({ RequestItems: { [name]: { Keys: keys, ConsistentRead: true } } }))
          rows.push(...(result.Responses?.[name] ?? []).map((row) => unmarshall(row)))
          keys = result.UnprocessedKeys?.[name]?.Keys ?? []
        }
        if (keys.length) throw new Error(`Incomplete ${model} read; refusing deletion`)
      }
      return remember(model, rows)
    },
    async scanProjected(model, fields) {
      const names = Object.fromEntries(['id', ...fields].map((field, i) => [`#f${i}`, field]))
      const rows: Row[] = []
      let key: Record<string, AttributeValue> | undefined
      do {
        const result = await db.send(new ScanCommand({ TableName: table(model), ConsistentRead: true, ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names, ExclusiveStartKey: key }))
        rows.push(...(result.Items ?? []).map((row) => unmarshall(row)))
        key = result.LastEvaluatedKey
      } while (key)
      return rows
    },
    async deleteRows(model, ids) {
      for (const id of ids) {
        const row = snapshots.get(`${model}:${id}`)
        if (!row) throw new Error(`Missing export snapshot for ${model}:${id}`)
        await db.send(new DeleteItemCommand(guardedDelete(model, row)))
      }
    },
    async finishDelete(shipment, caller, changes) {
      const now = new Date().toISOString()
      const audit = { id: randomUUID(), __typename: 'AuditLog', entityType: 'SHIPMENT', entityId: shipment.id, action: 'DELETE_SHIPMENT', user: caller.email, changes: JSON.stringify(changes), createdAt: now, updatedAt: now }
      await db.send(new TransactWriteItemsCommand({ TransactItems: [
        { Delete: guardedDelete('Shipment', shipment) },
        { Put: { TableName: table('AuditLog'), Item: marshall(audit) } },
      ] }))
    },
    async putIfAbsent(model, row) {
      try {
        await db.send(new PutItemCommand({ TableName: table(model), Item: marshall(row, { removeUndefinedValues: true }), ConditionExpression: 'attribute_not_exists(id)' }))
        return 'put'
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return 'exists'
        throw error
      }
    },
    async putObject(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: requireBucket(), Key: key, Body: body, ContentType: key.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json', ServerSideEncryption: 'AES256' }))
    },
    async getObject(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: requireBucket(), Key: key }))
      if (!result.Body) throw new Error(`Missing export object: ${key}`)
      return result.Body.transformToString()
    },
    async writeAudit(entityType, entityId, action, caller, changes) {
      const now = new Date().toISOString()
      await db.send(new PutItemCommand({ TableName: table('AuditLog'), Item: marshall({ id: randomUUID(), __typename: 'AuditLog', entityType, entityId, action, user: caller.email, changes: JSON.stringify(changes), createdAt: now, updatedAt: now }) }))
    },
  }
}
