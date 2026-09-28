import { useMemo, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  RefreshCw, Search, Inbox, Loader2, AlertCircle, Trash2, Check, RotateCcw,
  Mail, Wrench, FileText, ExternalLink, CreditCard, Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useVendorPayables } from '@/hooks/useVendorPayables'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/utils'
import { toLocalDateString } from '@/lib/payPeriod'
import { toast } from 'sonner'
import { formatCents } from '@/features/maintenance/maintenanceUi'
import type { VendorPayable, VendorPayableDetails, VendorPayment, VendorApAttachment } from '@/types/vendorAp'

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
  if (!trimmed) return null
  const cleaned = trimmed.replace(/[$,]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return 'invalid'
  return Math.round(n * 100)
}

function matchesSearch(item: VendorPayable, query: string): boolean {
  if (!query.trim()) return true
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
  const isDone = status === 'DONE'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: isDone ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
        color: isDone ? '#15803d' : '#b45309',
        border: `1px solid ${isDone ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)'}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isDone ? '#22c55e' : '#f59e0b',
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  )
}

function SourceBadge({ source }: { source: VendorPayable['source'] }) {
  const isMaintenance = source === 'MAINTENANCE'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: isMaintenance ? 'rgba(59,130,246,0.10)' : 'rgba(100,116,139,0.10)',
        color: isMaintenance ? '#2563eb' : '#475569',
        border: `1px solid ${isMaintenance ? 'rgba(59,130,246,0.20)' : 'rgba(100,116,139,0.20)'}`,
      }}
    >
      {isMaintenance ? <Wrench className="size-3" /> : <Mail className="size-3" />}
      {SOURCE_LABEL[source]}
    </span>
  )
}

// ── Linked maintenance invoice read-only details ─────────────────────────────

function LinkedInvoiceDetails({ invoiceId, canSeeInvoices }: { invoiceId: string; canSeeInvoices: boolean }) {
  const invoice = useAppStore((s) => s.maintenanceInvoices.find((i) => i.id === invoiceId))
  const equipment = useAppStore((s) => s.equipment.find((e) => e.id === invoice?.equipmentId))

  if (!invoice) {
    return <p style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Linked maintenance invoice not found.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>
          {invoice.vendor || 'Unknown vendor'}
        </span>
        {canSeeInvoices && (
          <Link to="/invoices">
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
              <ExternalLink className="size-3" />
              Open in Invoices
            </Button>
          </Link>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Field label="Equipment" value={equipment ? `#${equipment.unitNumber}${equipment.nickname ? ` · ${equipment.nickname}` : ''}` : invoice.equipmentId} />
        <Field label="Invoice date" value={invoice.date || '—'} />
        <Field label="Amount" value={formatCents(invoice.amount)} />
        <Field label="Invoice #" value={invoice.invoiceNumber || '—'} />
      </div>
      {invoice.description && (
        <div style={{ fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {invoice.description}
        </div>
      )}
      {(invoice.paymentMethod || invoice.paymentDate) && (
        <div style={{ fontSize: 12, color: 'var(--ds-t2)' }}>
          Recorded payment: {invoice.paymentMethod || '—'}
          {invoice.paymentDate && <span style={{ color: 'var(--ds-t3)', marginLeft: 6 }}>{invoice.paymentDate}</span>}
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ds-t1)', fontWeight: 500 }}>{value}</div>
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
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  const open = async (att: VendorApAttachment) => {
    if (urls[att.key]) {
      window.open(urls[att.key], '_blank', 'noopener,noreferrer')
      return
    }
    setLoadingKey(att.key)
    try {
      const url = await getAttachmentUrl(att.key)
      setUrls((prev) => ({ ...prev, [att.key]: url }))
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load attachment')
    } finally {
      setLoadingKey(null)
    }
  }

  if (attachments.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Attachments
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {attachments.map((att) => (
          <button
            key={att.key}
            type="button"
            onClick={() => open(att)}
            disabled={loadingKey === att.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid var(--ds-border)',
              background: 'var(--ds-surface)',
              fontSize: 12,
              color: 'var(--ds-t2)',
              cursor: 'pointer',
            }}
          >
            {loadingKey === att.key ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileText className="size-3.5" />
            )}
            <span className="max-w-[200px] truncate">{att.name}</span>
            <span style={{ color: 'var(--ds-t3)' }}>({(att.size / 1024).toFixed(1)} KB)</span>
          </button>
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
  const fullLoaded = !loading && !error

  const [vendor, setVendor] = useState(item.vendor ?? '')
  const [invoiceNumber, setInvoiceNumber] = useState(item.invoiceNumber ?? '')
  const [amount, setAmount] = useState(item.amount != null ? (item.amount / 100).toFixed(2) : '')
  const [invoiceDate, setInvoiceDate] = useState(item.invoiceDate ?? '')
  const [description, setDescription] = useState(item.description ?? '')
  const [saving, setSaving] = useState(false)

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
        description: description.trim() || null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{item.subject || '(no subject)'}</DialogTitle>
          <DialogDescription>
            {item.source} · {formatReceivedAt(item.receivedAt)} · from {item.fromEmail || 'unknown sender'}
          </DialogDescription>
        </DialogHeader>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 8 }}>
          {item.source === 'MAINTENANCE' && item.sourceInvoiceId && (
            <Section title="Source invoice">
              <LinkedInvoiceDetails invoiceId={item.sourceInvoiceId} canSeeInvoices={canSeeInvoices} />
            </Section>
          )}

          {isEmail ? (
            <Section title="Invoice details">
              <form id="details-form" onSubmit={submitDetails} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <div>
                    <Label htmlFor="ap-vendor" className="text-xs">Vendor</Label>
                    <Input id="ap-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} disabled={!fullLoaded || isPending || saving} className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="ap-invoice" className="text-xs">Invoice #</Label>
                    <Input id="ap-invoice" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} disabled={!fullLoaded || isPending || saving} className="mt-1" />
                  </div>
                  <div>
                    <Label htmlFor="ap-amount" className="text-xs">Amount ($)</Label>
                    <Input
                      id="ap-amount"
                      inputMode="decimal"
                      placeholder="Leave blank if unknown"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={!fullLoaded || isPending || saving}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ap-date" className="text-xs">Invoice date</Label>
                    <Input id="ap-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} disabled={!fullLoaded || isPending || saving} className="mt-1" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="ap-description" className="text-xs">Description</Label>
                  <Input id="ap-description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!fullLoaded || isPending || saving} className="mt-1" />
                </div>
              </form>
            </Section>
          ) : (
            <Section title="Invoice details">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                <Field label="Vendor" value={item.vendor || '—'} />
                <Field label="Invoice #" value={item.invoiceNumber || '—'} />
                <Field label="Amount" value={formatAmount(item.amount)} />
                <Field label="Invoice date" value={item.invoiceDate || '—'} />
              </div>
              {item.description && <div style={{ fontSize: 13, color: 'var(--ds-t2)', marginTop: 8, whiteSpace: 'pre-wrap' }}>{item.description}</div>}
            </Section>
          )}

          <Section title="Original message">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                From: {item.fromEmail || '—'} · Received: {formatReceivedAt(item.receivedAt)}
              </div>
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, color: 'var(--ds-t3)', fontSize: 13 }}>
                  <Loader2 className="size-4 animate-spin" />
                  Loading full message…
                </div>
              ) : error ? (
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--ds-red-bg, #fee2e2)', border: '1px solid var(--ds-red-border, #fecaca)', color: 'var(--ds-red-text, #991b1b)', fontSize: 13 }}>
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
                    color: 'var(--ds-t2)',
                    background: 'var(--ds-bg)',
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid var(--ds-border)',
                    margin: 0,
                    maxHeight: 240,
                    overflowY: 'auto',
                  }}
                >
                  {item.emailBody}
                </pre>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--ds-t3)' }}>No message body available.</p>
              )}
            </div>
          </Section>

          <AttachmentList attachments={item.attachments} getAttachmentUrl={getAttachmentUrl} />
        </div>

        <DialogFooter className="mt-4">
          {isEmail ? (
            <Button
              type="submit"
              form="details-form"
              disabled={!fullLoaded || isPending || saving}
              className="gap-1.5"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save details
            </Button>
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {item.status === 'NEED_TO_PAY' ? (
              <Button onClick={onPay} disabled={isPending} className="gap-1.5">
                <CreditCard className="size-4" />
                Mark done
              </Button>
            ) : (
              <>
                <Button onClick={onPay} disabled={isPending} className="gap-1.5">
                  <Pencil className="size-4" />
                  Edit payment
                </Button>
                <Button variant="outline" onClick={onReopen} disabled={isPending} className="gap-1.5">
                  <RotateCcw className="size-4" />
                  Reopen
                </Button>
              </>
            )}
            {canDelete && (
              <Button variant="outline" onClick={onDelete} disabled={isPending} className="gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50">
                <Trash2 className="size-4" />
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {title}
      </div>
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
  const [submitting, setSubmitting] = useState(false)

  if (!item) return null

  const isPending = pendingIds.has(item.id)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedMethod = method.trim()
    if (!trimmedMethod) {
      toast.error('Payment method is required')
      return
    }
    if (!date) {
      toast.error('Payment date is required')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(item.id, {
        paymentMethod: trimmedMethod,
        paymentDate: date,
        paymentReference: reference.trim() || null,
      })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const isCorrection = item.status === 'DONE'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{isCorrection ? 'Edit payment' : 'Record payment'}</DialogTitle>
          <DialogDescription>
            {item.vendor || 'Unknown vendor'} · {item.invoiceNumber || 'No invoice #'} · {formatAmount(item.amount)}
          </DialogDescription>
        </DialogHeader>
        <form id="payment-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
          <div>
            <Label htmlFor="pay-method" className="text-xs">Payment method</Label>
            <Input
              id="pay-method"
              placeholder="Card / check / cash / Zelle"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={isPending || submitting}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="pay-date" className="text-xs">Payment date</Label>
            <Input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={isPending || submitting} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="pay-reference" className="text-xs">Reference / check #</Label>
            <Input id="pay-reference" placeholder="Optional" value={reference} onChange={(e) => setReference(e.target.value)} disabled={isPending || submitting} className="mt-1" />
          </div>
        </form>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="payment-form" disabled={isPending || submitting} className="gap-1.5">
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {isCorrection ? 'Save changes' : 'Save payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {item.status === 'NEED_TO_PAY' ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onPay(item) }}
        >
          <Check className="size-3.5" />
          Mark done
        </Button>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={isPending}
            onClick={(e) => { e.stopPropagation(); onPay(item) }}
          >
            <Pencil className="size-3.5" />
            Edit payment
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={isPending}
            onClick={(e) => { e.stopPropagation(); onReopen(item) }}
          >
            <RotateCcw className="size-3.5" />
            Reopen
          </Button>
        </>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-red-600"
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onDelete(item) }}
          aria-label={`Delete queue row for ${item.vendor || item.subject}`}
          title="Delete queue row"
        >
          <Trash2 className="size-4" />
        </Button>
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
  const isMobile = useIsMobile()

  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<'ALL' | 'NEED_TO_PAY' | 'DONE'>('ALL')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailFull, setDetailFull] = useState<VendorPayable | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailIdRef = useRef<string | null>(null)
  const [paymentItem, setPaymentItem] = useState<VendorPayable | null>(null)

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

  const filtered = useMemo(() => {
    return items
      .filter((item) => activeTab === 'ALL' || item.status === activeTab)
      .filter((item) => matchesSearch(item, search))
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
  }, [items, activeTab, search])

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
        toast.success('Payment recorded')
        setDetailFull((prev) => (prev ? { ...prev, ...updated, emailBody: prev.emailBody } : updated))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to record payment')
        throw err
      }
    },
    [recordPayment],
  )

  const handleReopen = useCallback(
    async (item: VendorPayable) => {
      if (
        !window.confirm(
          'Reopen this payable?\n\n' +
            'This clears the recorded payment date and method in the linked maintenance invoice and returns the row to Need to pay.',
        )
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
      if (!canDelete) return
      const label = [item.vendor, item.invoiceNumber].filter(Boolean).join(' · ') || item.subject || 'this payable'
      if (
        !window.confirm(
          `Delete queue row for ${label}?\n\n` +
            'The original email/invoice source and any payment record are retained; only this queue row is removed.',
        )
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

  const padX = isMobile ? 16 : 32

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${isMobile ? 12 : 16}px ${padX}px`, borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.01em', margin: 0 }}>Vendor AP Queue</h1>
        <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
          Email invoices to vendorpayments@bcatcorp.com. Maintenance invoices are linked from the Invoices page.
        </p>
      </div>
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={async () => { await refresh(); reloadDetails() }} disabled={loading}>
        <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        Refresh
      </Button>
    </div>
  )

  const filters = (
    <div style={{ padding: `${isMobile ? 12 : 16}px ${padX}px`, borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {TABS.map(({ key, label }) => {
            const isActive = activeTab === key
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
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
          <Input
            placeholder="Search vendor, invoice #, subject, or sender…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search vendor AP queue"
            className="h-8 text-xs"
            style={{ paddingLeft: 36 }}
          />
        </div>
      </div>
    </div>
  )

  const emptyState = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 0', gap: 10, color: 'var(--ds-t3)' }}>
      <Inbox className="size-10 opacity-20" />
      <p className="text-sm">
        {error ? 'Couldn’t load queue. Try refreshing.' : 'No items match the current filters.'}
      </p>
    </div>
  )

  const renderTable = () => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
            {['Vendor', 'Invoice #', 'Amount', 'Source', 'Received', 'Status', 'Payment method', 'Date', 'Actions'].map((col) => (
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
            <tr
              key={item.id}
              style={{ borderBottom: '1px solid var(--ds-border)', cursor: 'pointer' }}
              className="hover:bg-[var(--ds-bg)] transition-colors"
              onClick={() => openDetails(item)}
            >
              <td style={{ padding: '14px 16px', maxWidth: 200 }}>
                <div className="truncate font-medium text-foreground">{item.vendor || '—'}</div>
              </td>
              <td style={{ padding: '14px 16px', maxWidth: 160 }}>
                <div className="truncate text-muted-foreground">{item.invoiceNumber || '—'}</div>
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {formatAmount(item.amount)}
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <SourceBadge source={item.source} />
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <div className="text-sm text-muted-foreground" title={formatReceivedAt(item.receivedAt)}>
                  {relativeReceived(item.receivedAt)}
                </div>
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusBadge status={item.status} />
                  {pendingIds.has(item.id) && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <span className="text-sm text-muted-foreground">{item.paymentMethod || '—'}</span>
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <span className="text-sm text-muted-foreground">{item.paymentDate || '—'}</span>
              </td>
              <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                <RowActions
                  item={item}
                  pendingIds={pendingIds}
                  canDelete={canDelete}
                  onPay={openPayment}
                  onReopen={handleReopen}
                  onDelete={handleDelete}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const renderCards = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {filtered.map((item) => (
        <div
          key={item.id}
          onClick={() => openDetails(item)}
          style={{
            background: 'var(--ds-surface)',
            border: '1px solid var(--ds-border)',
            borderRadius: 12,
            padding: 14,
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', marginBottom: 2 }} className="truncate">
                {item.vendor || 'Unknown vendor'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                {item.invoiceNumber || 'No invoice #'} · {formatAmount(item.amount)}
              </div>
            </div>
            <StatusBadge status={item.status} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--ds-t2)' }}>
            <div><span style={{ color: 'var(--ds-t3)' }}>Source:</span> <SourceBadge source={item.source} /></div>
            <div><span style={{ color: 'var(--ds-t3)' }}>Received:</span> {relativeReceived(item.receivedAt)}</div>
            <div><span style={{ color: 'var(--ds-t3)' }}>Method:</span> {item.paymentMethod || '—'}</div>
            <div><span style={{ color: 'var(--ds-t3)' }}>Date:</span> {item.paymentDate || '—'}</div>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <RowActions
              item={item}
              pendingIds={pendingIds}
              canDelete={canDelete}
              onPay={openPayment}
              onReopen={handleReopen}
              onDelete={handleDelete}
            />
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ds-bg)' }}>
      {header}
      {filters}

      {error && (
        <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: 8, background: 'var(--ds-red-bg, #fee2e2)', border: '1px solid var(--ds-red-border, #fecaca)', color: 'var(--ds-red-text, #991b1b)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)' }}>
          {loading && items.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 0', gap: 10, color: 'var(--ds-t3)' }}>
              <Loader2 className="size-6 animate-spin opacity-50" />
              <p className="text-sm">Loading vendor AP queue…</p>
            </div>
          ) : filtered.length === 0 ? (
            emptyState
          ) : isMobile ? (
            <div style={{ padding: 16 }}>{renderCards()}</div>
          ) : (
            renderTable()
          )}
        </div>
      </div>

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
    </div>
  )
}
