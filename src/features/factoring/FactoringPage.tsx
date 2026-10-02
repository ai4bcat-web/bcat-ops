import { Fragment, useMemo, useState, useCallback } from 'react'
import {
  RefreshCw, Search, Inbox, Mail, Loader2, AlertCircle, Trash2, ChevronRight, ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OtrPanel } from './OtrPanel'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useAppStore } from '@/store/useAppStore'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { useAuth } from '@/hooks/useAuth'
import { canDeleteFactoringItem } from '@/lib/auth/admin'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { FactoringRowFields } from './FactoringRowFields'
import { fieldsReadyLabel, isReadyToSubmit } from './factoringFields'
import { invoiceAmountOf, totalsByStatus, money } from './factoringTotals'
import { FactoringDocCell } from './FactoringDocCell'
import { OtrInvoiceBoard } from './OtrInvoiceBoard'
import type { OtrReadiness } from '@/lib/otrInvoice'
import type { FactoringItem, FactoringItemStatus } from '@/types'

// ── Status labels ────────────────────────────────────────────────────────────

const FACTORING_STATUS_LABEL: Record<FactoringItemStatus, string> = {
  NEED_TO_FACTOR:   'Need to factor',
  PENDING_WITH_OTR: 'Pending with OTR',
  FACTORED:         'Factored',
}

/**
 * Filter order is the order of the work: what still needs doing, what is waiting on OTR,
 * then everything, then what is finished. "Need to factor" is the default because an empty
 * queue there is the only state worth celebrating.
 */
const FILTER_ORDER = ['NEED_TO_FACTOR', 'PENDING_WITH_OTR', 'ALL', 'FACTORED'] as const
type FilterKey = (typeof FILTER_ORDER)[number]

