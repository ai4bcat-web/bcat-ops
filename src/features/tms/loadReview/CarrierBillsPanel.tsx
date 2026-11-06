/**
 * Load Review, two or more carriers: one column per live carrier with its rate, its
 * accessorials, its bill state and whether its rate con is signed, plus "Record all
 * bills". Release itself is refused by the release gate (the sentences in the drawer
 * name the carrier); this panel is where the missing pieces get fixed.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsAlert, TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { getShipmentBundle, recordBill } from '@/lib/apiClient'
import { carrierTotals, liveCarriersOf, marginOf } from '@/lib/carrierTotals'
import { formatCents } from '@/lib/invoiceBuild'
import type { ShipmentBundle } from '@/types/tms'
import { recordAllBills, type RecordOutcome } from './recordAllBills'

const OUTCOME_LABEL: Record<RecordOutcome['status'], string> = {
  recorded: 'Bill recorded',
  already: 'Already recorded',
  failed: 'Failed',
  skipped: 'Not attempted',
}

export function CarrierBillsPanel({ shipmentId, disabled = false, canOpenAp = false, onChanged }: {
  shipmentId: string
  disabled?: boolean
  /** Whether the viewer may follow the link to the bill. */
  canOpenAp?: boolean
  /** Something was recorded (or refused): the drawer re-runs the review. */
  onChanged: () => Promise<void>
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<RecordOutcome[]>([])
  const [working, setWorking] = useState(false)
  const [stamp, setStamp] = useState(0)

  useEffect(() => {
    let live = true
    getShipmentBundle(shipmentId)
      .then((next) => { if (live) setBundle(next) })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [shipmentId, stamp])

  const load = bundle?.loads[0]
  const live = bundle ? liveCarriersOf(bundle.loadCarriers, load?.id ?? '').filter((lc) => lc.kind === 'CARRIER') : []
  if (error) return <TmsAlert tone="red">{error}</TmsAlert>
  if (!bundle || live.length < 2) return null

  const totals = carrierTotals(bundle.charges, live)
  const customerTotalCents = bundle.charges.filter((c) => c.side === 'CUSTOMER').reduce((sum, c) => sum + c.amountCents, 0)
  const margin = marginOf({ customerTotalCents, carrierGrossCents: totals.totalCents })
  const unrecorded = live.filter((lc) => !lc.invoiceId)

  const run = async () => {
    setWorking(true)
    setResults([])
    try {
      setResults(await recordAllBills(unrecorded, (loadCarrierId) => recordBill({ loadCarrierId })))
    } finally {
      setWorking(false)
      setStamp((n) => n + 1)
      await onChanged()
    }
  }

  const failed = results.find((r) => r.status === 'failed')

  return (
    <TmsCard
      title="Carrier bills"
      actions={
        <TmsButton
          size="sm"
          variant="primary"
          data-testid="record-all-bills"
          disabled={disabled || working || unrecorded.length === 0}
          onClick={() => { void run() }}
        >
          {working ? 'Recording…' : 'Record all bills'}
        </TmsButton>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${live.length}, minmax(0, 1fr))` }} data-testid="carrier-bills">
        {live.map((lc) => {
          const row = totals.perCarrier.find((r) => r.loadCarrierId === lc.id)
          const name = lc.carrierName ?? 'Carrier'
          const signed = lc.rateConStatus === 'SIGNED'
          return (
            <div key={lc.id} className="flex flex-col gap-1 text-sm" data-testid={`carrier-bill-${lc.id}`}>
              <p className="font-medium">{name}</p>
              <p data-testid={`carrier-bill-rate-${lc.id}`}>Rate {row?.hasRate ? formatCents(row.linehaulCents) : '—'}</p>
              <p>Accessorials {formatCents(row?.accessorialCents ?? 0)}</p>
              <p>Total {formatCents(row?.totalCents ?? 0)}</p>
              <div className="flex flex-wrap gap-1">
                <TmsBadge tone={signed ? 'green' : 'orange'}>{signed ? 'Rate con signed' : 'Rate con not signed'}</TmsBadge>
                <TmsBadge tone={lc.invoiceId ? 'green' : 'orange'}>{lc.invoiceId ? 'Bill recorded' : 'Bill not recorded'}</TmsBadge>
                {!row?.hasRate && <TmsBadge tone="red">Rate missing</TmsBadge>}
              </div>
              {lc.invoiceId && canOpenAp && (
                <Link to={`/tms/invoicing/payable/bills/${encodeURIComponent(lc.invoiceId)}`}>Open bill</Link>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-sm" data-testid="carrier-bills-margin">
        Customer {formatCents(customerTotalCents)} − carriers {formatCents(totals.totalCents)} = margin {formatCents(margin.marginCents)}
      </p>
      {results.length > 0 && (
        <ul className="mt-2 text-sm" data-testid="record-all-results">
          {results.map((r) => (
            <li key={r.loadCarrierId} data-testid={`record-result-${r.loadCarrierId}`}>
              {r.name}: {OUTCOME_LABEL[r.status]}{r.message ? ` — ${r.message}` : ''}
            </li>
          ))}
        </ul>
      )}
      {failed && <TmsAlert tone="red">{`${failed.name}: ${failed.message ?? 'The bill could not be recorded.'}`}</TmsAlert>}
    </TmsCard>
  )
}
