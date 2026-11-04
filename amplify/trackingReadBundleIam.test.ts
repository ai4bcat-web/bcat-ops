/**
 * tmsTrackingActions reads whole shipments through the shared `readBundle`, which issues a BatchGetItem on the Load table
 * (by the shipment's loadIds) and on LoadFinancials (by load id). A Lambda missing either grant — or the LoadFinancials
 * table name — fails REVIEW_SHIPMENT_POD and the shipment thread on every real shipment (found driving the Step Y demo on
 * dev). Nothing local exercises IAM, so this reads the policy statements the way CDK will synthesise them.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRACKING_ACTIONS_TABLES } from './functions/tms-tracking-actions/tableEnv'

const backend = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'backend.ts'), 'utf8')

/** Every `trackingActionsFn.addToRolePolicy(new PolicyStatement({ actions: [...], resources: [...] }))`. */
function trackingStatements(): { actions: string[]; resources: string }[] {
  const out: { actions: string[]; resources: string }[] = []
  const re = /trackingActionsFn\.addToRolePolicy\(\s*new PolicyStatement\(\{([\s\S]*?)\}\)\s*\)/g
  for (const match of backend.matchAll(re)) {
    const body = match[1]
    const actions = /actions:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? ''
    const resources = /resources:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? ''
    out.push({ actions: [...actions.matchAll(/'([^']+)'/g)].map((m) => m[1]), resources })
  }
  return out
}

describe('tmsTrackingActions can run readBundle', () => {
  const batch = trackingStatements().filter((s) => s.actions.includes('dynamodb:BatchGetItem'))

  it('may BatchGetItem the Load table and the LoadFinancials table', () => {
    const resources = batch.map((s) => s.resources).join('\n')
    expect(resources).toMatch(/trackingLoadTbl\.tableArn/)
    expect(resources).toMatch(/trackingLoadFinancialsTbl\.tableArn/)
  })

  it('is told the LoadFinancials table name, which shipmentTablesFromEnv reads', () => {
    expect(TRACKING_ACTIONS_TABLES.LOAD_FINANCIALS_TABLE_NAME).toBe('LoadFinancials')
  })
})
