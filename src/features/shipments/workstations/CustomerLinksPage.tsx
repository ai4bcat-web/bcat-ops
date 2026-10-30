/**
 * Manage Customer Links — searchable filtered list of every CUSTOMER_VIEW link
 * across the book. Reachable from the Tracking board toolbar "Manage links" button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ban, CalendarClock, Copy, ExternalLink, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge,
  TmsButton,
  TmsDialog,
  TmsEmptyState,
  TmsInput,
  TmsSelect,
  TmsTable,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import {
  extendCustomerLink,
  listCustomerLinks,
  revokeCustomerLink,
} from '@/lib/apiClient'
import { formatBoardDateTime } from '@/lib/date'
import type { TrackingLinkRecord } from '@/types/tms'
import type { ShipmentRow } from '../shipmentViews'

const EXPIRY_PRESETS = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '14 days', hours: 336 },
  { label: '30 days', hours: 720 },
  { label: 'Custom', hours: -1 },
] as const

type StatusFilter = 'ALL' | 'ACTIVE' | 'REVOKED' | 'EXPIRED'

interface LinkRow {
  link: TrackingLinkRecord
  shipment: ShipmentRow | null
  customerName: string | null
}

function statusTone(status: string): 'green' | 'red' | 'gray' {
  if (status === 'ACTIVE') return 'green'
  if (status === 'REVOKED') return 'red'
  return 'gray'
}

export function CustomerLinksPage() {
  const navigate = useNavigate()
  const { shipments } = useShipments()
  const { customers } = useDirectory()
  const [links, setLinks] = useState<TrackingLinkRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE')
  const [extendTarget, setExtendTarget] = useState<LinkRow | null>(null)
  const [extendExpiry, setExtendExpiry] = useState(168)
  const [extendCustom, setExtendCustom] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await listCustomerLinks()
      setLinks(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load customer links')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  const shipmentById = useMemo(() => {
    const map = new Map<string, ShipmentRow>()
    for (const s of shipments) map.set(s.id, s)
    return map
  }, [shipments])

  const customerById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of customers) map.set(c.id, c.name)
    return map
  }, [customers])

  const rows: LinkRow[] = useMemo(() => {
    return links.map((link) => {
      const shipment = shipmentById.get(link.shipmentId) ?? null
      const customerName =
        (link.customerId ? customerById.get(link.customerId) : null) ??
        shipment?.customerName ?? null
      return { link, shipment, customerName }
    })
  }, [links, shipmentById, customerById])

  const q = query.trim().toLowerCase()

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter === 'ACTIVE' && r.link.status !== 'ACTIVE') return false
      if (statusFilter === 'REVOKED' && r.link.status !== 'REVOKED') return false
      if (statusFilter === 'EXPIRED' && r.link.status !== 'EXPIRED') return false
      if (q) {
        const needle = [
          r.shipment?.number,
          r.customerName,
          r.link.url,
          r.link.createdBy,
        ].some((v) => (v ?? '').toLowerCase().includes(q))
        if (!needle) return false
      }
      return true
    })
  }, [rows, statusFilter, q])

  const revoke = async (row: LinkRow) => {
    setBusy(true)
    try {
      await revokeCustomerLink({ trackingLinkId: row.link.id })
      await refresh()
      toast.success('Customer link revoked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke link')
    } finally {
      setBusy(false)
    }
  }

  const extend = async () => {
    if (!extendTarget) return
    setBusy(true)
    try {
      const expiresAt =
        extendCustom
          ? new Date(extendCustom + 'T23:59:59').toISOString()
          : new Date(Date.now() + extendExpiry * 3600_000).toISOString()
      await extendCustomerLink({ trackingLinkId: extendTarget.link.id, expiresAt })
      setExtendTarget(null)
      await refresh()
      toast.success('Link extended')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not extend link')
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<ColumnDef<LinkRow>> = [
    {
      key: 'shipment',
      header: 'SHIPMENT',
      width: 140,
      render: (row) =>
        row.shipment ? (
          <button
            type="button"
            className="tms-link"
            onClick={() => navigate(`/tms/shipments/${row.shipment!.id}?tab=tracking`)}
            style={{ fontWeight: 600, color: 'var(--tms-primary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', padding: 0 }}
          >
            {row.shipment.number}
          </button>
        ) : (
          <span className="tms-muted">—</span>
        ),
    },
    {
      key: 'customer',
      header: 'CUSTOMER',
      width: 160,
      render: (row) => <span>{row.customerName ?? '—'}</span>,
    },
    {
      key: 'url',
      header: 'URL',
      width: 300,
      render: (row) => {
        if (!row.link.url) return <span className="tms-muted">—</span>
        const truncated =
          row.link.url.length > 50
            ? `${row.link.url.slice(0, 47)}…`
            : row.link.url
        return (
          <span className="flex items-center gap-1">
            <span className="text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
              {truncated}
            </span>
            <TmsButton
              size="sm"
              variant="ghost"
              aria-label="Copy URL"
              onClick={() => { void navigator.clipboard?.writeText(row.link.url!); toast.success('URL copied') }}
            >
              <Copy size={12} />
            </TmsButton>
            <TmsButton
              size="sm"
              variant="ghost"
              aria-label="Open link"
              onClick={() => window.open(row.link.url!, '_blank')}
            >
              <ExternalLink size={12} />
            </TmsButton>
          </span>
        )
      },
    },
    {
      key: 'createdBy',
      header: 'CREATED BY',
      width: 160,
      render: (row) => <span className="text-xs">{row.link.createdBy}</span>,
    },
    {
      key: 'status',
      header: 'STATUS',
      width: 110,
      render: (row) => <TmsBadge tone={statusTone(row.link.status)}>{row.link.status}</TmsBadge>,
    },
    {
      key: 'expires',
      header: 'EXPIRES',
      width: 170,
      render: (row) => (
        <span className="text-xs">
          {row.link.expiresAt
            ? formatBoardDateTime(row.link.expiresAt)
            : '—'}
        </span>
      ),
    },
    {
      key: 'lastOpened',
      header: 'LAST OPENED',
      width: 170,
      render: (row) => (
        <span className="text-xs tms-muted">
          {row.link.lastOpenedAt ? formatBoardDateTime(row.link.lastOpenedAt) : '—'}
        </span>
      ),
    },
    {
      key: 'opens',
      header: 'OPENS',
      width: 80,
      render: (row) => <span className="text-xs">{row.link.openCount ?? 0}</span>,
    },
    {
      key: 'actions',
      header: 'ACTIONS',
      width: 180,
      render: (row) => (
        <span className="flex items-center gap-1">
          {row.link.status === 'ACTIVE' && (
            <>
              <TmsButton
                size="sm"
                variant="ghost"
                onClick={() => setExtendTarget(row)}
                disabled={busy}
              >
                <CalendarClock size={12} className="mr-1" />Extend
              </TmsButton>
              <TmsButton
                size="sm"
                variant="ghost"
                onClick={() => { void revoke(row) }}
                disabled={busy}
              >
                <Ban size={12} className="mr-1" />Revoke
              </TmsButton>
            </>
          )}
        </span>
      ),
    },
  ]

  return (
    <div className="tms-page" data-testid="customer-links-page">
      <div className="tms-page-head">
        <h1>Manage Customer Links</h1>
        <div className="tms-page-actions">
          <TmsButton size="sm" variant="secondary" onClick={() => navigate('/tms/tracking')}>
            Back to Tracking
          </TmsButton>
          <TmsButton size="sm" variant="secondary" onClick={() => { void refresh() }}>
            Refresh
          </TmsButton>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--tms-muted)]" />
          <TmsInput
            placeholder="Search by shipment, customer, URL…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 h-9 text-sm w-full"
            aria-label="Search customer links"
          />
        </div>
        <TmsSelect
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          options={[
            { value: 'ALL', label: 'All' },
            { value: 'ACTIVE', label: 'Active' },
            { value: 'REVOKED', label: 'Revoked' },
            { value: 'EXPIRED', label: 'Expired' },
          ]}
        />
      </div>

      {error ? (
        <p className="text-xs text-[color:var(--tms-badge-red)]">{error}</p>
      ) : loading ? (
        <p className="text-xs tms-muted">Loading customer links…</p>
      ) : filteredRows.length === 0 ? (
        <TmsEmptyState
          title="No customer links"
          message={q ? 'No links match your search.' : 'Create a customer URL from the Tracking board.'}
        />
      ) : (
        <TmsTable
          columns={columns}
          rows={filteredRows}
          rowKey={(r) => r.link.id}
        />
      )}

      <div className="mt-2 text-xs tms-muted">
        <strong>{filteredRows.length}</strong> link{filteredRows.length !== 1 ? 's' : ''}
        {statusFilter !== 'ALL' ? ` (showing ${statusFilter.toLowerCase()})` : ''}
      </div>

      {extendTarget && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open) setExtendTarget(null) }}
          title="Extend customer link"
          footer={
            <>
              <TmsButton variant="ghost" onClick={() => setExtendTarget(null)} disabled={busy}>
                Cancel
              </TmsButton>
              <TmsButton variant="primary" onClick={() => { void extend() }} disabled={busy}>
                {busy ? 'Extending…' : 'Extend'}
              </TmsButton>
            </>
          }
        >
          <p className="text-xs tms-muted mb-3">
            Current expiry: {formatBoardDateTime(extendTarget.link.expiresAt)}
          </p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {EXPIRY_PRESETS.map((p) => (
              <TmsButton
                key={p.label}
                size="sm"
                variant={p.hours === extendExpiry ? 'primary' : 'secondary'}
                onClick={() => { setExtendExpiry(p.hours); setExtendCustom('') }}
              >
                {p.label}
              </TmsButton>
            ))}
          </div>
          {extendExpiry === -1 && (
            <input
              type="date"
              value={extendCustom}
              onChange={(e) => setExtendCustom(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="h-9 w-full rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-input)] px-3 text-sm text-[color:var(--tms-text)]"
            />
          )}
        </TmsDialog>
      )}
    </div>
  )
}

export default CustomerLinksPage
