import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, Download, Settings, Banknote, PlusCircle, Pencil, Trash2, AlertTriangle, Copy } from 'lucide-react'
import { OTR_FIELD_LABEL, type OtrRequiredField } from '@/lib/otrInvoice'
import { DRIVER_PORTAL_URL } from '@/lib/driverPortal'
import { Avatar } from '@/components/ui/avatar'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useOwnerOperatorPay, type OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import type { OwnerOpTrip } from '@/lib/ownerOperatorTrips'
import { tripPayAmount, FACTORING_FEE_LABEL } from '@/lib/driverPay'
import { mileageDeductionLine } from '@/lib/mileageDeduction'
import { creditLineLabel } from '@/lib/payCredits'
import { payCreditsDeployed, type DriverPayCredit } from '@/lib/apiClient'
import { getColor } from '@/lib/driverColors'
import { weekLabelLong, sundayOf, shiftWeek } from '@/features/driver-pay/week'
import type { Driver } from '@/types'
import { SettingsModal, CreditModal } from './OwnerOperatorPayForms'
import { DeductionModal, WeeklyMileageRow } from '../driver-pay/DriverPayForms'
import { SendDriverInvite } from './SendDriverInvite'
import { SettlementDocUpload } from './SettlementDocUpload'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { PAY_HOLD_LABEL, type PayHoldReason } from '@/lib/payHold'

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const getInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'
const pct = (n: number) => `${Math.round(n * 100)}%`
const fmtShort = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : '—')

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--ds-t1)', padding: '7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
// Missing factoring data is a blocked dollar, so it is rendered in the same amber the
// page already uses for warnings rather than hidden behind an empty cell.
const MISSING: React.CSSProperties = { color: '#b45309', fontWeight: 600 }

/** The address a driver signs into the PWA with: Driver.email wins, else the pay setting's. */
function driverSignInEmail(row: OwnerOperatorPayRow): string {
  // An empty string is not a value — '' must fall through to the other source.
  return row.driver.email?.trim() || row.setting.email?.trim() || ''
}

/** One OTR field for a trip: the resolved value, or the field label in warning style. */
function OtrCell({ trip, field }: { trip: OwnerOpTrip; field: OtrRequiredField }) {
  const value = trip.readiness?.payload[field]
  if (value === undefined) return <span style={MISSING} title={`Missing: ${OTR_FIELD_LABEL[field]}`}>{OTR_FIELD_LABEL[field]}</span>
  return <>{field === 'InvoiceAmount' ? money(Number(value)) : String(value)}</>
}

/**
 * POD / rate confirmation presence. A missing document is an upload button rather than
 * a dead amber label, because this row is where someone finds out it is missing.
 *
 * Only the POD is amber. It is the one the driver owes and the one that holds their pay;
 * the rate confirmation is collected by the office at factoring, so it reads as an
 * ordinary to-do here.
 */
function OtrDoc({
  trip, kind, driver, staffEmail, onUploaded,
}: {
  trip: OwnerOpTrip
  kind: 'POD' | 'Rate confirmation'
  driver: Pick<Driver, 'id' | 'name' | 'email'>
  staffEmail: string
  onUploaded: () => void
}) {
  const present = !trip.readiness?.missingDocuments.includes(kind)
  return (
    <SettlementDocUpload
      driver={driver}
      loadId={trip.id}
      proNumber={String(trip.readiness?.payload.InvoiceNo ?? '')}
      kind={kind === 'POD' ? 'POD' : 'RATECON'}
      staffEmail={staffEmail}
      present={present}
      blocking={kind === 'POD'}
      onUploaded={onUploaded}
    />
  )
}

/**
 * The PRO, as the way into the load it names.
 *
 * Every conversation about a settlement row is "what is going on with 14559" — and the
 * answer is on the load. Copying the number and hunting for it on the Loads page is the
 * step this removes. Falls back to plain text when the row never resolved to a load, so
 * an unlinked trip reads as unlinked rather than as a dead link.
 */
