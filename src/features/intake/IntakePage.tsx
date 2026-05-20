import { useState, useMemo, useRef, useEffect } from 'react'
import {
  RefreshCw, ExternalLink, Paperclip, MessageSquare, User,
  ChevronDown, Inbox, Clock, CheckCircle2, Archive, Loader2, Hash,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import type { IntakeItem, IntakeStatus } from '@/types'

// ── Team members ──────────────────────────────────────────────────────────────

export const TEAM_MEMBERS = [
  { email: 'dennis@bcatcorp.com', name: 'Dennis' },
  { email: 'arcie@bcatcorp.com',  name: 'Arcie'  },
  { email: 'ryne@bcatcorp.com',   name: 'Ryne'   },
  { email: 'jenny@bcatcorp.com',  name: 'Jenny'  },
  { email: 'ruben@bcatcorp.com',  name: 'Ruben'  },
] as const

export function assigneeLabel(email: string) {
  return TEAM_MEMBERS.find((m) => m.email === email)?.name ?? email.split('@')[0]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export const STATUS_BADGE: Record<IntakeStatus, { label: string; className: string }> = {
  NEW:         { label: 'New',         className: 'bg-sky-50 text-sky-700 border-sky-200' },
  IN_PROGRESS: { label: 'In Progress', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  BUILT:       { label: 'Built',       className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  DONE:        { label: 'Done',        className: 'bg-slate-100 text-slate-600 border-slate-200' },
  ARCHIVED:    { label: 'Archived',    className: 'bg-slate-50 text-slate-400 border-slate-200' },
}

export const SOURCE_LABEL: Record<string, string> = {
  IVAN_CARTAGE:   'Ivan Cartage',
  BCAT_LOGISTICS: 'BCAT Logistics',
}

const ACTIVE_STATUSES = new Set<IntakeStatus>(['NEW', 'IN_PROGRESS'])

// ── Pro# modal ────────────────────────────────────────────────────────────────

function ProNumberModal({
  item,
  onConfirm,
  onClose,
}: {
  item: IntakeItem
  onConfirm: (proNumber: string) => Promise<void>
  onClose: () => void
}) {
  const [proNumber, setProNumber] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Auto-focus the input when modal opens
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const handleConfirm = async () => {
    const trimmed = proNumber.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onConfirm(trimmed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Mark as Done</DialogTitle>
          <DialogDescription>
            Enter the Pro# from Aljex for this BCAT Logistics load. Required before marking done.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Subject
          </p>
          <p className="text-sm text-foreground font-medium leading-snug">
            {item.subject || '(no subject)'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Hash className="size-3" /> Pro# <span className="text-destructive">*</span>
          </label>
          <Input
            ref={inputRef}
            value={proNumber}
            onChange={(e) => setProNumber(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            placeholder="e.g. A-2847391"
            className="h-9"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={handleConfirm}
            disabled={!proNumber.trim() || saving}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <CheckCircle2 className="size-3.5 mr-1.5" />}
            Mark as Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Assignee select ───────────────────────────────────────────────────────────

function AssigneeSelect({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (email: string) => void
  className?: string
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 pl-1.5 pr-5 text-[11px] rounded border border-slate-200 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-medium w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {TEAM_MEMBERS.map((m) => (
          <option key={m.email} value={m.email}>{m.name}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 size-2.5 text-muted-foreground" />
    </div>
  )
}

// ── Queue card ────────────────────────────────────────────────────────────────

function QueueCard({
  item,
  onBuildLoad,
  onMarkDone,
  onStatusChange,
  onAssigneeChange,
}: {
  item: IntakeItem
  onBuildLoad: (item: IntakeItem) => void
  onMarkDone: (item: IntakeItem) => void
  onStatusChange: (id: string, status: IntakeStatus) => void
  onAssigneeChange: (id: string, email: string) => void
}) {
  const isIvan  = item.source === 'IVAN_CARTAGE'
  const hasPdfs = (item.s3KeyPdfAttachments?.length ?? 0) > 0
  const badge   = STATUS_BADGE[item.status]

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm hover:shadow-md transition-shadow p-4 flex flex-col gap-3">
      {/* Top row: subject + status badge */}
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm font-semibold text-foreground leading-snug line-clamp-2">
          {item.subject || '(no subject)'}
        </p>
        <span className={cn(
          'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border',
          badge.className,
        )}>
          {badge.label}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="size-3" />
          {relativeTime(item.receivedAt)}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <User className="size-3" />
          <AssigneeSelect
            value={item.assignedTo ?? 'dennis@bcatcorp.com'}
            onChange={(email) => onAssigneeChange(item.id, email)}
          />
        </span>
        {hasPdfs && (
          <span className="flex items-center gap-1">
            <Paperclip className="size-3" />
            {item.s3KeyPdfAttachments.length}
          </span>
        )}
        {item.externalSource === 'slack' && (
          <span className="flex items-center gap-1 text-sky-600">
            <MessageSquare className="size-3" /> Slack
          </span>
        )}
        {item.externalUrl && (
          <a
            href={item.externalUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-sky-600 hover:text-sky-700 font-medium"
            onClick={(e) => e.stopPropagation()}
          >
            View <ExternalLink className="size-2.5" />
          </a>
        )}
      </div>

      {/* Body snippet */}
      {item.bodyText && (
        <p className="text-[11px] text-muted-foreground line-clamp-2 bg-slate-50 rounded px-2 py-1.5 border border-slate-100">
          {item.bodyText}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-0.5">
        {isIvan ? (
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1"
            onClick={() => onBuildLoad(item)}
          >
            <CheckCircle2 className="size-3" />
            Build Load
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5 flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => onMarkDone(item)}
          >
            <CheckCircle2 className="size-3" />
            Mark as Done
          </Button>
        )}

        {item.status === 'NEW' && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => onStatusChange(item.id, 'IN_PROGRESS')}
            title="Mark In Progress"
          >
            <Clock className="size-3" />
            In Progress
          </Button>
        )}

        <button
          className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 text-muted-foreground hover:text-slate-600 hover:bg-slate-50 transition-colors"
          title="Archive"
          onClick={() => onStatusChange(item.id, 'ARCHIVED')}
        >
          <Archive className="size-3" />
        </button>
      </div>
    </div>
  )
}

// ── History row ───────────────────────────────────────────────────────────────

function HistoryRow({
  item,
  loads,
  onAssigneeChange,
}: {
  item: IntakeItem
  loads: { id: string; aljexId: string }[]
  onAssigneeChange: (id: string, email: string) => void
}) {
  const badge = STATUS_BADGE[item.status] ?? { label: item.status, className: 'bg-slate-100 text-slate-600 border-slate-200' }
  const builtLoad = item.builtLoadId ? loads.find((l) => l.id === item.builtLoadId) : null

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/60 transition-colors">
      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(item.receivedAt)}
      </td>
      <td className="px-4 py-2.5">
        <span className={cn(
          'inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border',
          item.source === 'IVAN_CARTAGE'
            ? 'bg-violet-50 text-violet-700 border-violet-200'
            : 'bg-blue-50 text-blue-700 border-blue-200',
        )}>
          {SOURCE_LABEL[item.source] ?? item.source}
        </span>
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-foreground truncate max-w-[220px]">
            {item.subject || '(no subject)'}
          </p>
          {(item.s3KeyPdfAttachments?.length ?? 0) > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0">
              <Paperclip className="size-3" />{item.s3KeyPdfAttachments.length}
            </span>
          )}
        </div>
        {item.fromEmail && (
          <p className="text-[11px] text-muted-foreground truncate max-w-[220px] mt-0.5">{item.fromEmail}</p>
        )}
      </td>
      <td className="px-4 py-2.5">
        <AssigneeSelect
          value={item.assignedTo ?? 'dennis@bcatcorp.com'}
          onChange={(email) => onAssigneeChange(item.id, email)}
        />
      </td>
      <td className="px-4 py-2.5">
        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', badge.className)}>
          {badge.label}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs">
        {/* Ivan → built load link; BCAT → pro number */}
        {builtLoad ? (
          <span className="font-medium text-emerald-700">{builtLoad.aljexId || builtLoad.id.slice(0, 8)}</span>
        ) : item.proNumber ? (
          <span className="font-medium text-slate-700 flex items-center gap-0.5">
            <Hash className="size-3" />{item.proNumber}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {item.externalUrl ? (
          <a
            href={item.externalUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-0.5 text-xs text-sky-600 hover:text-sky-700 font-medium"
          >
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
    </tr>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'IVAN_CARTAGE',   label: 'Ivan Cartage'   },
  { key: 'BCAT_LOGISTICS', label: 'BCAT Logistics'  },
] as const

export function IntakePage() {
  const { items, loading, refresh, updateItem } = useIntakeItems()
  const { user } = useAuth()
  const setSelectedLoad      = useAppStore((s) => s.setSelectedLoad)
  const setPendingIntakeItem = useAppStore((s) => s.setPendingIntakeItem)
  const loads                = useAppStore((s) => s.loads)

  const actorEmail = user?.email ?? 'dispatch'

  // Active queue tab
  const [activeTab, setActiveTab] = useState<'IVAN_CARTAGE' | 'BCAT_LOGISTICS'>('IVAN_CARTAGE')

  // History filters
  const [historySource, setHistorySource] = useState<string>('ALL')
  const [historyStatus, setHistoryStatus] = useState<string>('ALL')

  // Pro# modal state
  const [proModalItem, setProModalItem] = useState<IntakeItem | null>(null)

  // Active queue items
  const activeItems = useMemo(() =>
    items
      .filter((i) => i.source === activeTab && ACTIVE_STATUSES.has(i.status))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()),
    [items, activeTab],
  )

  const ivanCount = useMemo(() => items.filter((i) => i.source === 'IVAN_CARTAGE' && ACTIVE_STATUSES.has(i.status)).length, [items])
  const bcatCount = useMemo(() => items.filter((i) => i.source === 'BCAT_LOGISTICS' && ACTIVE_STATUSES.has(i.status)).length, [items])

  const historyItems = useMemo(() => {
    let list = [...items]
    if (historySource !== 'ALL') list = list.filter((i) => i.source === historySource)
    if (historyStatus !== 'ALL') list = list.filter((i) => i.status === historyStatus)
    return list.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, historySource, historyStatus])

  const handleStatusChange = async (id: string, status: IntakeStatus) => {
    await updateItem(id, { status }, { actorName: actorEmail })
  }

  const handleBuildLoad = (item: IntakeItem) => {
    if (item.status === 'NEW') {
      updateItem(item.id, { status: 'IN_PROGRESS' }, { actorName: actorEmail }).catch(() => {})
    }
    setPendingIntakeItem(item.id)
    setSelectedLoad(null, 'create')
  }

  const handleMarkDone = (item: IntakeItem) => {
    setProModalItem(item)
  }

  const handleProConfirm = async (proNumber: string) => {
    if (!proModalItem) return
    await updateItem(
      proModalItem.id,
      { status: 'DONE', proNumber },
      { actorName: actorEmail, proNumber },
    )
    setProModalItem(null)
  }

  const handleAssigneeChange = async (id: string, email: string) => {
    const displayName = assigneeLabel(email)
    await updateItem(
      id,
      { assignedTo: email },
      { actorName: actorEmail, reassignedTo: displayName },
    )
  }

  const loadIndex = useMemo(() =>
    loads.map((l) => ({ id: l.id, aljexId: l.aljexId })),
    [loads],
  )

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#f8fafc]">
      {/* Page header */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-slate-200 bg-white shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Load Intake</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Incoming loads from Ivan Cartage and BCAT Logistics
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

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Section 1: Active Queue ───────────────────────────────────── */}
        <section className="px-8 pt-6 pb-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              Active Queue
            </h2>
            {loading && items.length === 0 && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Loading…
              </span>
            )}
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 mb-4 border-b border-slate-200">
            {TABS.map(({ key, label }) => {
              const count = key === 'IVAN_CARTAGE' ? ivanCount : bcatCount
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
                    activeTab === key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-slate-300',
                  )}
                >
                  {label}
                  {count > 0 && (
                    <span className={cn(
                      'text-[10px] font-bold rounded-full px-1.5 min-w-[18px] h-[18px] flex items-center justify-center',
                      activeTab === key ? 'bg-primary text-white' : 'bg-slate-200 text-slate-600',
                    )}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Cards grid */}
          {activeItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2 bg-white rounded-lg border border-slate-200">
              <Inbox className="size-8 opacity-20" />
              <p className="text-sm">No active items — all clear</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {activeItems.map((item) => (
                <QueueCard
                  key={item.id}
                  item={item}
                  onBuildLoad={handleBuildLoad}
                  onMarkDone={handleMarkDone}
                  onStatusChange={handleStatusChange}
                  onAssigneeChange={handleAssigneeChange}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 2: History Table ──────────────────────────────────── */}
        <section className="px-8 pt-2 pb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              All Intake History
              <span className="ml-2 text-[11px] font-normal text-muted-foreground normal-case tracking-normal">
                {historyItems.length} item{historyItems.length !== 1 ? 's' : ''}
              </span>
            </h2>

            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={historySource}
                  onChange={(e) => setHistorySource(e.target.value)}
                  className="h-8 pl-2.5 pr-7 text-xs rounded border border-slate-200 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="ALL">All Sources</option>
                  <option value="IVAN_CARTAGE">Ivan Cartage</option>
                  <option value="BCAT_LOGISTICS">BCAT Logistics</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              </div>
              <div className="relative">
                <select
                  value={historyStatus}
                  onChange={(e) => setHistoryStatus(e.target.value)}
                  className="h-8 pl-2.5 pr-7 text-xs rounded border border-slate-200 bg-white appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="NEW">New</option>
                  <option value="IN_PROGRESS">In Progress</option>
                  <option value="BUILT">Built</option>
                  <option value="DONE">Done</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm">
            {historyItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                <Inbox className="size-8 opacity-20" />
                <p className="text-sm">No records match the current filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      {['Received', 'Source', 'Subject', 'Assignee', 'Status', 'Pro# / Load', 'Link'].map((col) => (
                        <th key={col} className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {historyItems.map((item) => (
                      <HistoryRow
                        key={item.id}
                        item={item}
                        loads={loadIndex}
                        onAssigneeChange={handleAssigneeChange}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Pro# modal */}
      {proModalItem && (
        <ProNumberModal
          item={proModalItem}
          onConfirm={handleProConfirm}
          onClose={() => setProModalItem(null)}
        />
      )}

      {/* LoadDrawer — must be present for "Build Load" to work */}
      <LoadDrawer />
    </div>
  )
}
