/**
 * P5 / P6: the cash ledgers. ArPayment rows (customer receipts and credit memos) and ApPayment rows
 * (carrier payments), grouped so one remittance covering several PROs is one row with several
 * applications. Ids are deterministic, so a re-run rewrites identical rows.
 */
import type { EngineRow, EngineStore } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { invoiceMath, memoNet } from './memos'
import { noonUtcIso } from '../../../../src/lib/aljex/dates'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import { normalizePro } from '../../../../src/lib/proNumber'
import { rowIds } from './aggregate'
import { loadCarrierLookup, scanRows, text } from './directory'
import { rowFacts, type ApLine } from './facts'
import { readChunk, type StageData } from './stage'
import { IMPORT_ACTOR, bump, type Counts } from './types'
import { compactText, sha256Hex } from './util'

interface Group {
  id: string
  fields: EngineRow
  amountCents: number
  appliedCents: number
  unappliedCents: number
  apps: Map<string, number>
  notes: Set<string>
}

function addTo(groups: Map<string, Group>, id: string, base: EngineRow, amount: number, applied: number, unapplied: number, appKey: string, note?: string): void {
  let g = groups.get(id)
  if (!g) groups.set(id, (g = { id, fields: base, amountCents: 0, appliedCents: 0, unappliedCents: 0, apps: new Map(), notes: new Set() }))
  g.amountCents += amount
  g.appliedCents += applied
  g.unappliedCents += unapplied
  if (applied !== 0) g.apps.set(appKey, (g.apps.get(appKey) ?? 0) + applied)
  if (note) g.notes.add(note)
}

function methodFor(profile: AljexProfile, checkNo: string): string {
  const shape = checkNo === '' ? 'blank' : /^\d+$/.test(checkNo) ? 'numeric' : 'alpha'
  return profile.paymentMethodByCheckShape[shape]
}

/** Take `surplus` back from the tail of the lines (overpayment stays unapplied on the last receipts). */
function carveSurplus(amounts: number[], surplus: number): Array<{ amount: number; applied: number; unapplied: number }> {
  let left = surplus
  const out = amounts.map((a) => ({ amount: a, applied: a, unapplied: 0 }))
  for (let i = out.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(left, Math.max(out[i].amount, 0))
    out[i].applied -= take
    out[i].unapplied = take
    left -= take
  }
  return out
}

async function writeGroups(store: EngineStore, table: 'arPayment' | 'apPayment', groups: Map<string, Group>, applicationKey: 'invoiceId' | 'billId', counts: Counts, entity: 'AR_PAYMENT' | 'AP_PAYMENT', reentry: boolean): Promise<void> {
  const existing = new Set<string>()
  for (const r of await scanRows(store, table, ['id'])) existing.add(text(r.id))
  const rows: EngineRow[] = []
  for (const g of [...groups.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    bump(counts, entity, 'staged')
    bump(counts, entity, existing.has(g.id) && !reentry ? 'matched' : 'created')
    rows.push(
      compactText({
        ...g.fields,
        id: g.id,
        amountCents: g.amountCents,
        appliedCents: g.appliedCents,
        unappliedCents: g.unappliedCents,
        applications: [...g.apps.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ [applicationKey]: k, amountCents: v })),
        note: [...g.notes].sort().join('; '),
      }),
    )
  }
  await store.batchPut(table, rows)
}

async function* stagedRows(store: EngineStore, root: string, stage: StageData): AsyncGenerator<CanonicalRow> {
  for (let c = 0; c < stage.masters.chunkCount; c++) for (const r of await readChunk(store, root, c)) yield r
}

/** Orders/invoices/bills the import wrote itself: the ledger rows only apply to those. */
async function importedIndex(store: EngineStore) {
  const invoiceByOrder = new Map<string, { id: string; customerId: string; totalCents: number | null }>()
  for (const i of await scanRows(store, 'invoice', ['id', 'orderId', 'customerId', 'createdBy', 'totalCents'])) if (text(i.createdBy) === IMPORT_ACTOR) invoiceByOrder.set(text(i.orderId), { id: text(i.id), customerId: text(i.customerId), totalCents: typeof i.totalCents === 'number' ? i.totalCents : null })
  const bills = new Set<string>()
  for (const b of await scanRows(store, 'carrierBill', ['id', 'createdBy'])) if (text(b.createdBy) === IMPORT_ACTOR) bills.add(text(b.id))
  const orderByPro = new Map<string, { orderId: string; activeLoadCarrierId: string }>()
  for (const l of await scanRows(store, 'load', ['aljexId', 'orderId', 'activeLoadCarrierId'])) {
    const k = normalizePro(text(l.aljexId))
    if (k && text(l.orderId)) orderByPro.set(k, { orderId: text(l.orderId), activeLoadCarrierId: text(l.activeLoadCarrierId) })
  }
  return { invoiceByOrder, bills, orderByPro }
}

