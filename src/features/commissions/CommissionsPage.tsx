/**
 * Commissions — what each person is owed, who still has to agree to it, and the
 * periods those agreed numbers were handed to payroll in.
 *
 * Three things this board deliberately does not do. It never decides the approval
 * ladder: `commissionState` answers for the page and for the Lambda, so a button that
 * appears here is a button the server will honour and a button that is missing is work
 * the server would have refused anyway — the hiding is tidiness, never the boundary.
 * It never re-computes a number: `netCents` is what the ledger says is owed, and the
 * page prints it. And paying a period moves no money; it records that payroll, which
 * lives somewhere else entirely, has happened.
 *
 * Step R re-skinned it onto the MVMNT kit as the Commissions tab of My Brokerage, so
 * the page is a body: `BrokeragePage` owns the h1.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Coins, Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTabs, TmsTextarea,
} from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import {
  acceptCommissionCounter, approveCommission, approvePayPeriod, cancelCommission,
  commissionModelsDeployed, counterCommission, getTmsSettings, graphqlErrorText,
  listCommissionsByInvoice, listCommissionsByMonth, listCommissionsByRep, listPayPeriods,
  openPayPeriod, overrideCommission, payPayPeriod, previewCommissions, renderCommissionStatement,
  runCommissions, submitPayPeriod,
} from '@/lib/apiClient'
import { commissionState, type CommissionCaller } from '@/lib/commission'
import { chicagoDateStr, formatDateTime } from '@/lib/date'
import { saveBlob } from '@/lib/download'
import { formatCents } from '@/lib/invoiceBuild'
import { parseCents } from '@/lib/tmsDirectory'
import {
  COMMISSION_KINDS, COMMISSION_STATUSES, COMMISSION_TABS, commissionCsv, filterForCaller,
  kindLabel, monthLabel, monthOptions, needsReviewReason, rateLabel, roleLabel, sortForApproval,
  sortNewestFirst, statusLabel, statusTone, type CommissionTabKey,
} from './commissionViews'
import type {
  CommissionKind, CommissionPayPeriodRecord, CommissionRecord, CommissionStatus, TmsSettings,
} from '@/types/tms'

/** Which dialog is open, and the one row it is open about. Mount is the `open` flag. */
type CommissionDialog =
  | { kind: 'counter'; row: CommissionRecord }
  | { kind: 'override'; row: CommissionRecord }
  | { kind: 'cancel'; row: CommissionRecord }
  | { kind: 'pay'; period: CommissionPayPeriodRecord }

const PANEL: CSSProperties = {
  border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)',
  background: 'var(--tms-card)', padding: 14,
  display: 'flex', flexDirection: 'column', gap: 8,
}
const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }
const NUM: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const LIST: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }

/** The board's own tone vocabulary onto the seven MVMNT badge colours. */
const BADGE_TONES: Record<string, TmsTone> = {
  default: 'green',
  secondary: 'purple',
  destructive: 'red',
  outline: 'gray',
}

/**
 * Dollars typed by a person → integer cents, sign included.
 *
 * `parseCents` refuses a minus because almost every amount in the app is nonnegative;
 * a commission override is the exception, because a REVERSAL row's net is negative.
 */
function centsFromDollars(text: string): number {
  const trimmed = text.trim()
  const negative = trimmed.startsWith('-')
  const value = parseCents(negative ? trimmed.slice(1) : trimmed)
  if (value == null) throw new Error('Enter an amount')
  return negative ? -value : value
}

function Table({ children }: { children: ReactNode }) {
  return (
    <div className="tms-table-wrap">
      <table className="tms-table">{children}</table>
    </div>
  )
}

