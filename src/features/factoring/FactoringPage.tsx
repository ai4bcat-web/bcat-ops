import { useMemo, useState, useCallback } from 'react'
import {
  RefreshCw, Search, Inbox, Mail, Loader2, AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useFactoringItems } from '@/hooks/useFactoringItems'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { FactoringItem, FactoringItemStatus } from '@/types'

// ── Status labels ────────────────────────────────────────────────────────────

const FACTORING_STATUS_LABEL: Record<FactoringItemStatus, string> = {
  NEED_TO_FACTOR:   'Need to factor',
  PENDING_WITH_OTR: 'Pending with OTR',
  FACTORED:         'Factored',
}

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
  const { items, loading, error, pendingIds, refresh, updateStatus } = useFactoringItems()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<FactoringItemStatus | 'ALL'>('ALL')

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

      {/* Filters */}
      <div style={{ padding: '16px 32px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Status tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {(['ALL', ...STATUS_ORDER] as const).map((key) => {
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
                    {['PRO #', 'Subject', 'From', 'Received', 'Status'].map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: '10px 16px', textAlign: col === 'PRO #' ? 'left' : 'left',
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
                    <tr
                      key={item.id}
                      style={{ borderBottom: '1px solid var(--ds-border)' }}
                      className="hover:bg-[var(--ds-bg)] transition-colors"
                    >
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="inline-flex items-center justify-center size-7 rounded-md bg-slate-100 text-slate-600">
                            <Mail className="size-3.5" />
                          </span>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
                            {item.proNumber}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '14px 16px', minWidth: 260, maxWidth: 420 }}>
                        <p className="truncate text-sm text-foreground font-medium" title={item.subject}>
                          {item.subject || '(no subject)'}
                        </p>
                      </td>
                      <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                        <span className="text-sm text-muted-foreground">{item.fromEmail}</span>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
