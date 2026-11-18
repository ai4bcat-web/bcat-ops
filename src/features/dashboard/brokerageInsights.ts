import { monthChange, type Measures, type MonthMeasures, type RepMonthRow } from '@/lib/brokerageRevenue'
import { moneyCompact, pct } from './brokerageFormat'

export interface Insight { key: string; tone: 'good' | 'watch' | 'neutral'; text: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1]
export const monthShort = (m: string) => `${monthName(m)} ${m.slice(0, 4)}`

/**
 * Two to four plain-English takeaways from the figures already on the page: how the last finished month compared,
 * how the month in progress is going, the best month, and who brings in the profit. Nothing here is a new number:
 * every sentence restates a figure the charts show.
 */
/** The previous month cut to the same days as the month in progress ("Oct 1-18"); `through` is the last day counted. */
export interface SamePeriod { month: string; through: number; measures: Measures }

/** `Oct 1–18` (just `Oct 1` for the first day). */
export const samePeriodLabel = (p: Pick<SamePeriod, 'month' | 'through'>) => `${monthName(p.month)} 1${p.through > 1 ? `–${p.through}` : ''}`

export function brokerageInsights(rows: readonly MonthMeasures[], reps: readonly RepMonthRow[], grand: Measures, current: string, same?: SamePeriod | null): Insight[] {
  const out: Insight[] = []
  const done = rows.filter((r) => r.month < current && r.loads > 0)
  const last = done[done.length - 1]
  const before = done[done.length - 2]

  if (last && before) {
    const c = monthChange(last.profitCents, before.profitCents, 'money')
    if (c && c.dir !== 'flat') {
      out.push({
        key: 'trend', tone: c.dir === 'up' ? 'good' : 'watch',
        text: `${monthName(last.month)} profit was ${moneyCompact(last.profitCents)}, ${c.dir === 'up' ? 'up' : 'down'} ${c.text.replace(/^[+−]/, '')} from ${monthName(before.month)}.`,
      })
    } else if (c) {
      out.push({ key: 'trend', tone: 'neutral', text: `${monthName(last.month)} profit matched ${monthName(before.month)} at ${moneyCompact(last.profitCents)}.` })
    }
  }

  const now = rows.find((r) => r.month === current)
  if (now && now.loads > 0) {
    const loads = `${now.loads} load${now.loads === 1 ? '' : 's'}`
    out.push({
      key: 'pace', tone: 'neutral',
      // The same days of last month when they are known (a rep caller's figures have no day rows), else last month in full.
      text: same
        ? `${monthName(current)} so far: ${moneyCompact(now.profitCents)} profit on ${loads}. ${samePeriodLabel(same)} was ${moneyCompact(same.measures.profitCents)}.`
        : last
          ? `${monthName(current)} so far: ${moneyCompact(now.profitCents)} profit on ${loads}. ${monthName(last.month)} finished at ${moneyCompact(last.profitCents)}.`
          : `${monthName(current)} so far: ${moneyCompact(now.profitCents)} profit on ${loads}.`,
    })
  }

  if (done.length >= 2) {
    const best = done.reduce((a, b) => (b.profitCents > a.profitCents ? b : a))
    out.push({ key: 'best', tone: 'neutral', text: `Best month so far is ${monthName(best.month)} with ${moneyCompact(best.profitCents)} profit${best.marginBps == null ? '' : ` at ${pct(best.marginBps)}`}.` })
  }

  const named = reps.filter((r) => r.repKey !== '' && r.total.profitCents > 0)
  if (named.length > 0 && grand.profitCents > 0) {
    const top = named[0]
    const share = Math.round((top.total.profitCents / grand.profitCents) * 100)
    out.push({
      key: 'rep', tone: share >= 70 && named.length > 1 ? 'watch' : 'neutral',
      text: named.length === 1
        ? `${top.label} brought in all of the profit (${moneyCompact(top.total.profitCents)}).`
        : `${top.label} brings in ${share}% of profit (${moneyCompact(top.total.profitCents)}), ahead of ${named[1].label}.`,
    })
  }
  return out.slice(0, 4)
}
