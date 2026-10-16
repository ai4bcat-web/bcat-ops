import { describe, it, expect } from 'vitest'
import { normalizeSettings, dispatcherContactFor } from './dispatch'

describe('dispatcher contacts', () => {
  it('normalizes email, name and phone, dropping blanks and duplicates', () => {
    const r = normalizeSettings({ dispatcherContacts: [
      { email: 'Arcie@bcatcorp.com', name: ' Arcie ', phone: '(224) 555-0100' },
      { email: 'arcie@bcatcorp.com', name: 'dup', phone: '2245550100' },
      { email: '', name: 'nobody', phone: '' },
    ] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.dispatcherContacts).toEqual([{ email: 'arcie@bcatcorp.com', name: 'Arcie', phone: '+12245550100' }])
  })
  it('rejects a bad phone and names the dispatcher', () => {
    const r = normalizeSettings({ dispatcherContacts: [{ email: 'arcie@bcatcorp.com', name: 'Arcie', phone: '12' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.message).toContain('arcie@bcatcorp.com')
  })
  it('resolves the primary dispatcher first, then the backup, else nothing', () => {
    const settings = { dispatcherContacts: [{ email: 'arcie@bcatcorp.com', name: 'Arcie', phone: '+12245550100' }] }
    expect(dispatcherContactFor(settings, { dispatcherPrimary: 'ARCIE@bcatcorp.com', dispatcherBackup: null })?.name).toBe('Arcie')
    expect(dispatcherContactFor(settings, { dispatcherPrimary: 'jenny@bcatcorp.com', dispatcherBackup: 'arcie@bcatcorp.com' })?.phone).toBe('+12245550100')
    expect(dispatcherContactFor(settings, { dispatcherPrimary: 'jenny@bcatcorp.com', dispatcherBackup: null })).toBeNull()
    expect(dispatcherContactFor(null, { dispatcherPrimary: 'arcie@bcatcorp.com', dispatcherBackup: null })).toBeNull()
  })
})
