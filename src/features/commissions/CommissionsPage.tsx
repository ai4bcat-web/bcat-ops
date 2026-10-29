/**
 * `/commissions` — what each person is owed, who still has to agree to it, and the
 * periods those agreed numbers were handed to payroll in.
 *
 * Three things this board deliberately does not do. It never decides the approval
 * ladder: `commissionState` answers for the page and for the Lambda, so a button that
 * appears here is a button the server will honour and a button that is missing is work
 * the server would have refused anyway — the hiding is tidiness, never the boundary.
 * It never re-computes a number: `netCents` is what the ledger says is owed, and the
 * page prints it. And paying a period moves no money; it records that payroll, which
 * lives somewhere else entirely, has happened.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Coins, Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { cn } from '@/lib/utils'
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

const CARD = 'rounded-md border border-border bg-card p-4'
const TH = 'px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground'
const TD = 'px-2 py-2 align-top'
const MONEY = 'px-2 py-2 text-right tabular-nums align-top'
const SELECT = 'h-8 rounded-md border border-input bg-background px-2 text-sm'

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
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Coins size={18} />
        <h1 className="text-lg font-semibold">Commissions</h1>
        {tab !== 'pay-periods' && (
          <select
            aria-label="Commission month"
            className={cn(SELECT, 'ml-2')}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            {months.map((ym) => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
          </select>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9"
          aria-label="Refresh commissions"
          onClick={() => void load()}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <nav role="tablist" aria-label="Commission views" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {COMMISSION_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-label={t.label}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
            <Badge variant="outline" className="text-[10px]">{counts[t.key]}</Badge>
          </button>
        ))}
      </nav>

      <div className="flex-1 space-y-3 overflow-auto px-5 py-3">
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
      </div>

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
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Coins size={28} className="text-muted-foreground" />
      <h1 className="text-lg font-semibold">Commissions are switched off</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {deployed
          ? 'Nothing is computed, written or shown until an admin turns them on and saves a plan.'
          : 'This backend predates the commission tables, so there is nothing to read yet.'}
      </p>
      {isAdmin && deployed && (
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link to="/settings" aria-label="Open commission settings">Open Settings</Link>
        </Button>
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

  return (
    <li className={cn(CARD, 'space-y-2', row.needsReview && showReview && 'border-amber-500/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.shipmentNumber ?? row.invoiceNumber ?? row.orderId}</span>
        <span className="text-sm text-muted-foreground">{row.customerName ?? '—'}</span>
        <Badge variant="outline" className="text-[10px]">{roleLabel(row)}</Badge>
        {row.kind && row.kind !== 'EARNED' && (
          <Badge variant="secondary" className="text-[10px]">{kindLabel(row.kind)}</Badge>
        )}
        <Badge variant={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        <span className="ml-auto text-base font-semibold tabular-nums">{formatCents(row.netCents)}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Field label="Rep" value={row.repName ?? row.repId} />
        <Field label="Basis" value={`${row.basis ?? '—'} · ${formatCents(row.basisCents)}`} />
        <Field label="Rate" value={rateLabel(row)} />
        <Field label="Plan said" value={formatCents(row.amountCents)} />
      </dl>

      {reason && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
          Needs a look: this one {reason}.
        </p>
      )}

      {row.counterCents != null && (
        <p className="text-xs text-muted-foreground">
          Countered at {formatCents(row.counterCents)} by {row.counterBy ?? 'unknown'}
          {row.counterNote ? ` — ${row.counterNote}` : ''}
        </p>
      )}
      {row.overrideCents != null && (
        <p className="text-xs text-muted-foreground">
          Overridden to {formatCents(row.overrideCents)} by {row.overrideBy ?? 'unknown'}
          {row.overrideNote ? ` — ${row.overrideNote}` : ''}
        </p>
      )}
      {row.cancelReason && <p className="text-xs text-destructive">Cancelled: {row.cancelReason}</p>}

      {events.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {events.map((event, i) => (
            <li key={`${event.at}:${i}`}>
              {formatDateTime(event.at)} · {event.action} · {event.by}
              {event.amountCents != null ? ` · ${formatCents(event.amountCents)}` : ''}
              {event.note ? ` — ${event.note}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {onApprove && state.canApprove && (
          <Button size="sm" aria-label={`Approve ${row.id}`} disabled={busy} onClick={() => onApprove(row)}>
            Approve
          </Button>
        )}
        {onAccept && state.canAcceptCounter && (
          <Button size="sm" aria-label={`Accept counter on ${row.id}`} disabled={busy} onClick={() => onAccept(row)}>
            Accept
          </Button>
        )}
        {onCounter && state.canCounter && (
          <Button size="sm" variant="outline" aria-label={`Counter ${row.id}`} disabled={busy} onClick={() => onCounter(row)}>
            Counter
          </Button>
        )}
        {onOverride && state.canOverride && (
          <Button size="sm" variant="outline" aria-label={`Override ${row.id}`} disabled={busy} onClick={() => onOverride(row)}>
            Override
          </Button>
        )}
        {onCancel && state.canCancel && (
          <Button size="sm" variant="destructive" aria-label={`Cancel ${row.id}`} disabled={busy} onClick={() => onCancel(row)}>
            Cancel
          </Button>
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
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {rows.length === 0
          ? `Nothing was earned in ${monthLabel(month)}.`
          : `${rows.length} row${rows.length === 1 ? '' : 's'} · ${formatCents(total)} in ${monthLabel(month)}.`}
      </p>
      <ul className="space-y-2">
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
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {rows.length === 0
          ? `Nothing is waiting on you in ${monthLabel(month)}.`
          : `${rows.length} waiting${review > 0 ? ` · ${review} need a look first` : ''}.`}
      </p>
      <ul className="space-y-2">
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-label="Open a pay period" disabled={busy} onClick={onOpen}>
          Open a period
        </Button>
        <p className="text-sm text-muted-foreground">
          Paying a period <strong>records that payroll happened elsewhere</strong>. No money moves from here.
        </p>
      </div>

      {periods.length === 0 && (
        <p className={cn(CARD, 'text-sm text-muted-foreground')}>No pay period has been opened yet.</p>
      )}

      <ul className="space-y-3">
        {periods.map((period) => {
          const status = period.status ?? 'OPEN'
          return (
            <li key={period.id} className={cn(CARD, 'space-y-2')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{period.periodStart} → {period.periodEnd}</span>
                <Badge variant={status === 'PAID' ? 'default' : 'outline'}>{status}</Badge>
                <span className="text-sm text-muted-foreground">pays {period.payDate}</span>
                <span className="ml-auto text-base font-semibold tabular-nums">
                  {formatCents(period.totalCents ?? 0)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {period.commissionCount ?? 0} commission{(period.commissionCount ?? 0) === 1 ? '' : 's'}
                {period.paidAt ? ` · paid ${period.paidAt}` : ''}
                {period.paymentRef ? ` · ref ${period.paymentRef}` : ''}
              </p>

              {(period.byRep ?? []).length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={TH} scope="col">Rep</th>
                      <th className={cn(TH, 'text-right')} scope="col">Rows</th>
                      <th className={cn(TH, 'text-right')} scope="col">Owed</th>
                      <th className={TH} scope="col"><span className="sr-only">Statement</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(period.byRep ?? []).map((rep) => (
                      <tr key={rep.repId} className="border-b border-border/60">
                        <td className={TD}>{rep.repName ?? rep.repId}</td>
                        <td className={MONEY}>{rep.count}</td>
                        <td className={MONEY}>{formatCents(rep.amountCents)}</td>
                        <td className={cn(TD, 'text-right')}>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Statement for ${rep.repName ?? rep.repId}`}
                            disabled={busy}
                            onClick={() => onStatement(period.id, rep.repId)}
                          >
                            Statement
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="flex flex-wrap gap-2">
                {status === 'OPEN' && (
                  <Button size="sm" variant="outline" aria-label={`Submit ${period.id}`} disabled={busy} onClick={() => onSubmit(period)}>
                    Submit
                  </Button>
                )}
                {status === 'PENDING_APPROVAL' && (
                  <Button size="sm" aria-label={`Approve ${period.id}`} disabled={busy} onClick={() => onApprove(period)}>
                    Approve
                  </Button>
                )}
                {status === 'APPROVED' && (
                  <Button size="sm" aria-label={`Pay ${period.id}`} disabled={busy} onClick={() => onPay(period)}>
                    Pay
                  </Button>
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Status</Label>
        <select
          aria-label="Status"
          className={SELECT}
          value={statusFacet}
          onChange={(e) => onStatus(e.target.value as CommissionStatus | '')}
        >
          <option value="">Every status</option>
          {COMMISSION_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>

        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Kind</Label>
        <select
          aria-label="Kind"
          className={SELECT}
          value={kindFacet}
          onChange={(e) => onKind(e.target.value as CommissionKind | '')}
        >
          <option value="">Every kind</option>
          {COMMISSION_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>

        <Button size="sm" variant="outline" className="ml-auto" aria-label="Export commissions CSV" onClick={onCsv}>
          <Download size={14} className="mr-1" /> CSV
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH} scope="col">Shipment</th>
            <th className={TH} scope="col">Customer</th>
            <th className={TH} scope="col">Rep</th>
            <th className={TH} scope="col">Role</th>
            <th className={TH} scope="col">Kind</th>
            <th className={TH} scope="col">Status</th>
            <th className={cn(TH, 'text-right')} scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                Nothing matches in {monthLabel(month)}.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border/60">
              <td className={TD}>{row.shipmentNumber ?? row.orderId}</td>
              <td className={TD}>{row.customerName ?? '—'}</td>
              <td className={TD}>{row.repName ?? row.repId}</td>
              <td className={TD}>{roleLabel(row)}</td>
              <td className={TD}>{kindLabel(row.kind)}</td>
              <td className={TD}>{statusLabel(row.status)}</td>
              <td className={MONEY}>{formatCents(row.netCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    <section className={CARD}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Commissions</h2>
        <Button asChild size="sm" variant="ghost">
          <Link to="/commissions" aria-label="Open the commission desk">Commission desk</Link>
        </Button>
        {mayAct && (
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" aria-label="Preview commissions" disabled={busy} onClick={runPreview}>
              Preview
            </Button>
            <Button size="sm" variant="outline" aria-label="Recompute commissions" disabled={busy} onClick={runRecompute}>
              <RefreshCw size={14} className="mr-1" /> Recompute
            </Button>
          </div>
        )}
      </div>

      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No commission has been written against this invoice.</p>
      )}
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={TH} scope="col">Rep</th>
              <th className={TH} scope="col">Role</th>
              <th className={TH} scope="col">Status</th>
              <th className={cn(TH, 'text-right')} scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/60">
                <td className={TD}>{row.repName ?? row.repId}</td>
                <td className={TD}>{roleLabel(row)}</td>
                <td className={TD}>
                  <Badge variant={statusTone(row.status)} className="text-[10px]">{statusLabel(row.status)}</Badge>
                </td>
                <td className={MONEY}>{formatCents(row.netCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview && (
        <div className="mt-3 rounded border border-dashed border-border p-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            What the plans say today — computed, not written
          </p>
          {previewNote && <p className="mt-1 text-xs text-muted-foreground">{previewNote}</p>}
          {preview.length === 0 && !previewNote && (
            <p className="mt-1 text-xs text-muted-foreground">The plans pay nothing on this order.</p>
          )}
          <ul className="mt-1 space-y-0.5 text-xs">
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div>
          <Label htmlFor="commission-amount" className="text-xs uppercase tracking-wider text-muted-foreground">
            Amount (dollars)
          </Label>
          <Input
            id="commission-amount"
            aria-label="Amount in dollars"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="commission-note" className="text-xs uppercase tracking-wider text-muted-foreground">
            {noteLabel}
          </Label>
          <Textarea
            id="commission-note"
            aria-label={noteLabel}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button
            aria-label={confirmLabel}
            disabled={busy || amount.trim().length === 0 || (noteRequired && note.trim().length === 0)}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div>
          <Label htmlFor="commission-reason" className="text-xs uppercase tracking-wider text-muted-foreground">
            {label}
          </Label>
          <Textarea
            id="commission-reason"
            aria-label={label}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button
            variant="destructive"
            aria-label={confirmLabel}
            disabled={busy || reason.trim().length === 0}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Record {period.periodStart} → {period.periodEnd} as paid</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          This records that payroll has already paid {formatCents(period.totalCents ?? 0)} elsewhere. No money moves
          from here, so the payroll reference is what ties the two records together.
        </p>
        <div>
          <Label htmlFor="period-paid-at" className="text-xs uppercase tracking-wider text-muted-foreground">
            Paid date
          </Label>
          <Input
            id="period-paid-at"
            type="date"
            aria-label="Paid date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="period-reference" className="text-xs uppercase tracking-wider text-muted-foreground">
            Payroll reference
          </Label>
          <Input
            id="period-reference"
            aria-label="Payroll reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="mt-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} aria-label="Cancel">Cancel</Button>
          <Button
            aria-label="Record as paid"
            disabled={busy || reference.trim().length === 0 || paidAt.trim().length === 0}
            onClick={() => onConfirm(paidAt, reference.trim())}
          >
            Record as paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
