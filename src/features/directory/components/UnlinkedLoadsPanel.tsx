/**
 * Unlinked loads (Ryne 2026-11-16: "i'll do the customer links manually … can i do it in the customer profiles?").
 *
 *  - On a customer's profile (`customer` given): the unlinked shipments whose typed name looks like this customer, best match
 *    first, with "Link to this customer" per row and "Link selected (N)". The search box finds any other unlinked shipment by
 *    PRO or name, so a load typed under a different spelling can still be pulled in.
 *  - In the Directory (`customer` absent): every unlinked shipment, each with "Link…" (the same picker as the shipment's own
 *    "Link customer…", Create customer included).
 *
 * Linking is the shipment's own SET_SHIPMENT_CUSTOMER (Shipment, Order and Loads together, audited), so it is the same link
 * wherever it is made. Anyone who edits shipments can link; a shipment that has been linked meanwhile is reported, not changed.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsInput, TmsTable, type ColumnDef } from '@/features/tms/kit'
import { RepointCustomerDialog } from '@/features/shipments/components/RepointCustomerDialog'
import { setShipmentCustomer, type UnlinkedShipment } from '@/lib/apiClient'
import { formatDateShort } from '@/lib/date'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type { CustomerRecord } from '@/types/tms'
import { candidatesFor, confidenceLabel, searchUnlinked } from '../unlinked'
import { invalidateUnlinkedShipments, type useUnlinkedShipments } from '../useUnlinkedShipments'

type Unlinked = ReturnType<typeof useUnlinkedShipments>

export interface UnlinkedLoadsPanelProps {
  unlinked: Unlinked
  /** Directory customers (the picker's search list). */
  customers: CustomerRecord[]
  /** Profile mode: the customer to link to. */
  customer?: CustomerRecord
  /** Called after loads were linked (the profile refreshes its shipments list). */
  onLinked?: (shipmentIds: string[]) => void
}

interface Row { shipment: UnlinkedShipment; score: number | null }

const lane = (s: UnlinkedShipment) => [s.originCity, s.destinationCity].filter(Boolean).join(' → ') || '—'
const day = (iso: string | null) => (iso ? formatDateShort(iso) : '—')

