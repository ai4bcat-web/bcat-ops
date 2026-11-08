import { describe, expect, it } from 'vitest'
import { devRuleState, devSesAllowsRecipient, devSesDeny, KEEP_ENABLED_ON_DEV } from './devRuleGuard'

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

describe('dev SES guard', () => {
  it('lets the one test mailbox and its plus aliases through, and nobody else', () => {
    for (const ok of ['ai4bcat@gmail.com', 'ai4bcat+tracking@gmail.com', 'ai4bcat+tracking.shp-1@gmail.com']) {
      expect(devSesAllowsRecipient(ok)).toBe(true)
    }
    for (const bad of ['ai4bcat@gmail.com.evil.io', 'xai4bcat@gmail.com', 'ai4bcat@gmail.co', 'ryne@bcatcorp.com', 'ai4bcat+x@evil.com', 'ai4bcat@gmailXcom', '']) {
      expect(devSesAllowsRecipient(bad)).toBe(false)
    }
  })

  it('denies when ANY recipient is outside the allow-list', () => {
    const d = devSesDeny()
    expect(d.actions).toEqual(['ses:*'])
    expect(Object.keys(d.conditions)).toEqual(['ForAnyValue:StringNotLike'])
    expect(d.conditions['ForAnyValue:StringNotLike']['ses:Recipients']).toEqual(['ai4bcat@gmail.com', 'ai4bcat+*@gmail.com'])
  })
})
