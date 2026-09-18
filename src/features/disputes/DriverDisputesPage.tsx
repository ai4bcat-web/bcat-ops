import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, Search, Upload } from 'lucide-react'
import {
  portalAvailable,
  DisputePortalError,
  listDisputes,
  listDrivers,
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
const PDF_TYPE = 'application/pdf'
// Browsers report no MIME type for some formats (HEIC on desktop Chrome, files from
// unusual apps) - fall back to the extension so a real photo is never rejected.
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
}

/** MIME type to send for a picked file: the browser's, else inferred from the extension. */
function fileContentType(file: File): string {
  if (file.type) return file.type
  const ext = file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1].toLowerCase() ?? ''
  if (ext === 'pdf') return PDF_TYPE
  return IMAGE_EXTENSIONS[ext] ?? ''
}
const PAY_PERIOD_WEEKS = 104
const POLL_MS = 30000
const DRIVER_NOT_LISTED = '__not_listed__'

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
  padding: 14,
}

const btnPrimary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  borderRadius: 9,
  padding: '11px 22px',
  fontSize: 14,
  fontWeight: 600,
  background: 'var(--ds-blue)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
  minHeight: 44,
}

const inputStyle: CSSProperties = {
  width: '100%',
  borderRadius: 9,
  border: '1px solid var(--ds-border)',
  padding: '10px 12px',
  fontSize: 14,
  background: 'var(--ds-surface)',
  color: 'var(--ds-t1)',
  outline: 'none',
  minHeight: 44,
}

const inputClass = 'focus:border-[var(--ds-blue)] focus:ring-2 focus:ring-[var(--ds-blue)] focus:outline-none'

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

const sectionLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--ds-t3)',
}

// Centered content column — matches DriverPortalPage (720px, generous padding).
const PORTAL_COL = 'w-full'
const PORTAL_MAXW: CSSProperties = { maxWidth: 720 }

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
  if (Number.isNaN(paid) || paid < 0) return 'Amount paid must be a number of 0 or more.'
  if (Number.isNaN(requested) || requested < 0) return 'Amount requested must be a number of 0 or more.'
  if (!description.trim() || description.trim().length < 5) return 'Please provide a short description (at least 5 characters).'
  if (!confirmation) return 'A trip confirmation email screenshot or PDF is required.'
  return null
}

function validateFile(file: File, allowPdf: boolean, prefix: string): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `${prefix} "${file.name}" exceeds the 10 MB limit.`
  }
  const type = fileContentType(file)
  // SVG excluded to match the Lambda: staff open evidence from a signed URL, where a scripted SVG would run.
  const ok = (type.startsWith('image/') && !type.startsWith('image/svg')) || (allowPdf && type === PDF_TYPE)
  if (!ok) {
    return allowPdf
      ? `${prefix} "${file.name}" must be an image (screenshot, photo) or a PDF.`
      : `${prefix} "${file.name}" must be an image.`
  }
  return null
}

