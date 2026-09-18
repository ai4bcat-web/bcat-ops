import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, Search, Upload } from 'lucide-react'
import {
  portalAvailable,
  DisputePortalError,
  listDisputes,
  getUploadUrl,
  submitDispute,
  uploadFileToS3,
  uuid,
  type BoardItem,
  type ProofKind,
  type EvidenceFile,
} from '@/lib/disputePortalClient'
import { addDays, formatPayPeriod, formatWeekLabel, toLocalDateString } from '@/lib/payPeriod'

const TITLE_BASE = 'Ivan Cartage — Amazon Dispute Portal'
const CONTACT_EMAIL = 'onboarding@bcatcorp.com'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB
const CONFIRM_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const PAY_PERIOD_WEEKS = 104
const POLL_MS = 30000

const STATUS_META: Record<BoardItem['status'], { label: string; bg: string; fg: string }> = {
  PENDING: { label: 'Pending', bg: 'var(--ds-amber-bg)', fg: 'var(--ds-amber)' },
  POSTED: { label: 'Filed with Amazon', bg: 'var(--ds-blue-bg)', fg: 'var(--ds-blue-dark)' },
  PAID: { label: 'Paid', bg: 'var(--ds-green-bg)', fg: 'var(--ds-green)' },
  REJECTED: { label: 'Rejected', bg: 'var(--ds-red-bg)', fg: 'var(--ds-red)' },
}

const cardStyle: CSSProperties = {
  background: 'var(--ds-surface)',
  border: '1px solid var(--ds-border)',
  borderRadius: 12,
  boxShadow: 'var(--sh-sm)',
  padding: 18,
}

const inputStyle: CSSProperties = {
  width: '100%',
  borderRadius: 8,
  border: '1px solid var(--ds-border)',
  padding: '11px 12px',
  fontSize: 15,
  background: 'var(--ds-surface)',
  color: 'var(--ds-t1)',
  outline: 'none',
  minHeight: 44,
}

const btnPrimary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: 9,
  padding: '11px 20px',
  fontSize: 15,
  fontWeight: 600,
  background: 'var(--ds-blue)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  minHeight: 44,
}

const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || ''
  )
}

interface PayPeriodOption {
  value: string // YYYY-MM-DD Sunday start
  label: string
  start: Date
  end: Date
}

function buildPayPeriods(): { options: PayPeriodOption[]; defaultValue: string } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const currentSunday = addDays(today, -today.getDay())
  const options: PayPeriodOption[] = []
  for (let i = -PAY_PERIOD_WEEKS; i <= 0; i++) {
    const start = addDays(currentSunday, i * 7)
    options.push({ value: toLocalDateString(start), label: formatWeekLabel(start), start, end: addDays(start, 6) })
  }
  // Default to the last fully completed week (one week before the current Sunday).
  const defaultValue = toLocalDateString(addDays(currentSunday, -7))
  return { options, defaultValue }
}

function validateForm(
  driverName: string,
  tripNumber: string,
  payPeriod: string,
  shipmentDate: string,
  amountPaid: string,
  amountRequested: string,
  description: string,
  confirmation: File | null,
  periods: PayPeriodOption[],
): string | null {
  if (!driverName.trim()) return 'Driver name is required.'
  if (!tripNumber.trim()) return 'Trip number is required.'
  if (!payPeriod) return 'Pay period is required.'
  if (!shipmentDate) return 'Shipment date is required.'
  const period = periods.find((p) => p.value === payPeriod)
  if (period) {
    const ship = new Date(`${shipmentDate}T00:00:00`)
    if (ship < period.start || ship > period.end) {
      return 'Shipment date must be within the selected Sunday–Saturday pay period.'
    }
  }
  const paid = Number.parseFloat(amountPaid)
  const requested = Number.parseFloat(amountRequested)
  if (Number.isNaN(paid) || paid < 0) return 'Amount paid must be a number ≥ 0.'
  if (Number.isNaN(requested) || requested <= 0) return 'Amount requested must be a number greater than 0.'
  if (!description.trim() || description.trim().length < 5) return 'Please provide a short description (at least 5 characters).'
  if (!confirmation) return 'A trip confirmation email screenshot or PDF is required.'
  return null
}

