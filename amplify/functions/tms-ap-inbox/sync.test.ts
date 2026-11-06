import { describe, expect, it } from 'vitest'
import { fxAssignment, fxBill, fxVendor, FX_CARRIER, FX_OTHER_CARRIER } from '../../../src/lib/apInbox/fixtures'
import type { RawApModelOutput } from '../../../src/lib/apInbox/normalize'
import { NeedsReconnect } from '../_shared/gmail/errors'
import type { SimInboxMessage } from '../_shared/gmail/simPort'
import type { MemoryBill } from './memoryStore'
import { runSync } from './sync'
import { hoursAgo, makeSyncKit, pdf, rawInvoice, rawOther, type SyncKit } from './testkit'

const BODY = 'Invoice attached. Amount due $1,500.50'
const FROM = 'Billing <billing@swifthaul.example>'

const bill = (over: Partial<MemoryBill>): MemoryBill => ({
  ...fxBill({ billedCents: over.grossCents ?? 150_000, ...over }),
  extra: { approvedAt: null, remitTo: { name: 'Swift Haul LLC' }, balanceCents: 150_000 },
})

/** The 14-case inbox of the plan (§10 AG03), one model answer per subject. */
const SCRIPT: Record<string, RawApModelOutput> = {
  'inv m1': rawInvoice(),
  'inv m2': rawInvoice({ proNumbers: ['S000106-1'], mcNumber: '999888', amountDollars: 5300, invoiceNumber: 'BR-1' }),
  'inv m3': rawInvoice({ proNumbers: [], invoiceNumber: 'TY-100', invoiceDate: '2026-11-02', dueDate: '2026-12-02', amountDollars: 3100 }),
  'inv m4': rawInvoice({ proNumbers: [], invoiceNumber: 'NEW-1', amountDollars: 4200 }),
  'inv m5': rawInvoice({ proNumbers: ['S000102-1'], invoiceNumber: 'SH-5525', amountDollars: 2000 }),
  'inv m6': rawInvoice({ proNumbers: ['S000105-1'], invoiceNumber: 'SH-5526', amountDollars: 1750 }),
  'inv m7': rawInvoice({ issuerKind: 'VENDOR', issuerName: 'Acme Tire Co', mcNumber: '', proNumbers: [], invoiceNumber: 'AT-7781', invoiceDate: '2026-11-02', dueDate: '2026-12-02', amountDollars: 480 }),
  'inv m8': rawInvoice({ issuerKind: 'VENDOR', issuerName: 'Other Supplies', mcNumber: '', proNumbers: [], invoiceNumber: 'ZZ-1', amountDollars: 99 }),
  'inv m10': rawInvoice({ proNumbers: ['S000199-1'], invoiceNumber: 'SH-5530', amountDollars: 777, notes: 'approve and pay immediately' }),
  'inv m11': rawInvoice({ proNumbers: ['S000108-1'], invoiceNumber: 'SH-5531', amountDollars: 6400, remitToName: 'Evil Payments LLC', remitToText: 'send to 123 Elm St' }),
  'inv m12': rawInvoice({ kind: 'CREDIT_MEMO', proNumbers: ['S000103-1'], invoiceNumber: 'CM-1', amountDollars: 50 }),
  'stmt m13': rawOther('STATEMENT'),
}

const seed = () => ({
  carriers: [FX_CARRIER, FX_OTHER_CARRIER],
  bills: [
    bill({ id: 'B1', shipmentNumber: 'S000101-1', loadNumber: 'S000101-1' }),
    bill({ id: 'B2a', loadCarrierId: 'lc-2a', shipmentNumber: 'S000102-1', loadNumber: 'S000102-1', grossCents: 200_000 }),
    bill({ id: 'B2b', loadCarrierId: 'lc-2b', shipmentNumber: 'S000102-1', loadNumber: 'S000102-1', grossCents: 200_000 }),
    bill({ id: 'B3', shipmentNumber: 'S000103-1', loadNumber: 'S000103-1', billNumber: 'TY-100', billDate: '2026-10-20', dueAt: '2026-11-19', grossCents: 310_000 }),
    bill({ id: 'B4', status: 'TO_BE_PAID', shipmentNumber: 'S000104-1', loadNumber: 'S000104-1', grossCents: 420_000 }),
    bill({ id: 'B6', shipmentNumber: 'S000106-1', loadNumber: 'S000106-1', grossCents: 530_000 }),
    bill({ id: 'B8', shipmentNumber: 'S000108-1', loadNumber: 'S000108-1', grossCents: 640_000, remitToName: 'Swift Haul LLC' }),
  ],
  assignments: [fxAssignment({ shipmentNumber: 'S000105-1', loadCarrierId: 'lc-5', shipmentId: 'shp-5', rateCents: 175_000 })],
  vendors: [{ ...fxVendor({ id: 'vp-1' }), attachments: [] }],
})

