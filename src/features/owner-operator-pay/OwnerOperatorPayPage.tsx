import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, Download, Settings, Banknote, PlusCircle, Pencil, Trash2 } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useAuth } from '@/hooks/useAuth'
import { useOwnerOperatorPay, type OwnerOperatorPayRow } from '@/hooks/useOwnerOperatorPay'
import { OWNER_OP_FIRST_PERIOD } from '@/lib/ownerOperatorTrips'
import { tripPayAmount } from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { payCreditsDeployed, type DriverPayCredit } from '@/lib/apiClient'
import { getColor } from '@/lib/driverColors'
import { weekLabelLong, sundayOf, shiftWeek } from '@/features/driver-pay/week'
import type { Driver } from '@/types'
import { SettingsModal, CreditModal } from './OwnerOperatorPayForms'
import { DeductionModal } from '../driver-pay/DriverPayForms'

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const getInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?'
const pct = (n: number) => `${Math.round(n * 100)}%`
const fmtShort = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : '—')

const navBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--ds-t1)', padding: '7px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function initialPeriodStart(): string {
  const current = sundayOf()
  return current < OWNER_OP_FIRST_PERIOD ? OWNER_OP_FIRST_PERIOD : current
}

function statementCsv(row: OwnerOperatorPayRow, periodStart: string): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const L: string[] = []
  L.push(q(`${row.driver.name} — owner operator pay period ${weekLabelLong(periodStart)}`)); L.push('')
  L.push(['Load ID', 'Customer', 'Route', 'Miles', 'Freight', 'Driver Amount'].map(q).join(','))
  for (const t of row.trips) {
    L.push([t.loadId, t.customer, `${t.origin} → ${t.destination}`, t.miles ?? '', t.freightAmount, tripPayAmount(t.freightAmount, row.setting)].map(q).join(','))
  }
  L.push(['', '', '', '', q('Freight total'), q(row.statement.gross)].join(','))
  L.push(['', '', '', '', q('Driver share'), q(row.statement.driverAmount)].join(','))
  L.push(''); L.push([q('Deductions'), q('Amount')].join(','))
  for (const d of row.deductions) L.push([q(d.label), q(d.amount)].join(','))
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
                </button>
              )
            })}
          </div>
        )}

        {selectedRow && (
          <StatementCard
            key={selectedRow.driver.id}
            row={selectedRow}
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
    </div>
  )
}

function StatementCard({ row, onAddDeduction, onAddCredit, onAddDebit, onEditCredit, onRemoveCredit, onSettings, onRemoveDeduction, onWaiveDeduction, onExport }: {
  row: OwnerOperatorPayRow
  onAddDeduction: () => void
  onAddCredit: () => void; onAddDebit: () => void; onEditCredit: (c: DriverPayCredit) => void; onRemoveCredit: (c: DriverPayCredit) => void
  onSettings: () => void
  onRemoveDeduction: (id: string) => void; onWaiveDeduction: (label: string, amount: number) => Promise<void>
  onExport: () => void
}) {
  const { driver, setting, statement, oneOffs } = row
  const trips = row.trips

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
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{modeLabel}{setting.email ? ` · ${setting.email}` : ''}</div>
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

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
            <th style={{ ...TH, textAlign: 'left' }}>Load ID</th>
            <th style={{ ...TH, textAlign: 'left' }}>Customer</th>
            <th style={{ ...TH, textAlign: 'left' }}>Route</th>
            <th style={TH}>Miles</th>
            <th style={TH}>Freight</th>
            <th style={TH}>Driver Amount</th>
          </tr></thead>
          <tbody>
            {trips.length === 0 && <tr><td colSpan={6} style={{ ...TD, textAlign: 'center', color: 'var(--ds-t3)', padding: 18 }}>No brokerage loads delivered this week.</td></tr>}
            {trips.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                <td style={{ ...TD, textAlign: 'left', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{t.loadId}</td>
                <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer || '—'}</td>
                <td style={{ ...TD, textAlign: 'left', color: 'var(--ds-t2)' }}>{t.origin || '—'} → {t.destination || '—'}</td>
                <td style={TD}>{t.miles != null ? t.miles.toLocaleString('en-US') : '—'}</td>
                <td style={TD}>{money(t.freightAmount)}</td>
                <td style={{ ...TD, fontWeight: 600 }}>{money(tripPayAmount(t.freightAmount, setting))}</td>
              </tr>
            ))}
            {trips.length > 0 && (
              <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)', fontWeight: 700 }}>
                <td style={{ ...TD, textAlign: 'left' }} colSpan={4}>Freight total / driver share ({pct(setting.payPercent)})</td>
                <td style={TD}>{money(statement.gross)}</td>
                <td style={TD}>{money(statement.driverAmount)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Deductions</div>
        {row.deductions.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No deductions. Fixed expenses come from Settings.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 700, borderTop: '1px solid var(--ds-border)', marginTop: 4, paddingTop: 6 }}>
              <span style={{ flex: 1, color: 'var(--ds-t1)' }}>Total deductions</span>
              <span style={{ color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>({money(statement.totalDeductions)})</span>
              <span style={{ width: 16 }} />
            </div>
          </div>
        )}
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
