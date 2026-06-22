import { useState, useRef, useMemo, useEffect } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, Upload, Trash2, Settings, Download, DollarSign, Pencil, FileUp, FileText, Mail, FileSpreadsheet, AlertTriangle } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useAmazonPay, periodEnd, type DriverPayRow, type AmazonTrip } from '@/hooks/useAmazonPay'
import { useAmazonPayMasters, type AmazonPayMaster } from '@/hooks/useAmazonPayMasters'
import { useAuth } from '@/hooks/useAuth'
import { useDrivers } from '@/hooks/useDrivers'
import { tripPayAmount } from '@/lib/driverPay'
import { buildPayStatementPdf, payPdfFilename, pdfToBase64 } from '@/lib/payPdf'
import { sendDriverPayEmail } from '@/lib/apiClient'
import { getColor } from '@/lib/driverColors'
import type { Driver } from '@/types'
import { sundayOf, shiftWeek, weekLabelLong } from './week'
import { TripModal, ImportModal, MasterImportModal, DeductionModal, SettingsModal, EmailModal } from './DriverPayForms'

// Owner is CC'd on every pay statement that goes out to a driver.
const PAY_EMAIL_CC = 'ryne@bcatcorp.com'

// "6/7" style short date for a YYYY-MM-DD (UTC-safe).
function fmtShortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
}