export function CommissionsPage() {
  const { user, isAdmin } = useAuth()
  const userId = user?.userId ?? ''
  const email = user?.email ?? ''
  const groups = useMemo(() => user?.groups ?? [], [user?.groups])

  const [today] = useState(() => chicagoDateStr(new Date()))
  const months = useMemo(() => monthOptions(today, 12), [today])

  const [tab, setTab] = useState<CommissionTabKey>('mine')
  const [month, setMonth] = useState(() => months[0])
  const [dialog, setDialog] = useState<CommissionDialog | null>(null)
  const [busy, setBusy] = useState(false)

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [mineRows, setMineRows] = useState<CommissionRecord[]>([])
  const [monthRows, setMonthRows] = useState<CommissionRecord[]>([])
  const [periods, setPeriods] = useState<CommissionPayPeriodRecord[]>([])
  const [loading, setLoading] = useState(true)

  const [statusFacet, setStatusFacet] = useState<CommissionStatus | ''>('')
  const [kindFacet, setKindFacet] = useState<CommissionKind | ''>('')

  // No synchronous setState in an effect (react-hooks/set-state-in-effect): every write
  // happens in the promise chain, the shape `ArPage` uses.
  const loadSettings = useCallback(() =>
    getTmsSettings()
      .then((s) => setSettings(s))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not read the commission settings'))
      .finally(() => setSettingsLoaded(true)),
  [])
  useEffect(() => { loadSettings() }, [loadSettings])

  const enabled = settings?.commissionsEnabled === true && commissionModelsDeployed()

  const load = useCallback(() => {
    // Nothing to read, and nothing to spin: a switched-off desk renders `SwitchedOff`
    // rather than the board, so `loading` is never looked at on this path.
    if (!enabled) return Promise.resolve()
    // A rep picked from a profile is stored by username; a rep typed before there were
    // profiles is an e-mail. Mine is both.
    const myIds = userId && email && userId !== email ? [userId, email] : [userId || email]
    return Promise.all([
      Promise.all(myIds.map((id) => listCommissionsByRep(id, month))).then((lists) => lists.flat()),
      listCommissionsByMonth(month),
      listPayPeriods(),
    ])
      .then(([mine, all, pp]) => {
        setMineRows(mine)
        setMonthRows(all)
        setPeriods(pp)
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load commissions'))
      .finally(() => setLoading(false))
  }, [enabled, userId, email, month])
  useEffect(() => { load() }, [load])

  const caller: CommissionCaller = useMemo(() => ({
    id: userId,
    email,
    isAdmin,
    isManager: groups.includes('role-MANAGER'),
    mayApprove: isAdmin || settings?.commissionApprovalAdminOnly !== true,
  }), [userId, email, isAdmin, groups, settings?.commissionApprovalAdminOnly])

  const mine = useMemo(() => sortNewestFirst(mineRows), [mineRows])
  const toApprove = useMemo(
    () => sortForApproval(filterForCaller(monthRows, caller)),
    [monthRows, caller],
  )
  const history = useMemo(() => sortNewestFirst(
    monthRows.filter((r) => (
      (!statusFacet || (r.status ?? 'UN_APPROVED') === statusFacet) &&
      (!kindFacet || (r.kind ?? 'EARNED') === kindFacet)
    )),
  ), [monthRows, statusFacet, kindFacet])

  const counts: Record<CommissionTabKey, number> = {
    mine: mine.length,
    'to-approve': toApprove.length,
    'pay-periods': periods.length,
    history: history.length,
  }

  /** Every action is the same shape: call the Lambda, say what it said, re-read. */
  const act = (label: string, call: () => Promise<unknown>) => {
    setBusy(true)
    call()
      .then(() => {
        toast.success(label)
        setDialog(null)
        return load()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || `Could not ${label.toLowerCase()}`))
      .finally(() => setBusy(false))
  }

  const exportCsv = () => {
    saveBlob(new Blob([commissionCsv(history)], { type: 'text/csv' }), `commissions-${month}.csv`)
  }

  const openStatement = (payPeriodId: string, repId: string) => {
    setBusy(true)
    renderCommissionStatement({ payPeriodId, repId })
      .then(({ url }) => { window.open(url, '_blank', 'noopener') })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not render the statement'))
      .finally(() => setBusy(false))
  }

  if (settingsLoaded && !enabled) {
    return <SwitchedOff isAdmin={isAdmin} deployed={commissionModelsDeployed()} />
  }

  return (
    <div style={STACK}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {tab !== 'pay-periods' && (
          <TmsSelect
            aria-label="Commission month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ width: 'auto' }}
          >
            {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
          </TmsSelect>
        )}
        <TmsButton
          size="sm"
          style={{ marginLeft: 'auto' }}
          aria-label="Refresh commissions"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </TmsButton>
      </div>

      <TmsTabs
        tabs={COMMISSION_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))}
        active={tab}
        onSelect={(key) => setTab(key as CommissionTabKey)}
      />

      {tab === 'mine' && (
        <MineTab
          rows={mine}
          caller={caller}
          busy={busy}
          month={month}
          onCounter={(row) => setDialog({ kind: 'counter', row })}
          onAccept={(row) => act('Counter accepted', () => acceptCommissionCounter({ commissionId: row.id }))}
        />
      )}

      {tab === 'to-approve' && (
        <ApproveTab
          rows={toApprove}
          caller={caller}
          busy={busy}
          month={month}
          onApprove={(row) => act('Approved', () => approveCommission({ commissionId: row.id }))}
          onAccept={(row) => act('Counter accepted', () => acceptCommissionCounter({ commissionId: row.id }))}
          onCounter={(row) => setDialog({ kind: 'counter', row })}
          onOverride={(row) => setDialog({ kind: 'override', row })}
          onCancel={(row) => setDialog({ kind: 'cancel', row })}
        />
      )}

      {tab === 'pay-periods' && (
        <PayPeriodsTab
          periods={periods}
          busy={busy}
          onOpen={() => act('Pay period opened', () => openPayPeriod({}))}
          onSubmit={(p) => act('Pay period submitted', () => submitPayPeriod({ payPeriodId: p.id }))}
          onApprove={(p) => act('Pay period approved', () => approvePayPeriod({ payPeriodId: p.id }))}
          onPay={(p) => setDialog({ kind: 'pay', period: p })}
          onStatement={openStatement}
        />
      )}

      {tab === 'history' && (
        <HistoryTab
          rows={history}
          month={month}
          statusFacet={statusFacet}
          kindFacet={kindFacet}
          onStatus={setStatusFacet}
          onKind={setKindFacet}
          onCsv={exportCsv}
        />
      )}

      {dialog?.kind === 'counter' && (
        <AmountNoteDialog
          title={`Counter ${formatCents(dialog.row.netCents)}`}
          description="Your number and why. Nothing is paid until the other side agrees to it."
          noteLabel="Why this number"
          confirmLabel="Send counter"
          defaultCents={dialog.row.netCents}
          noteRequired
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(amountCents, note) =>
            act('Counter sent', () => counterCommission({ commissionId: dialog.row.id, amountCents, note }))}
        />
      )}

      {dialog?.kind === 'override' && (
        <AmountNoteDialog
          title={`Override ${formatCents(dialog.row.netCents)}`}
          description="Pays a different number than the plan said. What the plan said is kept on the row; the note is what an auditor reads back."
          noteLabel="Why the plan is being overridden"
          confirmLabel="Override"
          defaultCents={dialog.row.netCents}
          noteRequired
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(amountCents, note) =>
            act('Overridden', () => overrideCommission({ commissionId: dialog.row.id, amountCents, note }))}
        />
      )}

      {dialog?.kind === 'cancel' && (
        <ReasonPrompt
          title="Cancel this commission"
          description="The row stays on the record as cancelled and is never paid. It cannot be undone."
          label="Why it is being cancelled"
          confirmLabel="Cancel commission"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            act('Cancelled', () => cancelCommission({ commissionId: dialog.row.id, reason }))}
        />
      )}

      {dialog?.kind === 'pay' && (
        <PayPeriodDialog
          period={dialog.period}
          today={today}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(paidAt, reference) =>
            act('Recorded as paid', () => payPayPeriod({ payPeriodId: dialog.period.id, paidAt, reference }))}
        />
      )}
    </div>
  )
}

