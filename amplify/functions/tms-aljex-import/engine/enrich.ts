/**
 * ENRICH: a PRO that already exists on the target (own-fleet history backfilled from production).
 * Finance only: an Invoice (and its Order cache) and/or a CarrierBill (and its leg's AP cache). Status,
 * stops, driver, carrier, rates, documents and the legacy flag of a live record are never touched; a
 * disagreement on revenue or carrier is a reported mismatch with no write. The pre-image of every
 * touched row goes to an AuditLog row in the same transaction.
 */
import type { EngineRow, EngineStore, TxItem } from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import { classifyCharge } from '../../../../src/lib/aljex/charges'
import { noonUtcIso, addDays } from '../../../../src/lib/aljex/dates'
import { buildBill, buildInvoice, legacyRow, rowIds, type InvoiceLineInput, type LoadEnv } from './aggregate'
import { auditRow, text } from './directory'
import { rowFacts } from './facts'
import { stableId } from './util'

export interface ExistingLoad {
  id: string
  shipmentId: string
  orderId: string
  activeLoadCarrierId: string
}

export interface EnrichResult {
  outcome: 'enriched' | 'matched' | 'mismatch'
  items: TxItem[]
  invoice: boolean
  bill: boolean
  /** The row's invoice was expected (facts.invoice) so the INVOICE entity counts it. */
  invoiceExpected: boolean
  findings: Array<{ code: string; detail?: string }>
}

const stripZeros = (s: string): string => s.replace(/\D/g, '').replace(/^0+/, '')

