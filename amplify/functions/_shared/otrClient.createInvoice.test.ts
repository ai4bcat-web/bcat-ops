// @vitest-environment node
/**
 * What v2 actually wants on POST /invoices, verified against production OTR.
 *
 * The 400 that blocked every submit was a bare `{"statusCode":400,"message":"Invalid
 * Request"}` naming no field. It came from sending `CustomerMC` — which is what OTR's own
 * v2 reference lists in its required-fields table, while the example body on the very same
 * page shows `BrokerMC`. The live API takes BrokerMC. These pin that, and the two other
 * v1/v2 renames that sat behind it.
 */
import { describe, it, expect, vi } from 'vitest'
import { OtrClient, OtrAlreadyExistsError, judgeExistingInvoice } from './otrClient'

const V2 = 'https://services.otrsolutions.com/carrier-tms/2'

const PAYLOAD = {
  InvoiceNo: '14523',
  PoNumber: 'NWI180010',
  BrokerMC: '730061',
  InvoiceAmount: 500,
  InvoiceDate: '2026-10-05',
  FromCity: 'LIBERTYVILLE',
  FromState: 'IL',
  FromZip: '60048',
  ToCity: 'CHICAGO',
  ToState: 'IL',
  ToZip: '60607',
}

/**
 * A fetch that answers the token call, then hands `invoiceReply` to POST /invoices and `lookup`
 * to the read-back GET /invoices?invoicePkeys=... a 409 now makes. A test that does not pass a
 * lookup gets the matching invoice back (number 14523, $500, Pending), so only the cases that
 * care about the read-back have to say anything about it.
 */
