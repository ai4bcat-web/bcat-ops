/**
 * Every SES sender must be on the verified, DKIM-signed bcatcorp.com domain. Mail From a gmail.com
 * address through SES fails DMARC alignment: SES accepts it and nobody receives it (rate con 20002,
 * invoice 20027). Nothing local exercises SES, so this reads the FROM_ADDRESS values the way CDK
 * will synthesise them, plus the in-code fallbacks the Lambdas use when the variable is unset.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backend = readFileSync(join(here, 'backend.ts'), 'utf8')

const SENDER_DOMAIN = '@bcatcorp.com'

/** Every literal address in `X.addEnvironment('FROM_ADDRESS' | 'SES_FROM_ADDRESS', ...)`, defaults included. */
function backendSenders(): { line: string; address: string }[] {
  const out: { line: string; address: string }[] = []
  const re = /addEnvironment\(\s*'(?:SES_)?FROM_ADDRESS'\s*,([^\n]*)/g
  for (const match of backend.matchAll(re)) {
    for (const addr of match[1].matchAll(/'([^']+@[^']+)'/g)) out.push({ line: match[0].trim(), address: addr[1] })
  }
  return out
}

const LAMBDA_FALLBACKS = [
  'functions/tms-tracking-actions/handler.ts',
  'functions/tms-tracking-actions/thread.ts',
  'functions/shipment-notifier/handler.ts',
  'functions/driver-pay-emailer/handler.ts',
]

describe('SES senders', () => {
  it('finds the senders it is guarding', () => {
    expect(backendSenders().length).toBeGreaterThanOrEqual(10)
  })

  it.each(backendSenders())('$line sends from bcatcorp.com', ({ address }) => {
    expect(address.toLowerCase().endsWith(SENDER_DOMAIN)).toBe(true)
  })

  it('sends invoices from billing@bcatcorp.com', () => {
    expect(backend).toMatch(/financeActionsFn\.addEnvironment\('FROM_ADDRESS',\s*'billing@bcatcorp\.com'\)/)
  })

  it.each(LAMBDA_FALLBACKS)('%s has no gmail.com fallback sender', (file) => {
    const src = readFileSync(join(here, file), 'utf8')
    expect(src).not.toMatch(/FROM_ADDRESS\s*(\?\?|\|\|)\s*'[^']*@gmail\.com'/)
    expect(src).not.toMatch(/from:\s*'[^']*@gmail\.com'/)
  })
})