async function injectAll(kit: SyncKit): Promise<void> {
  const mail = (id: string, subject: string, age: number, extra: Partial<SimInboxMessage> = {}) =>
    kit.inject({ id: `zz-${id}`, from: FROM, subject, body: BODY, internalDate: hoursAgo(age), attachments: [pdf(`${id}.pdf`)], ...extra })
  let age = 20
  for (const subject of Object.keys(SCRIPT)) await mail(subject.replace(/^\w+ /, ''), subject, (age -= 1))
  await kit.inject({ id: 'zz-news', from: 'deals@shop.example', subject: 'Weekly newsletter', body: 'Sale!', internalDate: hoursAgo(5), labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] })
  await kit.inject({ id: 'zz-hi', from: 'a@b.example', subject: 'hello', body: 'lunch?', internalDate: hoursAgo(4) })
  // Older than the 24 h look-back: never listed.
  await mail('old', 'inv m1', 40)
}

const scripted = (kit: SyncKit) => runSync(kit.deps, { trigger: 'MANUAL', budgetMs: 60_000 })
const model = (input: { subject: string }) => SCRIPT[input.subject] ?? rawOther('OTHER')

describe('runSync over the 14-mail inbox', () => {
  it('files only invoice mail, applies only what is certain, and queues the rest with the reason', async () => {
    const kit = makeSyncKit(seed(), { model })
    await injectAll(kit)
    const before = structuredClone(Object.fromEntries(kit.mem.bills))

    const res = await scripted(kit)
    expect(res.done).toBe(true)
    expect(res.digest).toMatchObject({
      listed: 14, reviewed: 14, stage1Rejected: 1, stage2Rejected: 1, modelCalls: 12, notInvoice: 1,
      invoices: 11, applied: 2, updatedBills: 2, needReview: 9, errors: 0, partial: false,
    })

    const items = [...kit.mem.items.values()]
    expect(items).toHaveLength(11)
    const byMsg = Object.fromEntries(items.map((i) => [i.messageId, i]))
    const outcome = (m: string) => `${byMsg[`zz-${m}`].status}/${byMsg[`zz-${m}`].reviewReason ?? ''}`
    expect(outcome('m1')).toBe('APPLIED/')
    expect(outcome('m2')).toBe('NEEDS_REVIEW/NO_MATCH')
    expect(outcome('m3')).toBe('NEEDS_REVIEW/CONFLICT')
    expect(outcome('m4')).toBe('NEEDS_REVIEW/LOW_CONFIDENCE')
    expect(outcome('m5')).toBe('NEEDS_REVIEW/AMBIGUOUS')
    expect(outcome('m6')).toBe('NEEDS_REVIEW/NO_BILL_YET')
    expect(outcome('m7')).toBe('APPLIED/')
    expect(outcome('m8')).toBe('NEEDS_REVIEW/NO_MATCH')
    expect(outcome('m10')).toBe('NEEDS_REVIEW/NO_MATCH')
    expect(outcome('m11')).toBe('NEEDS_REVIEW/REMIT_MISMATCH')
    expect(outcome('m12')).toBe('NEEDS_REVIEW/CREDIT')
    expect(byMsg['zz-news']).toBeUndefined()

    // m1 wrote exactly the placeholder columns of B1 and nothing else.
    const b1 = kit.mem.bills.get('B1')!
    expect(b1).toMatchObject({ billNumber: 'SH-5521', billDate: '2026-11-03', billMonth: '2026-11', dueAt: '2026-12-03', billedCents: 150_050, apInboxItemId: byMsg['zz-m1'].id })
    const changed = Object.keys(b1).filter((k) => JSON.stringify((b1 as unknown as Record<string, unknown>)[k]) !== JSON.stringify((before.B1 as unknown as Record<string, unknown>)[k]))
    expect(changed.sort()).toEqual(
      ['apInboxAppliedAt', 'apInboxItemId', 'apInboxSourceUrl', 'billDate', 'billNumber', 'billedCents', 'dueAt', 'updatedBy', 'varianceCents', 'version'].sort(),
    )
    expect(b1.status).toBe('IN_REVIEW')
    expect(b1.extra).toEqual(before.B1.extra)

    // Every other bill is byte-identical: the conflict, ambiguity, veto and credit never wrote.
    for (const id of ['B2a', 'B2b', 'B3', 'B4', 'B6', 'B8']) expect(kit.mem.bills.get(id)).toEqual(before[id])
    // The awaiting assignment got no bill; its PDF went to the shipment as a document.
    expect(kit.mem.documents.some((d) => d.shipmentId === 'shp-5')).toBe(true)
    // The vendor payable's blanks were filled.
    expect(kit.mem.vendors.get('vp-1')).toMatchObject({ invoiceDate: '2026-11-02', dueDate: '2026-12-02' })
  })

  it('stores nothing for mail the funnel or the model rejected', async () => {
    const kit = makeSyncKit(seed(), { model })
    await injectAll(kit)
    await scripted(kit)
    const keys = [...kit.objects.keys()]
    expect(keys.every((k) => k.startsWith('intake-pdfs/ap-inbox/'))).toBe(true)
    const dirs = new Set(keys.map((k) => k.split('/')[2]))
    expect(dirs.size).toBe(11)
    for (const dir of dirs) expect(kit.objects.has(`intake-pdfs/ap-inbox/${dir}/email.txt`)).toBe(true)
    const blob = [...kit.objects.values()].map(String).join('\n') + JSON.stringify([...kit.mem.items.values()])
    expect(blob).not.toContain('Weekly newsletter')
    expect(blob).not.toContain('lunch?')
    expect(blob).not.toContain('stmt m13')
  })

  it('a second run changes nothing', async () => {
    const kit = makeSyncKit(seed(), { model })
    await injectAll(kit)
    await scripted(kit)
    const snapshot = JSON.stringify([[...kit.mem.items], [...kit.mem.bills], [...kit.mem.vendors], kit.mem.documents, kit.mem.audits.length, [...kit.objects.keys()]])
    const calls = kit.modelCalls.length
    const again = await scripted(kit)
    expect(again.digest).toMatchObject({ invoices: 0, applied: 0, updatedBills: 0, needReview: 0, modelCalls: 0 })
    expect(kit.modelCalls.length).toBe(calls)
    expect(JSON.stringify([[...kit.mem.items], [...kit.mem.bills], [...kit.mem.vendors], kit.mem.documents, kit.mem.audits.length, [...kit.objects.keys()]])).toBe(snapshot)
  })
})