export function UnlinkedLoadsPanel({ unlinked, customers, customer, onLinked }: UnlinkedLoadsPanelProps) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState<UnlinkedShipment | null>(null)

  const candidates = useMemo(() => (customer ? candidatesFor(customer, unlinked.rows) : []), [customer, unlinked.rows])
  const rows = useMemo<Row[]>(() => {
    if (!customer) return searchUnlinked(unlinked.rows, query).map((shipment) => ({ shipment, score: null }))
    const found = searchUnlinked(unlinked.rows, query)
    if (!query.trim()) return candidates.map((c) => ({ shipment: c.shipment, score: c.score }))
    const scores = new Map(candidates.map((c) => [c.shipment.id, c.score]))
    return found.map((shipment) => ({ shipment, score: scores.get(shipment.id) ?? null }))
  }, [customer, unlinked.rows, query, candidates])

  const done = (ids: string[]) => {
    invalidateUnlinkedShipments()
    unlinked.dropLinked(ids)
    setPicked((p) => new Set([...p].filter((id) => !ids.includes(id))))
    onLinked?.(ids)
  }

  const linkMany = async (shipments: UnlinkedShipment[]) => {
    if (!customer || shipments.length === 0) return
    setBusy(true)
    const ok: string[] = []
    const failed: string[] = []
    for (const s of shipments) {
      try {
        await setShipmentCustomer({ shipmentId: s.id, customerId: customer.id })
        ok.push(s.id)
      } catch (err) {
        failed.push(`${s.number ?? s.id}: ${err instanceof Error ? err.message : 'could not link'}`)
      }
    }
    setBusy(false)
    if (ok.length) {
      done(ok)
      toast.success(`${ok.length} load${ok.length === 1 ? '' : 's'} linked to ${customer.name}`)
    }
    if (failed.length) toast.error(failed.slice(0, 3).join(' · ') + (failed.length > 3 ? ` · +${failed.length - 3} more` : ''))
  }

  const columns: ColumnDef<Row>[] = [
    ...(customer ? [{
      key: 'pick', header: '', filter: false as const, sortable: false,
      render: ({ shipment }: Row) => (
        <input type="checkbox" aria-label={`Select ${shipment.number ?? shipment.id}`} checked={picked.has(shipment.id)}
          onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(shipment.id)) n.delete(shipment.id); else n.add(shipment.id); return n })} />
      ),
    }] : []),
    {
      key: 'pro', header: 'PRO', text: ({ shipment }) => String(shipment.number ?? ''),
      render: ({ shipment }) => <Link to={shipmentEditorPath(shipment.id)} className="tms-link">{shipment.number ?? shipment.id}</Link>,
    },
    { key: 'typed', header: 'Typed customer', text: ({ shipment }) => shipment.customerName, render: ({ shipment }) => shipment.customerName },
    { key: 'lane', header: 'Lane', text: ({ shipment }) => lane(shipment), render: ({ shipment }) => lane(shipment) },
    {
      key: 'pickup', header: 'Pickup', sortValue: ({ shipment }) => shipment.pickupAppt ?? '', text: ({ shipment }) => day(shipment.pickupAppt),
      render: ({ shipment }) => day(shipment.pickupAppt),
    },
    {
      key: 'status', header: 'Status', text: ({ shipment }) => shipment.status ?? '',
      render: ({ shipment }) => (
        <span className="flex flex-wrap gap-1">
          <TmsBadge>{shipment.status ?? '—'}</TmsBadge>
          {shipment.inLoadReview ? <TmsBadge tone="blue">In Load Review</TmsBadge> : null}
        </span>
      ),
    },
    ...(customer ? [{
      key: 'match', header: 'Match', sortValue: ({ score }: Row) => score ?? -1, text: ({ score }: Row) => (score == null ? '' : confidenceLabel(score)),
      render: ({ score }: Row) => (score == null
        ? <span className="tms-muted">Other name</span>
        : <TmsBadge tone={score >= 0.85 ? 'green' : score >= 0.65 ? 'orange' : 'gray'}>{`${confidenceLabel(score)} · ${Math.round(score * 100)}%`}</TmsBadge>),
    }] : []),
    {
      key: 'action', header: '', filter: false as const, sortable: false,
      render: ({ shipment }: Row) => (customer
        ? <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => void linkMany([shipment])}>Link to this customer</TmsButton>
        : <TmsButton size="sm" variant="primary" onClick={() => setLinking(shipment)}>Link…</TmsButton>),
    },
  ]

  const picks = rows.filter((r) => picked.has(r.shipment.id)).map((r) => r.shipment)

  return (
    <div className="space-y-3" data-testid={customer ? 'unlinked-loads-profile' : 'unlinked-loads-directory'}>
      <p className="tms-muted" style={{ fontSize: 13 }}>
        {customer
          ? `Loads that were saved with a typed customer name and no customer record. These look like ${customer.name}. Linking connects the shipment, its order and its loads to this customer.`
          : 'Every load that was saved with a typed customer name and no customer record. Link each to its customer, or create the customer.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <TmsInput value={query} placeholder={customer ? 'Search other unlinked loads by PRO or name…' : 'Search by PRO, name or lane…'}
          aria-label="Search unlinked loads" onChange={(e) => setQuery((e.target as HTMLInputElement).value)} style={{ maxWidth: 360 }} />
        {customer ? (
          <TmsButton variant="primary" size="sm" disabled={busy || picks.length === 0} onClick={() => void linkMany(picks)}>
            {`Link selected (${picks.length})`}
          </TmsButton>
        ) : null}
        <span className="tms-muted" style={{ fontSize: 12 }}>
          {unlinked.loading ? 'Loading…' : `${rows.length} shown${unlinked.total > unlinked.rows.length ? ` · ${unlinked.total} unlinked in all` : ''}`}
        </span>
      </div>
      {unlinked.error ? <p className="tms-field-error">{unlinked.error}</p> : null}
      <TmsTable
        columns={columns} rows={rows} rowKey={(r) => r.shipment.id}
        empty={unlinked.loading ? 'Loading unlinked loads…' : customer && !query.trim() ? `No unlinked loads look like ${customer.name}. Search to find others.` : 'No unlinked loads.'}
      />
      {linking ? (
        <RepointCustomerDialog
          shipment={{ id: linking.id, number: linking.number ?? linking.id, customerId: null, customerName: linking.customerName, updatedAt: linking.updatedAt ?? '' }}
          customers={customers} open onOpenChange={(open) => { if (!open) setLinking(null) }}
          onRepointed={() => { done([linking.id]); setLinking(null) }}
        />
      ) : null}
    </div>
  )
}
