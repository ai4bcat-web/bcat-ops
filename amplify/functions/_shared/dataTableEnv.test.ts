import { describe, expect, it } from 'vitest'
import { applyDataTableSuffix } from './dataTableEnv'

const TABLES = { SHIPMENT_TABLE_NAME: 'Shipment', AUDIT_LOG_TABLE_NAME: 'AuditLog' } as const

describe('applyDataTableSuffix', () => {
  it('names every listed table <Model>-<suffix>', () => {
    const env: Record<string, string | undefined> = { DATA_TABLE_SUFFIX: 'abc123-NONE' }
    applyDataTableSuffix(TABLES, env)
    expect(env.SHIPMENT_TABLE_NAME).toBe('Shipment-abc123-NONE')
    expect(env.AUDIT_LOG_TABLE_NAME).toBe('AuditLog-abc123-NONE')
  })

  it('lets an explicit table name win (unit tests, rehearsal stacks)', () => {
    const env: Record<string, string | undefined> = { DATA_TABLE_SUFFIX: 'abc123-NONE', SHIPMENT_TABLE_NAME: 'Shipment-rehearsal' }
    applyDataTableSuffix(TABLES, env)
    expect(env.SHIPMENT_TABLE_NAME).toBe('Shipment-rehearsal')
    expect(env.AUDIT_LOG_TABLE_NAME).toBe('AuditLog-abc123-NONE')
  })

  it('leaves the environment alone without a suffix', () => {
    const env: Record<string, string | undefined> = {}
    applyDataTableSuffix(TABLES, env)
    expect(env).toEqual({})
  })
})