// Custom row order for the driver cards (drag-to-reorder), remembered per browser.
const ROW_ORDER_KEY = 'bcat.driverpay.order'
function loadRowOrder(): string[] {
  try { const v = JSON.parse(localStorage.getItem(ROW_ORDER_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
function getInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'
}
function pct(n: number): string { return `${Math.round(n * 100)}%` }

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--ds-t1)', padding: '7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

// ── CSV export ──────────────────────────────────────────────────────────────
function statementCsv(row: DriverPayRow, periodStart: string): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const L: string[] = []
  L.push(q(`${row.driver.name} — pay week ${weekLabelLong(periodStart)}`))
  L.push('')
  L.push(['Load ID', 'Origin', 'Destination', 'Miles', 'Equipment', 'Freight', 'Rate/mi', 'Dispatcher', 'Status', 'Amount'].map(q).join(','))
  for (const t of row.trips) {
    L.push([t.loadId, t.origin, t.destination, t.miles, t.equipment, t.freightAmount, t.ratePerMile, t.dispatcher, t.status, tripPayAmount(t.freightAmount, row.setting)].map(q).join(','))
  }
  L.push(['', '', '', '', '', q('Gross'), q(row.statement.gross), '', q(`Driver ${pct(row.setting.payPercent)}`), q(row.statement.driverAmount)].join(','))
  L.push('')
  L.push([q('Deductions'), q('Amount')].join(','))
  for (const d of row.deductions) L.push([q(d.label), q(d.amount)].join(','))
  L.push([q('Total deductions'), q(row.statement.totalDeductions)].join(','))
  L.push('')
  L.push([q('CHECK AMOUNT'), q(row.statement.checkAmount)].join(','))
  return L.join('\n')
}
function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function DriverPayPage() {
  const [periodStart, setPeriodStart] = useState(sundayOf)
  const pay = useAmazonPay(periodStart)
  const masters = useAmazonPayMasters()
  const { user } = useAuth()

  const { drivers } = useDrivers()
  const [tripModal, setTripModal]   = useState<{ driverId: string } | null>(null)
  const [editTrip, setEditTrip]     = useState<AmazonTrip | null>(null)
  const [importDriver, setImport]   = useState<string | null>(null)
  const [masterOpen, setMasterOpen] = useState(false)
  const [dedDriver, setDedDriver]   = useState<string | null>(null)
  const [settingsFor, setSettings]  = useState<Driver | null>(null)
  const [emailFor, setEmailFor]     = useState<DriverPayRow | null>(null)

  const isThisWeek = periodStart === sundayOf()

  // ── Drag-to-reorder the driver cards (persisted per browser) ────────────────
  const [rowOrder, setRowOrder] = useState<string[]>(loadRowOrder)
  useEffect(() => { try { localStorage.setItem(ROW_ORDER_KEY, JSON.stringify(rowOrder)) } catch { /* ignore */ } }, [rowOrder])
  const dragId = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null)

  const orderedRows = useMemo(() => {
    const idx = (id: string) => { const i = rowOrder.indexOf(id); return i === -1 ? Infinity : i }
    return [...pay.rows].sort((a, b) => idx(a.driver.id) - idx(b.driver.id) || a.driver.name.localeCompare(b.driver.name))
  }, [pay.rows, rowOrder])

  // Tab selection — keep the chosen driver across weeks; fall back to the first.
  const selectedRow = orderedRows.find((r) => r.driver.id === selectedDriverId) ?? orderedRows[0] ?? null

  const onRowDragStart = (id: string) => { dragId.current = id; setDraggingId(id) }
  const onRowDragEnter = (targetId: string) => {
    const d = dragId.current
    if (!d || d === targetId) return
    setOverId(targetId)
    const ids = orderedRows.map((r) => r.driver.id)
    const from = ids.indexOf(d), to = ids.indexOf(targetId)
    if (from === -1 || to === -1 || from === to) return
    const next = [...ids]; next.splice(from, 1); next.splice(to, 0, d)
    setRowOrder(next)
  }
  const onRowDragEnd = () => { dragId.current = null; setDraggingId(null); setOverId(null) }

  const handleClearWeek = async () => {
    if (pay.tripCount === 0) return
    if (!window.confirm(`Delete all ${pay.tripCount} trip${pay.tripCount !== 1 ? 's' : ''} filed under ${weekLabelLong(periodStart)}?\n\nThis only clears trips for this week — settings, fuel and expenses are untouched. You can then re-upload the CSV to the correct week.`)) return
    try {
      const n = await pay.clearWeek()
      toast.success(`Cleared ${n} trip${n !== 1 ? 's' : ''} from ${weekLabelLong(periodStart)}`)
    } catch (e) {
      toast.error(`Couldn't clear the week: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const handlePdf = async (row: DriverPayRow) => {
    try {
      const doc = await buildPayStatementPdf(row, periodStart)
      doc.save(payPdfFilename(row, periodStart))
    } catch (e) {
      toast.error(`Couldn't build PDF: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  // Send the statement with the (possibly edited) fields from the email modal.
  const handleSendEmail = async (row: DriverPayRow, fields: { to: string; cc: string; subject: string; bodyText: string }) => {
    const doc = await buildPayStatementPdf(row, periodStart)
    const res = await sendDriverPayEmail({
      to: fields.to,
      cc: fields.cc || undefined,
      subject: fields.subject || undefined,
      bodyText: fields.bodyText || undefined,
      driverName: row.driver.name,
      periodLabel: weekLabelLong(periodStart),
      filename: payPdfFilename(row, periodStart),
      pdfBase64: pdfToBase64(doc),
    })
    if (!res.sent) throw new Error(res.error || 'The email service rejected the message')
    toast.success(`Sent to ${fields.to}${fields.cc ? ` (cc ${fields.cc})` : ''}`)
    setEmailFor(null)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 32px 12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Driver Pay</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Amazon weekly pay — trips, expenses &amp; check amount</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setMasterOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              <FileUp size={15} /> Upload master CSV
            </button>
            {pay.tripCount > 0 && (
              <button onClick={handleClearWeek} title="Delete all trips for this week"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-red, #dc2626)', background: 'var(--ds-surface)', color: 'var(--ds-red, #dc2626)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                <Trash2 size={15} /> Clear week ({pay.tripCount})
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button style={navBtn} onClick={() => setPeriodStart((p) => shiftWeek(p, -1))} aria-label="Previous week"><ChevronLeft size={16} /></button>
              <button onClick={() => setPeriodStart(sundayOf())} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: isThisWeek ? 'var(--ds-bg)' : 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>This week</button>
              <button style={{ ...navBtn, opacity: isThisWeek ? 0.4 : 1 }} onClick={() => !isThisWeek && setPeriodStart((p) => shiftWeek(p, 1))} disabled={isThisWeek} aria-label="Next week"><ChevronRight size={16} /></button>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 180, textAlign: 'right' }}>{weekLabelLong(periodStart)}</span>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px', maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pay.loading && pay.rows.length === 0 && <div style={{ color: 'var(--ds-t3)', fontSize: 14, padding: 40, textAlign: 'center' }}>Loading…</div>}

        {!pay.loading && pay.rows.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '60px 0', color: 'var(--ds-t3)' }}>
            <DollarSign size={36} style={{ opacity: 0.2 }} />
            <p style={{ fontSize: 14, fontWeight: 500 }}>No Amazon drivers set up for pay yet.</p>
            <p style={{ fontSize: 12.5 }}>Configure a driver below to start tracking weekly pay.</p>
          </div>
        )}

        {/* Driver tabs — click to switch, drag to reorder */}
        {orderedRows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {orderedRows.map((r) => {
              const active = selectedRow?.driver.id === r.driver.id
              const color = getColor(r.driver.colorKey)
              const dups = r.duplicateTripIds.size > 0
              return (
                <button
                  key={r.driver.id}
                  draggable
                  onDragStart={() => onRowDragStart(r.driver.id)}
                  onDragEnter={() => onRowDragEnter(r.driver.id)}
                  onDragEnd={onRowDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={() => setSelectedDriverId(r.driver.id)}
                  title={r.driver.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 10,
                    border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                    background: active ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)',
                    cursor: 'grab', fontFamily: 'inherit', boxShadow: active ? 'var(--sh-sm)' : 'none',
                    opacity: draggingId === r.driver.id ? 0.45 : 1,
                    outline: overId === r.driver.id ? '2px solid var(--ds-blue)' : 'none', outlineOffset: -2,
                  }}
                >
                  <Avatar src={r.driver.photoUrl} initials={getInitials(r.driver.name)} size="xs" style={{ background: color.avatarBg, color: '#fff' }} />
                  <span style={{ fontSize: 13, fontWeight: active ? 700 : 600, color: 'var(--ds-t1)' }}>{r.driver.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: r.statement.checkAmount >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(r.statement.checkAmount)}</span>
                  {dups && <AlertTriangle size={12} style={{ color: '#dc2626' }} aria-label="Has possible duplicate trips" />}
                </button>
              )
            })}
          </div>
        )}

        {selectedRow && (
          <StatementCard
            key={selectedRow.driver.id}
            row={selectedRow}
            periodStart={periodStart}
            onAddTrip={() => setTripModal({ driverId: selectedRow.driver.id })}
            onImport={() => setImport(selectedRow.driver.id)}
            onAddDeduction={() => setDedDriver(selectedRow.driver.id)}
            onSettings={() => setSettings(selectedRow.driver)}
            onEditTrip={setEditTrip}
            onRemoveTrip={pay.removeTrip}
            onRemoveDeduction={pay.removeDeduction}
            onExport={() => download(`pay-${selectedRow.driver.name.replace(/\s+/g, '-')}-${periodStart}.csv`, statementCsv(selectedRow, periodStart))}
            onPdf={() => handlePdf(selectedRow)}
            onEmail={() => setEmailFor(selectedRow)}
          />
        )}

        {/* Unconfigured drivers */}
        {pay.unconfigured.length > 0 && (
          <div style={{ borderRadius: 12, border: '1px dashed var(--ds-border)', padding: '14px 16px', background: 'var(--ds-surface)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Set up a driver for pay</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {pay.unconfigured.map((d) => (
                <button key={d.id} onClick={() => setSettings(d)}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', cursor: 'pointer', fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit' }}>
                  <Avatar initials={getInitials(d.name)} size="xs" style={{ background: getColor(d.colorKey).avatarBg, color: '#fff' }} />
                  {d.name} <Plus size={13} style={{ color: 'var(--ds-blue)' }} />
                </button>
              ))}
            </div>
          </div>
        )}

        <MasterUploadsCard masters={masters} />
      </div>

      {tripModal && (
        <TripModal driverId={tripModal.driverId} periodStart={periodStart}
          onSave={async (input) => { await pay.addTrip(input); setTripModal(null) }}
          onClose={() => setTripModal(null)} />
      )}
      {editTrip && (
        <TripModal driverId={editTrip.driverId} periodStart={editTrip.periodStart} initial={editTrip}
          onSave={async (input) => { await pay.updateTrip(editTrip.id, input); setEditTrip(null) }}
          onClose={() => setEditTrip(null)} />
      )}
      {masterOpen && (
        <MasterImportModal periodStart={periodStart} drivers={drivers}
          onImport={async (rows) => { for (const r of rows) await pay.addTrip(r); setMasterOpen(false) }}
          onSetPeriod={setPeriodStart}
          onArchive={async (m) => {
            try { await masters.archive({ ...m, uploadedBy: user?.email ?? null }) }
            catch (e) { toast.error(`Saved trips, but couldn't archive the file: ${e instanceof Error ? e.message : 'unknown error'}`) }
          }}
          onClose={() => setMasterOpen(false)} />
      )}
      {importDriver && (
        <ImportModal driverId={importDriver} periodStart={periodStart}
          onImport={async (rows) => { for (const r of rows) await pay.addTrip(r); setImport(null) }}
          onSetPeriod={setPeriodStart}
          onClose={() => setImport(null)} />
      )}
      {dedDriver && (
        <DeductionModal driverId={dedDriver} periodStart={periodStart}
          onSave={async (input) => { await pay.addDeduction(input); setDedDriver(null) }}
          onClose={() => setDedDriver(null)} />
      )}
      {settingsFor && (
        <SettingsModal driver={settingsFor}
          existing={pay.rows.find((r) => r.driver.id === settingsFor.id)?.setting}
          onSave={async (patch) => { await pay.saveSetting(settingsFor.id, patch); setSettings(null) }}
          onClose={() => setSettings(null)} />
      )}
      {emailFor && (() => {
        const r = emailFor
        const firstName = r.driver.name.trim().split(/\s+/)[0] || 'there'
        const start = fmtShortDate(periodStart)
        const end = fmtShortDate(periodEnd(periodStart))
        return (
          <EmailModal
            driverName={r.driver.name}
            defaultTo={r.setting.email || r.driver.email || ''}
            defaultCc={PAY_EMAIL_CC}
            defaultSubject={`Settlement — ${weekLabelLong(periodStart)}`}
            defaultBody={`Hi ${firstName},\n\nPlease find your settlements for weeks ${start} through ${end} attached.\n\n— Ivan Cartage`}
            onSend={(fields) => handleSendEmail(r, fields)}
            onClose={() => setEmailFor(null)}
          />
        )
      })()}
    </div>
  )
}