function ProLink({
  loadId, proNumber, children,
}: {
  loadId: string | null | undefined
  proNumber: string
  children: React.ReactNode
}) {
  const setSelectedLoad = useAppStore((st) => st.setSelectedLoad)
  const loads = useAppStore((st) => st.loads)
  const known = loadId ? loads.some((l) => l.id === loadId) : false
  if (!loadId || !known) return <>{children}</>
  return (
    <button
      type="button"
      onClick={() => setSelectedLoad(loadId, 'view')}
      aria-label={`Open the load for PRO ${proNumber || loadId}`}
      title="Open this load"
      style={{
        border: 'none', background: 'none', padding: 0, cursor: 'pointer',
        font: 'inherit', color: 'var(--ds-accent, #2563eb)', textDecoration: 'underline',
        textUnderlineOffset: 2,
      }}
    >
      {children}
    </button>
  )
}

/** What a held load is waiting on, in the cell where its pay would otherwise be. */
function HeldAmount({ reason }: { reason: PayHoldReason }) {
  return (
    <span style={MISSING} title="Not on this check until the POD is on file. It pays itself once the POD arrives.">
      Held — {PAY_HOLD_LABEL[reason]}
    </span>
  )
}

/** How many of the week's loads can be invoiced at OTR, and how many are blocked. */
function FactoringSummary({ trips, heldCount, heldFreight }: { trips: OwnerOpTrip[]; heldCount?: number; heldFreight?: number }) {
  const ready = trips.filter((t) => t.readiness?.ready).length
  const blocked = trips.length - ready
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 600, color: 'var(--ds-t1)' }}>Factoring readiness</span>
      <span style={{ color: ready > 0 ? '#15803d' : 'var(--ds-t3)' }}>{ready} of {trips.length} ready</span>
      {blocked > 0 && <span style={MISSING}>{blocked} blocked</span>}
      {/* A blocked load is not automatically an unpaid one — only a missing POD holds pay. */}
      {heldCount ? (
        <span style={MISSING}>
          {heldCount} held off this check{heldFreight ? ` (${money(heldFreight)} freight)` : ''}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Shown only when a POD store could not be read. Pay is NOT held in that state, so a
 * load with no POD may have been paid — which someone needs to be told, not shielded from.
 */
function PodCheckUnavailable() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 10, border: '1px solid #fcd34d', background: '#fffbeb', padding: '10px 12px' }}>
      <AlertTriangle size={15} style={{ color: '#b45309', marginTop: 1, flexShrink: 0 }} />
      <div style={{ fontSize: 12.5, color: '#92400e' }}>
        <b>PODs could not be checked.</b> Nothing is being held for a missing POD this
        time, so these checks may include loads with no proof of delivery on file.
        Reload once the PODs page is reachable again before paying anyone.
      </div>
    </div>
  )
}

/** The driver PWA address. Rendered once, in the page header — never per card. */
function DriverAppLink() {
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(DRIVER_PORTAL_URL)
      toast.success('Driver app URL copied')
    } catch {
      toast.error('Could not copy the URL')
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Driver app</span>
      <code style={{ fontSize: 12, color: 'var(--ds-t1)', background: 'var(--ds-bg)', padding: '2px 6px', borderRadius: 6 }}>{DRIVER_PORTAL_URL}</code>
      <button onClick={() => { void copyUrl() }} title="Copy the driver app URL" aria-label="Copy the driver app URL"
        style={{ display: 'flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit' }}>
        <Copy size={12} /> Copy
      </button>
    </div>
  )
}

/** One driver's own sign-in address, on their own card. A driver with no email on
 *  file cannot sign in at all, so that is stated instead of left blank. */
function DriverSignIn({ row }: { row: OwnerOperatorPayRow }) {
  const email = driverSignInEmail(row)
  if (!email) {
    return (
      <div style={{ fontSize: 12, color: '#b45309', marginTop: 2 }}>
        No email on file — {row.driver.name} cannot sign in to the driver app. Add one under Settings.
      </div>
    )
  }
  return (
    <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
      Signs in as <b style={{ color: 'var(--ds-t1)' }}>{email}</b> — sets their own password at <code>/driver/signup</code> and resets it from the login screen. Office staff never see or issue passwords.
      <SendDriverInvite driver={row.driver} email={email} />
    </div>
  )
}

