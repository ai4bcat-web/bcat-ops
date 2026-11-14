/**
 * The per-tab card beside the Receivable / Payable tabs, and the month-to-date profit check
 * both pages share. Rows that narrow the table are buttons (the due bucket or the party filter);
 * the rest are figures. Same list-card look as the totals card next to them.
 */
import { useEffect, useState } from 'react'
import { TmsListCard, type TmsListRow } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { loadSamples } from '@/lib/reportsClient'
import { DUE_BUCKET_LABEL, type DueBucket } from '@/features/ar/owedFilters'
import {
  REVIEW_REASON_LABEL, profitCheck, type ApAgingStats, type ApExpectedStats, type ApPaidStats, type ArInvoicedStats,
  type ArPaidStats, type ArReadyStats, type Money, type PartyMoney, type ProfitCheck, type ReviewReasonKey,
} from './accountingStats'

const n = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`
const days = (d: number | null) => (d == null ? null : `${d} d`)

/** The due buckets a tab card lists, in ladder order. */
const DUE_ROWS: DueBucket[] = ['past', 'week', 'month', 'later', 'none']

function dueRows(owed: ArInvoicedStats['owed'], unit: string, active: DueBucket | null, onDue: (b: DueBucket | null) => void): TmsListRow[] {
  return DUE_ROWS.filter((b) => b !== 'none' || owed.buckets.none.count > 0).map((b) => ({
    key: `due-${b}`,
    label: DUE_BUCKET_LABEL[b],
    value: formatCents(owed.buckets[b].cents),
    sub: n(owed.buckets[b].count, unit),
    share: owed.totalCents ? owed.buckets[b].cents / owed.totalCents : 0,
    tone: b === 'past' && owed.buckets.past.cents > 0 ? 'bad' : 'default',
    active: active === b,
    onClick: () => onDue(active === b ? null : b),
  }))
}

function partyRows(top: PartyMoney[], unit: string, active: readonly string[], onParty: (id: string | null) => void): TmsListRow[] {
  if (top.length === 0) return []
  const one = active.length === 1 ? active[0] : null
  return [
    { key: 'top-head', label: 'Largest balances', value: '', kind: 'group' },
    ...top.map((p): TmsListRow => ({
      key: `party-${p.id}`,
      label: p.name,
      value: formatCents(p.cents),
      sub: n(p.count, unit),
      kind: 'sub',
      active: one === p.id,
      onClick: () => onParty(one === p.id ? null : p.id),
    })),
  ]
}

const money = (m: Money, unit: string) => ({ value: formatCents(m.cents), sub: n(m.count, unit) })

export function ArReadyCard({ stats }: { stats: ArReadyStats }) {
  return (
    <TmsListCard
      title="Ready to invoice"
      testId="ar-tab-card"
      rows={[
        { key: 'total', label: 'Ready', ...money(stats.total, 'load') },
        { key: 'factor-ok', label: 'Ready to factor ✓', value: stats.factorReady == null ? null : String(stats.factorReady), title: 'Factor-billed loads with every OTR field' },
        { key: 'factor-missing', label: 'Factor · missing info', value: stats.factorMissing == null ? null : String(stats.factorMissing), tone: stats.factorMissing ? 'warn' : 'default' },
        { key: 'oldest', label: 'Oldest waiting', value: days(stats.oldestDays), sub: 'since released', tone: (stats.oldestDays ?? 0) > 7 ? 'warn' : 'default' },
      ]}
    />
  )
}

export function ArInvoicedCard({ stats, due, onDue, parties, onParty }: {
  stats: ArInvoicedStats
  due: DueBucket | null
  onDue: (b: DueBucket | null) => void
  parties: readonly string[]
  onParty: (id: string | null) => void
}) {
  return (
    <TmsListCard
      title="Open invoices"
      total={formatCents(stats.owed.totalCents)}
      testId="ar-tab-card"
      rows={[
        ...dueRows(stats.owed, 'invoice', due, onDue),
        { key: 'partial', label: 'Partially paid', ...money(stats.partial, 'invoice') },
        ...partyRows(stats.top, 'invoice', parties, onParty),
      ]}
    />
  )
}

export function ArPaidCard({ stats, monthLabel }: { stats: ArPaidStats; monthLabel: string }) {
  return (
    <TmsListCard
      title={`Paid · ${monthLabel}`}
      total={formatCents(stats.collected.cents)}
      testId="ar-tab-card"
      rows={[
        { key: 'collected', label: 'Collected', ...money(stats.collected, 'invoice') },
        { key: 'ach', label: 'ACH', ...money(stats.ach, 'invoice') },
        { key: 'check', label: 'Paper check', ...money(stats.check, 'invoice') },
        ...(stats.other.count ? [{ key: 'other', label: 'Other / not recorded', ...money(stats.other, 'invoice') }] : []),
        { key: 'dtp', label: 'Avg days to pay', value: days(stats.avgDaysToPay), sub: 'invoice → paid' },
        ...(stats.fastest ? [{ key: 'fast', label: 'Fastest', value: days(stats.fastest.days), sub: stats.fastest.name }] : []),
        ...(stats.slowest ? [{ key: 'slow', label: 'Slowest', value: days(stats.slowest.days), sub: stats.slowest.name, tone: 'warn' as const }] : []),
      ]}
    />
  )
}

export function ReviewReasonCard({ counts, total }: { counts: { key: ReviewReasonKey; count: number }[]; total: number }) {
  return (
    <TmsListCard
      title="Needs review"
      total={String(total)}
      testId="review-tab-card"
      rows={counts.map((c) => ({ key: c.key, label: REVIEW_REASON_LABEL[c.key], value: String(c.count), tone: c.key === 'other' ? 'default' : 'warn' }))}
    />
  )
}

export function ApExpectedCard({ stats }: { stats: ApExpectedStats }) {
  return (
    <TmsListCard
      title="Expected"
      total={formatCents(stats.total.cents)}
      testId="ap-tab-card"
      rows={[
        { key: 'total', label: 'Expected', ...money(stats.total, 'bill') },
        { key: 'fix', label: 'Needs fix', ...money(stats.needsFix, 'bill'), tone: stats.needsFix.count ? 'warn' : 'default', title: 'Shipment flagged in Needs review' },
        { key: 'oldest', label: 'Oldest expected', value: days(stats.oldestDays), sub: 'since recorded' },
      ]}
    />
  )
}

export function ApAgingCard({ stats, due, onDue, parties, onParty }: {
  stats: ApAgingStats
  due: DueBucket | null
  onDue: (b: DueBucket | null) => void
  parties: readonly string[]
  onParty: (id: string | null) => void
}) {
  return (
    <TmsListCard
      title="Open bills by due date"
      total={formatCents(stats.owed.totalCents)}
      testId="ap-tab-card"
      rows={[...dueRows(stats.owed, 'bill', due, onDue), ...partyRows(stats.top, 'bill', parties, onParty)]}
    />
  )
}

export function ApPaidCard({ stats, monthLabel }: { stats: ApPaidStats; monthLabel: string }) {
  return (
    <TmsListCard
      title={`Paid · ${monthLabel}`}
      total={formatCents(stats.paid.cents)}
      testId="ap-tab-card"
      rows={[
        { key: 'paid', label: 'Paid', ...money(stats.paid, 'bill') },
        { key: 'car', label: 'Delivery → paid · car shipping', value: days(stats.carAvgDays), sub: `${n(stats.carCount, 'bill')} · target 2 d`, tone: (stats.carAvgDays ?? 0) > 2 ? 'warn' : 'default' },
        { key: 'other', label: 'Delivery → paid · other', value: days(stats.otherAvgDays), sub: n(stats.otherCount, 'bill') },
      ]}
    />
  )
}

/** Month-to-date margin from the per-load lane samples; read once per month (the reports cache). */
export function ProfitCheckCard({ asOf, testId }: { asOf: string; testId?: string }) {
  const [check, setCheck] = useState<ProfitCheck | null>(null)
  useEffect(() => {
    let alive = true
    // Through a resolved promise so a missing read (an older backend, a test mock) is caught, not thrown.
    Promise.resolve()
      .then(() => loadSamples(`${asOf.slice(0, 7)}-01`, asOf))
      .then((read) => { if (alive) setCheck(profitCheck(read.rows)) })
      .catch(() => { /* the card stays on its dashes */ })
    return () => { alive = false }
  }, [asOf])
  const pct = check?.marginBps == null ? null : `${(check.marginBps / 100).toFixed(1)}%`
  const worst = check?.negative.slice(0, 5).map((x) => `${x.shipmentNumber} ${formatCents(x.profitCents)}`).join(' · ')
  return (
    <TmsListCard
      title="Profit check · month to date"
      testId={testId ?? 'profit-check-card'}
      rows={[
        { key: 'rev', label: 'Revenue', value: check ? formatCents(check.revenueCents) : null, sub: check ? n(check.loads, 'load') : null },
        { key: 'cost', label: 'Carrier cost', value: check ? formatCents(check.costCents) : null },
        { key: 'profit', label: 'Gross margin', value: check ? formatCents(check.profitCents) : null, sub: pct, tone: check && check.profitCents < 0 ? 'bad' : 'default' },
        {
          key: 'negative',
          label: 'Negative-margin loads',
          value: check ? String(check.negative.length) : null,
          tone: check && check.negative.length ? 'bad' : 'default',
          title: worst ? `Worst: ${worst}` : 'None',
        },
      ]}
    />
  )
}