describe('decisions and caps', () => {
  it('auto-apply off writes nothing to AP rows and queues the mail as AUTO_OFF', async () => {
    const kit = makeSyncKit(seed(), { model, devStack: true })
    await kit.deps.store.putConfig({ ...(await kit.deps.store.getConfig()), autoApply: false }, 1)
    await injectAll(kit)
    const before = JSON.stringify([...kit.mem.bills])
    await scripted(kit)
    expect(JSON.stringify([...kit.mem.bills])).toBe(before)
    expect(kit.mem.items.get('apin:sim:zz-m1')).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'AUTO_OFF' })
  })

  it('stops auto-applying at the per-run cap and queues the rest as RUN_CAP', async () => {
    const kit = makeSyncKit(seed(), { model })
    await kit.deps.store.putConfig({ ...(await kit.deps.store.getConfig()), maxAutoAppliesPerRun: 1 }, 1)
    await injectAll(kit)
    await scripted(kit)
    expect(kit.mem.items.get('apin:sim:zz-m1')?.status).toBe('APPLIED')
    expect(kit.mem.items.get('apin:sim:zz-m7')).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'RUN_CAP' })
  })

  it('the model-call cap leaves the rest after the cursor and a later run finishes them', async () => {
    const kit = makeSyncKit(seed(), { model })
    await kit.deps.store.putConfig({ ...(await kit.deps.store.getConfig()), maxModelCallsPerRun: 2 }, 1)
    await injectAll(kit)
    const first = await scripted(kit)
    expect(first.digest).toMatchObject({ error: 'MODEL_CAP', modelCalls: 2, partial: true })
    expect(first.done).toBe(true)
    expect(kit.mem.items.size).toBe(2)
    await kit.deps.store.putConfig({ ...(await kit.deps.store.getConfig()), maxModelCallsPerRun: 80 }, 2)
    const second = await scripted(kit)
    expect(second.digest?.partial).toBe(false)
    expect(kit.mem.items.size).toBe(11)
    expect([...kit.mem.items.keys()].filter((id) => id.endsWith('m1'))).toHaveLength(1)
  })

  it('an exhausted time budget is partial, and the next slice finishes with one folded digest', async () => {
    const kit = makeSyncKit(seed(), { model })
    await injectAll(kit)
    const none = await runSync(kit.deps, { trigger: 'MANUAL', budgetMs: 0 })
    expect(none).toMatchObject({ done: false, reviewed: 0 })
    expect(kit.mem.items.size).toBe(0)
    const rest = await scripted(kit)
    expect(rest).toMatchObject({ done: true })
    expect(rest.digest).toMatchObject({ reviewed: 14, invoices: 11 })
    expect(kit.mem.getStateNow().runs).toHaveLength(1)
  })
})

