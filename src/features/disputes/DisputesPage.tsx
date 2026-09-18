import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import {
  Plus, Search, Trash2, Pencil, ExternalLink, FileWarning,
  ChevronLeft, ChevronRight, RefreshCw, Link2,
} from 'lucide-react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils/errorMessage'
import { getDisputeEvidenceUrl } from '@/lib/apiClient'
import { formatPayPeriod } from '@/lib/payPeriod'
import type { AmazonDispute, DisputeEvidence, DisputeSource, DisputeStatus } from '@/types/dispute'
import {
  thBase, tdBase, iconBtnStyle,
  inputStyle, btnGhost, btnPrimary, btnDanger, Field, FormSection, Modal,
  Pill,
} from '@/features/maintenance/maintenanceUi'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtMoney(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const STATUS_ORDER: DisputeStatus[] = ['PENDING', 'POSTED', 'PAID', 'REJECTED']
const STATUS_LABEL: Record<DisputeStatus, string> = {
  PENDING: 'Pending', POSTED: 'Filed with Amazon', PAID: 'Paid', REJECTED: 'Rejected',
}
const STATUS_STYLE: Record<DisputeStatus, { bg: string; fg: string }> = {
  PENDING:  { bg: 'var(--ds-amber-bg)', fg: 'var(--ds-amber)' },
  POSTED:   { bg: 'var(--ds-blue-bg)',  fg: 'var(--ds-blue-dark)' },
  PAID:     { bg: 'var(--ds-green-bg)', fg: 'var(--ds-green)' },
  REJECTED: { bg: 'var(--ds-red-bg)',   fg: 'var(--ds-red)' },
}

const SOURCE_LABEL: Record<DisputeSource, string> = {
  GOOGLE_FORM: 'Google Form',
  MANUAL: 'Manual',
  DRIVER_PORTAL: 'Driver Portal',
}
const SOURCE_TONE: Record<DisputeSource, 'blue' | 'neutral' | 'violet'> = {
  GOOGLE_FORM: 'neutral',
  MANUAL: 'blue',
  DRIVER_PORTAL: 'violet',
}

const PAGE_SIZE = 50
const POLL_MS = 30_000

function statusOf(d: AmazonDispute): DisputeStatus {
  return (d.status as DisputeStatus) ?? 'PENDING'
}

function sourceOf(d: AmazonDispute): DisputeSource {
  return (d.source as DisputeSource) ?? 'MANUAL'
}

// Pill-styled native select — the whole status chip is a dropdown you can change inline.
function StatusSelect({
  status, onChange, disabled,
}: {
  status: DisputeStatus
  onChange: (next: DisputeStatus) => void
  disabled?: boolean
}) {
  const c = STATUS_STYLE[status]
  return (
    <select
      value={status}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as DisputeStatus)}
      title={disabled ? 'Saving…' : 'Change status'}
      style={{
        appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
        padding: '3px 10px', borderRadius: 999, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', lineHeight: 1.4,
        background: c.bg, color: c.fg, textAlign: 'center', opacity: disabled ? 0.6 : 1,
      }}
    >
      {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  )
}

// ── Evidence list (private S3 links fetched on demand) ─────────────────────────