const STATUS_ORDER: FactoringItemStatus[] = ['NEED_TO_FACTOR', 'PENDING_WITH_OTR', 'FACTORED']

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatReceivedAt(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativeReceived(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * The PRO number, as the way into the load it names.
 *
 * Everything in this queue is discussed by PRO, and the next question after "why is 14538
 * still red" is always on the load — its stops, its rate, its rate confirmation. Opening
 * the drawer here beats copying the number onto the Loads page.
 *
 * A row whose PRO never matched a load keeps its plain number: an underline that goes
 * nowhere is worse than no underline.
 */
function ProLink({ loadId, proNumber }: { loadId: string | null | undefined; proNumber: string }) {
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const loads = useAppStore((s) => s.loads)
  const known = loadId ? loads.some((l) => l.id === loadId) : false
  const text = (
    <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
      {proNumber}
    </span>
  )
  if (!known || !loadId) {
    return <span style={{ color: 'var(--ds-t1)' }} title="This PRO is not linked to a load yet">{text}</span>
  }
  return (
    <button
      type="button"
      onClick={() => setSelectedLoad(loadId, 'view')}
      aria-label={`Open the load for PRO ${proNumber}`}
      title="Open this load"
      style={{
        border: 'none', background: 'none', padding: 0, cursor: 'pointer',
        fontFamily: 'inherit', color: 'var(--ds-accent, #2563eb)',
        textDecoration: 'underline', textUnderlineOffset: 3,
      }}
    >
      {text}
    </button>
  )
}

/**
 * The readiness the Lambda cached on the row. It is an `a.json()` column, already parsed
 * on read by apiClient, so this is only a cast with a guard rather than a parse.
 */
function readinessOf(item: FactoringItem): OtrReadiness | null {
  const r = item.otrReadiness
  return r && typeof r === 'object' ? (r as OtrReadiness) : null
}

/**
 * Who the invoice bills, and how far to trust it.
 *
 * Nothing looks an MC up today, so no name here is verified against one. The best we have
 * is the broker record this load points at — whose name came from the load and whose MC
 * came from whoever typed one, independently — or a name someone entered against the row.
 */
function customerOf(item: FactoringItem): { name: string; source: string | null } {
  const r = readinessOf(item)
  return { name: (r?.customerName ?? '').trim(), source: r?.customerSource ?? null }
}

const CUSTOMER_SOURCE_NOTE: Record<string, string> = {
  verified: 'Looked up from the broker MC',
  entered: 'Entered on this row',
  directory: 'From the broker record on this load \u2014 not checked against the MC',
  load: 'From the load \u2014 often a shipper or an agent, not the broker being factored',
}

/** The PO number OTR requires, once it has resolved. */
function poOf(item: FactoringItem): string {
  const v = readinessOf(item)?.payload?.PoNumber
  return v == null ? '' : String(v)
}

/** Documents OTR still wants. Unknown readiness means both, since neither is proven. */
function missingDocs(item: FactoringItem): Array<'POD' | 'Rate confirmation'> {
  return readinessOf(item)?.missingDocuments ?? ['POD', 'Rate confirmation']
}

function matchesSearch(item: FactoringItem, query: string) {
  if (!query.trim()) return true
  const q = query.toLowerCase().trim()
  return (
    item.proNumber.toLowerCase().includes(q) ||
    item.subject.toLowerCase().includes(q) ||
    item.fromEmail.toLowerCase().includes(q)
  )
}

// ── Status select for a row ──────────────────────────────────────────────────

/**
 * What the invoice is worth.
 *
 * Pulled from the same resolved payload the invoice is submitted with, so the column and
 * the invoice can never disagree. When nothing has resolved a rate — the email carried no
 * amount and the load has no rate on it — this is a way in rather than a dash: the rate is
 * typed in the row's own editor, and a red cell that does nothing when clicked is how a
 * queue ends up with rows nobody ever priced.
 */
function AmountCell({ item, onEdit }: { item: FactoringItem; onEdit: () => void }) {
  const amount = invoiceAmountOf(item)
  if (amount != null) {
    return (
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
        {money(amount)}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Add the rate for PRO ${item.proNumber}`}
      title="No rate came through on the email or the load \u2014 add it here"
      style={{
        border: '1px solid #fca5a5', background: '#fee2e2', color: '#b91c1c',
        borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700,
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >
      Add rate
    </button>
  )
}

/**
 * What the queue is worth, per status.
 *
 * Counts were on the tabs already, and a count of invoices is not money. Rows with no rate
 * are called out beside the figure rather than folded into it: a total that silently
 * swallows what it could not price reads as complete and is not.
 */
function StatusTotals({ items }: { items: FactoringItem[] }) {
  const totals = totalsByStatus(items)
  const buckets = [
    ['NEED_TO_FACTOR', 'Need to factor'],
    ['PENDING_WITH_OTR', 'Pending with OTR'],
    ['FACTORED', 'Factored'],
    ['ALL', 'All'],
  ] as const

  return (
    <div
      role="group"
      aria-label="What the queue is worth, by status"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}
    >
      {buckets.map(([key, label]) => {
        const t = totals[key]
        const isAll = key === 'ALL'
        return (
          <div
            key={key}
            aria-label={`${label}: ${money(t.total)} across ${t.count} invoices`}
            style={{
              flex: '1 1 160px', minWidth: 160,
              border: '1px solid var(--ds-border)', borderRadius: 9,
              padding: '8px 12px',
              background: isAll ? 'var(--ds-bg)' : 'var(--ds-surface)',
            }}
          >
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
              {label}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 17, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
              {money(t.total)}
            </p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--ds-t3)' }}>
              {t.count} {t.count === 1 ? 'invoice' : 'invoices'}
              {t.missingRate > 0 && (
                <span style={{ color: '#b91c1c', fontWeight: 600 }}> \u00b7 {t.missingRate} with no rate</span>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/** The customer column: the confirmed broker, an unconfirmed guess, or nothing yet. */
function CustomerCell({ item }: { item: FactoringItem }) {
  const { name, source } = customerOf(item)
  if (!name) {
    return (
      <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }} title="Open the row to enter it">
        \u2014
      </span>
    )
  }
  // Only a real lookup earns plain, confident styling. Everything else reads as a guess,
  // because that is what it is.
  const verified = source === 'verified'
  return (
    <span
      title={source ? CUSTOMER_SOURCE_NOTE[source] : undefined}
      style={{
        display: 'block', fontSize: 12.5, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: verified ? 'var(--ds-t1)' : 'var(--ds-t3)',
        fontWeight: verified ? 600 : 400,
        fontStyle: verified ? 'normal' : 'italic',
      }}
    >
      {name}
    </span>
  )
}

function StatusSelect({
  item,
  disabled,
  onChange,
}: {
  item: FactoringItem
  disabled: boolean
  onChange: (id: string, status: FactoringItemStatus) => void
}) {
  return (
    <Select
      value={item.status}
      disabled={disabled}
      onValueChange={(value) => onChange(item.id, value as FactoringItemStatus)}
    >
      <SelectTrigger
        className="h-8 w-[170px] text-xs font-medium"
        aria-label={`Status for PRO ${item.proNumber}`}
      >
        <SelectValue placeholder="Set status" />
      </SelectTrigger>
      <SelectContent>
        {STATUS_ORDER.map((status) => (
          <SelectItem key={status} value={status} className="text-xs">
            {FACTORING_STATUS_LABEL[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function FactoringPage() {
  const { items, loading, error, pendingIds, refresh, updateStatus, removeItem } = useFactoringItems()
  const { user } = useAuth()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<FilterKey>('NEED_TO_FACTOR')
  const [view, setView] = useState<'queue' | 'board'>('queue')
  /**
   * Which rows are open. Collapsed by default: the panel is an editor, and rendering one
   * per row turned a list of twenty PROs into twenty stacked forms. The row itself already
   * says what is missing, so opening one is a decision, not the only way to see anything.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Deleting a row drops the record that a PRO was ever sent for factoring, so it is
  // limited to the two people who run factoring rather than every admin.
  const canDelete = canDeleteFactoringItem(user?.email)
  const staffEmail = user?.email ?? ''

  const counts = useMemo(() => ({
    ALL: items.length,
    NEED_TO_FACTOR: items.filter((i) => i.status === 'NEED_TO_FACTOR').length,
    PENDING_WITH_OTR: items.filter((i) => i.status === 'PENDING_WITH_OTR').length,
    FACTORED: items.filter((i) => i.status === 'FACTORED').length,
  }), [items])

  const filtered = useMemo(() => {
    return items
      .filter((item) => (activeTab === 'ALL' ? true : item.status === activeTab))
      .filter((item) => matchesSearch(item, search))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, activeTab, search])

  const handleStatusChange = useCallback(async (id: string, status: FactoringItemStatus) => {
    try {
      await updateStatus(id, status)
      toast.success(`Status updated to ${FACTORING_STATUS_LABEL[status]}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status')
    }
  }, [updateStatus])

  const handleDelete = useCallback(async (item: FactoringItem) => {
    if (!window.confirm(
      `Delete the queue row for PRO ${item.proNumber}?\n\n` +
      'This permanently removes the factoring queue entry. The original email remains in the inbox; forwarding it again will recreate the row.'
    )) return

    try {
      await removeItem(item.id)
      toast.success(`PRO ${item.proNumber} deleted from queue`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete queue row')
    }
  }, [removeItem])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 32px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.01em', margin: 0 }}>Factoring Queue</h1>
          <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            One row per PRO. Emails forwarded to ivanfactoring@bcatcorp.com appear automatically.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Two views of the same rows: the work to do, and where OTR has got to. */}
          <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3 }}>
            {([['queue', 'Queue'], ['board', 'OTR invoice board']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                style={{
                  padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                  fontSize: 12.5, fontWeight: view === key ? 600 : 500, fontFamily: 'inherit',
                  background: view === key ? 'var(--ds-surface)' : 'transparent',
                  color: view === key ? 'var(--ds-t1)' : 'var(--ds-t3)',
                  boxShadow: view === key ? 'var(--sh-sm)' : 'none', whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters — queue only; the board is sorted by submission and has its own refresh. */}
      <div style={{ padding: '16px 32px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0, display: view === 'queue' ? undefined : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Status tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {FILTER_ORDER.map((key) => {
              const isActive = activeTab === key
              const label = key === 'ALL' ? 'All' : FACTORING_STATUS_LABEL[key]
              const count = counts[key]
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 12px', fontSize: 12, fontWeight: 600,
                    borderRadius: 7, border: '1px solid transparent',
                    background: isActive ? 'var(--ds-blue)' : 'transparent',
                    color: isActive ? '#fff' : 'var(--ds-t2)',
                    borderColor: isActive ? 'var(--ds-blue)' : 'var(--ds-border)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {label}
                  {count > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, borderRadius: 999,
                      padding: '1px 6px', minWidth: 16, height: 16,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isActive ? 'rgba(255,255,255,0.25)' : 'var(--ds-border)',
                      color: isActive ? '#fff' : 'var(--ds-t2)',
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Search */}
          <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <Input
              placeholder="Search PRO, subject, or sender…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search factoring queue"
              className="h-8 text-xs"
              style={{ paddingLeft: 36 }}
            />
          </div>
        </div>
        {/* What the queue is worth, not just how many rows are in it. */}
        <StatusTotals items={items} />
      </div>

      {/* Error banner — never shown as an empty state */}
      {error && (
        <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: 8, background: 'var(--ds-red-bg, #fee2e2)', border: '1px solid var(--ds-red-border, #fecaca)', color: 'var(--ds-red-text, #991b1b)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {view === 'board' ? (
          <OtrInvoiceBoard items={items} onChanged={refresh} />
        ) : (
        <div style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)' }}>
          {loading && items.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 0', gap: 10, color: 'var(--ds-t3)' }}>
              <Loader2 className="size-6 animate-spin opacity-50" />
              <p className="text-sm">Loading factoring queue…</p>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 0', gap: 10, color: 'var(--ds-t3)' }}>
              <Inbox className="size-10 opacity-20" />
              <p className="text-sm">
                {error ? 'Couldn’t load queue. Try refreshing.' : 'No items match the current filters.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                    {['PRO #', 'PO #', 'Customer', 'Amount', 'Fields', 'Required for OTR', 'Documents', 'Received', 'Status', ...(canDelete ? ['Actions'] : [])].map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: '10px 16px', textAlign: 'left',
                          fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
                          textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <Fragment key={item.id}>
                    <tr
                      style={{ borderBottom: '1px solid var(--ds-border)' }}
                      className="hover:bg-[var(--ds-bg)] transition-colors"
                    >
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <button
                          onClick={() => toggleExpanded(item.id)}
                          aria-expanded={expanded.has(item.id)}
                          aria-label={`${expanded.has(item.id) ? 'Hide' : 'Edit'} the OTR fields for PRO ${item.proNumber}`}
                          title={item.subject || undefined}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, border: 'none',
                            background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          {expanded.has(item.id)
                            ? <ChevronDown className="size-4 text-muted-foreground" />
                            : <ChevronRight className="size-4 text-muted-foreground" />}
                          <span className="inline-flex items-center justify-center size-7 rounded-md bg-slate-100 text-slate-600">
                            <Mail className="size-3.5" />
                          </span>
                        </button>
                        {/* The PRO opens the load it names — the expander is the chevron
                            beside it, so one control does not have to mean two things. */}
                        <ProLink loadId={item.loadId} proNumber={item.proNumber} />
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: 13, color: poOf(item) ? 'var(--ds-t1)' : '#b91c1c',
                          fontWeight: poOf(item) ? 500 : 600,
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {poOf(item) || 'missing'}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', maxWidth: 190 }}>
                        <CustomerCell item={item} />
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <AmountCell item={item} onEdit={() => toggleExpanded(item.id)} />
                      </td>
                      {/* How close this row is to being invoiceable, as a count then the
                          individual fields. Green means resolved, red means still missing. */}
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: 12.5, fontWeight: 700,
                          // Green only when OTR would actually take it — same rule as Submit.
                          color: isReadyToSubmit(readinessOf(item)) ? '#15803d' : 'var(--ds-t2)',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {fieldsReadyLabel(readinessOf(item))}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <FactoringRowFields readiness={readinessOf(item)} />
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 5 }}>
                          <FactoringDocCell
                            kind="POD"
                            present={!missingDocs(item).includes('POD')}
                            loadId={item.loadId}
                            proNumber={item.proNumber}
                            itemId={item.id}
                            staffEmail={staffEmail}
                            onUploaded={refresh}
                          />
                          <FactoringDocCell
                            kind="RATECON"
                            present={!missingDocs(item).includes('Rate confirmation')}
                            loadId={item.loadId}
                            proNumber={item.proNumber}
                            itemId={item.id}
                            staffEmail={staffEmail}
                            onUploaded={refresh}
                          />
                        </div>
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <div className="text-sm text-muted-foreground" title={formatReceivedAt(item.receivedAt)}>
                          {relativeReceived(item.receivedAt)}
                        </div>
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <StatusSelect
                            item={item}
                            disabled={pendingIds.has(item.id)}
                            onChange={handleStatusChange}
                          />
                          {pendingIds.has(item.id) && (
                            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      </td>
                      {canDelete && (
                        <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-red-600"
                            aria-label={`Delete queue row for PRO ${item.proNumber}`}
                            title="Delete queue row"
                            disabled={pendingIds.has(item.id)}
                            onClick={() => handleDelete(item)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      )}
                    </tr>
                      {/* The editor, only for a row someone opened. */}
                      {expanded.has(item.id) && (
                        <tr>
                          <td colSpan={canDelete ? 10 : 9} style={{ padding: '0 16px 14px' }}>
                            <OtrPanel item={item} onChanged={refresh} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>
      {/* Opened by the PRO column. */}
      <LoadDrawer />
    </div>
  )
}