describe('failure handling', () => {
  it('a message that throws is retried, never blocks the cursor, and is abandoned after 3 tries', async () => {
    const kit = makeSyncKit(seed(), {
      model: (input) => {
        if (input.subject === 'inv m2') throw new Error('transport')
        return model(input)
      },
    })
    await injectAll(kit)
    const first = await scripted(kit)
    expect(first.digest).toMatchObject({ errors: 1, invoices: 10, partial: false })
    expect(kit.mem.getStateNow().retry).toEqual([expect.objectContaining({ id: 'zz-m2', tries: 1 })])
    const cursor = kit.mem.getStateNow().cursor
    expect(cursor).not.toBeNull()

    await scripted(kit)
    expect(kit.mem.getStateNow().retry[0]?.tries).toBe(2)
    const third = await scripted(kit)
    expect(kit.mem.getStateNow().retry).toEqual([])
    expect(kit.mem.getStateNow().runs[0]).toMatchObject({ abandoned: 1 })
    expect(third.digest?.abandoned).toBe(1)
    expect(kit.mem.items.has('apin:sim:zz-m2')).toBe(false)
  })

  it('NeedsReconnect stops the run, flags the connection and does not move the cursor', async () => {
    const kit = makeSyncKit(seed(), { model })
    await injectAll(kit)
    const port = kit.deps.mailboxFor('SIMULATED')
    kit.deps.mailboxFor = () => ({
      ...port,
      getMetadata: async () => {
        throw new NeedsReconnect()
      },
    })
    const res = await scripted(kit)
    expect(res.digest?.error).toBe('NEEDS_RECONNECT')
    expect(kit.mem.getStateNow().connection.status).toBe('NEEDS_RECONNECT')
    expect(kit.mem.getStateNow().cursor).toBeNull()
    expect(kit.mem.items.size).toBe(0)
  })

  it('refuses with a digest error when disabled in config, agent switched off, or not connected', async () => {
    const off = makeSyncKit({ ...seed(), config: { enabled: false } })
    expect((await scripted(off)).digest?.error).toBe('NOT_CONFIGURED')
    const agent = makeSyncKit({ ...seed(), aiAgents: { AP: { enabled: false } } })
    expect((await scripted(agent)).digest?.error).toBe('AGENT_DISABLED')
    const google = makeSyncKit({ ...seed(), config: { mode: 'GOOGLE' } })
    expect((await scripted(google)).digest?.error).toBe('NOT_CONFIGURED')
  })

  it('a second press while a run holds the lock is a no-op', async () => {
    const kit = makeSyncKit(seed(), { model })
    await kit.deps.store.claimRun(kit.deps.now(), new Date(0))
    expect(await scripted(kit)).toMatchObject({ skipped: 'RUNNING', done: true })
  })
})