function EvidenceList({ evidence }: { evidence: DisputeEvidence[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  const open = async (item: DisputeEvidence) => {
    const cached = urls[item.s3Key]
    if (cached) { window.open(cached, '_blank', 'noopener,noreferrer'); return }
    setLoading((l) => ({ ...l, [item.s3Key]: true }))
    try {
      const url = await getDisputeEvidenceUrl(item.s3Key)
      setUrls((u) => ({ ...u, [item.s3Key]: url }))
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(`Couldn't open ${item.fileName}: ${errorMessage(err)}`)
    } finally {
      setLoading((l) => ({ ...l, [item.s3Key]: false }))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {evidence.map((item, i) => (
        <button
          key={`${item.s3Key}-${i}`}
          type="button"
          onClick={() => void open(item)}
          disabled={loading[item.s3Key]}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
            padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ds-border)',
            background: 'var(--ds-surface)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Pill tone={item.kind === 'CONFIRMATION' ? 'ok' : 'blue'}>{item.kind}</Pill>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: 'var(--ds-t1)' }}>
            {item.fileName}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>
            {(item.size / 1024 / 1024).toFixed(2)} MB
          </span>
          {loading[item.s3Key]
            ? <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--ds-t3)' }} />
            : <ExternalLink size={14} style={{ color: 'var(--ds-blue)' }} />}
        </button>
      ))}
    </div>
  )
}

// ── Dispute modal (create + edit) ────────────────────────────────────────────────

type DisputeData = Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>

function DisputeModal({ dispute, onSave, onDelete, onClose }: {
  dispute: AmazonDispute | null
  onSave: (data: DisputeData) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}) {
  const isEdit = dispute !== null
  const [form, setForm] = useState({
    driverName:      dispute?.driverName ?? '',
    tripNumber:      dispute?.tripNumber ?? '',
    shipmentDate:    dispute?.shipmentDate ?? '',
    payPeriod:       dispute?.payPeriod ?? '',
    amountPaid:      dispute?.amountPaid != null ? String(dispute.amountPaid) : '',
    amountRequested: dispute?.amountRequested != null ? String(dispute.amountRequested) : '',
    description:     dispute?.description ?? '',
    photoUrl:        dispute?.photoUrl ?? '',
    status:          statusOf(dispute ?? ({} as AmazonDispute)),
    resolvedAmount:  dispute?.resolvedAmount != null ? String(dispute.resolvedAmount) : '',
    notes:           dispute?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }))
  const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : undefined }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.driverName.trim() || saving) return
    setSaving(true)
    try {
      await onSave({
        driverName:      form.driverName.trim(),
        tripNumber:      form.tripNumber.trim() || undefined,
        shipmentDate:    form.shipmentDate.trim() || undefined,
        payPeriod:       form.payPeriod.trim() || undefined,
        amountPaid:      num(form.amountPaid),
        amountRequested: num(form.amountRequested),
        description:     form.description.trim() || undefined,
        photoUrl:        form.photoUrl.trim() || undefined,
        status:          form.status,
        resolvedAmount:  form.status === 'PAID' ? num(form.resolvedAmount) : undefined,
        notes:           form.notes.trim() || undefined,
        ...(isEdit ? {} : { source: 'MANUAL' as const, submittedAt: new Date().toISOString() }),
      })
      onClose()
    } catch (err) {
      toast.error(`Couldn't save dispute: ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    try {
      await onDelete()
      onClose()
    } catch (err) {
      toast.error(`Couldn't delete dispute: ${errorMessage(err)}`)
    } finally {
      setDeleting(false)
    }
  }

  const source = sourceOf(dispute ?? ({} as AmazonDispute))

  return (
    <Modal
      title={isEdit ? 'Edit Dispute' : 'New Dispute'}
      onClose={onClose}
      footer={
        <>
          {isEdit && onDelete ? (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting || saving}
              style={{ ...btnDanger, opacity: deleting || saving ? 0.6 : 1, cursor: deleting || saving ? 'not-allowed' : 'pointer' }}
            >
              <Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : <span />}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onClose} disabled={saving || deleting} style={btnGhost}>Cancel</button>
            <button type="submit" form="dispute-form" disabled={saving || deleting} style={{ ...btnPrimary, opacity: saving || deleting ? 0.6 : 1, cursor: saving || deleting ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : <><Plus size={14} /> Create Dispute</>)}
            </button>
          </div>
        </>
      }
    >
      <form id="dispute-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <FormSection title="Trip">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Driver Name" required>
              <input style={inputStyle} value={form.driverName} onChange={(e) => set('driverName', e.target.value)} placeholder="Driver name" required />
            </Field>
            <Field label="Trip Number">
              <input style={inputStyle} value={form.tripNumber} onChange={(e) => set('tripNumber', e.target.value)} placeholder="112MP1BHQ" />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Shipment Date">
              <input type="date" style={inputStyle} value={form.shipmentDate} onChange={(e) => set('shipmentDate', e.target.value)} />
            </Field>
            <Field label="7-Day Period">
              <input style={inputStyle} value={form.payPeriod} onChange={(e) => set('payPeriod', e.target.value)} placeholder="4/19 - 4/25 or Sunday start" />
            </Field>
          </div>
          <Field label="Description">
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60, lineHeight: 1.5 }} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What happened" />
          </Field>
          <Field label="Legacy Proof Link (Google Drive)">
            <input style={inputStyle} value={form.photoUrl} onChange={(e) => set('photoUrl', e.target.value)} placeholder="https://drive.google.com/…" />
          </Field>
        </FormSection>

        {isEdit && dispute.evidence && dispute.evidence.length > 0 && (
          <FormSection title={`Uploaded Evidence (${dispute.evidence.length})`}>
            <EvidenceList evidence={dispute.evidence} />
          </FormSection>
        )}

        <FormSection title="Amounts & Status">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Paid by Amazon ($)">
              <input type="number" step="0.01" style={inputStyle} value={form.amountPaid} onChange={(e) => set('amountPaid', e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Amount Requested ($)">
              <input type="number" step="0.01" style={inputStyle} value={form.amountRequested} onChange={(e) => set('amountRequested', e.target.value)} placeholder="0.00" />
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={(e) => set('status', e.target.value as DisputeStatus)}>
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </Field>
            {form.status === 'PAID' && (
              <Field label="Amount Recovered ($)">
                <input type="number" step="0.01" style={inputStyle} value={form.resolvedAmount} onChange={(e) => set('resolvedAmount', e.target.value)} placeholder="0.00" />
              </Field>
            )}
          </div>
          <Field label="Internal Notes">
            <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 52, lineHeight: 1.5 }} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes for the team" />
          </Field>
        </FormSection>

        {isEdit && (
          <FormSection title="Submission Metadata">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
              <Field label="Source">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38 }}>
                  <Pill tone={SOURCE_TONE[source]}>{SOURCE_LABEL[source]}</Pill>
                </div>
              </Field>
              <Field label="Submitted">
                <div style={{ display: 'flex', alignItems: 'center', height: 38, fontSize: 13, color: 'var(--ds-t2)' }}>
                  {dispute.submittedAt ? new Date(dispute.submittedAt).toLocaleString() : '—'}
                </div>
              </Field>
            </div>
            {dispute.externalId && (
              <Field label="External ID">
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)' }}>{dispute.externalId}</div>
              </Field>
            )}
          </FormSection>
        )}
      </form>
    </Modal>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

