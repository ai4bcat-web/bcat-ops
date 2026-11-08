/**
 * In-memory DynamoDB / S3 / Lambda for the data-safety tests. Models only what the
 * Lambda uses: segmented, paged scans with ExclusiveStartKey; conditional puts;
 * ListTables; PITR + export bookkeeping; S3 objects; recorded self-invokes.
 */
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { LambdaClient } from '@aws-sdk/client-lambda'
import type { S3Client } from '@aws-sdk/client-s3'
import type { Deps, Row } from './export'

export const SUFFIX = 'api1-NONE'

export class FakeAws {
  tables = new Map<string, Row[]>()
  pitr = new Map<string, boolean>()
  exportStatus = new Map<string, 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'>()
  exportCalls: Row[] = []
  objects = new Map<string, string>()
  invokes: Row[] = []
  ms = Date.parse('2026-11-02T07:15:00Z')

  seed(model: string, rows: Row[], pitr = true): void {
    const name = `${model}-${SUFFIX}`
    this.tables.set(name, rows)
    this.pitr.set(name, pitr)
  }

  rows(model: string): Row[] {
    return this.tables.get(`${model}-${SUFFIX}`) ?? []
  }

  db = {
    send: async (cmd: { constructor: { name: string }; input: Row }): Promise<Row> => {
      const input = cmd.input as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (cmd.constructor.name) {
        case 'ListTablesCommand':
          return { TableNames: [...this.tables.keys(), 'Shipment-other-NONE', `Shipment-${SUFFIX}-rh1`] }
        case 'DescribeContinuousBackupsCommand':
          return {
            ContinuousBackupsDescription: {
              PointInTimeRecoveryDescription: {
                PointInTimeRecoveryStatus: this.pitr.get(input.TableName) ? 'ENABLED' : 'DISABLED',
                EarliestRestorableDateTime: new Date('2026-11-01T00:00:00Z'),
              },
            },
          }
        case 'DescribeTableCommand':
          return { Table: { TableArn: `arn:aws:dynamodb:us-east-1:111:table/${input.TableName}` } }
        case 'ExportTableToPointInTimeCommand': {
          this.exportCalls.push(input)
          const arn = `${input.TableArn}/export/1`
          if (!this.exportStatus.has(arn)) this.exportStatus.set(arn, 'IN_PROGRESS')
          return { ExportDescription: { ExportArn: arn } }
        }
        case 'DescribeExportCommand': {
          const status = this.exportStatus.get(input.ExportArn) ?? 'COMPLETED'
          return { ExportDescription: { ExportStatus: status, ItemCount: 3, BilledSizeBytes: 10, FailureMessage: status === 'FAILED' ? 'boom' : undefined } }
        }
        case 'GetItemCommand': {
          const key = unmarshall(input.Key).id
          const row = this.tables.get(input.TableName)?.find((r) => r.id === key)
          return row ? { Item: marshall(row, { removeUndefinedValues: true }) } : {}
        }
        case 'PutItemCommand': {
          const item = unmarshall(input.Item)
          const list = this.tables.get(input.TableName) ?? []
          this.tables.set(input.TableName, list)
          const i = list.findIndex((r) => r.id === item.id)
          if (input.ConditionExpression === 'attribute_not_exists(id)' && i >= 0) {
            throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' })
          }
          if (i >= 0) list[i] = item
          else list.push(item)
          return {}
        }
        case 'ScanCommand': {
          const total: number = input.TotalSegments ?? 1
          const seg: number = input.Segment ?? 0
          const all = (this.tables.get(input.TableName) ?? [])
            .filter((_, i) => i % total === seg)
            .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          const after = input.ExclusiveStartKey ? unmarshall(input.ExclusiveStartKey).id : null
          const rest = after === null ? all : all.filter((r) => String(r.id) > String(after))
          const limit: number = input.Limit ?? 1000
          const page = rest.slice(0, limit)
          const names: Record<string, string> = input.ExpressionAttributeNames ?? {}
          const picked = input.ProjectionExpression
            ? page.map((r) => Object.fromEntries((input.ProjectionExpression as string).split(',').filter((p) => names[p] in r).map((p) => [names[p], r[names[p]]])))
            : page
          return {
            Items: picked.map((r) => marshall(r, { removeUndefinedValues: true })),
            LastEvaluatedKey: rest.length > limit ? marshall({ id: page[page.length - 1].id }) : undefined,
          }
        }
        default:
          throw new Error(`FakeAws.db: unhandled ${cmd.constructor.name}`)
      }
    },
  }

  s3 = {
    send: async (cmd: { constructor: { name: string }; input: Row }): Promise<Row> => {
      const input = cmd.input as { Key: string; Body?: Buffer }
      if (cmd.constructor.name === 'PutObjectCommand') {
        this.objects.set(input.Key, Buffer.from(input.Body!).toString('utf8'))
        return {}
      }
      if (cmd.constructor.name === 'GetObjectCommand') {
        const body = this.objects.get(input.Key)
        if (body === undefined) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' })
        return { Body: { transformToString: async () => body } }
      }
      throw new Error(`FakeAws.s3: unhandled ${cmd.constructor.name}`)
    },
  }

  lambda = {
    send: async (cmd: { input: Row }): Promise<Row> => {
      this.invokes.push(JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString('utf8')))
      return {}
    },
  }

  deps(overrides: Partial<Deps> = {}): Deps {
    return {
      db: this.db as unknown as DynamoDBClient,
      s3: this.s3 as unknown as S3Client,
      lambda: this.lambda as unknown as LambdaClient,
      bucket: 'bucket',
      jobTable: `DataExportJob-${SUFFIX}`,
      auditTable: `AuditLog-${SUFFIX}`,
      suffix: SUFFIX,
      functionName: 'tms-data-safety-x',
      now: () => new Date(this.ms).toISOString(),
      nowMs: () => this.ms,
      uuid: (() => {
        let n = 0
        return () => `uuid${String(++n).padStart(8, '0')}`
      })(),
      presign: async (key, filename, ttl) => `https://signed/${key}?f=${filename}&ttl=${ttl}`,
      ...overrides,
    }
  }
}
