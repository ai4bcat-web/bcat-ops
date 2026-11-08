import { describe, it, expect } from 'vitest'
import type { ApInboxConfig } from '@/lib/apInbox/types'
import { formFromConfig, parseApInboxForm } from './apInboxSettingsModel'

const CONFIG: ApInboxConfig = {
  enabled: true, mode: 'GOOGLE', mailbox: 'ai4bcat@gmail.com', runHourChicago: 6, lookbackHours: 24, autoApply: true,
  autoApplyMinScore: 0.9, reviewMinScore: 0.5, maxMessagesPerRun: 200, maxModelCallsPerRun: 80, maxAutoAppliesPerRun: 50,
  dismissedRetentionDays: 30, resolvedRetentionDays: 180, ignoreSenders: ['a@x.com'], version: 3,
}

describe('parseApInboxForm', () => {
  it('round-trips a saved config', () => {
    const r = parseApInboxForm(formFromConfig(CONFIG))
    expect('config' in r && r.config.autoApplyMinScore).toBe(0.9)
    expect('config' in r && r.config.ignoreSenders).toEqual(['a@x.com'])
  })

  it('refuses an auto-update score below the 0.85 floor', () => {
    const r = parseApInboxForm({ ...formFromConfig(CONFIG), autoApplyMinScore: '0.8' })
    expect(r).toEqual({ error: 'Auto-update score must be between 0.85 and 0.99' })
  })

  it('keeps the review floor ten points under the auto score', () => {
    const r = parseApInboxForm({ ...formFromConfig(CONFIG), reviewMinScore: '0.85' })
    expect('error' in r).toBe(true)
  })

  it('refuses an hour outside 0-23 and a caps overflow', () => {
    expect('error' in parseApInboxForm({ ...formFromConfig(CONFIG), runHourChicago: '24' })).toBe(true)
    expect('error' in parseApInboxForm({ ...formFromConfig(CONFIG), maxMessagesPerRun: '501' })).toBe(true)
  })

  it('lower-cases and de-duplicates ignore senders', () => {
    const r = parseApInboxForm({ ...formFromConfig(CONFIG), ignoreSenders: 'Spam@X.com, spam@x.com\n@news.com' })
    expect('config' in r && r.config.ignoreSenders).toEqual(['spam@x.com', '@news.com'])
  })
})
