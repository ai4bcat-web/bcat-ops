import { randomUUID } from 'node:crypto'
import { BatchGetItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand, type DynamoDBClient, type AttributeValue } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { DeleteStore, ShipmentIndexedModel, StoreModel } from './shipmentDelete'
import type { Row } from '../_shared/shipmentStore'

const shipmentIndexes: Record<ShipmentIndexedModel, string> = {
  Order: 'ordersByShipmentId', Load: 'loadsByShipmentId', LoadCarrier: 'loadCarriersByShipmentId',
  LoadCharge: 'loadChargesByShipmentIdAndSortOrder', LoadCheckCall: 'loadCheckCallsByShipmentIdAndAt',
  TrackingLink: 'trackingLinksByShipmentId', ShipmentDocument: 'shipmentDocumentsByShipmentIdAndUploadedAt',
  ShipmentNotice: 'shipmentNoticesByShipmentIdAndAt', ShipmentPosting: 'shipmentPostingsByShipmentId',
  ShipmentMessage: 'shipmentMessagesByShipmentIdAndAt',
}

export function shipmentDeleteStore(db: DynamoDBClient, s3: S3Client, tables: Record<string, string>, bucket: string): DeleteStore {
  const snapshots = new Map<string, Row>()
  function remember(model: string, rows: Row[]): Row[] {
    for (const row of rows) snapshots.set(`${model}:${String(row.id)}`, row)
    return rows
  }
  function guardedDelete(model: string, row: Row) {
    // Legacy rows without updatedAt use their identity and creation timestamp.
    // Comparing the whole snapshot would exceed expression limits on wide rows.
    const fields = (row.updatedAt !== undefined ? ['updatedAt', 'version'] : ['id', 'createdAt', 'version'])
      .filter((field) => row[field] !== undefined)
    return { TableName: table(model), Key: marshall({ id: row.id }),
      ConditionExpression: ['attribute_exists(#id)', ...fields.map((_, i) => `#f${i} = :v${i}`)].join(' AND '),
      ExpressionAttributeNames: { '#id': 'id', ...Object.fromEntries(fields.map((field, i) => [`#f${i}`, field])) },
      ExpressionAttributeValues: marshall(Object.fromEntries(fields.map((field, i) => [`:v${i}`, row[field]]))),
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
  async function getRows(model: StoreModel, ids: string[]): Promise<Row[]> {
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
  }
  return {
    isOwner: (caller) => caller.email.trim().toLowerCase() === 'ryne@bcatcorp.com',
    now: () => new Date().toISOString(), randomId: randomUUID,
    async getRow(model, id) {
      const result = await db.send(new GetItemCommand({ TableName: table(model), Key: marshall({ id }) }))
      return result.Item ? remember(model, [unmarshall(result.Item)])[0] : null
    },
    async queryByShipment(model, shipmentId) {
      const ids: string[] = []
      let key: Record<string, AttributeValue> | undefined
      do {
        const result = await db.send(new QueryCommand({
          TableName: table(model), IndexName: shipmentIndexes[model],
          KeyConditionExpression: '#shipmentId = :shipmentId', ProjectionExpression: '#id',
          ExpressionAttributeNames: { '#shipmentId': 'shipmentId', '#id': 'id' },
          ExpressionAttributeValues: marshall({ ':shipmentId': shipmentId }), ExclusiveStartKey: key,
        }))
        ids.push(...(result.Items ?? []).map((row) => String(unmarshall(row).id)))
        key = result.LastEvaluatedKey
      } while (key)
      // The GSI only discovers ids; export current full base-table rows.
      return (await getRows(model, ids)).filter((row) => row.shipmentId === shipmentId)
    },
    getRows,
    async scanProjected(model, fields, matches?: Record<string, string[]>) {
      const names = Object.fromEntries([...new Set(['id', ...fields])].map((field, i) => [`#f${i}`, field]))
      const projection = Object.keys(names).join(', ')
      const values: Row = {}
      const filters: string[] = []
      if (matches) {
        for (const [field, ids] of Object.entries(matches)) {
          const unique = [...new Set(ids)]
          if (!unique.length) continue
          const alias = `#m${filters.length}`
          names[alias] = field
          // DynamoDB permits at most 100 operands in each IN expression.
          for (let i = 0; i < unique.length; i += 100) {
            const operands = unique.slice(i, i + 100).map((id) => {
              const token = `:v${Object.keys(values).length}`
              values[token] = id
              return token
            })
            filters.push(`${alias} IN (${operands.join(', ')})`)
          }
        }
        if (!filters.length) return []
      } else {
        for (const [alias, field] of Object.entries(names)) {
          if (fields.includes(field)) filters.push(`attribute_exists(${alias})`)
        }
      }
      const rows: Row[] = []
      let key: Record<string, AttributeValue> | undefined
      do {
        const result = await db.send(new ScanCommand({
          TableName: table(model), ProjectionExpression: projection, ExpressionAttributeNames: names,
          FilterExpression: filters.length ? filters.join(' OR ') : undefined,
          ExpressionAttributeValues: Object.keys(values).length ? marshall(values) : undefined,
          ExclusiveStartKey: key,
        }))
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
    async latestExportMarker(userEmail) {
      let key: Record<string, AttributeValue> | undefined
      do {
        const result = await db.send(new QueryCommand({
          TableName: table('AuditLog'), IndexName: 'auditLogsByEntityTypeAndEntityId',
          KeyConditionExpression: '#entityType = :entityType',
          FilterExpression: '#user = :user AND #action = :action',
          ExpressionAttributeNames: { '#entityType': 'entityType', '#user': 'user', '#action': 'action' },
          ExpressionAttributeValues: marshall({ ':entityType': 'DELETE_SHIPMENTS', ':user': userEmail, ':action': 'DELETE_EXPORT_WRITTEN' }),
          ScanIndexForward: false, ExclusiveStartKey: key,
        }))
        if (result.Items?.length) return unmarshall(result.Items[0])
        key = result.LastEvaluatedKey
      } while (key)
      return null
    },
  }
}