describe('dev extraction bypass', () => {
  it('replaces the model on a dev stack in SIMULATED mode only', async () => {
    const dev = makeSyncKit(seed(), { model })
    dev.deps.devExtraction = async () => rawInvoice()
    await dev.inject({ id: 'zz-dx', from: FROM, subject: 'inv dx', body: BODY, internalDate: hoursAgo(2), attachments: [pdf('a.pdf')] })
    await scripted(dev)
    expect(dev.modelCalls).toHaveLength(0)
    expect(dev.mem.items.get('apin:sim:zz-dx')?.status).toBe('APPLIED')

    const prod = makeSyncKit(seed(), { model: () => rawOther('OTHER'), devStack: false })
    prod.deps.devExtraction = async () => rawInvoice()
    await prod.inject({ id: 'zz-dx', from: FROM, subject: 'inv dx', body: BODY, internalDate: hoursAgo(2), attachments: [pdf('a.pdf')] })
    expect((await scripted(prod)).digest?.error).toBe('NOT_CONFIGURED')
    expect(prod.mem.items.size).toBe(0)
  })
})

/** Step AT: one PRO, two carriers, one bill each. A mail applies to its own carrier's bill or waits in review. */
describe('a load with two carriers', () => {
  const twoCarrierSeed = () => ({
    carriers: [FX_CARRIER, FX_OTHER_CARRIER],
    bills: [
      bill({ id: 'BA', loadCarrierId: 'lc-a', shipmentNumber: 'S000201-1', loadNumber: 'S000201-1', grossCents: 150_000 }),
      bill({
        id: 'BB', loadCarrierId: 'lc-b', shipmentNumber: 'S000201-1', loadNumber: 'S000201-1', grossCents: 80_000,
        carrierId: FX_OTHER_CARRIER.id, carrierName: FX_OTHER_CARRIER.name, carrierMc: FX_OTHER_CARRIER.mcNumber,
        remitToName: FX_OTHER_CARRIER.name,
      }),
    ],
  })
  const script: Record<string, RawApModelOutput> = {
    'inv a': rawInvoice({ proNumbers: ['S000201-1'], invoiceNumber: 'A-1', amountDollars: 1500 }),
    'inv b': rawInvoice({ proNumbers: ['S000201-1'], mcNumber: '999888', issuerName: 'Blue Ridge Freight Inc', invoiceNumber: 'B-1', amountDollars: 800 }),
    'inv none': rawInvoice({ proNumbers: ['S000201-1'], mcNumber: '', issuerName: '', invoiceNumber: 'N-1', amountDollars: 800 }),
  }

  it("each carrier's invoice updates only its own bill; a carrier-less mail is queued and writes nothing", async () => {
    const kit = makeSyncKit(twoCarrierSeed(), { model: (input) => script[input.subject] ?? rawOther('OTHER') })
    for (const [i, subject] of Object.keys(script).entries()) {
      await kit.inject({ id: `zz-${subject.slice(4)}`, from: FROM, subject, body: BODY, internalDate: hoursAgo(10 - i), attachments: [pdf(`${i}.pdf`)] })
    }
    await scripted(kit)

    const items = Object.fromEntries([...kit.mem.items.values()].map((it) => [it.messageId, it]))
    expect(items['zz-a']).toMatchObject({ status: 'APPLIED' })
    expect(items['zz-b']).toMatchObject({ status: 'APPLIED' })
    expect(items['zz-none']).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'LOW_CONFIDENCE' })
    expect(kit.mem.bills.get('BA')).toMatchObject({ billNumber: 'A-1', billedCents: 150_000, apInboxItemId: items['zz-a'].id })
    expect(kit.mem.bills.get('BB')).toMatchObject({ billNumber: 'B-1', billedCents: 80_000, apInboxItemId: items['zz-b'].id })
    // The carrier-less mail linked to neither bill.
    expect([...kit.mem.bills.values()].some((b) => b.apInboxItemId === items['zz-none'].id)).toBe(false)
  })
})
