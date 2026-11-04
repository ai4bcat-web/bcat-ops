import { describe, expect, it } from 'vitest'
import { devRuleState, KEEP_ENABLED_ON_DEV } from './devRuleGuard'

describe('dev rule guard', () => {
  it('leaves exactly the nightly export and its check enabled', () => {
    expect([...KEEP_ENABLED_ON_DEV].sort()).toEqual(['DataSafetyNightlyCheckRule', 'DataSafetyNightlyExportRule'])
    expect(devRuleState('DataSafetyNightlyExportRule')).toBe('ENABLED')
    expect(devRuleState('DataSafetyNightlyCheckRule')).toBe('ENABLED')
  })

  it('disables every other schedule, including lookalikes', () => {
    for (const id of ['ApptReportDailyRule', 'McpSyncRule', 'DataSafetyNightlyExportRule2', 'datasafetynightlyexportrule', 'DataSafety', '', undefined]) {
      expect(devRuleState(id)).toBe('DISABLED')
    }
  })
})
