/**
 * Settings > Cost to run (admin only): what BCAT Ops costs to keep running.
 *
 * AWS, Twilio, Hermes and the app's own AI calls are collected daily by
 * `scripts/costCollector.mjs`; anything without a billing API (Google Workspace, Motive,
 * MyCarrierPackets, subscriptions…) is a fixed monthly cost typed in below. The sums,
 * weeks, projection and CSV are all `src/lib/costToRun.ts`.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Plus, Save, Trash2, Wallet } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { TmsButton, TmsInput, TmsKpiCard, TmsSegmentedTabs, TmsSelect } from '@/features/tms/kit'
import { useTmsTokens } from '@/features/tms/tmsTokens'
import { getCostToRun, saveCostManualEntries, type CostToRunData } from '@/lib/apiClient'
import { downloadCsv } from '@/lib/directoryCsv'
import {
  COST_CATEGORIES, allServices, costCsv, dailyCosts, dollars, headline, totalsBy,
  type CostCategory, type CostManualEntry, type PeriodTotals,
} from '@/lib/costToRun'
import { ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

const MONTHS = 15
const CHART_TOKENS = [
  '--tms-chart-1', '--tms-chart-2', '--tms-chart-4', '--tms-chart-5', '--tms-chart-6',
  '--tms-chart-7', '--tms-chart-8', '--tms-chart-11', '--tms-chart-9', '--tms-chart-axis', '--tms-chart-grid',
] as const
const SOURCE_LABEL = { billed: 'Billed', estimated: 'Estimate', manual: 'Fixed monthly' } as const
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

const todayIso = () => new Date().toISOString().slice(0, 10)
const periodLabel = (unit: 'month' | 'week', p: string) => unit === 'month'
  ? new Date(`${p}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  : `Wk ${new Date(`${p}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}`

export function CostToRunCard() {
  const [data, setData] = useState<CostToRunData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unit, setUnit] = useState<'month' | 'week'>('month')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<CostManualEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const tok = useTmsTokens(CHART_TOKENS)

  const load = () => {
    getCostToRun(todayIso().slice(0, 7), MONTHS)
      .then((d) => { setData(d); setDraft(null) })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load costs'))
  }
  useEffect(load, [])

  const view = useMemo(() => {
    if (!data) return null
    const manual = draft ?? data.manual
    const services = allServices(data.meta, manual)
    const asOf = data.meta?.asOf ?? todayIso()
    const first = data.months[0] ? `${data.months[0].month}-01` : `${asOf.slice(0, 7)}-01`
    const daily = dailyCosts(data.months, manual, first, asOf)
    return {
      services, asOf,
      head: headline(daily, asOf),
      months: totalsBy('month', daily, services),
      weeks: totalsBy('week', daily, services),
    }
  }, [data, draft])

  if (error) return <SettingsCard icon={Wallet} title="Cost to run"><ErrorText>{error}</ErrorText></SettingsCard>
  if (!data || !view) return <SettingsCard icon={Wallet} title="Cost to run"><Loading /></SettingsCard>

  const periods: PeriodTotals[] = unit === 'month' ? view.months : view.weeks.slice(-26)
  const recent = periods.slice(-6)
  const thisMonth = view.months.at(-1)
  const lastMonth = view.months.at(-2)
  const thisWeek = view.weeks.at(-1)
  const lastWeek = view.weeks.at(-2)
  const categories = COST_CATEGORIES.filter((c) => view.services.some((s) => s.category === c.key))
  const chartData = periods.map((p) => ({
    label: periodLabel(unit, p.period),
    ...Object.fromEntries(categories.map((c) => [c.key, Math.round(p.byCategory[c.key] ?? 0) / 100])),
  }))
  const colors = CHART_TOKENS.slice(0, 9).map((t) => tok[t])
  const sourcesBad = Object.entries(data.meta?.sources ?? {}).filter(([, s]) => !s.ok)
  const toggle = (key: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const money = (cents: number | undefined) => (cents ? dollars(cents) : '—')

  const manual = draft ?? data.manual
  const setEntry = (i: number, patch: Partial<CostManualEntry>) =>
    setDraft(manual.map((e, k) => (k === i ? { ...e, ...patch } : e)))
  const save = async () => {
    setSaving(true)
    try {
      await saveCostManualEntries(manual.map((e) => ({ ...e, label: e.label.trim() })), data.settingsUpdatedAt)
      toast.success('Fixed monthly costs saved')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      icon={Wallet}
      title="Cost to run"
      description="What BCAT Ops costs to keep running: AWS, hosting, e-mail, sign-in, phone and texts, AI agents and the third-party services it depends on."
      actions={
        <TmsButton size="sm" onClick={() => downloadCsv(`bcat-ops-cost-${unit}s-${view.asOf}.csv`, costCsv(periods, view.services))}>
          <Download size={14} aria-hidden="true" /> Export CSV
        </TmsButton>
      }
    >
      <Stack gap={16}>
        <Hint>
          Costs as of {new Date(`${view.asOf}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
          {data.meta?.collectedAt ? `, collected ${new Date(data.meta.collectedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.
          {' '}AWS figures lag about a day.
        </Hint>
        {!data.meta && <ErrorText>No cost data has been collected yet. The collector runs once a day.</ErrorText>}
        {sourcesBad.length > 0 && (
          <ErrorText>Last collection could not read: {sourcesBad.map(([k, s]) => `${k} (${s.error ?? 'error'})`).join('; ')}</ErrorText>
        )}

        <div className="tms-cost-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <TmsKpiCard compact label="This month so far" value={dollars(view.head.monthToDate)} />
          <TmsKpiCard compact label="Projected this month" value={dollars(view.head.projectedMonth)} sub="At this month's daily rate" />
          <TmsKpiCard compact label="Last month" value={dollars(view.head.lastMonth)} />
          <TmsKpiCard compact label="Average per week" value={dollars(view.head.avgWeek12)} sub="Last 12 full weeks" />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>History by category</strong>
            <TmsSegmentedTabs
              size="sm"
              aria-label="Group history by"
              tabs={[{ key: 'month', label: 'Month' }, { key: 'week', label: 'Week' }]}
              active={unit}
              onSelect={(k) => setUnit(k as 'month' | 'week')}
            />
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid stroke={tok['--tms-chart-grid']} strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: tok['--tms-chart-axis'], fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => usdCompact.format(v)} tick={{ fill: tok['--tms-chart-axis'], fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip
                cursor={{ fill: tok['--tms-chart-grid'] }}
                formatter={(value) => dollars(Number(value) * 100)}
                contentStyle={{ background: 'var(--tms-card)', color: 'var(--tms-text)', border: '1px solid var(--tms-border)', borderRadius: 8, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
              {categories.map((c, i) => (
                <Bar key={c.key} dataKey={c.key} name={c.label} stackId="cost" fill={colors[i % colors.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="tms-table" style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Category / service</th>
                <th style={{ textAlign: 'right' }}>This month</th>
                <th style={{ textAlign: 'right' }}>Last month</th>
                <th style={{ textAlign: 'right' }}>This week</th>
                <th style={{ textAlign: 'right' }}>Last week</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const rows = view.services.filter((s) => s.category === c.key)
                const isOpen = open.has(c.key)
                return (
                  <Fragment key={c.key}>
                    <tr>
                      <td>
                        <button type="button" onClick={() => toggle(c.key)} aria-expanded={isOpen} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, background: 'none', border: 'none', padding: 0, color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
                          {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          {c.label}
                        </button>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(thisMonth?.byCategory[c.key])}</td>
                      <td style={{ textAlign: 'right' }}>{money(lastMonth?.byCategory[c.key])}</td>
                      <td style={{ textAlign: 'right' }}>{money(thisWeek?.byCategory[c.key])}</td>
                      <td style={{ textAlign: 'right' }}>{money(lastWeek?.byCategory[c.key])}</td>
                    </tr>
                    {isOpen && rows.map((s) => (
                      <tr key={s.key}>
                        <td style={{ paddingLeft: 28 }}>
                          {s.label}
                          <span className="tms-field-hint" style={{ marginLeft: 6 }}>
                            {SOURCE_LABEL[s.source]}{s.note ? ` · ${s.note}` : ''}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>{money(thisMonth?.byService[s.key])}</td>
                        <td style={{ textAlign: 'right' }}>{money(lastMonth?.byService[s.key])}</td>
                        <td style={{ textAlign: 'right' }}>{money(thisWeek?.byService[s.key])}</td>
                        <td style={{ textAlign: 'right' }}>{money(lastWeek?.byService[s.key])}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
              <tr>
                <td style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(thisMonth?.total)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(lastMonth?.total)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(thisWeek?.total)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(lastWeek?.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <strong style={{ fontSize: 13 }}>{unit === 'month' ? 'Monthly' : 'Weekly'} history</strong>
          <table className="tms-table" style={{ width: '100%', fontVariantNumeric: 'tabular-nums', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{unit === 'month' ? 'Month' : 'Week of'}</th>
                {categories.map((c) => <th key={c.key} style={{ textAlign: 'right' }}>{c.label}</th>)}
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {[...periods].reverse().map((p) => (
                <tr key={p.period}>
                  <td>{periodLabel(unit, p.period)}{p === periods.at(-1) ? ' (so far)' : ''}</td>
                  {categories.map((c) => <td key={c.key} style={{ textAlign: 'right' }}>{money(p.byCategory[c.key])}</td>)}
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recent.length === 0 && <Hint>No history yet.</Hint>}
        </div>

        <div>
          <strong style={{ fontSize: 13 }}>Fixed monthly costs</strong>
          <Hint>For services with no billing feed: Google Workspace mailboxes, Motive, MyCarrierPackets, Google Maps, Slack, the domain, AI subscriptions. They are spread evenly over each day of the months they cover.</Hint>
          <Stack gap={8}>
            {manual.map((e, i) => (
              <div key={e.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, alignItems: 'center' }} className="tms-cost-manual-row">
                <TmsInput aria-label="Service" placeholder="Service" value={e.label} onChange={(ev) => setEntry(i, { label: ev.target.value })} />
                <TmsSelect
                  aria-label="Category"
                  value={e.category}
                  onChange={(ev) => setEntry(i, { category: ev.target.value as CostCategory })}
                  options={COST_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
                />
                <TmsInput
                  aria-label="Monthly cost in dollars"
                  inputMode="decimal"
                  placeholder="$ / month"
                  value={e.monthlyCents ? String(e.monthlyCents / 100) : ''}
                  onChange={(ev) => {
                    const n = Number(ev.target.value.replace(/[$,]/g, ''))
                    setEntry(i, { monthlyCents: Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0 })
                  }}
                />
                <TmsInput aria-label="Start month" type="month" value={e.startMonth ?? ''} onChange={(ev) => setEntry(i, { startMonth: ev.target.value || null })} />
                <TmsInput aria-label="End month" type="month" value={e.endMonth ?? ''} onChange={(ev) => setEntry(i, { endMonth: ev.target.value || null })} />
                <TmsInput aria-label="Source note" placeholder="Where the price comes from" value={e.note ?? ''} onChange={(ev) => setEntry(i, { note: ev.target.value || null })} />
                <TmsButton size="sm" variant="ghost" aria-label={`Remove ${e.label || 'cost'}`} onClick={() => setDraft(manual.filter((_, k) => k !== i))}>
                  <Trash2 size={14} aria-hidden="true" />
                </TmsButton>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <TmsButton
                size="sm"
                onClick={() => setDraft([...manual, { id: `m${Date.now().toString(36)}`, label: '', category: 'thirdparty', monthlyCents: 0, startMonth: todayIso().slice(0, 7), endMonth: null, note: null }])}
              >
                <Plus size={14} aria-hidden="true" /> Add a fixed cost
              </TmsButton>
              {draft && (
                <>
                  <TmsButton size="sm" variant="primary" onClick={save} disabled={saving || manual.some((e) => !e.label.trim())}>
                    <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save fixed costs'}
                  </TmsButton>
                  <TmsButton size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Discard changes</TmsButton>
                </>
              )}
            </div>
          </Stack>
        </div>

        {(data.meta?.notes ?? []).length > 0 && (
          <Stack gap={4}>
            {data.meta!.notes.map((n) => <Hint key={n}>{n}</Hint>)}
            <Hint>Billed is the provider's own bill. Estimate is worked out from usage. Fixed monthly is typed in here. Spend in the same AWS account by other apps (the outreach engine, JobsDone OS, the Command Center) is left out.</Hint>
          </Stack>
        )}
      </Stack>
    </SettingsCard>
  )
}
