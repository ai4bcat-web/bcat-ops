/**
 * Step N2 — MyCarrierPackets scheduled sync Lambda.
 *
 * Triggered by EventBridge every 30 minutes. Reads the MCP credentials from SSM,
 * scans every carrier with an mcNumber, and updates each Carrier row with the
 * latest compliance data. Does not change directory status.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { mcpAdapter, applyMcpUpdate, mergeInsurancePolicies, type McpInsurance } from '../../../src/lib/integrations/mcpAdapter'

const ssm = new SSMClient({})
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

const CARRIER_TABLE_NAME = process.env.CARRIER_TABLE_NAME ?? ''
const INTEGRATION_PARAM_PATH = process.env.INTEGRATION_PARAM_PATH ?? ''

/** The one key a webhook parameter carries. */
const WEBHOOK_SECRET_KEY = 'webhookSigningSecret'

interface SyncResult {
  mcNumber: string
  carrierId?: string
  ok: boolean
  mode: 'STUB' | 'LIVE'
  error?: string
}

async function readMcpCredentials(): Promise<Record<string, string> | null> {
  const paramName = `${INTEGRATION_PARAM_PATH}/MYCARRIERPACKETS`
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }))
    const raw = result.Parameter?.Value
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key === WEBHOOK_SECRET_KEY) continue
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return null
  }
}

function normalizeMc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Find Carrier rows by mcNumber using a Scan with filter; the public Lambda is
 * explicitly granted this table, and the result set is small. */
async function findCarriersByMc(mcNumber: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let startKey: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: CARRIER_TABLE_NAME,
      FilterExpression: 'attribute_exists(mcNumber) AND mcNumber = :mc',
      ExpressionAttributeValues: { ':mc': mcNumber },
      ExclusiveStartKey: startKey,
    }))
    out.push(...(page.Items ?? []))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  return out
}

/** Apply one MCP carrier snapshot to the matching Carrier row(s). */
async function applyMcpToCarriers(mcp: Record<string, unknown>): Promise<number> {
  const mcNumber = typeof mcp.mcNumber === 'string' ? mcp.mcNumber.trim() : ''
  if (!mcNumber) return 0
  const carriers = await findCarriersByMc(mcNumber)
  if (carriers.length === 0) return 0
  const patch = applyMcpUpdate(mcp as never)
  const { mcNumber: _drop, ...rest } = patch as Record<string, unknown> & { mcNumber: unknown }
  void _drop
  if (mcp.insurance && typeof mcp.insurance === 'object') {
    const existing = carriers[0]!.insurancePolicies
    rest.insurancePolicies = mergeInsurancePolicies(
      existing as Array<Record<string, unknown>> | null | undefined,
      mcp.insurance as unknown as McpInsurance,
    )
  }
  const now = new Date().toISOString()
  for (const carrier of carriers) {
    await ddb.send(new PutCommand({
      TableName: CARRIER_TABLE_NAME,
      Item: { ...carrier, ...rest, updatedAt: now },
    }))
  }
  return carriers.length
}

/** Sync one carrier from MCP. */
async function syncOne(mcNumber: string, credentials: Record<string, string>): Promise<SyncResult> {
  const adapter = mcpAdapter(credentials)
  const ctx = { provider: 'MYCARRIERPACKETS' as const, credentials, settings: {}, now: new Date().toISOString() }
  try {
    const result = await adapter.sync!(ctx, { mcNumber })
    const detail = (result.detail ?? {}) as Record<string, unknown>
    const mcp = (detail.carrier ?? detail) as Record<string, unknown>
    const updated = await applyMcpToCarriers(mcp)
    return { mcNumber, ok: result.ok, mode: result.mode, ...(updated > 0 ? { carrierId: String(mcp.mcNumber ?? mcNumber) } : {}) }
  } catch (err) {
    return { mcNumber, ok: false, mode: 'LIVE', error: err instanceof Error ? err.message : String(err) }
  }
}

export const handler = async () => {
  const credentials = await readMcpCredentials()
  if (!credentials) {
    console.log('[mcp-sync] No MCP credentials configured; nothing to sync.')
    return { count: 0, ok: 0, skipped: 0, results: [] }
  }

  const results: SyncResult[] = []
  let startKey: Record<string, unknown> | undefined
  const now = new Date().toISOString()
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: CARRIER_TABLE_NAME,
      FilterExpression: 'attribute_exists(mcNumber) AND NOT begins_with(mcNumber, :empty)',
      ExpressionAttributeValues: { ':empty': '' },
      ExclusiveStartKey: startKey,
    }))
    for (const item of page.Items ?? []) {
      const mcNumber = normalizeMc(item.mcNumber)
      if (!mcNumber) continue
      results.push(await syncOne(mcNumber, credentials))
    }
    startKey = page.LastEvaluatedKey
  } while (startKey)

  const ok = results.filter((r) => r.ok).length
  console.log(`[mcp-sync] Synced ${ok}/${results.length} carriers at ${now}`)
  return { count: results.length, ok, skipped: results.length - ok, results }
}
