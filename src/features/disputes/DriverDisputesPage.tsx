import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Search } from 'lucide-react'
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
import { fileContentType } from '@/lib/disputeFiles'
import { addDays, formatPayPeriod, formatWeekLabel, toLocalDateString } from '@/lib/payPeriod'
import { FileDrop } from './FileDrop'
import { staffSupportingFileRejection } from './disputeEvidence'

const TITLE_BASE = 'Ivan Cartage — Amazon Dispute Portal'
const CONTACT_EMAIL = 'help@bcatcorp.com'

type PortalView = 'submit' | 'board'
type BoardFilter = 'all' | 'pending' | 'denied' | 'resolved'
// Driver-facing grouping of the staff statuses: "Filed with Amazon" is still pending from the
// driver's point of view.
const BOARD_FILTERS: { key: BoardFilter; label: string; statuses: BoardItem['status'][] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'pending', label: 'Pending', statuses: ['PENDING', 'POSTED'] },
  { key: 'denied', label: 'Denied', statuses: ['REJECTED'] },
  { key: 'resolved', label: 'Resolved', statuses: ['PAID'] },
]

const PAY_PERIOD_WEEKS = 104
const POLL_MS = 30000
const DRIVER_NOT_LISTED = '__not_listed__'
// The confirmation plus the five supporting files the portal API accepts.
const MAX_EVIDENCE_FILES = 6

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

/** A blank amount means $0 - a driver paid nothing shouldn't have to type it. */
function parseAmount(value: string): number {
  return value.trim() === '' ? 0 : Number.parseFloat(value)
}

