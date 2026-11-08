import { describe, it, expect } from 'vitest'
import { LIFECYCLE_TABS, activeLifecycleTab, visibleLifecycleTabs } from './lifecycleTabs'

describe('activeLifecycleTab', () => {
  it.each([
    ['/tms/rates', 'quote'],
    ['/tms/rates/spot', 'quote'],
    ['/tms/rates/new', 'quote'],
    ['/tms/rates/Q-12', 'quote'],
    ['/tms/shipments/intake', 'build'],
    ['/tms/shipments/intake/abc123', 'build'],
    ['/tms/shipments/new', 'build'],
    ['/tms/shipments/SHP-1/edit', 'build'],
    ['/tms/shipments', 'view'],
    ['/tms/shipments/', 'view'],
    ['/tms/shipments/SHP-1', 'view'],
    ['/tms/carrier-sales', 'book'],
    ['/tms/tracking', 'track'],
    ['/tms/tracking/links', 'track'],
    ['/tms/load-review', 'review'],
  ])('%s lights %s', (path, key) => {
    expect(activeLifecycleTab(path)).toBe(key)
  })

  it('the Quote tab opens the Quote inbox yet stays lit on the Quotes tab and the callback', () => {
    expect(LIFECYCLE_TABS.find((t) => t.key === 'quote')?.to).toBe('/tms/rates/spot')
    expect(activeLifecycleTab('/tms/rates')).toBe('quote')
    expect(activeLifecycleTab('/tms/rates/spot/callback')).toBe('quote')
  })

  it('lights Build, never View, for the intake queue', () => {
    expect(activeLifecycleTab('/tms/shipments/intake')).not.toBe('view')
  })

  it.each(['/dashboard', '/tms/customers', '/tms/invoicing', '/tms/brokerage/users', '/tms/ratesheet', '/tms', '/compliance'])(
    '%s lights no tab',
    (path) => {
      expect(activeLifecycleTab(path)).toBeNull()
    },
  )

  it('ignores a query string', () => {
    expect(activeLifecycleTab('/tms/shipments?list=all')).toBe('view')
  })
})

describe('visibleLifecycleTabs', () => {
  it('keeps the flow order and drops tabs the person may not open', () => {
    expect(visibleLifecycleTabs(() => true).map((t) => t.key)).toEqual(LIFECYCLE_TABS.map((t) => t.key))
    expect(visibleLifecycleTabs((k) => k !== 'loadReview').map((t) => t.key)).toEqual(['quote', 'build', 'view', 'book', 'track'])
  })
})
