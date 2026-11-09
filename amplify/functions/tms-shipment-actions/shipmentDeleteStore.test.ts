import { describe, expect, it } from 'vitest'
import { BatchGetItemCommand, DeleteItemCommand, GetItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand, type DynamoDBClient, type DeleteItemCommandInput } from '@aws-sdk/client-dynamodb'
import type { S3Client } from '@aws-sdk/client-s3'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import { shipmentDeleteStore } from './shipmentDeleteStore'
import { SHIPMENT_INDEXED_MODELS } from './shipmentDelete'
import type { Row } from '../_shared/shipmentStore'

type Command = BatchGetItemCommand | DeleteItemCommand | GetItemCommand | QueryCommand | ScanCommand | TransactWriteItemsCommand
function fixture(send: (command: Command) => unknown) {
  return shipmentDeleteStore({ send: async (command: Command) => send(command) } as unknown as DynamoDBClient, {} as S3Client,
    Object.fromEntries([...SHIPMENT_INDEXED_MODELS, 'Shipment', 'Invoice', 'ArPayment', 'AuditLog'].map((model) => [model, model])), 'exports')
}
function applyDelete(input: DeleteItemCommandInput, current: Row | undefined) {
  const names = input.ExpressionAttributeNames ?? {}
  const values = unmarshall(input.ExpressionAttributeValues ?? {})
  const clauses = input.ConditionExpression!.split(' AND ')
  if (input.ConditionExpression!.length > 4096) throw new Error('Expression too long')
  const matches = clauses.every((clause) => {
    const exists = /^attribute_exists\(([^)]+)\)$/.exec(clause)
    if (exists) return current?.[names[exists[1]]] !== undefined
    const [name, value] = clause.split(' = ')
    return current !== undefined && current[names[name]] === values[value]
  })
  if (!matches) throw Object.assign(new Error('Snapshot changed'), { name: 'ConditionalCheckFailedException' })
}

