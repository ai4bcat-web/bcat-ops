/**
 * `/tms/vendors` — the vendor AP queue, on the MVMNT list anatomy.
 *
 * One row per bill a vendor sent us, from the mailbox or from a maintenance invoice,
 * with what is still owed opening first. Nothing about the data or the write path
 * changed with the re-skin: the same `useVendorPayables` hook, the same confirmations,
 * the same admin-only delete of a queue row (which never touches the source invoice).
 */
import { useMemo, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2, AlertCircle, Trash2, Check, RotateCcw,
  Mail, Wrench, FileText, ExternalLink, CreditCard, Pencil,
} from 'lucide-react'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsIconButton, TmsInput, TmsListPage,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import { findVendorApDuplicates } from '@/lib/vendorApDuplicates'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/store/useAppStore'
import { toLocalDateString } from '@/lib/payPeriod'
import { toast } from 'sonner'
import { formatCents } from '@/features/maintenance/maintenanceUi'
import { VENDOR_PAYMENT_METHODS, type VendorPayable, type VendorPayableDetails, type VendorPayment, type VendorApAttachment } from '@/types/vendorAp'

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<VendorPayable['status'], string> = {
  NEED_TO_PAY: 'Need to pay',
  DONE: 'Done',
}

const SOURCE_LABEL: Record<VendorPayable['source'], string> = {
  MAINTENANCE: 'Maintenance',
  EMAIL: 'Email',
}

const TABS = [
  { key: 'ALL' as const, label: 'All' },
  { key: 'NEED_TO_PAY' as const, label: 'Need to pay' },
  { key: 'DONE' as const, label: 'Done' },
] as const

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
  return toLocalDateString(new Date())
}

function formatReceivedAt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativeReceived(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatAmount(cents?: number | null): string {
  if (cents == null) return '—'
  return formatCents(cents)
}

function parseDollars(value: string): number | null | 'invalid' {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const cleaned = trimmed.replace(/[$,]/g, '')
  const n = Number(cleaned)
  if (Number.isFinite(n) === false || n < 0) return 'invalid'
  return Math.round(n * 100)
}

function matchesSearch(item: VendorPayable, query: string): boolean {
  if (query.trim().length === 0) return true
  const q = query.toLowerCase().trim()
  return (
    (item.vendor ?? '').toLowerCase().includes(q) ||
    (item.invoiceNumber ?? '').toLowerCase().includes(q) ||
    (item.subject ?? '').toLowerCase().includes(q) ||
    (item.fromEmail ?? '').toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q)
  )
}

// ── Status / source badges ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: VendorPayable['status'] }) {
  return (
    <TmsBadge tone={status === 'DONE' ? 'green' : 'orange'}>{STATUS_LABEL[status]}</TmsBadge>
  )
}

