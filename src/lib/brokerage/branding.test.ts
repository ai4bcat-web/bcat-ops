import { describe, expect, it } from 'vitest'
import {
  BRAND_ACCENTS,
  BRAND_THEMES,
  SIGNATURE_TOKENS,
  brandKey,
  logoKeyOk,
  renderSignature,
  signatureTokens,
  validateBranding,
} from './branding'

describe('logoKeyOk', () => {
  it('accepts a key under brand/', () => {
    expect(logoKeyOk('brand/logos/square.png')).toBe(true)
  })

  it('refuses keys outside brand/', () => {
    expect(logoKeyOk('invoices/logo.png')).toBe(false)
    expect(logoKeyOk('shipment-docs/logo.png')).toBe(false)
  })

  it('refuses empty, non-string and overlong keys', () => {
    expect(logoKeyOk('')).toBe(false)
    expect(logoKeyOk(null)).toBe(false)
    expect(logoKeyOk('brand/' + 'x'.repeat(300))).toBe(false)
  })
})

describe('brandKey', () => {
  it('returns null for blank values', () => {
    expect(brandKey(null)).toBeNull()
    expect(brandKey('')).toBeNull()
  })

  it('throws for a key outside brand/', () => {
    expect(() => brandKey('public/logo.png')).toThrow('Logo keys must start with "brand/"')
  })

  it('accepts a brand key', () => {
    expect(brandKey('brand/wide.png')).toBe('brand/wide.png')
  })
})

describe('validateBranding', () => {
  it('refuses non-object input', () => {
    expect(() => validateBranding(null)).toThrow('Branding must be an object.')
    expect(() => validateBranding('dark')).toThrow('Branding must be an object.')
  })

  it('accepts all six accents', () => {
    for (const accent of BRAND_ACCENTS) {
      expect(validateBranding({ brandAccent: accent }).brandAccent).toBe(accent)
    }
  })

  it('refuses an unknown accent', () => {
    expect(() => validateBranding({ brandAccent: 'GREEN' })).toThrow('Accent colour must be one of')
  })

  it('refuses LIGHT and SYSTEM with the plan reason', () => {
    expect(() => validateBranding({ brandTheme: 'LIGHT' })).toThrow('Only the dark theme is built')
    expect(() => validateBranding({ brandTheme: 'SYSTEM' })).toThrow('Only the dark theme is built')
  })

  it('accepts DARK', () => {
    expect(validateBranding({ brandTheme: 'DARK' }).brandTheme).toBe('DARK')
  })

  it('validates the three logo keys', () => {
    const result = validateBranding({
      brandLogoSquareKey: 'brand/square.png',
      brandLogoWideKey: 'brand/wide.png',
      brandLogoDocumentKey: 'brand/doc.png',
    })
    expect(result.brandLogoSquareKey).toBe('brand/square.png')
    expect(result.brandLogoWideKey).toBe('brand/wide.png')
    expect(result.brandLogoDocumentKey).toBe('brand/doc.png')
  })

  it('validates sender addresses for the five slots', () => {
    const result = validateBranding({
      brandSenders: {
        shipment: 'ship@bcatcorp.com',
        rateCon: 'rate@bcatcorp.com',
        quoteReply: 'quote@bcatcorp.com',
        customerInvoice: 'invoice@bcatcorp.com',
        remittance: 'remit@bcatcorp.com',
      },
    })
    expect(result.brandSenders).toEqual({
      shipment: 'ship@bcatcorp.com',
      rateCon: 'rate@bcatcorp.com',
      quoteReply: 'quote@bcatcorp.com',
      customerInvoice: 'invoice@bcatcorp.com',
      remittance: 'remit@bcatcorp.com',
    })
  })

  it('refuses a bad sender address', () => {
    expect(() => validateBranding({ brandSenders: { shipment: 'not-an-email' } }))
      .toThrow('"not-an-email" is not an e-mail address')
  })

  it('omits missing keys from the result', () => {
    expect(validateBranding({ brandAccent: 'YELLOW' })).toEqual({ brandAccent: 'YELLOW' })
  })
})

describe('signatureTokens', () => {
  it('returns unknown tokens', () => {
    expect(signatureTokens('Hello {name}, reach us at {custom}.')).toEqual(['custom'])
  })

  it('returns empty when all tokens are known', () => {
    expect(signatureTokens(SIGNATURE_TOKENS.map((t) => `{${t}}`).join(' '))).toEqual([])
  })

  it('returns empty for blank input', () => {
    expect(signatureTokens(null)).toEqual([])
  })
})

describe('renderSignature', () => {
  it('replaces known tokens', () => {
    const rendered = renderSignature(
      '{name}\n{title}\n{phone}\n{company}',
      { name: 'Sam Smith', title: 'Dispatcher', phone: '555-1234' },
      { name: 'BCAT Logistics' },
    )
    expect(rendered).toBe('Sam Smith\nDispatcher\n555-1234\nBCAT Logistics')
  })

  it('returns empty for blank template', () => {
    expect(renderSignature(null, { name: 'Sam' }, { name: 'BCAT' })).toBe('')
  })
})