describe('shipment delete DynamoDB adapter', () => {
  it('paginates every shipment GSI and exports full consistent base-table rows, excluding moved children', async () => {
    const indexes = ['ordersByShipmentId', 'loadsByShipmentId', 'loadCarriersByShipmentId', 'loadChargesByShipmentIdAndSortOrder', 'loadCheckCallsByShipmentIdAndAt', 'trackingLinksByShipmentId', 'shipmentDocumentsByShipmentIdAndUploadedAt', 'shipmentNoticesByShipmentIdAndAt', 'shipmentPostingsByShipmentId', 'shipmentMessagesByShipmentIdAndAt']
    const cursor = marshall({ id: 'cursor' })
    let modelIndex = 0
    const store = fixture((command) => {
      if (command instanceof QueryCommand) {
        expect(command.input.IndexName).toBe(indexes[modelIndex])
        expect(command.input.ConsistentRead).toBeUndefined()
        expect(unmarshall(command.input.ExpressionAttributeValues!)).toEqual({ ':shipmentId': 's' })
        expect(command.input.ProjectionExpression).toBe('#id')
        if (!command.input.ExclusiveStartKey) return { Items: [marshall({ id: 'a' })], LastEvaluatedKey: cursor }
        expect(command.input.ExclusiveStartKey).toEqual(cursor)
        return { Items: [marshall({ id: 'b' }), marshall({ id: 'moved' })] }
      }
      if (command instanceof BatchGetItemCommand) {
        const request = command.input.RequestItems![SHIPMENT_INDEXED_MODELS[modelIndex]]
        expect(request.ConsistentRead).toBe(true)
        expect(request.ProjectionExpression).toBeUndefined()
        expect(request.Keys!.map((key) => unmarshall(key).id)).toEqual(['a', 'b', 'moved'])
        return { Responses: { [SHIPMENT_INDEXED_MODELS[modelIndex]]: [marshall({ id: 'a', shipmentId: 's', updatedAt: 'fresh', payload: 'full' }), marshall({ id: 'b', shipmentId: 's', payload: 'second' }), marshall({ id: 'moved', shipmentId: 'other' })] } }
      }
      throw new Error(`Unexpected ${command.constructor.name}`)
    })
    for (const model of SHIPMENT_INDEXED_MODELS) {
      expect(await store.queryByShipment(model, 's')).toEqual([{ id: 'a', shipmentId: 's', updatedAt: 'fresh', payload: 'full' }, { id: 'b', shipmentId: 's', payload: 'second' }])
      modelIndex++
    }
  })

  it('uses bounded guards on 200-attribute rows and rejects changed timestamps, versions and missing rows', async () => {
    const snapshot = { id: 's', updatedAt: 'original', version: 0, ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, 'data'])) }
    let current: Row | undefined = { ...snapshot }
    const store = fixture((command) => {
      if (command instanceof GetItemCommand) { expect(command.input.ConsistentRead).toBeUndefined(); return { Item: marshall(snapshot) } }
      if (command instanceof DeleteItemCommand) { applyDelete(command.input, current); current = undefined; return {} }
      if (command instanceof TransactWriteItemsCommand) { applyDelete(command.input.TransactItems![0].Delete!, current); return {} }
      throw new Error('Unexpected command')
    })
    await store.getRow('Shipment', 's')
    current = { ...snapshot, updatedAt: 'changed' }
    await expect(store.deleteRows('Shipment', ['s'])).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
    current = { ...snapshot, version: 1 }
    await expect(store.finishDelete(snapshot, { email: 'owner', sub: 'owner', groups: [], isAdmin: true }, {})).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
    current = undefined
    await expect(store.deleteRows('Shipment', ['s'])).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
    current = { ...snapshot, field0: 'untracked payload change' }
    await store.deleteRows('Shipment', ['s'])
    expect(current).toBeUndefined()
  })

  it('guards legacy rows by id and createdAt without comparing unrelated payload', async () => {
    const snapshot = { id: 's', createdAt: 'original', payload: 'old' }
    let current: Row = { ...snapshot, payload: 'new' }
    const store = fixture((command) => {
      if (command instanceof GetItemCommand) return { Item: marshall(snapshot) }
      if (command instanceof DeleteItemCommand) { applyDelete(command.input, current); return {} }
      throw new Error('Unexpected command')
    })
    await store.getRow('Shipment', 's')
    await store.deleteRows('Shipment', ['s'])
    current = { ...current, createdAt: 'replacement' }
    await expect(store.deleteRows('Shipment', ['s'])).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
  })

  it('finds the newest caller export past filtered empty pages, never another caller or action', async () => {
    const rows = [
      { id: '1', entityType: 'DELETE_SHIPMENTS', entityId: '2026-11-09T14:00:00Z#other', user: 'other', action: 'DELETE_EXPORT_WRITTEN' },
      { id: '2', entityType: 'DELETE_SHIPMENTS', entityId: '2026-11-09T13:00:00Z#restore', user: 'owner', action: 'RESTORE' },
      { id: '3', entityType: 'DELETE_SHIPMENTS', entityId: '2026-11-09T12:00:00Z#new', user: 'owner', action: 'DELETE_EXPORT_WRITTEN' },
      { id: '4', entityType: 'DELETE_SHIPMENTS', entityId: '2026-11-09T11:00:00Z#old', user: 'owner', action: 'DELETE_EXPORT_WRITTEN' },
    ]
    let calls = 0
    const store = fixture((command) => {
      if (!(command instanceof QueryCommand)) throw new Error('Expected query')
      calls++
      const input = command.input
      expect(input.IndexName).toBe('auditLogsByEntityTypeAndEntityId')
      expect(input.ScanIndexForward).toBe(false)
      const values = unmarshall(input.ExpressionAttributeValues!)
      expect(input.ExpressionAttributeNames).toMatchObject({ '#user': 'user', '#action': 'action', '#entityType': 'entityType' })
      expect(input.FilterExpression).toBe('#user = :user AND #action = :action')
      expect(input.KeyConditionExpression).toBe('#entityType = :entityType')
      const index = input.ExclusiveStartKey ? rows.findIndex((row) => row.id === unmarshall(input.ExclusiveStartKey!).id) + 1 : 0
      const row = rows[index]
      return { Items: row.entityType === values[':entityType'] && row.user === values[':user'] && row.action === values[':action'] ? [marshall(row)] : [], LastEvaluatedKey: index < rows.length - 1 ? marshall({ id: row.id }) : undefined }
    })
    expect(await store.latestExportMarker('owner')).toEqual(rows[2])
    expect(calls).toBe(3)
    expect(await store.latestExportMarker('absent')).toBeNull()
  })

  it('paginates projected billing scans with matching-key filters and retains payment reference fields', async () => {
    let scans = 0
    const store = fixture((command) => {
      if (!(command instanceof ScanCommand)) throw new Error('Expected scan')
      scans++
      expect(command.input.ConsistentRead).toBeUndefined()
      if (command.input.TableName === 'Invoice') {
        expect(unmarshall(command.input.ExpressionAttributeValues!)).toEqual({ ':v0': 's', ':v1': 'o' })
        expect(command.input.FilterExpression).toBe('#m0 IN (:v0) OR #m1 IN (:v1)')
        if (!command.input.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: marshall({ id: 'cursor' }) }
        return { Items: [marshall({ id: 'i', shipmentId: 's' })] }
      }
      expect(command.input.FilterExpression).toBe('attribute_exists(#f1) OR attribute_exists(#f2)')
      expect(command.input.ExpressionAttributeNames).toEqual({ '#f0': 'id', '#f1': 'applications', '#f2': 'reversalOfPaymentId' })
      return { Items: [marshall({ id: 'p', reversalOfPaymentId: 'original' })] }
    })
    expect(await store.scanProjected('Invoice', ['shipmentId', 'orderId'], { shipmentId: [], orderId: [] })).toEqual([])
    expect(scans).toBe(0)
    expect(await store.scanProjected('Invoice', ['shipmentId', 'orderId'], { shipmentId: ['s'], orderId: ['o'] })).toEqual([{ id: 'i', shipmentId: 's' }])
    expect(await store.scanProjected('ArPayment', ['applications', 'reversalOfPaymentId'])).toEqual([{ id: 'p', reversalOfPaymentId: 'original' }])
  })
})
