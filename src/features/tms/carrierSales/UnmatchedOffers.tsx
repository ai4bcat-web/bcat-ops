/**
 * Carrier Sales › Unmatched: inbound offers (e-mail or call) the listener could not file with certainty.
 * A suggested load is one click; otherwise the rep names the load, may correct what was read, and assigns.
 * Dismiss deletes the stored message at once. Rows also expire by TTL.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Mail, Phone } from 'lucide-react'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { assignInboundOffer, dismissInboundOffer, listShipmentsByNumber } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { normalizePro } from '@/lib/proNumber'
import type { ShipmentMessageRecord } from '@/types/tms'
import { flagChips, offerOf } from './riskOf'

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Chip = 'AUTO' | 'LOW' | 'MISSING' | 'CONFIRMED'
const CHIP_TONE: Record<Chip, 'green' | 'orange' | 'red' | 'blue'> = { AUTO: 'blue', LOW: 'orange', MISSING: 'red', CONFIRMED: 'green' }

function chipOf(value: string, key: string, meta: Record<string, { source: string; confidence: string }> | undefined, edited: boolean): Chip {
  if (edited) return 'CONFIRMED'
  if (!value.trim()) return 'MISSING'
  return meta?.[key]?.confidence === 'low' ? 'LOW' : 'AUTO'
}

interface Props {
  rows: ShipmentMessageRecord[]
  loading: boolean
  error: string | null
  onChanged: () => void | Promise<void>
}

export function UnmatchedOffers({ rows, loading, error, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<ShipmentMessageRecord | null>(null)
  const [dismissing, setDismissing] = useState<ShipmentMessageRecord | null>(null)

  const oneClick = async (m: ShipmentMessageRecord, shipmentId: string) => {
    setBusy(m.id)
    try {
      await assignInboundOffer({ messageId: m.id, shipmentId })
      toast.success('Offer assigned')
      await onChanged()
    } catch (e) { toast.error(messageOf(e)) } finally { setBusy(null) }
  }

  const columns: Array<ColumnDef<ShipmentMessageRecord>> = [
    {
      key: 'received', header: 'RECEIVED', width: 150,
      render: (m) => <span data-testid={`cs-unmatched-row-${m.id}`} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{m.channel === 'VOICE' ? <Phone size={13} aria-label="Phone call" /> : <Mail size={13} aria-label="E-mail" />}{formatDateTime(m.at)}</span>,
    },
    { key: 'source', header: 'SOURCE', width: 120, render: (m) => { const o = offerOf(m); return o?.source === 'CALL' ? 'Phone' : o?.boardProvider ?? 'E-mail' } },
    {
      key: 'carrier', header: 'CARRIER / MC', width: 240,
      render: (m) => {
        const x = offerOf(m)?.extraction
        return (
          <span style={{ display: 'grid', gap: 2 }}>
            <strong>{x?.carrier.name ?? m.from ?? '—'}</strong>
            <span className="tms-muted" style={{ fontSize: 12 }}>{x?.carrier.mc ? `MC ${x.carrier.mc}` : 'No MC'}</span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{flagChips(x?.flags).map((c) => <TmsBadge key={c.flag} tone={c.tone} title={c.title}>{c.label}</TmsBadge>)}</span>
          </span>
        )
      },
    },
    { key: 'rate', header: 'RATE', width: 100, render: (m) => { const r = offerOf(m)?.extraction.rateCents; return r == null ? '—' : formatCents(r) } },
    {
      key: 'lane', header: 'LANE AS READ', width: 200,
      render: (m) => {
        const x = offerOf(m)?.extraction
        const place = (p: { city: string | null; state: string | null } | null | undefined) => [p?.city, p?.state].filter(Boolean).join(', ') || '—'
        return `${place(x?.origin)} → ${place(x?.destination)}`
      },
    },
    { key: 'ref', header: 'REFERENCE CITED', width: 150, render: (m) => { const x = offerOf(m)?.extraction; return [...(x?.loadRefs ?? []), x?.postingRef].filter(Boolean).join(', ') || '—' } },
    {
      key: 'suggested', header: 'SUGGESTED LOAD', width: 230,
      render: (m) => {
        const top = offerOf(m)?.match.top
        if (!top) return <span className="tms-muted">None</span>
        return (
          <span title={top.signals.map((s) => `${s.detail} (+${s.points})`).join('\n')} style={{ display: 'grid', gap: 2 }}>
            <strong>{top.shipmentNumber ?? top.loadId}</strong>
            <span className="tms-muted" style={{ fontSize: 12 }}>{top.laneText}</span>
            <TmsBadge tone="gray">{top.how} · {Math.round(top.score * 100)}%</TmsBadge>
          </span>
        )
      },
    },
    {
      key: 'actions', header: '', width: 200,
      render: (m) => {
        const top = offerOf(m)?.match.top
        return (
          <span style={{ display: 'flex', gap: 6 }}>
            <TmsButton
              variant="primary" size="sm" data-testid={`cs-unmatched-assign-${m.id}`} disabled={busy === m.id}
              onClick={() => (top ? void oneClick(m, top.shipmentId) : setAssigning(m))}
            >
              {top ? 'Assign' : 'Assign…'}
            </TmsButton>
            {top ? <TmsButton size="sm" disabled={busy === m.id} onClick={() => setAssigning(m)}>Other load…</TmsButton> : null}
            <TmsButton size="sm" variant="destructive" data-testid={`cs-unmatched-dismiss-${m.id}`} disabled={busy === m.id} onClick={() => setDismissing(m)}>Dismiss</TmsButton>
          </span>
        )
      },
    },
  ]

  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="cs-unmatched-table">
      <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>
        Offers that named no load we could verify. Assign one to a load to file it as a carrier offer; dismiss to delete it.
        Unassigned rows are deleted automatically after the retention period in Settings › Carrier Sales.
      </p>
      {error ? <p className="tms-field-error">{error}</p> : null}
      <TmsTable
        columns={columns}
        rows={rows}
        rowKey={(m) => m.id}
        empty={<span className="tms-muted">{loading ? 'Loading…' : 'Nothing is waiting to be matched.'}</span>}
      />

      {assigning ? (
        <AssignDialog
          key={assigning.id}
          message={assigning}
          onClose={() => setAssigning(null)}
          onDone={async () => { setAssigning(null); await onChanged() }}
        />
      ) : null}

      <TmsDialog
        open={dismissing !== null}
        onOpenChange={(o) => { if (!o) setDismissing(null) }}
        title="Dismiss this message?"
        description="The stored message is deleted now. Nothing is filed."
        footer={
          <>
            <TmsButton onClick={() => setDismissing(null)}>Cancel</TmsButton>
            <TmsButton
              variant="destructive" data-testid="cs-unmatched-dismiss-confirm"
              onClick={async () => {
                const m = dismissing
                if (!m) return
                try { await dismissInboundOffer({ messageId: m.id }); toast.success('Dismissed'); setDismissing(null); await onChanged() } catch (e) { toast.error(messageOf(e)) }
              }}
            >
              Dismiss
            </TmsButton>
          </>
        }
      />
    </div>
  )
}

function AssignDialog({ message, onClose, onDone }: { message: ShipmentMessageRecord; onClose: () => void; onDone: () => Promise<void> }) {
  const offer = offerOf(message)
  const x = offer?.extraction
  const top = offer?.match.top
  const [loadText, setLoadText] = useState(top?.shipmentNumber ?? x?.loadRefs[0] ?? '')
  const [name, setName] = useState(x?.carrier.name ?? '')
  const [mc, setMc] = useState(x?.carrier.mc ?? '')
  const [rate, setRate] = useState(x?.rateCents != null ? String(x.rateCents / 100) : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const orig = { name: x?.carrier.name ?? '', mc: x?.carrier.mc ?? '', rate: x?.rateCents != null ? String(x.rateCents / 100) : '' }
  const meta = offer?.fieldMeta

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const wanted = loadText.trim()
      const hit = top && wanted === (top.shipmentNumber ?? '')
        ? top.shipmentId
        : (await Promise.all([...new Set([wanted, normalizePro(wanted) ?? ''].filter(Boolean))].map((t) => listShipmentsByNumber(t))))
          .flat().find((s) => !s.voidedAt)?.id
      if (!hit) { setError('No load with that ID.'); return }
      const dollars = Number(rate)
      await assignInboundOffer({
        messageId: message.id,
        shipmentId: hit,
        ...(name.trim() !== orig.name ? { carrierName: name.trim() } : {}),
        ...(mc.trim() !== orig.mc ? { carrierMc: mc.trim() } : {}),
        ...(rate.trim() !== orig.rate && Number.isFinite(dollars) && dollars > 0 ? { amountCents: Math.round(dollars * 100) } : {}),
      })
      toast.success('Offer assigned')
      await onDone()
    } catch (e) { setError(messageOf(e)) } finally { setBusy(false) }
  }

  const field = (label: string, key: string, value: string, set: (v: string) => void, original: string) => (
    <TmsField label={<span>{label} <TmsBadge tone={CHIP_TONE[chipOf(value, key, meta, value.trim() !== original.trim())]}>{chipOf(value, key, meta, value.trim() !== original.trim())}</TmsBadge></span>}>
      <TmsInput value={value} onChange={(e) => set(e.target.value)} />
    </TmsField>
  )

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Assign to a load"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="cs-unmatched-assign-confirm" disabled={busy || !loadText.trim()} onClick={() => { void submit() }}>Assign</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <TmsField label="Load ID (PRO)"><TmsInput data-testid="cs-unmatched-load-input" value={loadText} onChange={(e) => setLoadText(e.target.value)} /></TmsField>
          {field('Carrier name', 'carrierName', name, setName, orig.name)}
          {field('MC number', 'carrierMc', mc, setMc, orig.mc)}
          {field('Rate ($)', 'rateCents', rate, setRate, orig.rate)}
          {error ? <p className="tms-field-error">{error}</p> : null}
        </div>
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>
          {message.subject ? <strong style={{ display: 'block' }}>{message.subject}</strong> : null}
          {message.body ?? ''}
        </div>
      </div>
    </TmsDialog>
  )
}