export async function runArLedger(args: { store: EngineStore; root: string; stage: StageData; profile: AljexProfile; counts: Counts; reentry: boolean }): Promise<void> {
  const { store, root, stage, profile, counts } = args
  const idx = await importedIndex(store)
  const groups = new Map<string, Group>()
  const memoLines = stage.masters.memos?.byInvoice ?? {}
  for await (const row of stagedRows(store, root, stage)) {
    if (row.kind !== 'LOAD') continue
    const facts = rowFacts(row, profile, stage.masters.window)
    if (!facts.invoice) continue
    const ref = idx.orderByPro.get(row.proKey as string)
    const invoice = ref ? idx.invoiceByOrder.get(ref.orderId) : undefined
    // The receipt belongs to the customer of the invoice it pays: an enriched invoice keeps the live order's
    // customer, which the file's account code need not resolve to.
    if (!invoice?.customerId) continue
    const { id: invoiceId, customerId } = invoice
    // Credits/debits are memo adjustment lines on the invoice itself (DECIDED-1): only receipts are ledger rows.
    const math = invoiceMath(row, memoNet(memoLines[row.proKey as string]))
    const lines = row.payments.filter((p) => p.amountCents !== 0)
    // The receipts apply to the invoice AS WRITTEN: a fully paid revenue-difference row carries the paid amount (revenueBasis.ts), so no surplus.
    const written = invoice.totalCents ?? math.totalCents
    const carved = carveSurplus(lines.map((p) => p.amountCents), Math.max(0, math.paymentsCents - Math.max(written, 0)))
    lines.forEach((p, i) => {
      const date = p.date ?? row.dates.invoice ?? stage.masters.window.start
      const key = p.checkNo ? `${customerId}|${p.checkNo}|${date}` : `${row.proKey}|${p.n}`
      const id = `arp-aljex-${sha256Hex(key).slice(0, 16)}`
      addTo(groups, id, { customerId, kind: 'PAYMENT', receivedAt: noonUtcIso(date), method: methodFor(profile, p.checkNo), reference: p.checkNo, createdBy: IMPORT_ACTOR }, carved[i].amount, carved[i].applied, carved[i].unapplied, invoiceId)
    })
  }
  await writeGroups(store, 'arPayment', groups, 'invoiceId', counts, 'AR_PAYMENT', args.reentry)
}

export async function runApLedger(args: { store: EngineStore; root: string; stage: StageData; profile: AljexProfile; counts: Counts; reentry: boolean }): Promise<void> {
  const { store, root, stage, profile, counts } = args
  const [carriers, idx] = await Promise.all([loadCarrierLookup(store), importedIndex(store)])
  const groups = new Map<string, Group>()
  for await (const row of stagedRows(store, root, stage)) {
    if (row.kind !== 'LOAD' || !row.carrier) continue
    const facts = rowFacts(row, profile, stage.masters.window)
    const ap = facts.ap
    const carrier = row.carrier.id ? carriers.get(row.carrier.id) : undefined
    const ref = idx.orderByPro.get(row.proKey as string)
    if (!ap || !carrier || !ref) continue
    const ids = rowIds(row)
    const billId = `cb:${ref.activeLoadCarrierId || ids.loadCarrierId}:1`
    if (!idx.bills.has(billId)) continue
    const lines: ApLine[] = [...ap.carrierPayments, ...ap.extraLines].filter((l) => l.amountCents !== 0)
    const carved = carveSurplus(lines.map((l) => l.amountCents), ap.unappliedCents)
    const billDate = row.dates.delivered ?? row.dates.release ?? row.dates.created ?? row.dates.invoice ?? stage.masters.window.start
    lines.forEach((l, i) => {
      const date = l.date ?? billDate
      const key = l.checkNo ? `${carrier.id}|${l.checkNo}|${date}` : `${row.proKey}|ap|${i}`
      const id = `app-aljex-${sha256Hex(key).slice(0, 16)}`
      addTo(groups, id, { carrierId: carrier.id, payeeKind: 'CARRIER', kind: 'PAYMENT', paidAt: noonUtcIso(date), method: methodFor(profile, l.checkNo) === 'CHECK' ? 'CHECK' : 'OTHER', reference: l.checkNo, remitTo: null, createdBy: IMPORT_ACTOR }, carved[i].amount, carved[i].applied, carved[i].unapplied, billId, l.gl ? `GL ${l.gl}` : undefined)
    })
  }
  await writeGroups(store, 'apPayment', groups, 'billId', counts, 'AP_PAYMENT', args.reentry)
}