function stubFetch(
  invoiceReply: { status: number; body: unknown },
  lookup: { status: number; body: unknown } = {
    status: 200,
    body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 1 },
  },
) {
  const calls: Array<{ url: string; body: unknown }> = []
  const gets: string[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/auth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 7199 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (init?.method === 'GET') {
      gets.push(String(url))
      const lb = typeof lookup.body === 'string' ? lookup.body : JSON.stringify(lookup.body)
      return new Response(lb === '' ? null : lb, {
        status: lookup.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    // A raw string is sent verbatim, so a test can hand back an empty or non-JSON body.
    const body = typeof invoiceReply.body === 'string'
      ? invoiceReply.body
      : JSON.stringify(invoiceReply.body)
    return new Response(body === '' ? null : body, {
      status: invoiceReply.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { impl, calls, gets }
}

function client(impl: unknown) {
  return new OtrClient({
    baseUrl: V2,
    uploadBaseUrl: V2,
    username: 'u',
    password: 'p',
    subscriptionKey: 'k',
    clientDot: '547328',
    fetchImpl: impl as typeof fetch,
  })
}

const CREATED = {
  IsDuplicate: false, Message: null, invoicePkey: 25520749, invoiceNo: '14523',
  poNumber: 'NWI180010', clientName: 'IVAN CARTAGE CO (MC-274623)', invoiceExists: true,
  brokerName: 'NEW WAVE INTERNATIONAL CARGO, INC.',
}

describe('the v2 create-invoice body', () => {
  it('sends BrokerMC as a number, not CustomerMC', async () => {
    const { impl, calls } = stubFetch({ status: 201, body: CREATED })
    await client(impl).createInvoice(PAYLOAD)
    const body = calls[0].body as Record<string, unknown>
    expect(body.BrokerMC).toBe(730061)
    expect(body).not.toHaveProperty('CustomerMC')
  })

  it('sends our own DOT, which v2 requires', async () => {
    const { impl, calls } = stubFetch({ status: 201, body: CREATED })
    await client(impl).createInvoice(PAYLOAD)
    expect((calls[0].body as Record<string, unknown>).ClientDOT).toBe('547328')
  })

  it('drops the ZIPs, which v2 does not take', async () => {
    const { impl, calls } = stubFetch({ status: 201, body: CREATED })
    await client(impl).createInvoice(PAYLOAD)
    const body = calls[0].body as Record<string, unknown>
    expect(body).not.toHaveProperty('FromZip')
    expect(body).not.toHaveProperty('ToZip')
  })

  it('refuses before calling OTR when no DOT is configured', async () => {
    const { impl, calls } = stubFetch({ status: 201, body: CREATED })
    const c = new OtrClient({
      baseUrl: V2, uploadBaseUrl: V2, username: 'u', password: 'p',
      subscriptionKey: 'k', fetchImpl: impl as typeof fetch,
    })
    await expect(c.createInvoice(PAYLOAD)).rejects.toThrow(/ClientDOT/)
    expect(calls).toHaveLength(0)
  })
})

describe('the v2 create-invoice response', () => {
  it('reads the id from invoicePkey', async () => {
    // v1 called it invoiceId. Reading only that threw away an invoice just created.
    const { impl } = stubFetch({ status: 201, body: CREATED })
    const r = await client(impl).createInvoice(PAYLOAD)
    expect(r.invoiceId).toBe(25520749)
    expect(r.brokerName).toBe('NEW WAVE INTERNATIONAL CARGO, INC.')
  })

  it('still reads a v1 invoiceId', async () => {
    const { impl } = stubFetch({ status: 200, body: { invoiceId: 999, invoiceNo: '14523' } })
    expect((await client(impl).createInvoice(PAYLOAD)).invoiceId).toBe(999)
  })

  it('carries on with the existing invoice when OTR says duplicate', async () => {
    /*
     * A submit interrupted after the invoice was created — a timeout, a retry, a second
     * click — could otherwise never be finished: every later attempt died on the 409
     * before reaching the documents.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { impl } = stubFetch({ status: 409, body: { ...CREATED, IsDuplicate: false } })
    const r = await client(impl).createInvoice(PAYLOAD)
    expect(warn).toHaveBeenCalledWith('[otr] invoice already exists at OTR; continuing with it', expect.objectContaining({ invoiceId: 25520749 }))
    warn.mockRestore()
    expect(r.invoiceId).toBe(25520749)
    expect(r.isDuplicate).toBe(true)
    expect(r.invoiceExists).toBe(true)
  })

  it('refuses a 409 that names a DIFFERENT invoice number — another PRO with this PO', async () => {
    // PRO 14641 was handed 14624's invoice id this way and had its rate con filed on it.
    const { impl } = stubFetch({ status: 409, body: { ...CREATED, invoiceNo: '14624' } })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/different PRO/)
  })

  it('still raises on a 409 that carries no id to go on', async () => {
    const { impl } = stubFetch({ status: 409, body: { message: 'conflict' } })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/Duplicate/)
  })

  it('names the broker MC when OTR has not approved it', async () => {
    const { impl } = stubFetch({ status: 402, body: { message: 'not approved' } })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/730061 is not approved/)
  })
})

describe('when OTR answers with no body at all', () => {
  it('explains a 204 instead of crashing on JSON.parse', async () => {
    /*
     * The live failure on PRO 14519. OTR returns 204 with a zero-byte body when it does not
     * recognise the broker MC — reproduced against production, where the same payload with
     * a known MC returns 201 and an invoicePkey. The old code fell through to
     * JSON.parse(''), so the office was shown "Unexpected end of JSON input" as the entire
     * explanation for why their load would not factor.
     */
    const { impl } = stubFetch({ status: 204, body: '' })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/created nothing/)
  })

  it('names the MC to check, because that is what is usually wrong', async () => {
    const { impl } = stubFetch({ status: 204, body: '' })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/730061/)
  })

  it('never surfaces a parser message to the office', async () => {
    const { impl } = stubFetch({ status: 204, body: '' })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.not.toThrow(/Unexpected end of JSON/)
  })

  it('treats an empty 200 the same way — a success with nothing to confirm it', async () => {
    const { impl } = stubFetch({ status: 200, body: '' })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/created nothing/)
  })

  it('explains a body that is not JSON rather than throwing over it', async () => {
    const { impl } = stubFetch({ status: 200, body: '<html>maintenance</html>' })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/could not read/)
  })

  it('still creates normally when OTR answers properly', async () => {
    const { impl } = stubFetch({ status: 201, body: CREATED })
    expect((await client(impl).createInvoice(PAYLOAD)).invoiceId).toBe(25520749)
  })
})

describe('the broker check that gates a submit', () => {
  /** A fetch that answers the token call, then the broker-check with `reply`. */
  function stubBroker(reply: { status: number; body: unknown }) {
    const impl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7199 }), { status: 200 })
      }
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      return new Response(body === '' ? null : body, { status: reply.status })
    })
    return impl
  }

  it('reports NOT FOUND rather than throwing, so the submit can act on it', async () => {
    /*
     * The live case: MC 2577587 on PRO 14519. OTR has no such broker, and a create with it
     * returns 204 and silently does nothing — so knowing this BEFORE creating is what turns
     * a dead end into "try another MC".
     */
    const r = await client(stubBroker({ status: 404, body: { Message: 'not found', ResponseStatus: 404 } }))
      .brokerCheck({ brokerMc: '2577587' })
    expect(r.decision).toBe('NOT FOUND')
    expect(r.message).toMatch(/2577587/)
  })

  it('keeps NOT FOUND distinct from NOT APPROVED', async () => {
    // Different problems with different fixes: one needs a new MC, the other a phone call.
    const r = await client(stubBroker({ status: 200, body: { message: 'Not Approved' } }))
      .brokerCheck({ brokerMc: '730061' })
    expect(r.decision).toBe('NOT APPROVED')
  })

  it('still throws on a transport failure, which is indeterminate', async () => {
    // A 500 says nothing about the MC. The submit treats this as unknown and proceeds —
    // refusing to invoice every time OTR has a bad minute would hold up good loads.
    await expect(
      client(stubBroker({ status: 500, body: 'boom' })).brokerCheck({ brokerMc: '730061' }),
    ).rejects.toThrow(/Broker check failed/)
  })
})