function initialPeriodStart(): string {
  const current = sundayOf()
  return current < OWNER_OP_FIRST_PERIOD ? OWNER_OP_FIRST_PERIOD : current
}

function csvField(trip: OwnerOpTrip, field: OtrRequiredField) {
  return String(trip.readiness?.payload[field] ?? '')
}

function csvDoc(trip: OwnerOpTrip, kind: 'POD' | 'Rate confirmation') {
  return trip.readiness?.missingDocuments.includes(kind) ? 'Missing' : 'Yes'
}

function statementCsv(row: OwnerOperatorPayRow, periodStart: string): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const L: string[] = []
  L.push(q(`${row.driver.name} — owner operator pay period ${weekLabelLong(periodStart)}`)); L.push('')
  L.push([
    'PRO #', 'PO #', 'Load ID', 'Customer', 'Broker MC', 'Invoice amount', 'Invoice date',
    'Origin city', 'Origin state', 'Origin ZIP', 'Dest city', 'Dest state', 'Dest ZIP',
    'POD', 'Rate confirmation', 'Miles', 'Freight', 'Driver Amount', 'On this check',
  ].map(q).join(','))
  const heldReasonById = new Map(row.heldTrips.map((h) => [h.trip.id, h.reason]))
  for (const t of row.trips) {
    L.push([
      csvField(t, 'InvoiceNo'), csvField(t, 'PoNumber'),
      t.loadId, t.customer, csvField(t, 'BrokerMC'),
      csvField(t, 'InvoiceAmount'), csvField(t, 'InvoiceDate'),
      csvField(t, 'FromCity'), csvField(t, 'FromState'), csvField(t, 'FromZip'),
      csvField(t, 'ToCity'), csvField(t, 'ToState'), csvField(t, 'ToZip'),
      csvDoc(t, 'POD'), csvDoc(t, 'Rate confirmation'),
      t.miles ?? '', t.freightAmount,
      // A held load's pay is not on this check, so the column shows 0 rather than a
      // figure someone could total up and expect to see in the driver's bank.
      heldReasonById.has(t.id) ? 0 : tripPayAmount(t.freightAmount, row.setting),
      heldReasonById.has(t.id) ? `Held — ${PAY_HOLD_LABEL[heldReasonById.get(t.id)!]}` : 'Yes',
    ].map(q).join(','))
  }
  L.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', q('Freight total'), q(row.statement.gross)].join(','))
  L.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', q('Driver share'), q(row.statement.driverAmount)].join(','))
  if (row.heldFreight > 0) {
    L.push(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', q('Held for POD (not paid)'), q(row.heldFreight)].join(','))
  }
  L.push(''); L.push([q('Deductions'), q('Amount')].join(','))
  for (const d of row.deductions) L.push([q(d.label), q(d.amount)].join(','))
  // Charged on every settlement, so the line is exported even when it is $0.00.
  L.push([q(FACTORING_FEE_LABEL), q(row.statement.factoringFee)].join(','))
  L.push([q('Total deductions'), q(row.statement.totalDeductions)].join(','))
  if (row.credits.length) {
    L.push(''); L.push([q('Credits'), q('Amount')].join(','))
    for (const c of row.credits) L.push([q(creditLineLabel(c)), q(c.amount)].join(','))
    L.push([q('Total credits'), q(row.statement.totalCredits)].join(','))
  }
  if (row.debits.length || row.fixedDebits.length) {
    L.push(''); L.push([q('Debits'), q('Amount')].join(','))
    for (const c of row.debits) L.push([q(creditLineLabel(c)), q(c.amount)].join(','))
    for (const d of row.fixedDebits) L.push([q(d.label), q(d.amount)].join(','))
    L.push([q('Total debits'), q(row.statement.totalDebits)].join(','))
  }
  L.push(''); L.push([q('CHECK AMOUNT'), q(row.statement.checkAmount)].join(','))
  return L.join('\n')
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

export function OwnerOperatorPayPage() {
  const [periodStart, setPeriodStart] = useState(initialPeriodStart)
  const pay = useOwnerOperatorPay(periodStart)
  const { user } = useAuth()

  const [dedDriver, setDedDriver] = useState<string | null>(null)
  const [creditFor, setCreditFor] = useState<{ row: OwnerOperatorPayRow; credit?: DriverPayCredit; kind?: 'CREDIT' | 'DEBIT' } | null>(null)
  const [settingsFor, setSettings] = useState<Driver | null>(null)
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null)

  const isThisWeek = periodStart === sundayOf()
  const isFirstWeek = periodStart === OWNER_OP_FIRST_PERIOD
  const selectedRow = pay.rows.find((r) => r.driver.id === selectedDriverId) ?? pay.rows[0] ?? null

  const handleRemoveCredit = async (c: DriverPayCredit) => {
    const noun = c.kind === 'DEBIT' ? 'debit' : 'credit'
    if (!window.confirm(`Remove the ${money(c.amount)} ${creditLineLabel(c)} ${noun} from this check?`)) return
    try { await pay.removeCredit(c.id); toast.success(noun === 'debit' ? 'Debit removed' : 'Credit removed') }
    catch (e) { toast.error(`Couldn't remove the ${noun}: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 32px 12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Banknote size={20} /> Owner Operator Settlements</h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
              Weekly (Sun→Sat) — brokerage loads delivered by owner operators · % of freight
              {' · weekly expenses charged here from Sep 27'}
            </p>
            <DriverAppLink />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button style={{ ...navBtn, opacity: isFirstWeek ? 0.4 : 1 }} onClick={() => !isFirstWeek && setPeriodStart((p) => shiftWeek(p, -1))} disabled={isFirstWeek} aria-label="Previous week"><ChevronLeft size={16} /></button>
              <button onClick={() => setPeriodStart(initialPeriodStart())} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: isThisWeek ? 'var(--ds-bg)' : 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>This week</button>
              <button style={{ ...navBtn, opacity: isThisWeek ? 0.4 : 1 }} onClick={() => !isThisWeek && setPeriodStart((p) => shiftWeek(p, 1))} disabled={isThisWeek} aria-label="Next week"><ChevronRight size={16} /></button>
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', minWidth: 180, textAlign: 'right' }}>{weekLabelLong(periodStart)}</span>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 32px 40px', maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pay.loading && pay.rows.length === 0 && <div style={{ color: 'var(--ds-t3)', fontSize: 14, padding: 40, textAlign: 'center' }}>Loading…</div>}
        {pay.error && <div style={{ color: '#dc2626', fontSize: 13, padding: 12, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2' }}>{pay.error}</div>}
        {!pay.loading && !pay.podsKnown && <PodCheckUnavailable />}

        {!pay.loading && pay.rows.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '60px 0', color: 'var(--ds-t3)' }}>
            <Banknote size={36} style={{ opacity: 0.2 }} />
            <p style={{ fontSize: 14, fontWeight: 500 }}>No owner operators configured.</p>
            <p style={{ fontSize: 12.5, maxWidth: 440, textAlign: 'center' }}>Active Amazon pay settings are included automatically, even in weeks without brokerage loads. Amazon trip history remains on <b>Amazon Settlements</b>.</p>
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
                  {r.duplicateTripIds.size > 0 && <AlertTriangle size={12} style={{ color: '#dc2626' }} aria-label="Has possible duplicate loads" />}
                </button>
              )
            })}
          </div>
        )}

        {pay.rows.length > 0 && (
          <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', padding: '12px 16px', background: 'var(--ds-surface)' }}>
            <FactoringSummary
              trips={pay.rows.flatMap((r) => r.trips)}
              heldCount={pay.rows.reduce((n, r) => n + r.heldTrips.length, 0)}
              heldFreight={pay.rows.reduce((n, r) => n + r.heldFreight, 0)}
            />
          </div>
        )}

        {selectedRow && (
          <StatementCard
            key={selectedRow.driver.id}
            row={selectedRow}
            staffEmail={user?.email ?? ''}
            onRefresh={pay.refresh}
            onAddDeduction={() => setDedDriver(selectedRow.driver.id)}
            onAddCredit={() => setCreditFor({ row: selectedRow })}
            onAddDebit={() => setCreditFor({ row: selectedRow, kind: 'DEBIT' })}
            onEditCredit={(c) => setCreditFor({ row: selectedRow, credit: c })}
            onRemoveCredit={handleRemoveCredit}
            onSettings={() => setSettings(selectedRow.driver)}
            onRemoveDeduction={pay.removeDeduction}
            onWaiveDeduction={async (label, amount) => {
              if (!window.confirm(`Waive ${label} (${money(amount)}) for ${weekLabelLong(periodStart)} only?\n\nAdds an offsetting refund line to this week; every other week keeps the charge.`)) return
              try { await pay.addDeduction({ driverId: selectedRow.driver.id, periodStart, label: `Waived — ${label}`, amount: -amount, date: null }); toast.success(`${label} waived for this week`) }
              catch (e) { toast.error(`Couldn't waive: ${e instanceof Error ? e.message : 'unknown error'}`) }
            }}
            onAddMileage={async (miles, costPerMile) => {
              await pay.addDeduction({ driverId: selectedRow.driver.id, periodStart, ...mileageDeductionLine(miles, costPerMile), date: null })
              toast.success('Mileage deduction added')
            }}
            onExport={() => download(`owner-operator-pay-${selectedRow.driver.name.replace(/\s+/g, '-')}-${periodStart}.csv`, statementCsv(selectedRow, periodStart))}
          />
        )}

        {pay.unconfigured.length > 0 && (
          <div style={{ borderRadius: 12, border: '1px dashed var(--ds-border)', padding: '14px 16px', background: 'var(--ds-surface)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Set up an owner operator</div>
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

      {dedDriver && <DeductionModal driverId={dedDriver} periodStart={periodStart} onSave={async (input) => { await pay.addDeduction(input); setDedDriver(null) }} onClose={() => setDedDriver(null)} />}
      {creditFor && (
        <CreditModal
          driverId={creditFor.row.driver.id}
          driverName={creditFor.row.driver.name}
          periodStart={periodStart}
          periodLabel={weekLabelLong(periodStart)}
          initial={creditFor.credit}
          kind={creditFor.credit?.kind === 'DEBIT' ? 'DEBIT' : (creditFor.kind ?? 'CREDIT')}
          createdBy={user?.email ?? null}
          onSave={async (input) => {
            const noun = input.kind === 'DEBIT' ? 'debit' : 'credit'
            if (creditFor.credit) { await pay.updateCredit(creditFor.credit.id, input); toast.success(`${noun === 'debit' ? 'Debit' : 'Credit'} updated`) }
            else { await pay.addCredit(input); toast.success(`Added ${money(input.amount)} ${noun} to ${creditFor.row.driver.name}'s check`) }
            setCreditFor(null)
          }}
          onClose={() => setCreditFor(null)}
        />
      )}
      {settingsFor && <SettingsModal driver={settingsFor} existing={pay.rows.find((r) => r.driver.id === settingsFor.id)?.baseSetting} onSave={async (patch, expectedUpdatedAt) => { await pay.saveSetting(settingsFor.id, patch, expectedUpdatedAt); setSettings(null) }} onClose={() => setSettings(null)} />}
      {/* Opened by the PRO column. Present on every page that can select a load. */}
      <LoadDrawer />
    </div>
  )
}

function StatementCard({ row, staffEmail, onRefresh, onAddDeduction, onAddCredit, onAddDebit, onEditCredit, onRemoveCredit, onSettings, onRemoveDeduction, onWaiveDeduction, onAddMileage, onExport }: {
  row: OwnerOperatorPayRow
  /** Recorded on any document uploaded from this card. */
  staffEmail: string
  /** Re-reads the week so an uploaded POD moves its load from held to paid. */
  onRefresh: () => void
  onAddDeduction: () => void
  onAddCredit: () => void; onAddDebit: () => void; onEditCredit: (c: DriverPayCredit) => void; onRemoveCredit: (c: DriverPayCredit) => void
  onSettings: () => void
  onRemoveDeduction: (id: string) => void; onWaiveDeduction: (label: string, amount: number) => Promise<void>
  onAddMileage: (miles: number, costPerMile: number) => Promise<void>
  onExport: () => void
}) {
  const { driver, setting, statement, oneOffs } = row
  const trips = row.trips
  // Held loads stay in the table, in delivery order, so the week reads as one list.
  const heldReasonById = new Map(row.heldTrips.map((h) => [h.trip.id, h.reason]))

  const color = getColor(driver.colorKey)
  const modeLabel = setting.expensesBeforePercent ? `${pct(setting.payPercent)} of net (after expenses)` : `${pct(setting.payPercent)} of freight − expenses`

  const iconBtn = (onClick: () => void, Icon: typeof Plus, label: string) => (
    <button onClick={onClick} title={label} aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}><Icon size={13} /> {label}</button>
  )

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--ds-border)', overflow: 'hidden', boxShadow: 'var(--sh-sm)', background: 'var(--ds-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <Avatar src={driver.photoUrl} initials={getInitials(driver.name)} size="lg" style={{ background: color.avatarBg, color: '#fff' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{driver.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{modeLabel}</div>
          <DriverSignIn row={row} />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Check amount</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: statement.checkAmount >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(statement.checkAmount)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
        {iconBtn(onAddDeduction, Plus, 'Add expense')}
        <button onClick={onAddCredit} title="Add extra pay to this check (detention, bonus, reimbursement…)"
          style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid #86efac', background: 'var(--ds-surface)', color: '#15803d', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
          <PlusCircle size={13} /> Add credit
        </button>
        <button onClick={onAddDebit} title="Take money off this check after the net (cash advance, damage, escrow…)"
          style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid #fca5a5', background: 'var(--ds-surface)', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
          <PlusCircle size={13} /> Add debit
        </button>
        {iconBtn(onExport, Download, 'CSV')}
        <div style={{ flex: 1 }} />
        {iconBtn(onSettings, Settings, 'Settings')}
      </div>

      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--ds-border)' }}>
        <FactoringSummary trips={trips} heldCount={row.heldTrips.length} heldFreight={row.heldFreight} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
            {/* PRO and PO lead: they are how the office and OTR both name a load. */}
            <th style={{ ...TH, textAlign: 'left' }}>PRO #</th>
            <th style={{ ...TH, textAlign: 'left' }}>PO #</th>
            <th style={{ ...TH, textAlign: 'left' }}>Load ID</th>
            <th style={{ ...TH, textAlign: 'left' }}>Customer</th>
            <th style={{ ...TH, textAlign: 'left' }}>Route</th>
            <th style={TH}>Broker MC</th>
            <th style={TH}>Invoice amount</th>
            <th style={TH}>Invoice date</th>
            <th style={TH}>Origin city</th>
            <th style={TH}>Origin state</th>
            <th style={TH}>Origin ZIP</th>
            <th style={TH}>Dest city</th>
            <th style={TH}>Dest state</th>
            <th style={TH}>Dest ZIP</th>
            <th style={TH}>POD</th>
            <th style={TH}>Rate con</th>
            <th style={TH}>Miles</th>
            <th style={TH}>Freight</th>
            <th style={TH}>Driver Amount</th>
          </tr></thead>
          <tbody>
            {trips.length === 0 && <tr><td colSpan={19} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 18 }}>No brokerage loads delivered this week.</td></tr>}
            {trips.map((t) => {
              const dup = row.duplicateTripIds.has(t.id)
              const held = heldReasonById.get(t.id)
              return (
              <tr key={t.id} style={{ borderBottom: '1px solid var(--ds-border)', background: dup ? 'var(--ds-red-bg, #fef2f2)' : held ? '#fffbeb' : undefined }}>
                <td style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                  {/* The PRO is how everyone refers to a load, so it is also the way to it. */}
                  <ProLink loadId={t.id} proNumber={String(t.readiness?.payload.InvoiceNo ?? '')}>
                    <OtrCell trip={t} field="InvoiceNo" />
                  </ProLink>
                </td>
                <td style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)' }}>
                  <OtrCell trip={t} field="PoNumber" />
                </td>
                <td style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', fontWeight: dup ? 700 : 400, color: dup ? '#dc2626' : 'var(--ds-t2)' }}
                    title={dup ? 'Duplicate — this Load ID also settled last week' : undefined}>
                  {dup && <AlertTriangle size={12} style={{ color: '#dc2626', verticalAlign: '-1px', marginRight: 4 }} />}
                  {t.loadId}
                </td>
                <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer || '—'}</td>
                <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)' }}>{t.origin || '—'} → {t.destination || '—'}</td>
                <td style={TD}><OtrCell trip={t} field="BrokerMC" /></td>
                <td style={TD}><OtrCell trip={t} field="InvoiceAmount" /></td>
                <td style={TD}><OtrCell trip={t} field="InvoiceDate" /></td>
                <td style={{ ...TD, textAlign: 'left' }}><OtrCell trip={t} field="FromCity" /></td>
                <td style={TD}><OtrCell trip={t} field="FromState" /></td>
                <td style={TD}><OtrCell trip={t} field="FromZip" /></td>
                <td style={{ ...TD, textAlign: 'left' }}><OtrCell trip={t} field="ToCity" /></td>
                <td style={TD}><OtrCell trip={t} field="ToState" /></td>
                <td style={TD}><OtrCell trip={t} field="ToZip" /></td>
                <td style={TD}><OtrDoc trip={t} kind="POD" driver={driver} staffEmail={staffEmail} onUploaded={onRefresh} /></td>
                <td style={TD}><OtrDoc trip={t} kind="Rate confirmation" driver={driver} staffEmail={staffEmail} onUploaded={onRefresh} /></td>
                <td style={TD}>{t.miles != null ? t.miles.toLocaleString('en-US') : '—'}</td>
                <td style={TD}>{money(t.freightAmount)}</td>
                <td style={{ ...TD, fontWeight: 600 }}>
                  {held ? <HeldAmount reason={held} /> : money(tripPayAmount(t.freightAmount, setting))}
                </td>
              </tr>
            )})}
            {trips.length > 0 && (
              <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontWeight: 700 }}>
                <td style={{ ...TD, textAlign: 'left' }} colSpan={17}>
                  Freight total / driver share ({pct(setting.payPercent)})
                  {row.heldFreight > 0 && (
                    <span style={{ ...MISSING, fontWeight: 600, marginLeft: 8 }}>
                      excludes {money(row.heldFreight)} held for POD
                    </span>
                  )}
                </td>
                <td style={TD}>{money(statement.gross)}</td>
                <td style={TD}>{money(statement.driverAmount)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Deductions</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {row.deductions.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No weekly expenses. Fixed expenses come from Settings.</div>
          )}
          {row.deductions.map((d, i) => {
            const oneOff = oneOffs.find((o) => o.label === d.label && o.amount === d.amount)
            const refund = d.amount < 0
            const isFixed = !oneOff && !d.label.startsWith('Fuel (card')
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1, color: 'var(--ds-t2)' }}>{d.label}</span>
                <span style={{ color: refund ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>
                  {refund ? `+${money(-d.amount)}` : `(${money(d.amount)})`}
                </span>
                {oneOff
                  ? <button onClick={() => onRemoveDeduction(oneOff.id)} title="Remove" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Trash2 size={12} /></button>
                  : isFixed
                    ? <button onClick={() => onWaiveDeduction(d.label, d.amount)} title={`Waive ${d.label} for THIS WEEK ONLY — adds an offsetting refund line; the charge stays on every other week`} style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16, fontSize: 11, fontWeight: 700 }}>⃠</button>
                    : <span style={{ width: 16 }} />}
              </div>
            )
          })}
          {/* The 2% fee is charged on every settlement, so the line is always listed —
              including the $0.00 of a week with no loads, where leaving it out reads as
              "they forgot it". It comes out of calcDriverPay rather than row.deductions,
              hence its own row above the total. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
            <span style={{ flex: 1, color: 'var(--ds-t2)' }}>{FACTORING_FEE_LABEL}</span>
            <span style={{ color: statement.factoringFee > 0 ? '#dc2626' : 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>({money(statement.factoringFee)})</span>
            <span style={{ width: 16 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 4, paddingTop: 6 }}>
            <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Total deductions</span>
            <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>({money(statement.totalDeductions)})</span>
            <span style={{ width: 16 }} />
          </div>
        </div>

        {/* Weekly mileage — the same miles × $/mile entry the Amazon statement carries,
            unconditional here because every week this page renders owns its charges. */}
        <WeeklyMileageRow onAdd={onAddMileage} />
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Credits</div>
          <button onClick={onAddCredit} title="Add a credit" style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', color: '#15803d', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
            <PlusCircle size={12} /> Add
          </button>
        </div>
        {!payCreditsDeployed() ? (
          <div style={{ fontSize: 12.5, color: '#b45309' }}>Credits need the latest backend deploy (<code>npx ampx sandbox</code> / pipeline deploy) before they can be saved.</div>
        ) : row.credits.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No credits. Add detention, layover, a bonus or a reimbursement to pay {driver.name} extra on this check.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {row.credits.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {creditLineLabel(c)}
                  {(c.date || c.loadRef) && (
                    <span style={{ color: 'var(--ds-t3)', fontSize: 11.5 }}>
                      {c.date ? ` · ${fmtShort(c.date)}` : ''}{c.loadRef ? ` · ${c.loadRef}` : ''}
                    </span>
                  )}
                </span>
                <span style={{ color: '#15803d', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>+{money(c.amount)}</span>
                <button onClick={() => onEditCredit(c)} title="Edit credit" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Pencil size={12} /></button>
                <button onClick={() => onRemoveCredit(c)} title="Remove credit" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Trash2 size={12} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 4, paddingTop: 6 }}>
              <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Total credits</span>
              <span style={{ color: '#15803d', fontVariantNumeric: 'tabular-nums' }}>+{money(statement.totalCredits)}</span>
              <span style={{ width: 40 }} />
            </div>
          </div>
        )}
      </div>

      {(row.fixedDebits.length > 0 || row.debits.length > 0) && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ds-border)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Debits (after net)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {row.fixedDebits.map((d, i) => (
              <div key={`fixed-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
                <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>({money(d.amount)})</span>
                <span style={{ width: 40 }} />
              </div>
            ))}
            {row.debits.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1, color: 'var(--ds-t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {creditLineLabel(c)}
                  {(c.date || c.loadRef) && (
                    <span style={{ color: 'var(--ds-t3)', fontSize: 11.5 }}>
                      {c.date ? ` · ${fmtShort(c.date)}` : ''}{c.loadRef ? ` · ${c.loadRef}` : ''}
                    </span>
                  )}
                </span>
                <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>−{money(c.amount)}</span>
                <button onClick={() => onEditCredit(c)} title="Edit debit" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Pencil size={12} /></button>
                <button onClick={() => onRemoveCredit(c)} title="Remove debit" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer', width: 16 }}><Trash2 size={12} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 4, paddingTop: 6 }}>
              <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Total debits</span>
              <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>−{money(statement.totalDebits)}</span>
              <span style={{ width: 40 }} />
            </div>
          </div>
        </div>
      )}

      {(statement.totalCredits > 0 || statement.totalDebits > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 16px', borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <span style={{ flex: 1, color: 'var(--ds-t2)' }}>Pay after {pct(setting.payPercent)} model</span>
            <span style={{ color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{money(statement.payBeforeCredits)}</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <span style={{ flex: 1, color: 'var(--ds-t2)' }}>Credits (paid at 100%)</span>
            <span style={{ color: '#15803d', fontVariantNumeric: 'tabular-nums' }}>+{money(statement.totalCredits)}</span>
          </div>
          {statement.totalDebits > 0 && (
            <div style={{ display: 'flex', gap: 10 }}>
              <span style={{ flex: 1, color: 'var(--ds-t2)' }}>Debits (after net)</span>
              <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>−{money(statement.totalDebits)}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 3, paddingTop: 5 }}>
            <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Check amount</span>
            <span style={{ color: statement.checkAmount >= 0 ? '#15803d' : '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{money(statement.checkAmount)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