function validateForm(
  driverName: string,
  tripNumber: string,
  payPeriod: string,
  shipmentDate: string,
  amountPaid: string,
  amountRequested: string,
  description: string,
  evidenceCount: number,
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
  const paid = parseAmount(amountPaid)
  const requested = parseAmount(amountRequested)
  if (Number.isNaN(paid) || paid < 0) return 'Amount paid must be a number of 0 or more.'
  if (Number.isNaN(requested) || requested < 0) return 'Amount requested must be a number of 0 or more.'
  if (!description.trim() || description.trim().length < 5) return 'Please provide a short description (at least 5 characters).'
  if (evidenceCount === 0) return 'Attach your trip confirmation email — a screenshot, photo, or PDF.'
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
  // One evidence list: the first file is the trip confirmation, the rest back it up.
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([])
  const [submissionId, setSubmissionId] = useState(() => uuid())

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccessId, setSubmitSuccessId] = useState<string | null>(null)

  const [boardItems, setBoardItems] = useState<BoardItem[]>([])
  const [boardLoading, setBoardLoading] = useState(true)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [boardSearch, setBoardSearch] = useState('')
  const requestGenRef = useRef(0)

  // Top-level tab, shareable as ?tab=board (staff link drivers straight to the board).
  const [searchParams, setSearchParams] = useSearchParams()
  const view: PortalView = searchParams.get('tab') === 'board' ? 'board' : 'submit'
  const setView = (next: PortalView) =>
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next === 'board') p.set('tab', 'board')
      else p.delete('tab')
      return p
    }, { replace: true })
  const [boardFilter, setBoardFilter] = useState<BoardFilter>('all')

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

  const sortedItems = useMemo(
    // Pages arrive in scan order; sort the assembled list so newest shipments lead.
    () => [...boardItems].sort(
      (a, b) => (b.shipmentDate ?? '').localeCompare(a.shipmentDate ?? '') || a.driverName.localeCompare(b.driverName),
    ),
    [boardItems],
  )
  const filterCounts = useMemo(() => {
    const counts = {} as Record<BoardFilter, number>
    for (const f of BOARD_FILTERS) {
      counts[f.key] = f.statuses ? sortedItems.filter((i) => f.statuses!.includes(i.status)).length : sortedItems.length
    }
    return counts
  }, [sortedItems])
  const filteredItems = useMemo(() => {
    const statuses = BOARD_FILTERS.find((f) => f.key === boardFilter)?.statuses ?? null
    const q = boardSearch.trim().toLowerCase()
    return sortedItems.filter(
      (item) =>
        (!statuses || statuses.includes(item.status)) &&
        (!q || item.driverName.toLowerCase().includes(q) || (item.tripNumber ?? '').toLowerCase().includes(q)),
    )
  }, [sortedItems, boardFilter, boardSearch])

  // ── Form handlers ---------------------------------------------------------
  const onEvidenceChange = (incoming: File[]) => {
    setSubmitError(null)
    setEvidenceFiles((prev) => [...prev, ...incoming].slice(0, MAX_EVIDENCE_FILES))
  }

  const removeEvidence = (index: number) => {
    setEvidenceFiles((prev) => prev.filter((_, i) => i !== index))
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
    setEvidenceFiles([])
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
      evidenceFiles.length,
      payPeriodOptions,
    )
    const fileErr = evidenceFiles.map((file) => staffSupportingFileRejection(file)).find(Boolean)
    if (!validation && fileErr) {
      setSubmitError(fileErr)
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
      // Exactly one CONFIRMATION is required by the portal API; the first file is it.
      const evidence: EvidenceFile[] = []
      for (const [index, file] of evidenceFiles.entries()) {
        evidence.push(await uploadEvidence(file, index === 0 ? 'CONFIRMATION' : 'PHOTO'))
      }

      const result = await submitDispute({
        submissionId,
        driverName: driverName.trim(),
        tripNumber: tripNumber.trim(),
        payPeriod,
        shipmentDate,
        amountPaid: parseAmount(amountPaid),
        amountRequested: parseAmount(amountRequested),
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

  const tabStyle = (active: boolean): CSSProperties => ({
    padding: '9px 16px',
    borderRadius: 9,
    fontSize: 14,
    fontWeight: 600,
    border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
    background: active ? 'var(--ds-blue)' : 'var(--ds-surface)',
    color: active ? '#fff' : 'var(--ds-t2)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  })
  const filterStyle = (active: boolean): CSSProperties => ({
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${active ? 'var(--ds-blue-dark)' : 'var(--ds-border)'}`,
    background: active ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
    color: active ? 'var(--ds-blue-dark)' : 'var(--ds-t2)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  })

  return (
    <Shell driverName={driverName}>
      <div className={PORTAL_COL} style={{ ...PORTAL_MAXW, marginLeft: 'auto', marginRight: 'auto', paddingLeft: 16, paddingRight: 16, paddingTop: 24, paddingBottom: 24 }}>
        <div role="tablist" aria-label="Portal sections" className="flex gap-2" style={{ marginBottom: 20 }}>
          <button type="button" role="tab" aria-selected={view === 'submit'} onClick={() => setView('submit')} style={tabStyle(view === 'submit')}>
            Submit a dispute
          </button>
          <button type="button" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')} style={tabStyle(view === 'board')}>
            Status board
            <span style={{ ...chipBase, marginLeft: 8, background: view === 'board' ? 'rgba(255,255,255,0.22)' : 'var(--ds-bg-2)', color: view === 'board' ? '#fff' : 'var(--ds-t2)' }}>
              {filterCounts.all}
            </span>
          </button>
        </div>

        {view === 'submit' && (<>
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
              <Field label="Amount Amazon paid (USD)" htmlFor="amountPaid">
                <input
                  id="amountPaid"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  placeholder="0.00 - leave blank if nothing was paid"
                  style={inputStyle}
                  className={inputClass}
                />
              </Field>

              <Field label="Amount we're requesting (USD)" htmlFor="amountRequested">
                <input
                  id="amountRequested"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amountRequested}
                  onChange={(e) => setAmountRequested(e.target.value)}
                  placeholder="0.00 - leave blank if unsure"
                  style={inputStyle}
                  className={inputClass}
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
                id="evidence"
                label="Trip confirmation email and any other photos for proof *"
                hint="Required. Start with the confirmation email — a screenshot, photo, or PDF — then add up to five more files as proof. 10 MB each."
                accept="image/*,application/pdf"
                multiple
                files={evidenceFiles}
                onFiles={onEvidenceChange}
                onRemove={removeEvidence}
                disabled={evidenceFiles.length >= MAX_EVIDENCE_FILES}
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
        </>)}

        {/* ── Shared status board ── */}
        {view === 'board' && (
        <section aria-labelledby="board-title" style={cardStyle}>
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
          <div role="tablist" aria-label="Filter disputes by status" className="flex flex-wrap gap-2" style={{ marginBottom: 12 }}>
            {BOARD_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={boardFilter === f.key}
                onClick={() => setBoardFilter(f.key)}
                style={filterStyle(boardFilter === f.key)}
              >
                {f.label} <span style={{ opacity: 0.7, fontWeight: 500 }}>{filterCounts[f.key]}</span>
              </button>
            ))}
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
                  <th
                    className="uppercase"
                    style={{
                      textAlign: 'right',
                      padding: '8px 6px',
                      color: 'var(--ds-t3)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                    }}
                  >
                    Recovered
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>
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
                      <td
                        style={{
                          padding: '10px 6px',
                          color: 'var(--ds-t2)',
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {item.resolvedAmount == null ? '—' : formatCurrency(item.resolvedAmount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        )}

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

function formatDisplayDate(value: string): string {
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCurrency(dollars: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars)
}

function statusPill(status: BoardItem['status']) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING
  return (
    <span style={{ ...chipBase, background: meta.bg, color: meta.fg }}>
      {meta.label}
    </span>
  )
}
