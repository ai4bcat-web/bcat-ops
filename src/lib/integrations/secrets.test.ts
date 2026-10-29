import { describe, it, expect } from 'vitest'
import { maskOf, redactSecrets, validateCredentials } from './secrets'
import { descriptorOf } from './registry'

const dat = descriptorOf('DAT')!
const rmis = descriptorOf('RMIS')!

describe('maskOf', () => {
  it('keeps the last four characters and nothing more', () => {
    const mask = maskOf(dat.credentialFields, {
      serviceAccountEmail: 'dat@bcatcorp.com',
      serviceAccountPassword: 'sup3rsecretvalue',
      rateViewTier: 'Combo Pro',
    })
    expect(mask).toEqual([
      { key: 'serviceAccountEmail', last4: '.com' },
      { key: 'serviceAccountPassword', last4: 'alue' },
      { key: 'rateViewTier', last4: ' Pro' },
    ])
  })

  it('masks a short value to nothing rather than to itself', () => {
    const mask = maskOf(dat.credentialFields, {
      serviceAccountEmail: 'a@b.co',
      serviceAccountPassword: '1234',
      rateViewTier: 'abc',
    })
    expect(mask).toContainEqual({ key: 'serviceAccountPassword', last4: '' })
    expect(mask).toContainEqual({ key: 'rateViewTier', last4: '' })
  })

  it('records nothing for a field with no value', () => {
    expect(maskOf(dat.credentialFields, { serviceAccountPassword: '   ' })).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('removes a value and its base64 form from the same message', () => {
    const password = 'hunter2hunter2'
    const encoded = btoa(password)
    const message = `401 from DAT: password=${password}, header=Basic ${encoded}`
    const out = redactSecrets(message, [password])
    expect(out).not.toContain(password)
    expect(out).not.toContain(encoded)
    expect(out).toBe('401 from DAT: password=•••, header=Basic •••')
  })

  it('redacts the longer value first, so a contained value cannot half-reveal it', () => {
    const out = redactSecrets('token=abc123-suffix and user=abc123', ['abc123', 'abc123-suffix'])
    expect(out).toBe('token=••• and user=•••')
  })

  it('leaves a message with no credential in it alone', () => {
    expect(redactSecrets('HTTP 503', ['', null, undefined])).toBe('HTTP 503')
  })
})

describe('validateCredentials', () => {
  const good = {
    serviceAccountEmail: 'dat@bcatcorp.com',
    serviceAccountPassword: 'hunter2hunter2',
    rateViewTier: 'Combo Pro',
  }

  it('accepts a complete set', () => {
    expect(validateCredentials(dat, good)).toEqual({ ok: true })
  })

  it('names every missing required field', () => {
    const result = validateCredentials(dat, { serviceAccountEmail: 'dat@bcatcorp.com' })
    expect(result).toEqual({
      ok: false,
      errors: ['Service account password is required', 'RateView subscription is required'],
    })
  })

  it('refuses a whitespace-only value and a value with edge spaces', () => {
    expect(validateCredentials(dat, { ...good, rateViewTier: '   ' })).toEqual({
      ok: false,
      errors: ['RateView subscription is required'],
    })
    expect(validateCredentials(dat, { ...good, serviceAccountPassword: ' hunter2hunter2' })).toMatchObject({
      ok: false,
    })
  })

  it('refuses a plus address on the DAT service account', () => {
    const result = validateCredentials(dat, { ...good, serviceAccountEmail: 'ops+dat@bcatcorp.com' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.errors[0]).toContain('"+"')
  })

  it('refuses something that is not an e-mail where an e-mail is declared', () => {
    expect(validateCredentials(dat, { ...good, serviceAccountEmail: 'dat-at-bcatcorp' })).toMatchObject({ ok: false })
  })

  it('does not require an optional field but still checks one that is given', () => {
    const creds = { clientId: 'bcat', clientPassword: 'secret-value' }
    expect(validateCredentials(rmis, creds)).toEqual({ ok: true })
    expect(validateCredentials(rmis, { ...creds, carrierInviteUrl: 'https://rmis.com/invite ' })).toMatchObject({
      ok: false,
    })
  })
})