/** The due date, red once it has passed on an unpaid row, with days to go while it has not. */
function DueCell({ item, today }: { item: VendorPayable; today: string }) {
  if (!item.dueDate) return <span className="tms-muted">—</span>
  const days = Math.round((Date.parse(`${item.dueDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  const open = item.status !== 'DONE'
  const overdue = open && days < 0
  return (
    <div>
      <div style={{ fontWeight: overdue ? 600 : undefined, color: overdue ? 'var(--tms-badge-red)' : undefined }}>{item.dueDate}</div>
      {open ? (
        <div style={{ fontSize: 11, color: overdue ? 'var(--tms-badge-red)' : 'var(--tms-muted)' }}>
          {overdue ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'due today' : `in ${days} day${days === 1 ? '' : 's'}`}
        </div>
      ) : null}
    </div>
  )
}

function SourceBadge({ source }: { source: VendorPayable['source'] }) {
  const isMaintenance = source === 'MAINTENANCE'
  return (
    <TmsBadge tone={isMaintenance ? 'blue' : 'gray'}>
      {isMaintenance ? <Wrench size={11} /> : <Mail size={11} />}
      {SOURCE_LABEL[source]}
    </TmsBadge>
  )
}

// ── Linked maintenance invoice read-only details ─────────────────────────────

function LinkedInvoiceDetails({ invoiceId, canSeeInvoices }: { invoiceId: string; canSeeInvoices: boolean }) {
  const invoice = useAppStore((s) => s.maintenanceInvoices.find((i) => i.id === invoiceId))
  const equipment = useAppStore((s) => s.equipment.find((e) => e.id === invoice?.equipmentId))

  if (!invoice) {
    return <p className="tms-muted" style={{ fontSize: 13 }}>Linked maintenance invoice not found.</p>
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{invoice.vendor || 'Unknown vendor'}</span>
        {canSeeInvoices && (
          <Link to="/invoices" className="tms-btn tms-btn-ghost tms-btn-sm">
            <ExternalLink size={12} />
            Open in Invoices
          </Link>
        )}
      </div>
      <div className="tms-grid tms-grid-2">
        <Field label="Equipment" value={equipment ? `#${equipment.unitNumber}${equipment.nickname ? ` · ${equipment.nickname}` : ''}` : invoice.equipmentId} />
        <Field label="Invoice date" value={invoice.date || '—'} />
        <Field label="Amount" value={formatCents(invoice.amount)} />
        <Field label="Invoice #" value={invoice.invoiceNumber || '—'} />
      </div>
      {invoice.description && (
        <div className="tms-muted" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {invoice.description}
        </div>
      )}
      {(invoice.paymentMethod || invoice.paymentDate) && (
        <div className="tms-muted" style={{ fontSize: 12 }}>
          Recorded payment: {invoice.paymentMethod || '—'}
          {invoice.paymentDate && <span style={{ marginLeft: 6 }}>{invoice.paymentDate}</span>}
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tms-field-label">{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  )
}

// ── Attachment list ──────────────────────────────────────────────────────────

function AttachmentList({
  attachments,
  getAttachmentUrl,
}: {
  attachments: VendorApAttachment[]
  getAttachmentUrl: (key: string) => Promise<string>
}) {
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  // Open the tab synchronously inside the click (popup blockers reject a window.open
  // that follows an await), then sign a fresh URL each time so an expired cached
  // link never lands the user on an S3 403.
  const open = async (att: VendorApAttachment) => {
    // No `noopener` in the feature string: it makes window.open return null. Sever
    // the opener by hand so the signed S3 page still can't reach this window.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setLoadingKey(att.key)
    try {
      const url = await getAttachmentUrl(att.key)
      if (tab) tab.location.href = url
      else window.location.assign(url)
    } catch (err) {
      tab?.close()
      toast.error(err instanceof Error ? err.message : 'Failed to load attachment')
    } finally {
      setLoadingKey(null)
    }
  }

  if (attachments.length === 0) return null

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="tms-field-label">Attachments</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {attachments.map((att) => (
          <TmsButton key={att.key} size="sm" onClick={() => open(att)} disabled={loadingKey === att.key}>
            {loadingKey === att.key ? <Loader2 size={13} /> : <FileText size={13} />}
            <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
            <span className="tms-muted">({(att.size / 1024).toFixed(1)} KB)</span>
          </TmsButton>
        ))}
      </div>
    </div>
  )
}

// ── Details dialog ───────────────────────────────────────────────────────────

function DetailsDialog({
  item,
  loading,
  error,
  pendingIds,
  canDelete,
  canSeeInvoices,
  onClose,
  onSave,
  onPay,
  onReopen,
  onDelete,
  getAttachmentUrl,
}: {
  item: VendorPayable
  loading: boolean
  error: string | null
  pendingIds: Set<string>
  canDelete: boolean
  canSeeInvoices: boolean
  onClose: () => void
  onSave: (patch: VendorPayableDetails) => Promise<void>
  onPay: () => void
  onReopen: () => void
  onDelete: () => void
  getAttachmentUrl: (key: string) => Promise<string>
}) {
  const isEmail = item.source === 'EMAIL'
  const isPending = pendingIds.has(item.id)
  const fullLoaded = loading === false && error === null

  const [vendor, setVendor] = useState(item.vendor ?? '')
  const [invoiceNumber, setInvoiceNumber] = useState(item.invoiceNumber ?? '')
  const [amount, setAmount] = useState(item.amount != null ? (item.amount / 100).toFixed(2) : '')
  const [invoiceDate, setInvoiceDate] = useState(item.invoiceDate ?? '')
  const [dueDate, setDueDate] = useState(item.dueDate ?? '')
  const [vendorEmail, setVendorEmail] = useState(item.vendorEmail ?? '')
  const [description, setDescription] = useState(item.description ?? '')
  const [saving, setSaving] = useState(false)

  const locked = fullLoaded === false || isPending || saving

  const submitDetails = async (e: React.FormEvent) => {
    e.preventDefault()
    const cents = parseDollars(amount)
    if (cents === 'invalid') {
      toast.error('Amount must be a valid dollar amount')
      return
    }
    setSaving(true)
    try {
      await onSave({
        vendor: vendor.trim() || null,
        invoiceNumber: invoiceNumber.trim() || null,
        amount: cents,
        invoiceDate: invoiceDate || null,
        dueDate: dueDate || null,
        vendorEmail: vendorEmail.trim() || null,
        description: description.trim() || null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      className="tms-dialog-wide"
      title={item.subject || '(no subject)'}
      description={`${item.source} · ${formatReceivedAt(item.receivedAt)} · from ${item.fromEmail || 'unknown sender'}`}
      footer={
        <>
          {isEmail && (
            <TmsButton type="submit" form="details-form" variant="primary" disabled={locked} style={{ marginRight: 'auto' }}>
              {saving && <Loader2 size={13} />}
              Save details
            </TmsButton>
          )}
          {item.status === 'NEED_TO_PAY' ? (
            <TmsButton variant="primary" onClick={onPay} disabled={isPending}>
              <CreditCard size={14} />
              Mark done
            </TmsButton>
          ) : (
            <>
              <TmsButton variant="primary" onClick={onPay} disabled={isPending}>
                <Pencil size={14} />
                Edit payment
              </TmsButton>
              <TmsButton onClick={onReopen} disabled={isPending}>
                <RotateCcw size={14} />
                Reopen
              </TmsButton>
            </>
          )}
          {canDelete && (
            <TmsButton variant="destructive" onClick={onDelete} disabled={isPending}>
              <Trash2 size={14} />
              Delete
            </TmsButton>
          )}
          <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 20 }}>
        {item.source === 'MAINTENANCE' && item.sourceInvoiceId && (
          <Section title="Source invoice">
            <LinkedInvoiceDetails invoiceId={item.sourceInvoiceId} canSeeInvoices={canSeeInvoices} />
          </Section>
        )}

        {isEmail ? (
          <Section title="Invoice details">
            <form id="details-form" onSubmit={submitDetails} style={{ display: 'grid', gap: 14 }}>
              <div className="tms-grid tms-grid-2">
                <TmsField label="Vendor" htmlFor="ap-vendor">
                  <TmsInput id="ap-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={locked} />
                </TmsField>
                <TmsField label="Invoice #" htmlFor="ap-invoice">
                  <TmsInput id="ap-invoice" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} disabled={locked} />
                </TmsField>
                <TmsField label="Amount ($)" htmlFor="ap-amount">
                  <TmsInput
                    id="ap-amount"
                    inputMode="decimal"
                    placeholder="Leave blank if unknown"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={locked}
                  />
                </TmsField>
                <TmsField label="Invoice date" htmlFor="ap-date">
                  <TmsInput id="ap-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} disabled={locked} />
                </TmsField>
                <TmsField label="Due date" htmlFor="ap-due">
                  <TmsInput id="ap-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={locked} />
                </TmsField>
                <TmsField label="Vendor email (payment confirmations)" htmlFor="ap-vendor-email">
                  <TmsInput
                    id="ap-vendor-email"
                    type="email"
                    placeholder={item.fromEmail ?? 'ap@vendor.com'}
                    value={vendorEmail}
                    onChange={(e) => setVendorEmail(e.target.value)}
                    disabled={locked}
                  />
                </TmsField>
              </div>
              <TmsField label="Description" htmlFor="ap-description">
                <TmsInput id="ap-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={locked} />
              </TmsField>
            </form>
          </Section>
        ) : (
          <Section title="Invoice details">
            <div className="tms-grid tms-grid-2">
              <Field label="Vendor" value={item.vendor || '—'} />
              <Field label="Invoice #" value={item.invoiceNumber || '—'} />
              <Field label="Amount" value={formatAmount(item.amount)} />
              <Field label="Invoice date" value={item.invoiceDate || '—'} />
              <Field label="Due date" value={item.dueDate || '—'} />
              <Field label="Vendor email" value={item.vendorEmail || item.fromEmail || '—'} />
              {item.confirmationSentAt ? <Field label="Confirmation" value={`Emailed to ${item.confirmationSentTo} · ${formatReceivedAt(item.confirmationSentAt)}`} /> : null}
            </div>
            {item.description && <div className="tms-muted" style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>{item.description}</div>}
          </Section>
        )}

        <Section title="Original message">
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="tms-muted" style={{ fontSize: 12 }}>
              From: {item.fromEmail || '—'} · Received: {formatReceivedAt(item.receivedAt)}
            </div>
            {loading ? (
              <div className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, fontSize: 13 }}>
                <Loader2 size={16} />
                Loading full message…
              </div>
            ) : error ? (
              <div style={{ padding: 12, borderRadius: 'var(--tms-radius)', background: 'rgba(237,90,118,0.14)', border: '1px solid var(--tms-badge-red)', color: 'var(--tms-badge-red)', fontSize: 13 }}>
                {error}
              </div>
            ) : item.emailBody ? (
              <pre
                style={{
                  fontFamily: 'inherit',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: 'var(--tms-muted)',
                  background: 'var(--tms-card)',
                  padding: 12,
                  borderRadius: 'var(--tms-radius)',
                  border: '1px solid var(--tms-border)',
                  margin: 0,
                  maxHeight: 240,
                  overflowY: 'auto',
                }}
              >
                {item.emailBody}
              </pre>
            ) : (
              <p className="tms-muted" style={{ fontSize: 13 }}>No message body available.</p>
            )}
          </div>
        </Section>

        <AttachmentList attachments={item.attachments} getAttachmentUrl={getAttachmentUrl} />
      </div>
    </TmsDialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="tms-field-label">{title}</div>
      {children}
    </div>
  )
}

// ── Payment dialog ───────────────────────────────────────────────────────────

function PaymentDialog({
  item,
  open,
  pendingIds,
  onClose,
  onSubmit,
}: {
  item: VendorPayable | null
  open: boolean
  pendingIds: Set<string>
  onClose: () => void
  onSubmit: (id: string, payment: VendorPayment) => Promise<void>
}) {
  const [method, setMethod] = useState(item?.paymentMethod ?? '')
  const [date, setDate] = useState(item?.paymentDate ?? todayIso())
  const [reference, setReference] = useState(item?.paymentReference ?? '')
  const [notify, setNotify] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  if (!item) return null

  const isPending = pendingIds.has(item.id)
  const isCorrection = item.status === 'DONE'
  const vendorEmail = (item.vendorEmail || item.fromEmail || '').trim()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedMethod = method.trim()
    if (trimmedMethod.length === 0) {
      toast.error('Pick how it was paid')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(item.id, {
        paymentMethod: trimmedMethod,
        // A new payment is stamped with today by the server; a correction keeps its date.
        ...(isCorrection ? { paymentDate: date } : {}),
        paymentReference: reference.trim() || null,
        notifyVendor: notify && vendorEmail.length > 0 && isCorrection === false,
      })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose() }}
      title={isCorrection ? 'Edit payment' : 'Record payment'}
      description={`${item.vendor || 'Unknown vendor'} · ${item.invoiceNumber || 'No invoice #'} · ${formatAmount(item.amount)}`}
      footer={
        <>
          <TmsButton onClick={onClose} disabled={submitting}>Cancel</TmsButton>
          <TmsButton type="submit" form="payment-form" variant="primary" disabled={isPending || submitting}>
            {submitting && <Loader2 size={13} />}
            {isCorrection ? 'Save changes' : 'Save payment'}
          </TmsButton>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <div>
          <div className="tms-field-label">Payment method</div>
          <div className="tms-grid tms-grid-3" style={{ marginTop: 4 }}>
            {VENDOR_PAYMENT_METHODS.map((m) => (
              <TmsButton
                key={m}
                variant={method === m ? 'primary' : 'secondary'}
                onClick={() => setMethod(m)}
                disabled={isPending || submitting}
              >
                {m}
              </TmsButton>
            ))}
          </div>
        </div>
        {isCorrection ? (
          <TmsField label="Payment date" htmlFor="pay-date">
            <TmsInput id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={isPending || submitting} />
          </TmsField>
        ) : (
          <p className="tms-muted" style={{ fontSize: 12 }}>Stamped with today's date and the time you save it.</p>
        )}
        <TmsField label="Reference / check #" htmlFor="pay-reference">
          <TmsInput id="pay-reference" placeholder="Optional" value={reference} onChange={(e) => setReference(e.target.value)} disabled={isPending || submitting} />
        </TmsField>
        {isCorrection === false ? (
          vendorEmail ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" id="pay-notify" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={isPending || submitting} />
              <span>Email a payment confirmation to <span style={{ fontWeight: 600 }}>{vendorEmail}</span></span>
            </label>
          ) : (
            <p className="tms-muted" style={{ fontSize: 12 }}>No vendor email on file, so no confirmation will be sent. Add one under Edit details.</p>
          )
        ) : null}
      </form>
    </TmsDialog>
  )
}

// ── Row actions ──────────────────────────────────────────────────────────────

function RowActions({
  item,
  pendingIds,
  canDelete,
  onPay,
  onReopen,
  onDelete,
}: {
  item: VendorPayable
  pendingIds: Set<string>
  canDelete: boolean
  onPay: (item: VendorPayable) => void
  onReopen: (item: VendorPayable) => void
  onDelete: (item: VendorPayable) => void
}) {
  const isPending = pendingIds.has(item.id)
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
      {item.status === 'NEED_TO_PAY' ? (
        <TmsButton
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onPay(item) }}
        >
          <Check size={13} />
          Mark done
        </TmsButton>
      ) : (
        <>
          <TmsButton
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={(e) => { e.stopPropagation(); onPay(item) }}
          >
            <Pencil size={13} />
            Edit payment
          </TmsButton>
          <TmsButton
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={(e) => { e.stopPropagation(); onReopen(item) }}
          >
            <RotateCcw size={13} />
            Reopen
          </TmsButton>
        </>
      )}
      {canDelete && (
        <TmsIconButton
          shape="plain"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onDelete(item) }}
          aria-label={`Delete queue row for ${item.vendor || item.subject}`}
          title="Delete queue row"
        >
          <Trash2 size={14} />
        </TmsIconButton>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function VendorApPage() {
  const {
    items,
    loading,
    error,
    pendingIds,
    refresh,
    getPayableDetails,
    updateDetails,
    recordPayment,
    reopenPayable,
    removePayable,
    getAttachmentUrl,
  } = useVendorPayables()
  const { user, hasPageAccess } = useAuth()

  const [search, setSearch] = useState('')
  // Opens on what is still owed: a paid row leaves this view, which is what "mark done" should look like.
  const [activeTab, setActiveTab] = useState<'ALL' | 'NEED_TO_PAY' | 'DONE'>('NEED_TO_PAY')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailFull, setDetailFull] = useState<VendorPayable | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailIdRef = useRef<string | null>(null)
  const [paymentItem, setPaymentItem] = useState<VendorPayable | null>(null)
  const [pageSize, setPageSize] = useState(50)

  const canDelete = user?.groups.includes('ADMIN') ?? false
  const canSeeInvoices = hasPageAccess('invoices')

  const detailListItem = useMemo(() => items.find((i) => i.id === detailId) ?? null, [items, detailId])
  const detailItem = useMemo<VendorPayable | null>(() => {
    if (!detailListItem) return detailFull
    return { ...detailListItem, emailBody: detailFull?.emailBody ?? detailListItem.emailBody }
  }, [detailListItem, detailFull])

  const loadDetails = useCallback(
    async (id: string) => {
      detailIdRef.current = id
      setDetailLoading(true)
      setDetailError(null)
      try {
        const full = await getPayableDetails(id)
        if (detailIdRef.current === id) {
          setDetailFull(full)
        }
      } catch (err) {
        if (detailIdRef.current === id) {
          setDetailError(err instanceof Error ? err.message : 'Failed to load invoice details')
        }
      } finally {
        if (detailIdRef.current === id) {
          setDetailLoading(false)
        }
      }
    },
    [getPayableDetails],
  )

  const openDetails = useCallback(
    (item: VendorPayable) => {
      setDetailId(item.id)
      void loadDetails(item.id)
    },
    [loadDetails],
  )

  const openPayment = useCallback((item: VendorPayable) => setPaymentItem(item), [])

  const closeDetails = useCallback(() => {
    detailIdRef.current = null
    setDetailId(null)
    setDetailFull(null)
    setDetailError(null)
    setDetailLoading(false)
  }, [])

  const reloadDetails = useCallback(() => {
    if (detailIdRef.current) {
      void loadDetails(detailIdRef.current)
    }
  }, [loadDetails])

  const counts = useMemo(() => ({
    ALL: items.length,
    NEED_TO_PAY: items.filter((i) => i.status === 'NEED_TO_PAY').length,
    DONE: items.filter((i) => i.status === 'DONE').length,
  }), [items])

  // The same bill twice: later copies go red so an admin can delete them.
  const duplicates = useMemo(() => findVendorApDuplicates(items), [items])

  const filtered = useMemo(() => {
    return items
      .filter((item) => activeTab === 'ALL' || item.status === activeTab)
      .filter((item) => matchesSearch(item, search))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, activeTab, search])

  const pageRows = useMemo(() => filtered.slice(0, pageSize), [filtered, pageSize])

  const handleSaveDetails = useCallback(
    async (patch: VendorPayableDetails) => {
      if (!detailListItem) return
      try {
        const updated = await updateDetails(detailListItem.id, patch)
        toast.success('Details saved')
        setDetailFull((prev) => (prev ? { ...prev, ...updated, emailBody: prev.emailBody } : updated))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save details')
        throw err
      }
    },
    [detailListItem, updateDetails],
  )

  const handlePaymentSubmit = useCallback(
    async (id: string, payment: VendorPayment) => {
      try {
        const updated = await recordPayment(id, payment)
        const wasOpen = detailIdRef.current === id
        if (wasOpen && updated.status === 'DONE') {
          // Paid from the details dialog: the job is finished, so the dialog goes too.
          closeDetails()
        } else {
          setDetailFull((prev) => (prev ? { ...prev, ...updated, emailBody: prev.emailBody } : updated))
        }
        toast.success(updated.status === 'DONE' ? 'Paid — moved to Done' : 'Payment updated')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to record payment')
        throw err
      }
    },
    [recordPayment, closeDetails],
  )

  const handleReopen = useCallback(
    async (item: VendorPayable) => {
      if (
        window.confirm(
          'Reopen this payable?\n\n' +
            'This clears the recorded payment date and method in the linked maintenance invoice and returns the row to Need to pay.',
        ) === false
      ) {
        return
      }
      try {
        const updated = await reopenPayable(item.id)
        toast.success('Payable reopened')
        setDetailFull((prev) => (prev ? { ...prev, ...updated, emailBody: prev.emailBody } : updated))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to reopen payable')
      }
    },
    [reopenPayable],
  )

  const handleDelete = useCallback(
    async (item: VendorPayable) => {
      if (canDelete === false) return
      const label = [item.vendor, item.invoiceNumber].filter(Boolean).join(' · ') || item.subject || 'this payable'
      if (
        window.confirm(
          `Delete queue row for ${label}?\n\n` +
            'The original email/invoice source and any payment record are retained; only this queue row is removed.',
        ) === false
      ) {
        return
      }
      try {
        await removePayable(item.id)
        toast.success('Queue row deleted')
        closeDetails()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete queue row')
      }
    },
    [canDelete, closeDetails, removePayable],
  )

  const today = todayIso()

  const columns: Array<ColumnDef<VendorPayable>> = [
    {
      key: 'vendor',
      header: 'VENDOR',
      width: 200,
      render: (item) => (
        <div>
          <div style={{ fontWeight: 600 }}>{item.vendor || '—'}</div>
          {duplicates.has(item.id) ? (
            <div
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-badge-red)' }}
              title={`Same ${duplicates.get(item.id)!.reason} as an earlier row. Delete this one.`}
            >
              Duplicate · same {duplicates.get(item.id)!.reason}
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'invoice', header: 'INVOICE #', width: 160, render: (item) => <span className="tms-muted">{item.invoiceNumber || '—'}</span> },
    {
      key: 'amount',
      header: 'AMOUNT',
      width: 130,
      render: (item) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatAmount(item.amount)}
          {item.amount == null && item.extractedAt ? (
            <span className="tms-muted" style={{ display: 'block', fontSize: 11 }} title={item.extractionNote ?? undefined}>not on invoice</span>
          ) : null}
        </span>
      ),
    },
    { key: 'due', header: 'DUE', width: 140, render: (item) => <DueCell item={item} today={today} /> },
    { key: 'source', header: 'SOURCE', width: 130, render: (item) => <SourceBadge source={item.source} /> },
    {
      key: 'received',
      header: 'RECEIVED',
      width: 120,
      render: (item) => <span className="tms-muted" title={formatReceivedAt(item.receivedAt)}>{relativeReceived(item.receivedAt)}</span>,
    },
    {
      key: 'status',
      header: 'STATUS',
      width: 150,
      render: (item) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StatusBadge status={item.status} />
          {pendingIds.has(item.id) && <Loader2 size={13} className="tms-muted" />}
        </span>
      ),
    },
    { key: 'method', header: 'PAYMENT METHOD', width: 150, render: (item) => <span className="tms-muted">{item.paymentMethod || '—'}</span> },
    {
      key: 'date',
      header: 'DATE',
      width: 150,
      render: (item) => (
        <span className="tms-muted" title={item.paidAt ? formatReceivedAt(item.paidAt) : undefined}>
          {item.paidAt ? formatReceivedAt(item.paidAt) : item.paymentDate || '—'}
          {item.confirmationSentAt ? <span style={{ display: 'block', fontSize: 11 }}>✉ confirmed</span> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 300,
      render: (item) => (
        <RowActions
          item={item}
          pendingIds={pendingIds}
          canDelete={canDelete}
          onPay={openPayment}
          onReopen={handleReopen}
          onDelete={handleDelete}
        />
      ),
    },
  ]

  return (
    <>
      <TmsListPage<VendorPayable>
        title="Vendors"
        search={{ value: search, onChange: setSearch, placeholder: 'Search vendor, invoice #, subject, or sender…' }}
        onRefresh={() => { void (async () => { await refresh(); reloadDetails() })() }}
        quickTabs={{
          tabs: TABS.map(({ key, label }) => ({ key, label, count: counts[key] })),
          active: activeTab,
          onSelect: (key) => setActiveTab(key as 'ALL' | 'NEED_TO_PAY' | 'DONE'),
        }}
        banner={
          <p className="tms-muted" style={{ fontSize: 12 }}>
            Email invoices to vendorpayments@bcatcorp.com. Maintenance invoices are linked from the Invoices page.
            {error ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, color: 'var(--tms-badge-red)' }}>
                <AlertCircle size={14} />
                {error}
              </span>
            ) : null}
          </p>
        }
        columns={columns}
        rows={pageRows}
        rowKey={(item) => item.id}
        onRowClick={openDetails}
        page={{ from: pageRows.length === 0 ? 0 : 1, to: pageRows.length, total: filtered.length, pageSize, onPageSize: setPageSize }}
        emptyText={
          error
            ? 'Couldn’t load queue. Try refreshing.'
            : loading
              ? 'Loading vendor AP queue…'
              : 'No items match the current filters.'
        }
        onClearFilters={() => { setSearch(''); setActiveTab('ALL') }}
      />

      {detailItem && (
        <DetailsDialog
          key={detailItem.id}
          item={detailItem}
          loading={detailLoading}
          error={detailError}
          pendingIds={pendingIds}
          canDelete={canDelete}
          canSeeInvoices={canSeeInvoices}
          onClose={closeDetails}
          onSave={handleSaveDetails}
          onPay={() => {
            setPaymentItem(detailItem)
          }}
          onReopen={() => handleReopen(detailItem)}
          onDelete={() => handleDelete(detailItem)}
          getAttachmentUrl={getAttachmentUrl}
        />
      )}

      <PaymentDialog
        key={paymentItem?.id}
        item={paymentItem}
        open={paymentItem !== null}
        pendingIds={pendingIds}
        onClose={() => setPaymentItem(null)}
        onSubmit={handlePaymentSubmit}
      />
    </>
  )
}