// ── One driver's weekly statement ──────────────────────────────────────────────
function StatementCard({ row, onAddTrip, onImport, onAddDeduction, onSettings, onEditTrip, onRemoveTrip, onRemoveDeduction, onExport, onPdf, onEmail }: {
  row: DriverPayRow; periodStart: string
  onAddTrip: () => void; onImport: () => void; onAddDeduction: () => void; onSettings: () => void
  onEditTrip: (t: AmazonTrip) => void
  onRemoveTrip: (id: string) => void; onRemoveDeduction: (id: string) => void; onExport: () => void
  onPdf: () => void; onEmail: () => void
}) {
  const { driver, setting, trips, statement, oneOffs } = row
  const color = getColor(driver.colorKey)
  const modeLabel = setting.expensesBeforePercent ? `${pct(setting.payPercent)} after expenses` : `${pct(setting.payPercent)} of gross − expenses`

  const iconBtn = (onClick: () => void, Icon: typeof Plus, label: string) => (
    <button onClick={onClick} title={label} aria-label={label}
      style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
      <Icon size={13} /> {label}
    </button>
  )

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)', background: 'var(--ds-surface)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <Avatar src={driver.photoUrl} initials={getInitials(driver.name)} size="lg" style={{ background: color.avatarBg, color: '#fff' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{driver.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{modeLabel}{setting.email ? ` · ${setting.email}` : ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Check amount</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: statement.checkAmount >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(statement.checkAmount)}</div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        {iconBtn(onAddTrip, Plus, 'Add trip')}
        {iconBtn(onImport, Upload, 'Import')}
        {iconBtn(onAddDeduction, Plus, 'Add expense')}
        {iconBtn(onExport, Download, 'CSV')}
        {iconBtn(onPdf, FileText, 'PDF')}
        {iconBtn(onEmail, Mail, 'Email')}
        <div style={{ flex: 1 }} />
        {iconBtn(onSettings, Settings, 'Settings')}
      </div>

      {/* Trips */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <th style={{ ...TH, textAlign: 'left' }}>Load</th>
            <th style={{ ...TH, textAlign: 'left' }}>Route</th>
            <th style={TH}>Miles</th>
            <th style={TH}>Freight</th>
            <th style={TH}>Rate/mi</th>
            <th style={{ ...TH, textAlign: 'left' }}>Status</th>
            <th style={TH}>Amount</th>
            <th style={{ ...TH, width: 56 }}></th>
          </tr></thead>
          <tbody>
            {trips.length === 0 && <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 18 }}>No trips this week — add or import them.</td></tr>}
            {trips.map((t) => {
              const dup = row.duplicateTripIds.has(t.id)
              return (
              <tr key={t.id} style={{ borderBottom: '1px solid var(--ds-border)', background: dup ? 'var(--ds-red-bg, #fef2f2)' : undefined }} className="dp-trip-row">
                <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', cursor: 'pointer', color: dup ? '#dc2626' : undefined, fontWeight: dup ? 700 : undefined }} title={dup ? 'Duplicate — this Load ID also ran last week' : 'Click to edit'}>
                  {dup && <AlertTriangle size={12} style={{ color: '#dc2626', verticalAlign: '-1px', marginRight: 4 }} />}
                  {t.loadId || '—'}
                </td>
                <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}>{[t.origin, t.destination].filter(Boolean).join(' → ') || '—'}</td>
                <td style={TD}>{t.miles != null ? t.miles.toLocaleString() : '—'}</td>
                <td style={TD}>{money(t.freightAmount)}</td>
                <td style={TD}>{t.ratePerMile != null ? `$${t.ratePerMile.toFixed(2)}` : '—'}</td>
                <td style={{ ...TD, textAlign: 'left', color: t.status === 'Cancelled' ? '#dc2626' : 'var(--ds-t2)' }}>{t.status || '—'}</td>
                <td style={{ ...TD, fontWeight: 600 }}>{money(tripPayAmount(t.freightAmount, setting))}</td>
                <td style={{ ...TD, padding: '7px 4px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => onEditTrip(t)} title="Edit trip" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px' }}><Pencil size={13} /></button>
                  <button onClick={() => onRemoveTrip(t.id)} title="Remove trip" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px' }}><Trash2 size={13} /></button>
                </td>
              </tr>
            )})}
            {trips.length > 0 && (
              <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontWeight: 700 }}>
                <td style={{ ...TD, textAlign: 'left' }} colSpan={3}>Gross / driver share ({pct(setting.payPercent)})</td>
                <td style={TD} colSpan={3}>{money(statement.gross)}</td>
                <td style={TD}>{money(statement.driverAmount)}</td><td></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Deductions */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Deductions</div>
        {row.deductions.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No deductions. Fixed expenses come from Settings; fuel pulls from the card automatically.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {row.deductions.map((d, i) => {
              const oneOff = oneOffs.find((o) => o.label === d.label && o.amount === d.amount)
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                  <span style={{ flex: 1, color: 'var(--ds-t2)' }}>{d.label}</span>
                  <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>({money(d.amount)})</span>
                  {oneOff
                    ? <button onClick={() => onRemoveDeduction(oneOff.id)} title="Remove" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Trash2 size={12} /></button>
                    : <span style={{ width: 16 }} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, padding: '12px 16px', borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        <Total label="Total deductions" value={money(statement.totalDeductions)} negative />
        {setting.expensesBeforePercent && <Total label={`Subtotal × ${pct(setting.payPercent)}`} value={money(statement.subtotal)} />}
        <Total label="Check amount" value={money(statement.checkAmount)} strong color={statement.checkAmount >= 0 ? '#15803d' : '#dc2626'} />
      </div>
    </div>
  )
}

function Total({ label, value, negative, strong, color }: { label: string; value: string; negative?: boolean; strong?: boolean; color?: string }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: strong ? 18 : 14, fontWeight: strong ? 700 : 600, color: color ?? (negative ? '#dc2626' : 'var(--ds-t1)'), fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{negative ? `(${value})` : value}</div>
    </div>
  )
}

// ── Master uploads archive ──────────────────────────────────────────────────────
function fmtBytes(n?: number | null): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function MasterUploadsCard({ masters }: { masters: ReturnType<typeof useAmazonPayMasters> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const items = [...masters.masters].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))

  const onDelete = async (m: AmazonPayMaster) => {
    if (!window.confirm(`Delete the archived file "${m.fileName}"?\n\nThis removes the stored CSV only — imported trips stay.`)) return
    setBusy(m.id)
    try { await masters.remove(m) } catch (e) { toast.error(`Couldn't delete: ${e instanceof Error ? e.message : 'unknown error'}`) } finally { setBusy(null) }
  }
  const onDownload = async (m: AmazonPayMaster) => {
    setBusy(m.id)
    try { await masters.download(m) } catch (e) { toast.error(`Couldn't open file: ${e instanceof Error ? e.message : 'unknown error'}`) } finally { setBusy(null) }
  }

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <FileSpreadsheet size={16} style={{ color: 'var(--ds-blue)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Master uploads</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>Every uploaded master CSV, archived and downloadable</div>
        </div>
        {items.length > 0 && <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{items.length} file{items.length !== 1 ? 's' : ''}</span>}
      </div>

      {masters.loading && items.length === 0 ? (
        <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No uploads yet — files you import with “Upload master CSV” are kept here.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>File</th>
              <th style={{ ...TH, textAlign: 'left' }}>Pay week</th>
              <th style={{ ...TH, textAlign: 'left' }}>Uploaded</th>
              <th style={TH}>Trips</th>
              <th style={TH}>Drivers</th>
              <th style={TH}>Size</th>
              <th style={{ ...TH, width: 84 }}></th>
            </tr></thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <td style={{ ...TD, textAlign: 'left', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.fileName}>{m.fileName}</td>
                  <td style={{ ...TD, textAlign: 'left' }}>{weekLabelLong(m.periodStart)}</td>
                  <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)' }}>{fmtDateTime(m.uploadedAt)}{m.uploadedBy ? ` · ${m.uploadedBy}` : ''}</td>
                  <td style={TD}>{m.tripCount ?? '—'}</td>
                  <td style={TD}>{m.driverCount ?? '—'}</td>
                  <td style={{ ...TD, color: 'var(--ds-t3)' }}>{fmtBytes(m.sizeBytes)}</td>
                  <td style={{ ...TD, padding: '7px 8px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => onDownload(m)} disabled={busy === m.id} title="Download CSV" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}><Download size={14} /></button>
                    <button onClick={() => onDelete(m)} disabled={busy === m.id} title="Delete archived file" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
