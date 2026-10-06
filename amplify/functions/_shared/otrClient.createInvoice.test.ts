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
import { OtrClient } from './otrClient'

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

/** A fetch that answers the token call, then hands `invoiceReply` to POST /invoices. */
function stubFetch(invoiceReply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/auth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 7199 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
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
  return { impl, calls }
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
    const { impl } = stubFetch({ status: 409, body: { ...CREATED, IsDuplicate: false } })
    const r = await client(impl).createInvoice(PAYLOAD)
    expect(r.invoiceId).toBe(25520749)
    expect(r.isDuplicate).toBe(true)
    expect(r.invoiceExists).toBe(true)
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