function validateFile(file: File, allowedTypes: string[], prefix: string): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `${prefix} "${file.name}" exceeds the 10 MB limit.`
  }
  if (!allowedTypes.includes(file.type)) {
    if (allowedTypes.includes('application/pdf')) {
      return `${prefix} "${file.name}" must be PNG, JPEG, WEBP, or PDF.`
    }
    return `${prefix} "${file.name}" must be PNG, JPEG, or WEBP.`
  }
  return null
}

export function DriverDisputesPage() {
  const { options: payPeriodOptions, defaultValue: defaultPayPeriod } = useMemo(() => buildPayPeriods(), [])

  const [driverName, setDriverName] = useState('')
  const [tripNumber, setTripNumber] = useState('')
  const [payPeriod, setPayPeriod] = useState(defaultPayPeriod)
  const [shipmentDate, setShipmentDate] = useState('')
  const [amountPaid, setAmountPaid] = useState('')
  const [amountRequested, setAmountRequested] = useState('')
  const [description, setDescription] = useState('')
  const [confirmation, setConfirmation] = useState<File | null>(null)
  const [photos, setPhotos] = useState<File[]>([])
  const [submissionId, setSubmissionId] = useState(() => uuid())

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccessId, setSubmitSuccessId] = useState<string | null>(null)

  const [boardItems, setBoardItems] = useState<BoardItem[]>([])
  const [boardLoading, setBoardLoading] = useState(true)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [boardSearch, setBoardSearch] = useState('')
  const requestGenRef = useRef(0)

  useEffect(() => {
    document.title = TITLE_BASE
    return () => {
      document.title = 'BCAT OPS'
    }
  }, [])

  // ── Board loading ---------------------------------------------------------
  const loadBoard = useCallback(async () => {
    if (!portalAvailable) {
      setBoardError('Dispute portal is not configured.')
      setBoardLoading(false)
      return
    }
    const currentGen = ++requestGenRef.current

    let nextToken: string | undefined | null = undefined
    let isFirstPage = true

    try {
      while (true) {
        const res = await listDisputes(nextToken ?? undefined)
        if (currentGen !== requestGenRef.current) return
        if (isFirstPage) {
          setBoardItems(res.items)
        } else {
          setBoardItems((prev) => [...prev, ...res.items])
        }
        setBoardError(null)
        if (!res.nextToken) break
        nextToken = res.nextToken
        isFirstPage = false
      }
    } catch (err) {
      if (currentGen !== requestGenRef.current) return
      setBoardError(err instanceof DisputePortalError ? err.message : 'Could not load the dispute board.')
    } finally {
      if (currentGen === requestGenRef.current) setBoardLoading(false)
    }
  }, [])

  useEffect(() => {
    const timeout = setTimeout(() => loadBoard(), 0)
    return () => clearTimeout(timeout)
  }, [loadBoard])

  useEffect(() => {
    if (!portalAvailable || boardLoading) return
    const interval = setInterval(() => {
      // Background poll: loadBoard manages loading state; stale-generation checks
      // drop late responses if a manual refresh overlaps.
      loadBoard()
    }, POLL_MS)
    return () => clearInterval(interval)
  }, [boardLoading, loadBoard])

  const filteredItems = useMemo(() => {
    const q = boardSearch.trim().toLowerCase()
    // Pages arrive in scan order; sort the assembled list so newest shipments lead.
    const sorted = [...boardItems].sort(
      (a, b) => (b.shipmentDate ?? '').localeCompare(a.shipmentDate ?? '') || a.driverName.localeCompare(b.driverName),
    )
    if (!q) return sorted
    return sorted.filter(
      (item) =>
        item.driverName.toLowerCase().includes(q) ||
        (item.tripNumber ?? '').toLowerCase().includes(q),
    )
  }, [boardItems, boardSearch])

  // ── Form handlers ---------------------------------------------------------
  const onConfirmationChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setSubmitError(null)
    setConfirmation(file)
  }

  const onPhotosChange = (e: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? [])
    setSubmitError(null)
    setPhotos((prev) => [...prev, ...incoming].slice(0, 5))
  }

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index))
  }

  const resetForm = () => {
    setDriverName('')
    setTripNumber('')
    setPayPeriod(defaultPayPeriod)
    setShipmentDate('')
    setAmountPaid('')
    setAmountRequested('')
    setDescription('')
    setConfirmation(null)
    setPhotos([])
    setSubmitError(null)
    setSubmissionId(uuid())
  }

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    setSubmitError(null)
    setSubmitSuccessId(null)

    const validation = validateForm(
      driverName,
      tripNumber,
      payPeriod,
      shipmentDate,
      amountPaid,
      amountRequested,
      description,
      confirmation,
      payPeriodOptions,
    )
    if (confirmation) {
      const fileErr = validateFile(confirmation, CONFIRM_TYPES, 'Confirmation file')
      if (!validation && fileErr) {
        setSubmitError(fileErr)
        setSubmitting(false)
        return
      }
    }
    let photoErr: string | null = null
    for (const photo of photos) {
      const err = validateFile(photo, PHOTO_TYPES, 'Photo')
      if (err) {
        photoErr = err
        break
      }
    }
    if (!validation && photoErr) {
      setSubmitError(photoErr)
      setSubmitting(false)
      return
    }

    if (validation) {
      setSubmitError(validation)
      setSubmitting(false)
      return
    }

    try {
      const evidence: EvidenceFile[] = []
      if (confirmation) {
        const meta = await getUploadUrl({
          submissionId,
          fileName: confirmation.name,
          contentType: confirmation.type || 'application/octet-stream',
          size: confirmation.size,
          kind: 'CONFIRMATION' as ProofKind,
        })
        await uploadFileToS3(confirmation, meta.uploadUrl)
        evidence.push({
          s3Key: meta.s3Key,
          fileName: confirmation.name,
          contentType: confirmation.type || 'application/octet-stream',
          size: confirmation.size,
          kind: 'CONFIRMATION',
        })
      }
      for (const photo of photos) {
        const meta = await getUploadUrl({
          submissionId,
          fileName: photo.name,
          contentType: photo.type || 'application/octet-stream',
          size: photo.size,
          kind: 'PHOTO' as ProofKind,
        })
        await uploadFileToS3(photo, meta.uploadUrl)
        evidence.push({
          s3Key: meta.s3Key,
          fileName: photo.name,
          contentType: photo.type || 'application/octet-stream',
          size: photo.size,
          kind: 'PHOTO',
        })
      }

      const result = await submitDispute({
        submissionId,
        driverName: driverName.trim(),
        tripNumber: tripNumber.trim(),
        payPeriod,
        shipmentDate,
        amountPaid: Number.parseFloat(amountPaid),
        amountRequested: Number.parseFloat(amountRequested),
        description: description.trim(),
        evidence,
      })

      setSubmitSuccessId(result.id)
      resetForm()
      // Refresh the public board so the new dispute is visible.
      loadBoard()
    } catch (err) {
      setSubmitError(err instanceof DisputePortalError ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedPeriod = payPeriodOptions.find((p) => p.value === payPeriod)
  const periodEndStr = selectedPeriod ? toLocalDateString(selectedPeriod.end) : undefined

  if (!portalAvailable) {
    return (
      <Shell driverName={driverName}>
        <div className="mx-auto max-w-md px-4 py-16 text-center">
          <AlertTriangle className="mx-auto mb-4" size={40} style={{ color: 'var(--ds-amber)' }} />
          <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--ds-t1)' }}>
            Dispute portal unavailable
          </h1>
          <p className="text-sm" style={{ color: 'var(--ds-t2)' }}>
            This page can't connect right now. The endpoint is not configured on this preview.
          </p>
          <p className="mt-4 text-sm" style={{ color: 'var(--ds-muted-soft)' }}>
            Staff can reach us at{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--ds-blue)' }}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell driverName={driverName}>
      <div className="mx-auto w-full px-4 py-6" style={{ maxWidth: 760 }}>
        <section aria-labelledby="dispute-form-title" style={cardStyle}>
          <h1
            id="dispute-form-title"
            className="flex items-center gap-2 text-lg font-semibold"
            style={{ color: 'var(--ds-t1)' }}
          >
            <FileText size={20} /> Submit an Amazon pay dispute
          </h1>
          <p className="mb-4 text-sm" style={{ color: 'var(--ds-t2)', lineHeight: 1.5 }}>
            If Amazon paid less than expected on a trip, fill this out and upload the trip
            confirmation email. <strong>Amounts and evidence remain staff-only.</strong>{' '}
            <a href="/disputes" className="underline" style={{ color: 'var(--ds-t3)' }}>
              Staff view
            </a>
          </p>

          {submitSuccessId && (
            <div
              role="status"
              className="mb-4 rounded-lg p-3 text-sm font-medium"
              style={{ background: 'var(--ds-green-bg)', color: 'var(--ds-green)' }}
            >
              <CheckCircle2 size={15} className="inline align-text-bottom mr-1" />
              Dispute submitted. Reference: <span className="font-mono">{submitSuccessId}</span>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="mb-4 rounded-lg p-3 text-sm font-medium"
              style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)' }}
            >
              <AlertTriangle size={15} className="inline align-text-bottom mr-1" />
              {submitError}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Driver name *" htmlFor="driverName">
              <input
                id="driverName"
                type="text"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder="Jane Driver"
                style={inputStyle}
                required
              />
            </Field>

            <Field label="Trip number *" htmlFor="tripNumber">
              <input
                id="tripNumber"
                type="text"
                value={tripNumber}
                onChange={(e) => setTripNumber(e.target.value)}
                placeholder="e.g. 1117J7TV9"
                style={inputStyle}
                required
              />
            </Field>

            <Field label="Pay period (Sunday–Saturday) *" htmlFor="payPeriod">
              <select
                id="payPeriod"
                value={payPeriod}
                onChange={(e) => setPayPeriod(e.target.value)}
                style={inputStyle}
              >
                {payPeriodOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Shipment date *" htmlFor="shipmentDate">
              <input
                id="shipmentDate"
                type="date"
                max={periodEndStr}
                value={shipmentDate}
                onChange={(e) => setShipmentDate(e.target.value)}
                style={inputStyle}
                required
              />
              {selectedPeriod && (
                <span className="mt-1 block text-xs" style={{ color: 'var(--ds-t3)' }}>
                  Must be between{' '}
                  <span className="font-mono">{toLocalDateString(selectedPeriod.start)}</span> and{' '}
                  <span className="font-mono">{toLocalDateString(selectedPeriod.end)}</span>.
                </span>
              )}
            </Field>

            <Field label="Amount Amazon paid (USD) *" htmlFor="amountPaid">
              <input
                id="amountPaid"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                placeholder="0.00"
                style={inputStyle}
                required
              />
            </Field>

            <Field label="Amount we're requesting (USD) *" htmlFor="amountRequested">
              <input
                id="amountRequested"
                type="number"
                inputMode="decimal"
                min={0.01}
                step="0.01"
                value={amountRequested}
                onChange={(e) => setAmountRequested(e.target.value)}
                placeholder="0.00"
                style={inputStyle}
                required
              />
            </Field>
          </div>

          <Field label="Short description *" htmlFor="description" className="mt-4">
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened with this trip's pay?"
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
              required
            />
          </Field>

          <div className="mt-4 space-y-4 rounded-lg p-3" style={{ background: 'var(--ds-bg-2)' }}>
            <FileField
              id="confirmation"
              label="Trip confirmation email screenshot or PDF *"
              hint="Required. PNG, JPEG, WEBP, or PDF. Max 10 MB."
              accept="image/png,image/jpeg,image/webp,application/pdf"
              file={confirmation}
              onChange={onConfirmationChange}
              icon={<Upload size={16} />}
            />

            <div>
              <label
                htmlFor="photos"
                className="mb-1 flex items-center gap-1.5 text-sm font-medium"
                style={{ color: 'var(--ds-t1)' }}
              >
                <Upload size={16} /> Optional photos
              </label>
              <p className="mb-2 text-xs" style={{ color: 'var(--ds-t3)' }}>
                Up to 5 images (PNG, JPEG, WEBP), 10 MB each.
              </p>
              <input
                id="photos"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                capture="environment"
                onChange={onPhotosChange}
                disabled={photos.length >= 5}
                style={{ fontSize: 14 }}
              />
              {photos.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {photos.map((photo, i) => (
                    <li
                      key={`${photo.name}-${i}`}
                      className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)' }}
                    >
                      <PhotoPreview file={photo} />
                      <span className="max-w-[140px] truncate">{photo.name}</span>
                      <button
                        type="button"
                        onClick={() => removePhoto(i)}
                        className="rounded px-1.5 py-0.5 font-medium"
                        style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)' }}
                        aria-label={`Remove ${photo.name}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, flex: 1 }}
            >
              {submitting ? (
                <>
                  <Loader2 size={17} className="animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <CheckCircle2 size={17} /> Submit dispute
                </>
              )}
            </button>
          </div>

          <p className="mt-3 text-xs" style={{ color: 'var(--ds-muted-soft)' }}>
            Submission ID (kept across retries): <span className="font-mono">{submissionId}</span>
          </p>
        </section>

        {/* ── Shared status board ── */}
        <section aria-labelledby="board-title" className="mt-6" style={cardStyle}>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="board-title" className="text-lg font-semibold" style={{ color: 'var(--ds-t1)' }}>
                Shared dispute status board
              </h2>
              <p className="text-xs" style={{ color: 'var(--ds-t3)' }}>
                Driver names, trip numbers, pay periods, shipment dates, and status only.
                Amounts, descriptions, and evidence are staff-only.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:flex-none">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--ds-muted-soft)' }} />
                <input
                  type="text"
                  value={boardSearch}
                  onChange={(e) => setBoardSearch(e.target.value)}
                  placeholder="Search name or trip…"
                  aria-label="Search disputes by driver or trip"
                  style={{ ...inputStyle, paddingLeft: 30, height: 38, minHeight: 38 }}
                />
              </div>
              <button
                type="button"
                onClick={() => { setBoardLoading(true); setBoardError(null); loadBoard() }}
                disabled={boardLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium"
                style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)' }}
              >
                <RefreshCw size={15} className={boardLoading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {boardError && (
            <div
              role="alert"
              className="mb-3 rounded-lg p-3 text-sm"
              style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)' }}
            >
              {boardError}
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 6px', color: 'var(--ds-t3)', fontSize: 12, fontWeight: 600 }}>Driver</th>
                  <th style={{ textAlign: 'left', padding: '8px 6px', color: 'var(--ds-t3)', fontSize: 12, fontWeight: 600 }}>Trip</th>
                  <th style={{ textAlign: 'left', padding: '8px 6px', color: 'var(--ds-t3)', fontSize: 12, fontWeight: 600 }}>Pay period</th>
                  <th style={{ textAlign: 'left', padding: '8px 6px', color: 'var(--ds-t3)', fontSize: 12, fontWeight: 600 }}>Shipment</th>
                  <th style={{ textAlign: 'left', padding: '8px 6px', color: 'var(--ds-t3)', fontSize: 12, fontWeight: 600 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>
                      {boardLoading ? (
                        <span className="inline-flex items-center gap-2">
                          <Loader2 size={16} className="animate-spin" /> Loading disputes…
                        </span>
                      ) : (
                        'No disputes found.'
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr key={item.id} style={{ borderBottom: '1px solid var(--ds-border-soft)' }}>
                      <td style={{ padding: '10px 6px', color: 'var(--ds-t1)' }} className="font-medium">
                        {item.driverName}
                      </td>
                      <td style={{ padding: '10px 6px', color: 'var(--ds-t2)', fontFamily: 'var(--font-mono, monospace)' }}>
                        {item.tripNumber ?? '—'}
                      </td>
                      <td style={{ padding: '10px 6px', color: 'var(--ds-t2)' }}>{item.payPeriod ? formatPayPeriod(item.payPeriod) : '—'}</td>
                      <td style={{ padding: '10px 6px', color: 'var(--ds-t2)' }}>
                        {item.shipmentDate ? formatDisplayDate(item.shipmentDate) : '—'}
                      </td>
                      <td style={{ padding: '10px 6px' }}>{statusPill(item.status)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  )
}

// ── Presentational helpers ─────────────────────────────────────────────────

function Shell({ children, driverName }: { children: React.ReactNode; driverName?: string }) {
  const initials = initialsOf(driverName ?? '')
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="mx-auto flex w-full items-center gap-3 px-4" style={{ maxWidth: 760, height: 60 }}>
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: 'linear-gradient(135deg, var(--ds-blue) 0%, var(--ds-blue-dark) 100%)' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold" style={{ color: '#fff', letterSpacing: '0.02em' }}>
              IVAN <span style={{ color: 'var(--ds-blue)' }}>CARTAGE</span>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>Amazon dispute portal</div>
          </div>
          {initials && (
            <div
              className="ml-auto flex items-center justify-center"
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.12)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
              }}
              title={driverName}
            >
              {initials}
            </div>
          )}
        </div>
      </header>
      <main style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>{children}</main>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
  className = '',
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium" style={{ color: 'var(--ds-t1)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function FileField({
  id,
  label,
  hint,
  accept,
  file,
  onChange,
  icon,
}: {
  id: string
  label: string
  hint: string
  accept: string
  file: File | null
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  icon: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--ds-t1)' }}>
        {icon} {label}
      </label>
      <p className="mb-2 text-xs" style={{ color: 'var(--ds-t3)' }}>
        {hint}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="file" accept={accept} onChange={onChange} style={{ fontSize: 14 }} />
      </div>
      {file && (
        <div
          className="mt-2 inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
          style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)' }}
        >
          <FileText size={14} style={{ color: 'var(--ds-t3)' }} />
          <span className="max-w-[200px] truncate">{file.name}</span>
          <span className="font-mono" style={{ color: 'var(--ds-t3)' }}>
            {(file.size / 1024 / 1024).toFixed(2)} MB
          </span>
        </div>
      )}
    </div>
  )
}

function PhotoPreview({ file }: { file: File }) {
  if (!file.type.startsWith('image/')) return null
  const url = URL.createObjectURL(file)
  return (
    <img
      src={url}
      alt="Photo preview"
      width={32}
      height={32}
      className="rounded object-cover"
      onLoad={() => URL.revokeObjectURL(url)}
    />
  )
}

function formatDisplayDate(value: string): string {
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusPill(status: BoardItem['status']) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING
  return (
    <span style={{ ...chipBase, background: meta.bg, color: meta.fg }}>
      {meta.label}
    </span>
  )
}
