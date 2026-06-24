import { useState, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, Upload, Trash2, Settings, Download, Pencil, FileText, Mail, Boxes, CalendarDays, GripVertical, DownloadCloud } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useBoxTruckPay, type BoxTruckPayRow, type BoxTruckTrip } from '@/hooks/useBoxTruckPay'
import { tripPayAmount } from '@/lib/driverPay'
import { persistDragOrder } from '@/lib/calendarOrder'
import { buildBoxTruckPayStatementPdf, boxTruckPdfFilename, pdfToBase64 } from '@/lib/payPdfBoxTruck'
import { sendDriverPayEmail } from '@/lib/apiClient'
import { getColor } from '@/lib/driverColors'
import { currentPeriodStart, shiftPeriod, periodEnd, periodLabelLong } from '@/lib/biweekly'
import type { Driver } from '@/types'
import { TripModal, ImportModal, SettingsModal } from './BoxTruckPayForms'
import { DeductionModal, EmailModal } from '../driver-pay/DriverPayForms'

const PAY_EMAIL_CC = 'ryne@bcatcorp.com'
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const getInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'
const pct = (n: number) => `${Math.round(n * 100)}%`
const fmtShort = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : '—')

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--ds-t1)', padding: '7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function statementCsv(row: BoxTruckPayRow, periodStart: string): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const L: string[] = []
  L.push(q(`${row.driver.name} — pay period ${periodLabelLong(periodStart)}`)); L.push('')
  L.push(['Source', 'Date', 'Aljex PRO #', 'PU / TMS #', 'Customer', 'Status', 'Gross Profit', 'Driver Amount'].map(q).join(','))
  for (const t of row.trips) {
    L.push([t.loadId ? 'calendar' : 'manual', t.date, t.aljexPro, t.proNumber, t.customer, t.status, t.grossProfit, tripPayAmount(t.grossProfit, row.setting)].map(q).join(','))
  }
  L.push(['', '', '', '', '', q('Gross'), q(row.statement.gross), q(row.statement.driverAmount)].join(','))
  L.push(''); L.push([q('Deductions'), q('Amount')].join(','))
  for (const d of row.deductions) L.push([q(d.label), q(d.amount)].join(','))
  L.push([q('Total deductions'), q(row.statement.totalDeductions)].join(','))
  L.push(''); L.push([q('CHECK AMOUNT'), q(row.statement.checkAmount)].join(','))
  return L.join('\n')
}
function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function BoxTruckPayPage() {
  const [periodStart, setPeriodStart] = useState(currentPeriodStart)
  const pay = useBoxTruckPay(periodStart)

  const [tripModal, setTripModal] = useState<{ driverId: string } | null>(null)
  const [editTrip, setEditTrip]   = useState<BoxTruckTrip | null>(null)
  const [importDriver, setImport] = useState<string | null>(null)
  const [dedDriver, setDedDriver] = useState<string | null>(null)
  const [settingsFor, setSettings] = useState<Driver | null>(null)
  const [emailFor, setEmailFor]   = useState<BoxTruckPayRow | null>(null)
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null)

  const isThisPeriod = periodStart === currentPeriodStart()
  const selectedRow = pay.rows.find((r) => r.driver.id === selectedDriverId) ?? pay.rows[0] ?? null

  const handleClearPeriod = async () => {
    if (pay.tripCount === 0) return
    if (!window.confirm(`Delete all ${pay.tripCount} shipment${pay.tripCount !== 1 ? 's' : ''} filed under ${periodLabelLong(periodStart)}?\n\nSettings, fuel and expenses are untouched. You can re-pull from the calendar afterward.`)) return
    try {
      const n = await pay.clearPeriod()
      toast.success(`Cleared ${n} shipment${n !== 1 ? 's' : ''} from ${periodLabelLong(periodStart)}`)
    } catch (e) {
      toast.error(`Couldn't clear the period: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const handlePull = async (driverId: string) => {
    try {
      const n = await pay.pullFromCalendar(driverId)
      toast.success(n ? `Pulled ${n} load${n !== 1 ? 's' : ''} from the calendar` : 'No new loads to pull for this period')
    } catch (e) {
      toast.error(`Couldn't pull from the calendar: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  const handlePdf = async (row: BoxTruckPayRow) => {
    try { (await buildBoxTruckPayStatementPdf(row, periodStart)).save(boxTruckPdfFilename(row, periodStart)) }
    catch (e) { toast.error(`Couldn't build PDF: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }
  const preparePdf = async (row: BoxTruckPayRow) => {
    const doc = await buildBoxTruckPayStatementPdf(row, periodStart)
    return { base64: pdfToBase64(doc), blobUrl: doc.output('bloburl').toString() }
  }
  const handleSendEmail = async (row: BoxTruckPayRow, fields: { to: string; cc: string; subject: string; bodyText: string; pdfBase64: string }) => {
    const res = await sendDriverPayEmail({
      to: fields.to, cc: fields.cc || undefined, subject: fields.subject || undefined, bodyText: fields.bodyText || undefined,
      driverName: row.driver.name, periodLabel: periodLabelLong(periodStart), filename: boxTruckPdfFilename(row, periodStart), pdfBase64: fields.pdfBase64,
    })
    if (!res.sent) throw new Error(res.error || 'The email service rejected the message')
    toast.success(`Sent to ${fields.to}${fields.cc ? ` (cc ${fields.cc})` : ''}`)
    setEmailFor(null)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 32px 12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Boxes size={20} /> Driver Pay — Box Trucks</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>Biweekly (Wed→Tue) — pull each driver's delivered loads from the calendar, then edit/reorder · % of net after expenses</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {pay.tripCount > 0 && (
              <button onClick={handleClearPeriod} title="Delete all shipments for this period"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-red, #dc2626)', background: 'var(--ds-surface)', color: 'var(--ds-red, #dc2626)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                <Trash2 size={15} /> Clear period ({pay.tripCount})
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button style={navBtn} onClick={() => setPeriodStart((p) => shiftPeriod(p, -1))} aria-label="Previous period"><ChevronLeft size={16} /></button>
              <button onClick={() => setPeriodStart(currentPeriodStart())} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: isThisPeriod ? 'var(--ds-bg)' : 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>This period</button>
              <button style={{ ...navBtn, opacity: isThisPeriod ? 0.4 : 1 }} onClick={() => !isThisPeriod && setPeriodStart((p) => shiftPeriod(p, 1))} disabled={isThisPeriod} aria-label="Next period"><ChevronRight size={16} /></button>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 180, textAlign: 'right' }}>{periodLabelLong(periodStart)}</span>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px', maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pay.loading && pay.rows.length === 0 && <div style={{ color: 'var(--ds-t3)', fontSize: 14, padding: 40, textAlign: 'center' }}>Loading…</div>}
        {pay.error && <div style={{ color: '#dc2626', fontSize: 13, padding: 12, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2' }}>{pay.error}</div>}

        {!pay.loading && pay.rows.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '60px 0', color: 'var(--ds-t3)' }}>
            <Boxes size={36} style={{ opacity: 0.2 }} />
            <p style={{ fontSize: 14, fontWeight: 500 }}>No box-truck drivers set up for pay yet.</p>
            <p style={{ fontSize: 12.5 }}>Configure a driver below (e.g. Zak) to start tracking biweekly pay.</p>
          </div>
        )}

        {pay.rows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {pay.rows.map((r) => {
              const active = selectedRow?.driver.id === r.driver.id
              const color = getColor(r.driver.colorKey)
              return (
                <button key={r.driver.id} onClick={() => setSelectedDriverId(r.driver.id)} title={r.driver.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 10, border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`, background: active ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)', cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? 'var(--sh-sm)' : 'none' }}>
                  <Avatar src={r.driver.photoUrl} initials={getInitials(r.driver.name)} size="xs" style={{ background: color.avatarBg, color: '#fff' }} />
                  <span style={{ fontSize: 13, fontWeight: active ? 700 : 600, color: 'var(--ds-t1)' }}>{r.driver.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: r.statement.checkAmount >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(r.statement.checkAmount)}</span>
                </button>
              )
            })}
          </div>
        )}

        {selectedRow && (
          <StatementCard
            key={selectedRow.driver.id}
            row={selectedRow}
            onPull={() => handlePull(selectedRow.driver.id)}
            onAddTrip={() => setTripModal({ driverId: selectedRow.driver.id })}
            onImport={() => setImport(selectedRow.driver.id)}
            onAddDeduction={() => setDedDriver(selectedRow.driver.id)}
            onSettings={() => setSettings(selectedRow.driver)}
            onEditTrip={setEditTrip}
            onRemoveTrip={pay.removeTrip}
            onRemoveDeduction={pay.removeDeduction}
            onUpdateTrip={(id, patch) => { void pay.updateTrip(id, patch) }}
            onExport={() => download(`pay-${selectedRow.driver.name.replace(/\s+/g, '-')}-${periodStart}.csv`, statementCsv(selectedRow, periodStart))}
            onPdf={() => handlePdf(selectedRow)}
            onEmail={() => setEmailFor(selectedRow)}
          />
        )}

        {pay.unconfigured.length > 0 && (
          <div style={{ borderRadius: 12, border: '1px dashed var(--ds-border)', padding: '14px 16px', background: 'var(--ds-surface)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Set up a box-truck driver</div>
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
      </div>

      {tripModal && <TripModal driverId={tripModal.driverId} periodStart={periodStart} onSave={async (input) => { await pay.addTrip(input); setTripModal(null) }} onClose={() => setTripModal(null)} />}
      {editTrip && <TripModal driverId={editTrip.driverId} periodStart={editTrip.periodStart} initial={editTrip} onSave={async (input) => { await pay.updateTrip(editTrip.id, input); setEditTrip(null) }} onClose={() => setEditTrip(null)} />}
      {importDriver && <ImportModal driverId={importDriver} periodStart={periodStart} onImport={async (rows) => { for (const r of rows) await pay.addTrip(r); setImport(null) }} onClose={() => setImport(null)} />}
      {dedDriver && <DeductionModal driverId={dedDriver} periodStart={periodStart} onSave={async (input) => { await pay.addDeduction(input); setDedDriver(null) }} onClose={() => setDedDriver(null)} />}
      {settingsFor && <SettingsModal driver={settingsFor} existing={pay.rows.find((r) => r.driver.id === settingsFor.id)?.setting} onSave={async (patch) => { await pay.saveSetting(settingsFor.id, patch); setSettings(null) }} onClose={() => setSettings(null)} />}
      {emailFor && (() => {
        const r = emailFor
        const firstName = r.driver.name.trim().split(/\s+/)[0] || 'there'
        return (
          <EmailModal driverName={r.driver.name} defaultTo={r.setting.email || r.driver.email || ''} defaultCc={PAY_EMAIL_CC}
            defaultSubject={`Settlement — ${periodLabelLong(periodStart)}`}
            defaultBody={`Hi ${firstName},\n\nPlease find your settlement for ${fmtShort(periodStart)} through ${fmtShort(periodEnd(periodStart))} attached.\n\n— Ivan Cartage`}
            filename={boxTruckPdfFilename(r, periodStart)} preparePdf={() => preparePdf(r)} onSend={(fields) => handleSendEmail(r, fields)} onClose={() => setEmailFor(null)} />
        )
      })()}
    </div>
  )
}

// ── One driver's biweekly statement ─────────────────────────────────────────
function StatementCard({ row, onPull, onAddTrip, onImport, onAddDeduction, onSettings, onEditTrip, onRemoveTrip, onRemoveDeduction, onExport, onPdf, onEmail, onUpdateTrip }: {
  row: BoxTruckPayRow
  onPull: () => void; onAddTrip: () => void; onImport: () => void; onAddDeduction: () => void; onSettings: () => void
  onEditTrip: (t: BoxTruckTrip) => void
  onRemoveTrip: (id: string) => void; onRemoveDeduction: (id: string) => void; onExport: () => void
  onPdf: () => void; onEmail: () => void
  onUpdateTrip: (id: string, patch: { sortOrder: number }) => void
}) {
  const { driver, setting, statement, oneOffs } = row
  const dragId = useRef<string | null>(null)
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const trips = useMemo(() => {
    if (!dragOrder) return row.trips
    const byId = new Map(row.trips.map((t) => [t.id, t]))
    return dragOrder.map((id) => byId.get(id)).filter(Boolean) as typeof row.trips
  }, [row.trips, dragOrder])

  const onTripDragStart = (id: string) => { dragId.current = id; setDragOrder(row.trips.map((t) => t.id)) }
  const onTripDragEnter = (targetId: string) => {
    const d = dragId.current
    if (!d || d === targetId) return
    setOverId(targetId)
    setDragOrder((prev) => {
      const ids = prev ?? row.trips.map((t) => t.id)
      const from = ids.indexOf(d), to = ids.indexOf(targetId)
      if (from < 0 || to < 0 || from === to) return ids
      const next = [...ids]; next.splice(from, 1); next.splice(to, 0, d); return next
    })
  }
  const onTripDragEnd = () => {
    if (dragOrder) persistDragOrder(dragOrder, (id) => row.trips.find((t) => t.id === id)?.sortOrder, onUpdateTrip)
    dragId.current = null; setOverId(null); setDragOrder(null)
  }

  const color = getColor(driver.colorKey)
  const modeLabel = setting.expensesBeforePercent ? `${pct(setting.payPercent)} of net (after expenses)` : `${pct(setting.payPercent)} of gross − expenses`
  const iconBtn = (onClick: () => void, Icon: typeof Plus, lbl: string) => (
    <button onClick={onClick} title={lbl} aria-label={lbl} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}><Icon size={13} /> {lbl}</button>
  )

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)', background: 'var(--ds-surface)' }}>
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        <button onClick={onPull} title="Pull this driver's delivered loads for the period"
          style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
          <DownloadCloud size={14} /> Pull from calendar{row.unpulledLoadCount ? ` (${row.unpulledLoadCount})` : ''}
        </button>
        {iconBtn(onAddTrip, Plus, 'Add shipment')}
        {iconBtn(onImport, Upload, 'Import')}
        {iconBtn(onAddDeduction, Plus, 'Add expense')}
        {iconBtn(onExport, Download, 'CSV')}
        {iconBtn(onPdf, FileText, 'PDF')}
        {iconBtn(onEmail, Mail, 'Email')}
        <div style={{ flex: 1 }} />
        {iconBtn(onSettings, Settings, 'Settings')}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <th style={{ ...TH, textAlign: 'left' }}>Date</th>
            <th style={{ ...TH, textAlign: 'left' }}>Aljex PRO #</th>
            <th style={{ ...TH, textAlign: 'left' }}>PU / TMS #</th>
            <th style={{ ...TH, textAlign: 'left' }}>Customer</th>
            <th style={{ ...TH, textAlign: 'left' }}>Status</th>
            <th style={TH}>Gross Profit</th>
            <th style={TH}>Amount</th>
            <th style={{ ...TH, width: 64 }}></th>
          </tr></thead>
          <tbody>
            {trips.length === 0 && <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 18 }}>No shipments yet. Click <b>Pull from calendar</b> to load what {driver.name} delivered this period, or add one manually.</td></tr>}
            {trips.map((t) => {
              const fromCal = !!t.loadId
              return (
                <tr key={t.id} onDragEnter={() => onTripDragEnter(t.id)} onDragOver={(e) => e.preventDefault()}
                  style={{ borderBottom: '1px solid var(--ds-border)', background: overId === t.id ? 'var(--ds-blue-bg, #eff6ff)' : undefined, opacity: dragId.current === t.id && dragOrder ? 0.5 : 1 }}>
                  <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', cursor: 'pointer' }}>
                    {fromCal && <CalendarDays size={11} style={{ color: 'var(--ds-blue)', verticalAlign: '-1px', marginRight: 4 }} aria-label="From calendar" />}
                    {fmtShort(t.date ?? '')}
                  </td>
                  <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, cursor: 'pointer' }}>{t.aljexPro || '—'}</td>
                  <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', color: 'var(--ds-t2)', cursor: 'pointer' }}>{t.proNumber || '—'}</td>
                  <td onClick={() => onEditTrip(t)} style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }}>{t.customer || '—'}</td>
                  <td style={{ ...TD, textAlign: 'left', color: t.status === 'COVERED' ? '#b45309' : 'var(--ds-t2)' }}>{t.status || '—'}</td>
                  <td style={TD}>{money(t.grossProfit)}</td>
                  <td style={{ ...TD, fontWeight: 600 }}>{money(tripPayAmount(t.grossProfit, setting))}</td>
                  <td style={{ ...TD, padding: '7px 4px', whiteSpace: 'nowrap' }}>
                    <span draggable onDragStart={() => onTripDragStart(t.id)} onDragEnd={onTripDragEnd} title="Drag to reorder" aria-label="Drag to reorder" style={{ display: 'inline-flex', cursor: 'grab', color: 'var(--ds-t3)', padding: '0 2px', verticalAlign: 'middle' }}><GripVertical size={13} /></span>
                    <button onClick={() => onEditTrip(t)} title="Edit shipment" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px' }}><Pencil size={13} /></button>
                    <button onClick={() => onRemoveTrip(t.id)} title="Remove shipment" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px' }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              )
            })}
            {trips.length > 0 && (
              <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontWeight: 700 }}>
                <td style={{ ...TD, textAlign: 'left' }} colSpan={5}>Gross profit / driver share ({pct(setting.payPercent)})</td>
                <td style={TD}>{money(statement.gross)}</td>
                <td style={TD}>{money(statement.driverAmount)}</td><td></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
                  {oneOff ? <button onClick={() => onRemoveDeduction(oneOff.id)} title="Remove" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Trash2 size={12} /></button> : <span style={{ width: 16 }} />}
                </div>
              )
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 4, paddingTop: 6 }}>
              <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Total deductions</span>
              <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>({money(statement.totalDeductions)})</span>
              <span style={{ width: 16 }} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
