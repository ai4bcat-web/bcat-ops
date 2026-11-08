import { describe, expect, it } from 'vitest'
import { dnsRecordsFor, normalizeDomain, validateWhiteLabel, whiteLabelPatch } from './whiteLabel'

describe('normalizeDomain', () => {
  it('lowercases and strips scheme and trailing dot', () => {
    expect(normalizeDomain('HTTPS://TMS.BCATCORP.COM.')).toBe('tms.bcatcorp.com')
    expect(normalizeDomain('https://www.bcatcorp.com/')).toBe('www.bcatcorp.com')
  })

  it('strips auth, port and path', () => {
    expect(normalizeDomain('https://user:pass@tms.bcatcorp.com:8443/path')).toBe('tms.bcatcorp.com')
  })

  it('refuses an IP address', () => {
    expect(() => normalizeDomain('192.168.1.1')).toThrow('An IP address cannot be used')
    expect(() => normalizeDomain('10.0.0.1')).toThrow('An IP address cannot be used')
  })

  it('refuses a bare public suffix', () => {
    expect(() => normalizeDomain('com')).toThrow('public suffix')
    expect(() => normalizeDomain('co.uk')).toThrow('public suffix')
  })

  it('refuses empty input', () => {
    expect(() => normalizeDomain('')).toThrow('Domain is required')
    expect(() => normalizeDomain(null)).toThrow('Domain must be text')
  })
})

describe('dnsRecordsFor', () => {
  it('is deterministic for a domain and app id', () => {
    const records = dnsRecordsFor('tms.bcatcorp.com', 'd3dejqzs77khq6')
    expect(records).toHaveLength(4)
    expect(records[0]).toEqual({ type: 'CNAME', name: 'tms.bcatcorp.com', value: 'd3dejqzs77khq6.amplifyapp.com' })
  })

  it('falls back to a default app id', () => {
    const records = dnsRecordsFor('portal.bcatcorp.com', '')
    expect(records[0].value).toBe('app.amplifyapp.com')
  })
})

describe('whiteLabelPatch', () => {
  it('computes PENDING status and records from the domain', () => {
    const result = whiteLabelPatch(null, 'TMS.BCATCORP.COM', 'ryne@bcatcorp.com', '2026-10-29T12:00:00Z', 'd3dejqzs77khq6')
    expect(result.domain).toBe('tms.bcatcorp.com')
    expect(result.status).toBe('PENDING')
    expect(result.records).toHaveLength(4)
    expect(result.requestedBy).toBe('ryne@bcatcorp.com')
    expect(result.requestedAt).toBe('2026-10-29T12:00:00Z')
  })

  it('carries forward checkedAt from existing', () => {
    const existing = {
      domain: 'tms.bcatcorp.com',
      status: 'PENDING' as const,
      records: [],
      checkedAt: '2026-10-28T00:00:00Z',
    }
    const result = whiteLabelPatch(existing, 'tms.bcatcorp.com', 'ryne@bcatcorp.com', '2026-10-29T12:00:00Z')
    expect(result.checkedAt).toBe('2026-10-28T00:00:00Z')
    expect(result.failureReason).toBeNull()
  })
})

describe('validateWhiteLabel', () => {
  it('normalizes and computes the stored block', () => {
    const result = validateWhiteLabel(
      { domain: 'https://TMS.BCATCORP.COM/' },
      null,
      'ryne@bcatcorp.com',
      '2026-10-29T12:00:00Z',
      'd3dejqzs77khq6',
    )
    expect(result?.status).toBe('PENDING')
    expect(result?.records).toHaveLength(4)
  })

  it('returns null for null input', () => {
    expect(validateWhiteLabel(null, null, 'ryne@bcatcorp.com', 'now')).toBeNull()
  })

  it('refuses a caller-supplied VERIFIED status', () => {
    const result = validateWhiteLabel(
      { domain: 'tms.bcatcorp.com', status: 'VERIFIED', records: [] },
      null,
      'ryne@bcatcorp.com',
      'now',
      'app',
    )
    expect(result?.status).toBe('PENDING')
    expect(result?.records.length).toBeGreaterThan(0)
  })
})