/* ── Switched off ────────────────────────────────────────────────────────── */

function SwitchedOff({ isAdmin, deployed }: { isAdmin: boolean; deployed: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '64px 24px', textAlign: 'center' }}>
      <Coins size={28} className="tms-muted" />
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Commissions are switched off</h2>
      <p className="tms-muted" style={{ maxWidth: 440, margin: 0, fontSize: 14 }}>
        {deployed
          ? 'Nothing is computed, written or shown until an admin turns them on and saves a plan.'
          : 'This backend predates the commission tables, so there is nothing to read yet.'}
      </p>
      {isAdmin && deployed && (
        <Link to="/tms/brokerage" aria-label="Open commission settings" className="tms-btn tms-btn-secondary tms-btn-sm">
          Open Settings
        </Link>
      )}
    </div>
  )
}

/* ── One row ─────────────────────────────────────────────────────────────── */

/**
 * A commission as a person reads it: what it was earned on, what the plan charged, what
 * is owed, and every hand it has passed through. Buttons are whatever `commissionState`
 * allows AND the tab offered a handler for — the Mine tab has no Approve to hand it.
 */
function CommissionRow({
  row, caller, busy, showReview, onApprove, onAccept, onCounter, onOverride, onCancel,
}: {
  row: CommissionRecord
  caller: CommissionCaller
  busy: boolean
  showReview?: boolean
  onApprove?: (row: CommissionRecord) => void
  onAccept?: (row: CommissionRecord) => void
  onCounter?: (row: CommissionRecord) => void
  onOverride?: (row: CommissionRecord) => void
  onCancel?: (row: CommissionRecord) => void
}) {
  const state = commissionState(row, caller)
  const reason = showReview ? needsReviewReason(row) : null
  const events = row.events ?? []
  const flagged = row.needsReview === true && showReview === true

  return (
    <li style={flagged ? { ...PANEL, borderColor: 'var(--tms-badge-orange)' } : PANEL}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 500 }}>{row.shipmentNumber ?? row.invoiceNumber ?? row.orderId}</span>
        <span className="tms-muted" style={{ fontSize: 14 }}>{row.customerName ?? '—'}</span>
        <TmsBadge tone="gray">{roleLabel(row)}</TmsBadge>
        {row.kind && row.kind !== 'EARNED' && <TmsBadge tone="purple">{kindLabel(row.kind)}</TmsBadge>}
        <TmsBadge tone={BADGE_TONES[statusTone(row.status)] ?? 'gray'}>{statusLabel(row.status)}</TmsBadge>
        <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatCents(row.netCents)}
        </span>
      </div>

      <dl className="tms-grid tms-grid-4" style={{ margin: 0, fontSize: 12, gap: 8 }}>
        <Field label="Rep" value={row.repName ?? row.repId} />
        <Field label="Basis" value={`${row.basis ?? '—'} · ${formatCents(row.basisCents)}`} />
        <Field label="Rate" value={rateLabel(row)} />
        <Field label="Plan said" value={formatCents(row.amountCents)} />
      </dl>

      {reason && (
        <p style={{ margin: 0, border: '1px solid var(--tms-badge-orange)', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}>
          Needs a look: this one {reason}.
        </p>
      )}

      {row.counterCents != null && (
        <p className="tms-field-hint" style={{ margin: 0 }}>
          Countered at {formatCents(row.counterCents)} by {row.counterBy ?? 'unknown'}
          {row.counterNote ? ` — ${row.counterNote}` : ''}
        </p>
      )}
      {row.overrideCents != null && (
        <p className="tms-field-hint" style={{ margin: 0 }}>
          Overridden to {formatCents(row.overrideCents)} by {row.overrideBy ?? 'unknown'}
          {row.overrideNote ? ` — ${row.overrideNote}` : ''}
        </p>
      )}
      {row.cancelReason && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--tms-badge-red)' }}>Cancelled: {row.cancelReason}</p>
      )}

      {events.length > 0 && (
        <ul className="tms-muted" style={{ ...LIST, gap: 2, fontSize: 12 }}>
          {events.map((event, i) => (
            <li key={`${event.at}:${i}`}>
              {formatDateTime(event.at)} · {event.action} · {event.by}
              {event.amountCents != null ? ` · ${formatCents(event.amountCents)}` : ''}
              {event.note ? ` — ${event.note}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {onApprove && state.canApprove && (
          <TmsButton variant="primary" size="sm" aria-label={`Approve ${row.id}`} disabled={busy} onClick={() => onApprove(row)}>
            Approve
          </TmsButton>
        )}
        {onAccept && state.canAcceptCounter && (
          <TmsButton variant="primary" size="sm" aria-label={`Accept counter on ${row.id}`} disabled={busy} onClick={() => onAccept(row)}>
            Accept
          </TmsButton>
        )}
        {onCounter && state.canCounter && (
          <TmsButton size="sm" aria-label={`Counter ${row.id}`} disabled={busy} onClick={() => onCounter(row)}>
            Counter
          </TmsButton>
        )}
        {onOverride && state.canOverride && (
          <TmsButton size="sm" aria-label={`Override ${row.id}`} disabled={busy} onClick={() => onOverride(row)}>
            Override
          </TmsButton>
        )}
        {onCancel && state.canCancel && (
          <TmsButton size="sm" variant="destructive" aria-label={`Cancel ${row.id}`} disabled={busy} onClick={() => onCancel(row)}>
            Cancel
          </TmsButton>
        )}
      </div>
    </li>
  )
}

/* ── Mine ────────────────────────────────────────────────────────────────── */

function MineTab({ rows, caller, busy, month, onCounter, onAccept }: {
  rows: CommissionRecord[]
  caller: CommissionCaller
  busy: boolean
  month: string
  onCounter: (row: CommissionRecord) => void
  onAccept: (row: CommissionRecord) => void
}) {
  const total = rows.reduce((sum, r) => (r.status === 'CANCELLED' ? sum : sum + r.netCents), 0)
  return (
    <div style={STACK}>
      <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>
        {rows.length === 0
          ? `Nothing was earned in ${monthLabel(month)}.`
          : `${rows.length} row${rows.length === 1 ? '' : 's'} · ${formatCents(total)} in ${monthLabel(month)}.`}
      </p>
      <ul style={LIST}>
        {rows.map((row) => (
          <CommissionRow
            key={row.id}
            row={row}
            caller={caller}
            busy={busy}
            onCounter={onCounter}
            onAccept={onAccept}
          />
        ))}
      </ul>
    </div>
  )
}

/* ── To approve ──────────────────────────────────────────────────────────── */

function ApproveTab({
  rows, caller, busy, month, onApprove, onAccept, onCounter, onOverride, onCancel,
}: {
  rows: CommissionRecord[]
  caller: CommissionCaller
  busy: boolean
  month: string
  onApprove: (row: CommissionRecord) => void
  onAccept: (row: CommissionRecord) => void
  onCounter: (row: CommissionRecord) => void
  onOverride: (row: CommissionRecord) => void
  onCancel: (row: CommissionRecord) => void
}) {
  const review = rows.filter((r) => r.needsReview).length
  return (
    <div style={STACK}>
      <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>
        {rows.length === 0
          ? `Nothing is waiting on you in ${monthLabel(month)}.`
          : `${rows.length} waiting${review > 0 ? ` · ${review} need a look first` : ''}.`}
      </p>
      <ul style={LIST}>
        {rows.map((row) => (
          <CommissionRow
            key={row.id}
            row={row}
            caller={caller}
            busy={busy}
            showReview
            onApprove={onApprove}
            onAccept={onAccept}
            onCounter={onCounter}
            onOverride={onOverride}
            onCancel={onCancel}
          />
        ))}
      </ul>
    </div>
  )
}

/* ── Pay periods ─────────────────────────────────────────────────────────── */

function PayPeriodsTab({ periods, busy, onOpen, onSubmit, onApprove, onPay, onStatement }: {
  periods: CommissionPayPeriodRecord[]
  busy: boolean
  onOpen: () => void
  onSubmit: (period: CommissionPayPeriodRecord) => void
  onApprove: (period: CommissionPayPeriodRecord) => void
  onPay: (period: CommissionPayPeriodRecord) => void
  onStatement: (payPeriodId: string, repId: string) => void
}) {
  return (
    <div style={STACK}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <TmsButton variant="primary" size="sm" aria-label="Open a pay period" disabled={busy} onClick={onOpen}>
          Open a period
        </TmsButton>
        <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>
          Paying a period <strong>records that payroll happened elsewhere</strong>. No money moves from here.
        </p>
      </div>

      {periods.length === 0 && (
        <p className="tms-muted" style={{ ...PANEL, margin: 0, fontSize: 14 }}>No pay period has been opened yet.</p>
      )}

      <ul style={{ ...LIST, gap: 12 }}>
        {periods.map((period) => {
          const status = period.status ?? 'OPEN'
          return (
            <li key={period.id} style={PANEL}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 500 }}>{period.periodStart} → {period.periodEnd}</span>
                <TmsBadge tone={status === 'PAID' ? 'green' : 'gray'}>{status}</TmsBadge>
                <span className="tms-muted" style={{ fontSize: 14 }}>pays {period.payDate}</span>
                <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {formatCents(period.totalCents ?? 0)}
                </span>
              </div>
              <p className="tms-field-hint" style={{ margin: 0 }}>
                {period.commissionCount ?? 0} commission{(period.commissionCount ?? 0) === 1 ? '' : 's'}
                {period.paidAt ? ` · paid ${period.paidAt}` : ''}
                {period.paymentRef ? ` · ref ${period.paymentRef}` : ''}
              </p>

              {(period.byRep ?? []).length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">Rep</th>
                      <th scope="col" style={NUM}>Rows</th>
                      <th scope="col" style={NUM}>Owed</th>
                      <th scope="col" aria-label="Statement" />
                    </tr>
                  </thead>
                  <tbody>
                    {(period.byRep ?? []).map((rep) => (
                      <tr key={rep.repId}>
                        <td>{rep.repName ?? rep.repId}</td>
                        <td style={NUM}>{rep.count}</td>
                        <td style={NUM}>{formatCents(rep.amountCents)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <TmsButton
                            size="sm"
                            variant="ghost"
                            aria-label={`Statement for ${rep.repName ?? rep.repId}`}
                            disabled={busy}
                            onClick={() => onStatement(period.id, rep.repId)}
                          >
                            Statement
                          </TmsButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {status === 'OPEN' && (
                  <TmsButton size="sm" aria-label={`Submit ${period.id}`} disabled={busy} onClick={() => onSubmit(period)}>
                    Submit
                  </TmsButton>
                )}
                {status === 'PENDING_APPROVAL' && (
                  <TmsButton variant="primary" size="sm" aria-label={`Approve ${period.id}`} disabled={busy} onClick={() => onApprove(period)}>
                    Approve
                  </TmsButton>
                )}
                {status === 'APPROVED' && (
                  <TmsButton variant="primary" size="sm" aria-label={`Pay ${period.id}`} disabled={busy} onClick={() => onPay(period)}>
                    Pay
                  </TmsButton>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ── History ─────────────────────────────────────────────────────────────── */

function HistoryTab({ rows, month, statusFacet, kindFacet, onStatus, onKind, onCsv }: {
  rows: CommissionRecord[]
  month: string
  statusFacet: CommissionStatus | ''
  kindFacet: CommissionKind | ''
  onStatus: (value: CommissionStatus | '') => void
  onKind: (value: CommissionKind | '') => void
  onCsv: () => void
}) {
  return (
    <div style={STACK}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
        <TmsField label="Status">
          <TmsSelect
            aria-label="Status"
            value={statusFacet}
            onChange={(e) => onStatus(e.target.value as CommissionStatus | '')}
            style={{ width: 'auto' }}
          >
            <option value="">Every status</option>
            {COMMISSION_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </TmsSelect>
        </TmsField>

        <TmsField label="Kind">
          <TmsSelect
            aria-label="Kind"
            value={kindFacet}
            onChange={(e) => onKind(e.target.value as CommissionKind | '')}
            style={{ width: 'auto' }}
          >
            <option value="">Every kind</option>
            {COMMISSION_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
          </TmsSelect>
        </TmsField>

        <TmsButton size="sm" style={{ marginLeft: 'auto' }} aria-label="Export commissions CSV" onClick={onCsv}>
          <Download size={14} /> CSV
        </TmsButton>
      </div>

      <Table>
        <thead>
          <tr>
            <th scope="col">Shipment</th>
            <th scope="col">Customer</th>
            <th scope="col">Rep</th>
            <th scope="col">Role</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col" style={NUM}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="tms-muted" style={{ padding: '32px 0', textAlign: 'center' }}>
                Nothing matches in {monthLabel(month)}.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.shipmentNumber ?? row.orderId}</td>
              <td>{row.customerName ?? '—'}</td>
              <td>{row.repName ?? row.repId}</td>
              <td>{roleLabel(row)}</td>
              <td>{kindLabel(row.kind)}</td>
              <td>{statusLabel(row.status)}</td>
              <td style={NUM}>{formatCents(row.netCents)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

/* ── The invoice detail's card ───────────────────────────────────────────── */

/**
 * What one invoice earned, on the bill it was earned from.
 *
 * Preview computes and writes nothing: it is what the plans say *today*, which is the
 * only honest way to answer "why is this number what it is" after a plan has changed.
 * Recompute writes, and the ledger rule still holds — an approved or paid row is never
 * rewritten, only adjusted.
 */
export function InvoiceCommissionCard({
  invoiceId, orderId, isAdmin, isManager,
}: {
  invoiceId: string
  orderId: string
  isAdmin: boolean
  isManager: boolean
}) {
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [rows, setRows] = useState<CommissionRecord[]>([])
  const [preview, setPreview] = useState<CommissionRecord[] | null>(null)
  const [previewNote, setPreviewNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    // A backend that predates the commission tables has nothing to answer with, and the
    // card stays unmounted either way — `loaded` false hides it exactly as `enabled` does.
    if (!commissionModelsDeployed()) return Promise.resolve()
    return getTmsSettings()
      .then((settings) => {
        const on = settings?.commissionsEnabled === true
        setEnabled(on)
        return on ? listCommissionsByInvoice(invoiceId).then((r) => setRows(r)) : undefined
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not read this invoice\u2019s commissions'))
      .finally(() => setLoaded(true))
  }, [invoiceId])
  useEffect(() => { load() }, [load])

  if (!loaded || !enabled) return null

  const mayAct = isAdmin || isManager

  const runPreview = () => {
    setBusy(true)
    previewCommissions({ orderId })
      .then((result) => {
        setPreview(result.rows ?? [])
        setPreviewNote(result.note ?? null)
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not preview the commissions'))
      .finally(() => setBusy(false))
  }

  const runRecompute = () => {
    setBusy(true)
    runCommissions({ invoiceId })
      .then(() => {
        toast.success('Commissions recomputed')
        setPreview(null)
        return load()
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not recompute the commissions'))
      .finally(() => setBusy(false))
  }

  return (
    <section style={PANEL}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Commissions</h3>
        <Link to="/tms/brokerage/commissions" aria-label="Open the commission desk" className="tms-btn tms-btn-ghost tms-btn-sm">
          Commission desk
        </Link>
        {mayAct && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <TmsButton size="sm" aria-label="Preview commissions" disabled={busy} onClick={runPreview}>
              Preview
            </TmsButton>
            <TmsButton size="sm" aria-label="Recompute commissions" disabled={busy} onClick={runRecompute}>
              <RefreshCw size={14} /> Recompute
            </TmsButton>
          </div>
        )}
      </div>

      {rows.length === 0 && (
        <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>No commission has been written against this invoice.</p>
      )}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th scope="col">Rep</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col" style={NUM}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.repName ?? row.repId}</td>
                <td>{roleLabel(row)}</td>
                <td><TmsBadge tone={BADGE_TONES[statusTone(row.status)] ?? 'gray'}>{statusLabel(row.status)}</TmsBadge></td>
                <td style={NUM}>{formatCents(row.netCents)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {preview && (
        <div style={{ border: '1px dashed var(--tms-border)', borderRadius: 4, padding: 8 }}>
          <p className="tms-field-label" style={{ margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            What the plans say today — computed, not written
          </p>
          {previewNote && <p className="tms-field-hint" style={{ margin: '4px 0 0' }}>{previewNote}</p>}
          {preview.length === 0 && !previewNote && (
            <p className="tms-field-hint" style={{ margin: '4px 0 0' }}>The plans pay nothing on this shipment.</p>
          )}
          <ul style={{ ...LIST, gap: 2, marginTop: 4, fontSize: 12 }}>
            {preview.map((row) => (
              <li key={row.id}>
                {row.repName ?? row.repId} · {roleLabel(row)} · {formatCents(row.netCents)}
                {needsReviewReason(row) ? ` — ${needsReviewReason(row)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/* ── Dialogs ─────────────────────────────────────────────────────────────── */

function AmountNoteDialog({
  title, description, noteLabel, confirmLabel, defaultCents, noteRequired, busy, onClose, onConfirm,
}: {
  title: string
  description: string
  noteLabel: string
  confirmLabel: string
  defaultCents: number
  noteRequired: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (amountCents: number, note: string) => void
}) {
  const [amount, setAmount] = useState(() => (defaultCents / 100).toFixed(2))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirm = () => {
    let cents: number
    try {
      cents = centsFromDollars(amount)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Enter a valid amount')
      return
    }
    setError(null)
    onConfirm(cents, note.trim())
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      description={description}
      footer={
        <>
          <TmsButton onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton
            variant="primary"
            aria-label={confirmLabel}
            disabled={busy || amount.trim().length === 0 || (noteRequired && note.trim().length === 0)}
            onClick={confirm}
          >
            {confirmLabel}
          </TmsButton>
        </>
      }
    >
      <div style={STACK}>
        <TmsField label="Amount (dollars)" htmlFor="commission-amount">
          <TmsInput
            id="commission-amount"
            aria-label="Amount in dollars"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </TmsField>
        <TmsField label={noteLabel} htmlFor="commission-note">
          <TmsTextarea
            id="commission-note"
            aria-label={noteLabel}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </TmsField>
        {error && <p style={{ margin: 0, fontSize: 14, color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}

function ReasonPrompt({ title, description, label, confirmLabel, busy, onClose, onConfirm }: {
  title: string
  description: string
  label: string
  confirmLabel: string
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      description={description}
      footer={
        <>
          <TmsButton onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton
            variant="destructive"
            aria-label={confirmLabel}
            disabled={busy || reason.trim().length === 0}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </TmsButton>
        </>
      }
    >
      <TmsField label={label} htmlFor="commission-reason">
        <TmsTextarea
          id="commission-reason"
          aria-label={label}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </TmsField>
    </TmsDialog>
  )
}

function PayPeriodDialog({ period, today, busy, onClose, onConfirm }: {
  period: CommissionPayPeriodRecord
  today: string
  busy: boolean
  onClose: () => void
  onConfirm: (paidAt: string, reference: string) => void
}) {
  const [paidAt, setPaidAt] = useState(() => period.payDate || today)
  const [reference, setReference] = useState('')

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Record ${period.periodStart} → ${period.periodEnd} as paid`}
      description={`This records that payroll has already paid ${formatCents(period.totalCents ?? 0)} elsewhere. No money moves from here, so the payroll reference is what ties the two records together.`}
      footer={
        <>
          <TmsButton onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</TmsButton>
          <TmsButton
            variant="primary"
            aria-label="Record as paid"
            disabled={busy || reference.trim().length === 0 || paidAt.trim().length === 0}
            onClick={() => onConfirm(paidAt, reference.trim())}
          >
            Record as paid
          </TmsButton>
        </>
      }
    >
      <div style={STACK}>
        <TmsField label="Paid date" htmlFor="period-paid-at">
          <TmsInput
            id="period-paid-at"
            type="date"
            aria-label="Paid date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
          />
        </TmsField>
        <TmsField label="Payroll reference" htmlFor="period-reference">
          <TmsInput
            id="period-reference"
            aria-label="Payroll reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </TmsField>
      </div>
    </TmsDialog>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="tms-field-label" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  )
}