describe('a 409 "already exists" is only carried on with when the invoice is OURS and live', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  async function refused(reply: { status: number; body: unknown }, lookup?: { status: number; body: unknown }) {
    const { impl, gets } = stubFetch(reply, lookup)
    try {
      await client(impl).createInvoice(PAYLOAD)
    } catch (e) {
      return { e: e as OtrAlreadyExistsError, gets }
    }
    throw new Error('expected createInvoice to refuse')
  }

  it('reads the invoice back before adopting it', async () => {
    const warn = quiet()
    const { impl, gets } = stubFetch({ status: 409, body: CREATED })
    await client(impl).createInvoice(PAYLOAD)
    warn.mockRestore()
    expect(gets).toHaveLength(1)
    expect(gets[0]).toContain('25520749')
  })

  it('logs the 409 body so there is something to read afterwards', async () => {
    const warn = quiet()
    const { impl } = stubFetch({ status: 409, body: CREATED })
    await client(impl).createInvoice(PAYLOAD)
    expect(warn).toHaveBeenCalledWith('[otr] create answered 409', expect.objectContaining({
      invoiceNo: '14523',
      body: expect.stringContaining('25520749'),
    }))
    warn.mockRestore()
  })

  it('adopts an invoice that agrees on number and amount and is still Pending', async () => {
    const warn = quiet()
    const { impl } = stubFetch({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 1 } })
    expect((await client(impl).createInvoice(PAYLOAD)).invoiceId).toBe(25520749)
    warn.mockRestore()
  })

  it('refuses when OTR\'s copy carries a different invoice number', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14999', invoiceAmount: 500, Status: 1 } })
    warn.mockRestore()
    expect(e).toBeInstanceOf(OtrAlreadyExistsError)
    expect(e.reason).toBe('number_mismatch')
    expect(e.invoiceId).toBe(25520749)
    expect(e.message).toMatch(/different PRO/)
  })

  it('refuses when OTR\'s copy carries a different amount', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 650, Status: 1 } })
    warn.mockRestore()
    expect(e.reason).toBe('amount_mismatch')
    expect(e.message).toMatch(/\$650\.00, not \$500\.00/)
  })

  it('refuses an invoice OTR holds as Dead (status 4), and says to ask OTR to void it', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 4 } })
    warn.mockRestore()
    expect(e.reason).toBe('unusable')
    expect(e.otrStatus).toBe('Dead')
    expect(e.message).toBe('OTR already has invoice 25520749 for 14523 (Dead). Ask OTR to void it, or change the invoice number.')
  })

  it('refuses an invoice OTR holds as Duplicate (status 7)', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 7 } })
    warn.mockRestore()
    expect(e.reason).toBe('unusable')
    expect(e.otrStatus).toBe('Duplicate')
  })

  it('reads a status that arrives as a word, not a number', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 'Dead' } })
    warn.mockRestore()
    expect(e.reason).toBe('unusable')
  })

  it('refuses when the invoice cannot be read back', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 500, body: { message: 'boom' } })
    warn.mockRestore()
    expect(e.reason).toBe('lookup_failed')
    expect(e.message).toMatch(/could not be read back/)
  })

  it('refuses when OTR does not say the amount, because it cannot be confirmed', async () => {
    const warn = quiet()
    const { e } = await refused({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', Status: 1 } })
    warn.mockRestore()
    expect(e.reason).toBe('unconfirmed')
  })

  it('falls back to the number the 409 body named when the read-back has none', async () => {
    const warn = quiet()
    const { impl } = stubFetch({ status: 409, body: CREATED }, { status: 200, body: { invoiceAmount: 500, Status: 1 } })
    expect((await client(impl).createInvoice(PAYLOAD)).invoiceId).toBe(25520749)
    warn.mockRestore()
  })

  it('still raises on a 409 with no invoice id, and does not read anything back', async () => {
    const warn = quiet()
    const { impl, gets } = stubFetch({ status: 409, body: { message: 'conflict' } })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toThrow(/Duplicate/)
    warn.mockRestore()
    expect(gets).toHaveLength(0)
  })

  it('a refusal never returns an invoice, so nothing can be uploaded to it', async () => {
    const warn = quiet()
    const { impl } = stubFetch({ status: 409, body: CREATED }, { status: 200, body: { InvoiceNo: '14523', invoiceAmount: 500, Status: 4 } })
    await expect(client(impl).createInvoice(PAYLOAD)).rejects.toBeInstanceOf(OtrAlreadyExistsError)
    warn.mockRestore()
  })
})