export function DriverDisputesPage() {
  const { options: payPeriodOptions, defaultValue: defaultPayPeriod } = useMemo(() => buildPayPeriods(), [])

  const [driverName, setDriverName] = useState('')
  // Active drivers from the platform; empty (not configured / fetch failed) falls back to free text.
  const [drivers, setDrivers] = useState<string[]>([])
  const [driverNotListed, setDriverNotListed] = useState(false)
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

  useEffect(() => {
    if (!portalAvailable) return
    let cancelled = false
    listDrivers()
      .then((names) => { if (!cancelled) setDrivers(names) })
      .catch(() => { /* dropdown is a convenience; the text field still works */ })
    return () => { cancelled = true }
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
  const onConfirmationChange = (file: File | null) => {
    setSubmitError(null)
    setConfirmation(file)
  }

  const onPhotosChange = (incoming: File[]) => {
    setSubmitError(null)
    setPhotos((prev) => [...prev, ...incoming].slice(0, 5))
  }

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index))
  }

  const resetForm = () => {
    setDriverName('')
    setDriverNotListed(false)
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
      const fileErr = validateFile(confirmation, true, 'Confirmation file')
      if (!validation && fileErr) {
        setSubmitError(fileErr)
        setSubmitting(false)
        return
      }
    }
    let photoErr: string | null = null
    for (const photo of photos) {
      const err = validateFile(photo, false, 'Photo')
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
      const uploadEvidence = async (file: File, kind: ProofKind): Promise<EvidenceFile> => {
        const contentType = fileContentType(file)
        const meta = await getUploadUrl({ submissionId, fileName: file.name, contentType, size: file.size, kind })
        await uploadFileToS3(file, meta.uploadUrl, contentType)
        return { s3Key: meta.s3Key, fileName: file.name, contentType, size: file.size, kind }
      }
      const evidence: EvidenceFile[] = []
      if (confirmation) evidence.push(await uploadEvidence(confirmation, 'CONFIRMATION'))
      for (const photo of photos) evidence.push(await uploadEvidence(photo, 'PHOTO'))

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
        <div className="max-w-md text-center" style={{ marginLeft: 'auto', marginRight: 'auto', paddingLeft: 16, paddingRight: 16, paddingTop: 64, paddingBottom: 64 }}>
          <AlertTriangle size={40} style={{ color: 'var(--ds-amber)', marginLeft: 'auto', marginRight: 'auto', marginBottom: 16 }} />
          <h1 className="text-xl font-semibold" style={{ color: 'var(--ds-t1)', marginBottom: 8 }}>
            Dispute portal unavailable
          </h1>
          <p className="text-sm" style={{ color: 'var(--ds-t2)' }}>
            This page can't connect right now. The endpoint is not configured on this preview.
          </p>
          <p className="text-sm" style={{ color: 'var(--ds-muted-soft)', marginTop: 16 }}>
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
      <div className={PORTAL_COL} style={{ ...PORTAL_MAXW, marginLeft: 'auto', marginRight: 'auto', paddingLeft: 16, paddingRight: 16, paddingTop: 24, paddingBottom: 24 }}>
        <div style={{ marginBottom: 20 }}>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--ds-t1)' }}>
            Submit an Amazon pay dispute
          </h1>
          <p className="text-sm" style={{ color: 'var(--ds-t3)', marginTop: 4 }}>
            If Amazon paid less than expected, fill this out and upload your trip confirmation email.
            Amounts and evidence remain staff-only.
          </p>
        </div>

        <section aria-labelledby="dispute-form-title" style={cardStyle}>
          <h2 id="dispute-form-title" className="sr-only">
            Dispute form
          </h2>

          {submitSuccessId && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--ds-green-bg)', color: 'var(--ds-green)', marginBottom: 12, padding: 12 }}
            >
              <CheckCircle2 size={16} />
              <span>
                Dispute submitted. Reference: <span className="font-mono">{submitSuccessId}</span>
              </span>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)', marginBottom: 12, padding: 12 }}
            >
              <AlertTriangle size={16} />
              <span>{submitError}</span>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <div style={{ ...sectionLabel, marginBottom: 12 }}>
              Trip
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Driver name *" htmlFor="driverName">
                {drivers.length > 0 && !driverNotListed ? (
                  <select
                    id="driverName"
                    value={driverName}
                    onChange={(e) => {
                      if (e.target.value === DRIVER_NOT_LISTED) {
                        setDriverNotListed(true)
                        setDriverName('')
                      } else {
                        setDriverName(e.target.value)
                      }
                    }}
                    style={inputStyle}
                    className={inputClass}
                    required
                  >
                    <option value="">Select your name…</option>
                    {drivers.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value={DRIVER_NOT_LISTED}>My name isn't listed</option>
                  </select>
                ) : (
                  <>
                    <input
                      id="driverName"
                      type="text"
                      value={driverName}
                      onChange={(e) => setDriverName(e.target.value)}
                      placeholder="Jane Driver"
                      style={inputStyle}
                      className={inputClass}
                      required
                      autoFocus={driverNotListed}
                    />
                    {driverNotListed && (
                      <button
                        type="button"
                        onClick={() => { setDriverNotListed(false); setDriverName('') }}
                        className="text-xs font-medium"
                        style={{ marginTop: 6, color: 'var(--ds-blue)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        Back to the driver list
                      </button>
                    )}
                  </>
                )}
              </Field>

              <Field label="Trip number *" htmlFor="tripNumber">
                <input
                  id="tripNumber"
                  type="text"
                  value={tripNumber}
                  onChange={(e) => setTripNumber(e.target.value)}
                  placeholder="e.g. 1117J7TV9"
                  style={inputStyle}
                  className={inputClass}
                  required
                />
              </Field>

              <Field label="Pay period (Sunday-Saturday) *" htmlFor="payPeriod">
                <select
                  id="payPeriod"
                  value={payPeriod}
                  onChange={(e) => setPayPeriod(e.target.value)}
                  style={inputStyle}
                  className={inputClass}
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
                  className={inputClass}
                  required
                />
                {selectedPeriod && (
                  <span className="block text-xs" style={{ color: 'var(--ds-t3)', marginTop: 4 }}>
                    Must be between{' '}
                    <span className="font-mono">{toLocalDateString(selectedPeriod.start)}</span> and{' '}
                    <span className="font-mono">{toLocalDateString(selectedPeriod.end)}</span>.
                  </span>
                )}
              </Field>
            </div>

            <Field label="Short description *" htmlFor="description" style={{ marginTop: 16 }}>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened with this trip's pay?"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
                className={inputClass}
                required
              />
            </Field>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ ...sectionLabel, marginBottom: 12 }}>
              Amounts
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  className={inputClass}
                  required
                />
              </Field>

              <Field label="Amount we're requesting (USD) *" htmlFor="amountRequested">
                <input
                  id="amountRequested"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amountRequested}
                  onChange={(e) => setAmountRequested(e.target.value)}
                  placeholder="0.00"
                  style={inputStyle}
                  className={inputClass}
                  required
                />
              </Field>
            </div>
          </div>

          <div>
            <div style={{ ...sectionLabel, marginBottom: 12 }}>
              Evidence
            </div>
            <div className="rounded-xl" style={{ display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--ds-bg-2)', padding: 12 }}>
              <FileDrop
                id="confirmation"
                label="Trip confirmation email *"
                hint="Required. A screenshot, photo, or PDF of the confirmation email. Any image type works. Max 10 MB."
                accept="image/*,application/pdf"
                files={confirmation ? [confirmation] : []}
                onFiles={(files) => onConfirmationChange(files[0] ?? null)}
                onRemove={() => onConfirmationChange(null)}
                browseLabel={confirmation ? 'Replace file' : 'Browse files'}
              />

              <FileDrop
                id="photos"
                label="Optional photos"
                hint="Up to 5 images (any type), 10 MB each."
                accept="image/*"
                multiple
                files={photos}
                onFiles={onPhotosChange}
                onRemove={removePhoto}
                disabled={photos.length >= 5}
                browseLabel="Add photos"
              />
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="w-full sm:w-auto"
              style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}
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

          <p className="text-xs" style={{ color: 'var(--ds-muted-soft)', marginTop: 12 }}>
            Submission ID (kept across retries): <span className="font-mono">{submissionId}</span>
          </p>
        </section>

        {/* ── Shared status board ── */}
        <section aria-labelledby="board-title" style={{ ...cardStyle, marginTop: 20 }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" style={{ marginBottom: 12 }}>
            <div className="flex items-center gap-2">
              <h2 id="board-title" className="text-base font-semibold" style={{ color: 'var(--ds-t1)' }}>
                Shared dispute status board
              </h2>
              <span style={{ ...chipBase, background: 'var(--ds-bg-2)', color: 'var(--ds-t2)' }}>
                {filteredItems.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:flex-none">
                <Search
                  size={15}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--ds-muted-soft)' }}
                />
                <input
                  type="text"
                  value={boardSearch}
                  onChange={(e) => setBoardSearch(e.target.value)}
                  placeholder="Search name or trip…"
                  aria-label="Search disputes by driver or trip"
                  style={{ ...inputStyle, paddingLeft: 30, height: 38, minHeight: 38 }}
                  className={inputClass}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setBoardLoading(true)
                  setBoardError(null)
                  loadBoard()
                }}
                disabled={boardLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border text-sm font-medium"
                style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}
              >
                <RefreshCw size={15} className={boardLoading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {boardError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)', marginBottom: 12, padding: 12 }}
            >
              <AlertTriangle size={16} />
              <span>{boardError}</span>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'left',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Driver
                  </th>
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'left',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Trip
                  </th>
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'left',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Pay period
                  </th>
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'left',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Shipment
                  </th>
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'left',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Status
                  </th>
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
                      <td
                        style={{
                          padding: '10px 6px',
                          color: 'var(--ds-t2)',
                          fontFamily: 'var(--font-mono, monospace)',
                        }}
                      >
                        {item.tripNumber ?? '—'}
                      </td>
                      <td style={{ padding: '10px 6px', color: 'var(--ds-t2)' }}>
                        {item.payPeriod ? formatPayPeriod(item.payPeriod) : '—'}
                      </td>
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

        {/* Footer help card */}
        <div style={{ ...cardStyle, marginTop: 24, padding: '16px 18px', background: 'var(--ds-bg)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>
            Need a hand?
          </div>
          <div className="text-sm" style={{ color: 'var(--ds-t3)', marginTop: 4 }}>
            Questions about a dispute? Our team is happy to help.
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm" style={{ marginTop: 8 }}>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              style={{ color: 'var(--ds-blue)', fontWeight: 600, textDecoration: 'none' }}
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </div>
    </Shell>
  )
}

// ── Presentational helpers ─────────────────────────────────────────────────

function Shell({ children, driverName }: { children: React.ReactNode; driverName?: string }) {
  const initials = initialsOf(driverName ?? '')
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Black sticky top bar — carrier identity, always visible while the driver scrolls. */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: '#0e1116',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex w-full items-center gap-3" style={{ ...PORTAL_MAXW, marginLeft: 'auto', marginRight: 'auto', paddingLeft: 16, paddingRight: 16, height: 60 }}>
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
          <div className="flex items-center gap-3" style={{ marginLeft: 'auto' }}>
            <a
              href="/disputes"
              className="text-sm font-semibold hover:underline"
              style={{ color: 'var(--ds-blue)', textDecoration: 'none' }}
            >
              Staff view
            </a>
            {initials && (
              <div
                className="flex items-center justify-center"
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
        </div>
      </header>
      {/* Center the content on the page — vertically + horizontally — and scroll when it's tall. */}
      <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: '100%', maxWidth: 720 }}>{children}</div>
      </main>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
  style,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  style?: CSSProperties
}) {
  return (
    <div style={style}>
      <label htmlFor={htmlFor} className="block text-sm font-medium" style={{ color: 'var(--ds-t1)', marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function FileDrop({
  id,
  label,
  hint,
  accept,
  multiple = false,
  disabled = false,
  files,
  onFiles,
  onRemove,
  browseLabel,
}: {
  id: string
  label: string
  hint: string
  accept: string
  multiple?: boolean
  disabled?: boolean
  files: File[]
  onFiles: (files: File[]) => void
  onRemove: (index: number) => void
  browseLabel: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const take = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    if (picked.length) onFiles(multiple ? picked : picked.slice(0, 1))
  }

  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--ds-t1)', marginBottom: 4 }}>
        <Upload size={16} /> {label}
      </label>
      <p className="text-xs" style={{ color: 'var(--ds-t3)', marginBottom: 8 }}>
        {hint}
      </p>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (!disabled) take(e.dataTransfer.files)
        }}
        className="flex flex-col items-center justify-center gap-2 rounded-lg text-center"
        style={{
          border: `2px dashed ${dragging ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 20,
          paddingBottom: 20,
          background: dragging ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'border-color 120ms, background 120ms',
        }}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => {
            take(e.target.files)
            e.target.value = '' // allow re-picking the same file after Remove
          }}
          // A <label htmlFor> click lands here and would bubble to the zone's onClick -> second picker.
          onClick={(e) => e.stopPropagation()}
          className="sr-only"
        />
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: 'var(--ds-blue-bg)', color: 'var(--ds-blue-dark)' }}
        >
          <Upload size={18} />
        </div>
        <span
          className="inline-flex items-center rounded-md text-sm font-semibold"
          style={{ background: 'var(--ds-blue)', color: '#fff', pointerEvents: 'none', paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8 }}
        >
          {browseLabel}
        </span>
        <span className="text-xs" style={{ color: 'var(--ds-t3)' }}>
          {disabled ? 'Maximum reached' : 'or drag and drop here'}
        </span>
      </div>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
          {files.map((file, i) => (
            <li
              key={`${file.name}-${file.size}-${i}`}
              className="flex items-center gap-2 rounded-md border text-xs"
              style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}
            >
              <PhotoPreview file={file} />
              <span className="max-w-[160px] truncate">{file.name}</span>
              <span className="font-mono" style={{ color: 'var(--ds-t3)' }}>
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="rounded font-medium"
                style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 }}
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PhotoPreview({ file }: { file: File }) {
  // Browsers can't decode every image type we accept (HEIC on Chrome/Firefox); fall back to an icon.
  const [url, setUrl] = useState<string | null>(() =>
    fileContentType(file).startsWith('image/') ? URL.createObjectURL(file) : null,
  )
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  if (!url) return <FileText size={14} style={{ color: 'var(--ds-t3)' }} />
  return (
    <img
      src={url}
      alt="Photo preview"
      width={32}
      height={32}
      className="rounded object-cover"
      onError={() => setUrl(null)}
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
