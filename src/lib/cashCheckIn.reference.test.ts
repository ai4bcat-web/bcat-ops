import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CASH_SETTINGS, projectCash, type CashCheckIn, type CashOutlookRow, type CashSettingsValues } from './cashCheckIn'

// Runs the standalone reference's own <script> (Docs/reference/…html) in a VM and checks
// projectCash against its outlook() month by month. The reference has no cash lag, so
// every lagMonths is 0 here; the lag itself is covered in cashCheckIn.test.ts.

const html = readFileSync(new URL('../../Docs/reference/bcat-weekly-checkin-reference.html', import.meta.url), 'utf8')
const source = html.split('<script>')[1].split('</script>')[0]
const prefix = source.slice(0, source.indexOf('(async function init()'))
const context = createContext({ document: { querySelector: () => ({ addEventListener() {} }), addEventListener() {} } })
runInContext(`${prefix}\nglobalThis.reference = { run: (payload) => { state = payload; return outlook(); } };})();`, context)
const reference = context.reference as { run: (payload: unknown) => unknown }

let seed = 718
const random = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }

/** The row fields the reference's outlook() defines — `estimated` and `landing` are ours. */
const referenceFields = ({ ym, per, net, netToCome, items, itemsSum, cash, status, current, fxCash, fxDelta, fxActive }: CashOutlookRow) =>
  ({ ym, per, net, netToCome, items, itemsSum, cash, status, current, fxCash, fxDelta, fxActive })

describe('projectCash vs the reference outlook()', () => {
  it('matches month for month across 240 generated scenarios', () => {
    for (let i = 0; i < 240; i++) {
      const settings: CashSettingsValues = structuredClone(DEFAULT_CASH_SETTINGS)
      settings.months = 3 + random(10)
      settings.floor = random(70000)
      for (const c of ['bcat', 'ivan', 'amazon'] as const) settings.runrate[c] = { fixed: random(80000), profit: random(60000) - 20000, lagMonths: 0 }
      settings.factoring = { on: i % 3 !== 0, start: ['2026-01', '2026-02', '2026-03', '2025-12'][i % 4], stop: ['', '2026-03', '2026-04', '2026-02'][i % 4], eligible: random(150000), fee: random(20) / 4, advance: random(101) }
      settings.items = [{ ym: '2026-02', label: 'Tax payment', amount: -random(25000) }, { ym: '2026-05', label: 'Receipt', amount: random(12000) }]
      const day = [1, 2, 3, 15, 28][i % 5]
      const latest: CashCheckIn = { id: 'latest', date: `2026-02-${String(day).padStart(2, '0')}`, cash: random(60000) - 5000, ar: random(300000), ap: random(90000), cards: random(12000), bcatMtdProfit: i % 3 ? random(12000) - 6000 : null, ivanMtdProfit: i % 7 ? random(20000) : 0, amazonMtdProfit: i % 2 ? random(22000) : null }
      const checkins = [{ ...latest, id: 'older', date: '2026-01-30', cash: 999999 }, latest]
      const expected = reference.run({ ...settings, checkins: checkins.map((c) => ({ ...c, bcat: c.bcatMtdProfit, ivan: c.ivanMtdProfit, amazon: c.amazonMtdProfit })) })
      const actual = projectCash(checkins, settings, '2026-02-01').map(referenceFields)
      expect(JSON.parse(JSON.stringify(actual)), `scenario ${i}`).toEqual(JSON.parse(JSON.stringify(expected)))
    }
  })
})