type StatusFilter = 'ALL' | DisputeStatus

export function DisputesPage() {
  const amazonDisputes      = useAppStore((s) => s.amazonDisputes)
  const addAmazonDispute    = useAppStore((s) => s.addAmazonDispute)
  const updateAmazonDispute = useAppStore((s) => s.updateAmazonDispute)
  const deleteAmazonDispute = useAppStore((s) => s.deleteAmazonDispute)
  const refreshAmazonDisputes = useAppStore((s) => s.refreshAmazonDisputes)

  const [search, setSearch]       = useState('')
  const [statusF, setStatusF]     = useState<StatusFilter>('ALL')
  const [newOpen, setNewOpen]     = useState(false)
  const [editItem, setEditItem]   = useState<AmazonDispute | null>(null)
  const [page, setPage]           = useState(1)
  const [savingStatusId, setSavingStatusId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Poll for portal writes — public DynamoDB mutations do not trigger GraphQL subscriptions.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshAmazonDisputes()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [refreshAmazonDisputes])

  const doRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshAmazonDisputes()
    } finally {
      setRefreshing(false)
    }
  }

  const filtered = useMemo(() => {
    return amazonDisputes
      .filter((d) => statusF === 'ALL' || statusOf(d) === statusF)
      .filter((d) => {
        if (!search) return true
        const q = search.toLowerCase()
        return (
          d.driverName.toLowerCase().includes(q) ||
          (d.tripNumber ?? '').toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          (d.payPeriod ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt))
  }, [amazonDisputes, statusF, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const paged = useMemo(() => {
    return filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  }, [filtered, safePage])

  // KPIs (over ALL disputes, not the current filter)
  const pendingCount   = amazonDisputes.filter((d) => statusOf(d) === 'PENDING').length
  const openRequested  = amazonDisputes
    .filter((d) => statusOf(d) === 'PENDING' || statusOf(d) === 'POSTED')
    .reduce((s, d) => s + (d.amountRequested ?? 0), 0)
  const recovered      = amazonDisputes
    .filter((d) => statusOf(d) === 'PAID')
    .reduce((s, d) => s + (d.resolvedAmount ?? d.amountRequested ?? 0), 0)

  const KPIS = [
    { label: 'Total Disputes', value: String(amazonDisputes.length), color: '#a78bfa' },
    { label: 'Pending',        value: String(pendingCount),          color: '#f59e0b' },
    { label: 'Open Requested', value: fmtMoney(openRequested),       color: '#1ea8f3' },
    { label: 'Recovered',      value: fmtMoney(recovered),           color: '#22c55e' },
  ]

  async function changeStatus(d: AmazonDispute, next: DisputeStatus) {
    if (next === statusOf(d) || savingStatusId) return
    setSavingStatusId(d.id)
    try {
      await updateAmazonDispute(d.id, { status: next })
      toast.success(`Marked ${STATUS_LABEL[next]}`)
    } catch (err) {
      toast.error(`Couldn't update status: ${errorMessage(err)}`)
    } finally {
      setSavingStatusId(null)
    }
  }

  const FILTERS: StatusFilter[] = ['ALL', ...STATUS_ORDER]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Page header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px 12px' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Amazon Disputes</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
              Driver-submitted pay disputes · arrive from the{' '}
              <a href="/amazon-disputes" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ds-blue)' }}>driver portal</a>
              {' '}or the legacy Google Form
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => void doRefresh()}
              disabled={refreshing}
              title="Refresh list"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)',
                borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)',
                cursor: refreshing ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
            <a
              href="/amazon-disputes"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px',
                background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)',
                borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)',
                textDecoration: 'none', fontFamily: 'inherit',
              }}
            >
              <Link2 size={14} /> Driver Portal
            </a>
            <button
              onClick={() => setNewOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', background: 'var(--ds-blue)', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <Plus size={14} /> New Dispute
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: '0 32px 12px' }}>
          {KPIS.map((k) => (
            <div key={k.label} style={{ position: 'relative', overflow: 'hidden', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: k.color }} />
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ds-t3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginLeft: 4 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color, letterSpacing: '-0.02em', marginTop: 4, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '24px 32px', maxWidth: 1360 }}>
        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search driver, trip, description…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
              style={{ width: 280, height: 34, paddingLeft: 30, paddingRight: 10, boxSizing: 'border-box', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 7, fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {FILTERS.map((f) => {
              const active = statusF === f
              return (
                <button
                  key={f}
                  onClick={() => { setStatusF(f); setPage(1) }}
                  style={{ height: 34, padding: '0 12px', borderRadius: 7, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`, background: active ? 'var(--ds-blue)' : 'var(--ds-surface)', color: active ? '#fff' : 'var(--ds-t2)', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {f === 'ALL' ? 'All' : STATUS_LABEL[f]}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <FileWarning className="size-8 opacity-20" />
              <p className="text-sm">No disputes found.</p>
              <p className="text-xs text-slate-400">Disputes arrive automatically when a driver submits the portal or Google Form, or add one manually.</p>
            </div>
          ) : (
            <>
              <div style={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto' }}>
                <table style={{ width: '100%', minWidth: 1240, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                  <colgroup>
                    <col style={{ width: 96 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 112 }} />
                    <col style={{ width: 130 }} />
                    <col />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 108 }} />
                    <col style={{ width: 108 }} />
                    <col style={{ width: 64 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 72 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {['Submitted', 'Source', 'Trip #', 'Ship Date', '7-Day Period', 'Driver', 'Description', 'Paid', 'Requested', 'Proof', 'Status', ''].map((h, i) => (
                        <th key={i} style={{ ...thBase, textAlign: i === 7 || i === 8 ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((d) => {
                      const st = statusOf(d)
                      const src = sourceOf(d)
                      const hasEvidence = (d.evidence?.length ?? 0) > 0
                      return (
                        <tr key={d.id} className="maint-row">
                          <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>{(d.submittedAt ?? d.createdAt).slice(0, 10)}</td>
                          <td style={tdBase}>
                            <Pill tone={SOURCE_TONE[src]}>{SOURCE_LABEL[src]}</Pill>
                          </td>
                          <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.tripNumber || '—'}</td>
                          <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>{d.shipmentDate || '—'}</td>
                          <td style={{ ...tdBase, fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{d.payPeriod ? formatPayPeriod(d.payPeriod) : '—'}</td>
                          <td style={{ ...tdBase, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.driverName}</td>
                          <td style={{ ...tdBase, fontSize: 12.5, color: 'var(--ds-t3)', lineHeight: 1.45 }}>
                            {d.description ? d.description : <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
                          </td>
                          <td style={{ ...tdBase, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ds-t2)', whiteSpace: 'nowrap' }}>{fmtMoney(d.amountPaid)}</td>
                          <td style={{ ...tdBase, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap' }}>{fmtMoney(d.amountRequested)}</td>
                          <td style={tdBase}>
                            {hasEvidence
                              ? <span style={{ fontSize: 11, color: 'var(--ds-blue)', fontWeight: 600 }}>{d.evidence!.length} file{d.evidence!.length === 1 ? '' : 's'}</span>
                              : d.photoUrl
                                ? <a href={d.photoUrl} target="_blank" rel="noreferrer" aria-label="View proof" style={{ color: 'var(--ds-blue)', display: 'inline-flex' }}><ExternalLink size={15} /></a>
                                : <span style={{ color: 'var(--ds-muted-soft)' }}>—</span>}
                          </td>
                          <td style={tdBase}>
                            <StatusSelect status={st} onChange={(next) => void changeStatus(d, next)} disabled={savingStatusId === d.id} />
                          </td>
                          <td style={{ ...tdBase, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button aria-label="Edit dispute" disabled={deletingId === d.id} onClick={() => setEditItem(d)} style={{ ...iconBtnStyle, color: 'var(--ds-t3)', opacity: deletingId === d.id ? 0.5 : 1 }}><Pencil size={13} /></button>
                            <button
                              aria-label="Delete dispute"
                              disabled={deletingId === d.id}
                              onClick={() => {
                                setDeletingId(d.id)
                                deleteAmazonDispute(d.id)
                                  .then(() => toast.success('Dispute deleted'))
                                  .catch((err) => toast.error(`Couldn't delete: ${errorMessage(err)}`))
                                  .finally(() => setDeletingId(null))
                              }}
                              style={{ ...iconBtnStyle, color: 'var(--ds-red)', opacity: deletingId === d.id ? 0.5 : 1, cursor: deletingId === d.id ? 'wait' : 'pointer' }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                  <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                    {filtered.length} dispute{filtered.length === 1 ? '' : 's'} · Page {safePage} of {pageCount}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px',
                        borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                        color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit',
                        cursor: safePage <= 1 ? 'not-allowed' : 'pointer', opacity: safePage <= 1 ? 0.5 : 1,
                      }}
                    >
                      <ChevronLeft size={14} /> Prev
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                      disabled={safePage >= pageCount}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4, height: 30, padding: '0 10px',
                        borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                        color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit',
                        cursor: safePage >= pageCount ? 'not-allowed' : 'pointer', opacity: safePage >= pageCount ? 0.5 : 1,
                      }}
                    >
                      Next <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {newOpen && (
        <DisputeModal
          dispute={null}
          onSave={async (data) => { await addAmazonDispute(data) }}
          onClose={() => setNewOpen(false)}
        />
      )}
      {editItem && (
        <DisputeModal
          dispute={editItem}
          onSave={async (data) => { await updateAmazonDispute(editItem.id, data) }}
          onDelete={async () => { await deleteAmazonDispute(editItem.id) }}
          onClose={() => setEditItem(null)}
        />
      )}
    </div>
  )
}
