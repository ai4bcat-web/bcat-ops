import { describe, expect, it } from 'vitest'
import { devRuleState, KEEP_ENABLED_ON_DEV } from './devRuleGuard'

describe('dev rule guard', () => {
  it('leaves exactly the nightly export, its check and the rollup sweep enabled', () => {
    expect([...KEEP_ENABLED_ON_DEV].sort()).toEqual(['DashboardRollupSweepRule', 'DataSafetyNightlyCheckRule', 'DataSafetyNightlyExportRule'])
    expect(devRuleState('DataSafetyNightlyExportRule')).toBe('ENABLED')
    expect(devRuleState('DataSafetyNightlyCheckRule')).toBe('ENABLED')
    expect(devRuleState('DashboardRollupSweepRule')).toBe('ENABLED')
  })

  it('disables every other schedule, including lookalikes', () => {
    for (const id of ['ApptReportDailyRule', 'McpSyncRule', 'DataSafetyNightlyExportRule2', 'datasafetynightlyexportrule', 'DataSafety', 'DashboardRollupSweepRule2', 'dashboardrollupsweeprule', '', undefined]) {
      expect(devRuleState(id)).toBe('DISABLED')
    }
  })
})