describe('judgeExistingInvoice', () => {
  const sent = { invoiceNo: '20041', amountDollars: 400 }
  it('adopts a matching live invoice', () => {
    expect(judgeExistingInvoice(sent, { invoiceNo: '20041', invoiceAmount: 400, status: '1' }, 1).adopt).toBe(true)
  })
  it('adopts a matching Approved invoice: it is ours and it is live', () => {
    expect(judgeExistingInvoice(sent, { invoiceNo: '20041', invoiceAmount: 400, status: '3' }, 1).adopt).toBe(true)
  })
  it('compares cents, so 400 and 400.004 agree but 400 and 400.01 do not', () => {
    expect(judgeExistingInvoice(sent, { invoiceNo: '20041', invoiceAmount: 400.004, status: '1' }, 1).adopt).toBe(true)
    expect(judgeExistingInvoice(sent, { invoiceNo: '20041', invoiceAmount: 400.01, status: '1' }, 1).adopt).toBe(false)
  })
  it('trims the invoice numbers', () => {
    expect(judgeExistingInvoice({ invoiceNo: ' 20041 ', amountDollars: 400 }, { invoiceNo: '20041 ', invoiceAmount: 400, status: '1' }, 1).adopt).toBe(true)
  })
  it('refuses when neither OTR nor the 409 body gives a number', () => {
    const v = judgeExistingInvoice(sent, { invoiceNo: '', invoiceAmount: 400, status: '1' }, 1, '')
    expect(v.adopt).toBe(false)
    expect(!v.adopt && v.reason).toBe('unconfirmed')
  })
  it('judges the number before the status, so a different PRO is reported as that', () => {
    const v = judgeExistingInvoice(sent, { invoiceNo: '20000', invoiceAmount: 400, status: '4' }, 1)
    expect(!v.adopt && v.reason).toBe('number_mismatch')
  })
})