export async function buildEnrich(store: EngineStore, row: CanonicalRow, existing: ExistingLoad, env: LoadEnv): Promise<EnrichResult> {
  const facts = rowFacts(row, env.profile, env.window)
  const findings: EnrichResult['findings'] = []
  const items: TxItem[] = []
  let invoice = false
  let bill = false
  let mismatch = false
  const [order] = await store.getMany('order', [existing.orderId])
  if (!order) {
    return { outcome: 'matched', items, invoice, bill, invoiceExpected: facts.invoice, findings: [{ code: 'ENRICH_NO_ORDER' }] }
  }
  const customerId = text(order.customerId) || (row.customer.account ? env.customers.byAccount.get(row.customer.account) : undefined)
  const ids = { ...rowIds(row, env.invoiceOwners), orderId: existing.orderId, shipmentId: existing.shipmentId, loadId: existing.id }

  if (facts.invoice && !text(order.invoiceId)) {
    if (typeof order.revenueCents === 'number' && order.revenueCents !== row.money.invoiceAmountCents) {
      mismatch = true
      findings.push({ code: 'ENRICH_MISMATCH', detail: 'revenue' })
    } else if (!customerId) findings.push({ code: 'INVOICE_NO_CUSTOMER' })
    else {
      const lines: InvoiceLineInput[] = row.charges
        .map((c) => ({ c, cl: classifyCharge(c, env.profile) }))
        .filter(({ cl }) => cl.kind === 'CHARGE')
        .map(({ c, cl }) => ({ chargeId: stableId('chg', `${ids.key}:C:${c.line}`), code: cl.code, label: cl.label, rateCents: cl.rateCents ?? cl.amountCents, count: cl.rateCents != null ? cl.count : 1, amountCents: cl.amountCents }))
      const terms = env.customers.termsById.get(customerId) ?? null
      const built = buildInvoice(row, facts, env, { ids, customerId, lines, customerTermsDays: terms })
      invoice = true
      items.push({ op: 'put', table: 'invoice', item: built.row })
      const set: EngineRow = {
        arStatus: built.balance === 0 ? 'PAID' : 'UNPAID',
        arStatusChangedAt: built.row.issuedAt,
        invoiceId: ids.invoiceId,
        invoiceNumber: row.pro,
        invoicedAt: built.row.issuedAt,
        arBalanceCents: built.balance,
        updatedBy: 'aljex-import',
        ...(built.row.paidAt ? { paidAt: built.row.paidAt } : {}),
        ...(built.row.factoringItemId ? { factoringItemId: built.row.factoringItemId } : {}),
      }
      items.push({ op: 'update', table: 'order', id: existing.orderId, set, condition: { expression: 'attribute_not_exists(invoiceId)' } })
      items.push({
        op: 'put',
        table: 'auditLog',
        item: auditRow(`enrich-order:${row.proKey}:${env.runId}`, 'Order', existing.orderId, 'ALJEX_IMPORT_ENRICH', {
          before: { arStatus: order.arStatus ?? null, arStatusChangedAt: order.arStatusChangedAt ?? null, invoiceId: order.invoiceId ?? null, arBalanceCents: order.arBalanceCents ?? null },
          after: { arStatus: set.arStatus, invoiceId: ids.invoiceId },
        }),
      })
    }
  }

  const ap = facts.ap
  if (ap && existing.activeLoadCarrierId) {
    const [lc] = await store.getMany('loadCarrier', [existing.activeLoadCarrierId])
    const billId = `cb:${existing.activeLoadCarrierId}:1`
    const [existingBill] = lc ? await store.getMany('carrierBill', [billId]) : []
    if (lc && !existingBill && lc.kind === 'CARRIER' && text(lc.carrierId)) {
      const rowMc = stripZeros(row.carrier?.mc ?? '')
      if (rowMc && stripZeros(text(lc.carrierMc)) !== rowMc) {
        mismatch = true
        findings.push({ code: 'ENRICH_MISMATCH', detail: 'carrier' })
      } else {
        const billIds = { ...ids, loadCarrierId: existing.activeLoadCarrierId, billId }
        const billDate = row.dates.delivered ?? row.dates.release ?? row.dates.created ?? row.dates.invoice ?? env.window.start
        const terms = env.settings.defaultCarrierTermsDays ?? 30
        const billRow = buildBill(row, ap, billIds, { id: text(lc.carrierId), name: text(lc.carrierName), mc: text(lc.carrierMc), termsDays: terms }, billDate, terms, facts, env)
        bill = true
        items.push({ op: 'put', table: 'carrierBill', item: billRow })
        const open = (billRow.balanceCents as number) > 0
        items.push({
          op: 'update',
          table: 'loadCarrier',
          id: existing.activeLoadCarrierId,
          set: { apStatus: billRow.status === 'PAID' ? 'PAID' : 'TO_BE_PAID', apBalanceCents: billRow.balanceCents, chargesFinalizedAt: noonUtcIso(billDate), ...(open ? { apOpen: 'OPEN', apStatusChangedAt: noonUtcIso(billDate) } : {}), updatedBy: 'aljex-import' },
          remove: open ? undefined : ['apOpen'],
        })
        items.push({
          op: 'put',
          table: 'auditLog',
          item: auditRow(`enrich-leg:${row.proKey}:${env.runId}`, 'LoadCarrier', existing.activeLoadCarrierId, 'ALJEX_IMPORT_ENRICH', {
            before: { apStatus: lc.apStatus ?? null, apOpen: lc.apOpen ?? null, apBalanceCents: lc.apBalanceCents ?? null, chargesFinalizedAt: lc.chargesFinalizedAt ?? null },
            after: { apStatus: billRow.status },
          }),
        })
        void addDays
      }
    }
  }
  const outcome = mismatch ? 'mismatch' : items.length ? 'enriched' : 'matched'
  // The lossless source row is kept for an enriched PRO too (once; never rewritten by a later run).
  const [haveRaw] = await store.getMany('legacyAljexRow', [`aljex:${row.pro}`])
  if (!haveRaw && !mismatch) items.push({ op: 'put', table: 'legacyAljexRow', item: legacyRow(row, existing.shipmentId, env, 'LOAD') })
  return { outcome, items, invoice, bill, invoiceExpected: facts.invoice, findings }
}
