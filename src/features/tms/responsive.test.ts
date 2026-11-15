import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./responsive.css', import.meta.url), 'utf8')

/** The rules inside every `@media (max-width: 640px)` block, joined. */
const phone = css.split('@media (max-width: 640px)').slice(1).map((block) => block.slice(0, block.indexOf('\n}'))).join('\n')

describe('Accounting on phones', () => {
  it('stacks the head-band summary cards one per line instead of a sideways row', () => {
    expect(phone).toMatch(/\.tms-head-band-cards \{ display: grid; grid-template-columns: minmax\(0, 1fr\)/)
    expect(css).not.toMatch(/tms-head-band-cards[^}]*scroll-snap/)
  })

  it('keeps status tab labels on one line in a strip that scrolls', () => {
    expect(css).toMatch(/\.tms-ship-tab-board \{ max-width: none; white-space: nowrap; \}/)
  })

  it('pins the top bar flush to the top of the screen', () => {
    expect(css).toMatch(/\.tms-shell \.tms-topbar \{ top: 0;/)
  })
})

describe('Accounting numbers stay inside their cards on phones', () => {
  it('lets a stat tile size and wrap its own amount, beating the compact tile font size', () => {
    expect(phone).toMatch(/\.tms-stat-row > \.tms-kpi-card[^{]*\{ min-width: 0; container-type: inline-size; \}/)
    expect(phone).toMatch(/\.tms-kpi-card \.tms-kpi-card-value\.tms-kpi-card-value[^{]*\{[^}]*white-space: normal; overflow-wrap: anywhere/)
    expect(phone).toMatch(/font-size: clamp\(14px, 13cqi, 22px\)/)
  })

  it('wraps chip rows and button groups inside phone cards', () => {
    expect(phone).toMatch(/\.tms-dg-card-details dd \[style\*='display: flex'\] \{ flex-wrap: wrap; min-width: 0; max-width: 100%; \}/)
    expect(phone).toMatch(/\.tms-dg-card-actions \[style\*='display: flex'\] \{ flex-wrap: wrap;/)
  })

  it('keeps settlements and hours inside the screen', () => {
    expect(phone).toMatch(/\.tms-pay-page \{ width: 100%; min-width: 0;/)
    expect(phone).toMatch(/\.tms-pay-stmt-head \{ flex-wrap: wrap; \}/)
    expect(phone).toMatch(/\.tms-hours-head \{ display: none !important; \}/)
    expect(phone).toMatch(/\.tms-hours-row > \[data-label\]::before \{ content: attr\(data-label\)/)
  })

  it('applies none of it on desktop: every rule sits in a max-width block', () => {
    const blocks = css.split('@media').slice(1)
    const base = css.split('@media')[0]
    for (const hook of ['tms-pay-page', 'tms-pay-stmt-head', 'tms-hours-row', 'container-type']) {
      expect(base).not.toContain(hook)
      for (const block of blocks.filter((b) => b.includes(hook))) expect(block.slice(0, block.indexOf('{'))).toMatch(/max-width: (640|900|1194)px/)
    }
  })
})

describe('Nothing spills past its card on a phone', () => {
  it('lets long badges wrap inside their card', () => {
    expect(phone).toMatch(/\.tms-shell \.tms-badge, \.tms-portal \.tms-badge \{ white-space: normal;/)
  })

  it('wraps the chips inside phone cards but keeps the card amount whole', () => {
    expect(phone).toMatch(/\.tms-dg-card-main div, \.tms-shell \.tms-dg-card-main span \{ max-width: 100%; flex-wrap: wrap; min-width: 0; \}/)
    expect(phone).toMatch(/\.tms-dg-card \.tms-dg-card-amount \{ min-width: auto; flex-shrink: 0; \}/)
  })

  it('draws each truck on Driver info as a card instead of an 896px row', () => {
    expect(phone).toMatch(/\.tms-truckmap-head \{ display: none !important; \}/)
    expect(phone).toMatch(/\.tms-truckmap-row \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) !important; min-width: 0 !important;/)
  })

  it('stacks the Amazon disputes header and puts its KPI tiles two across', () => {
    expect(phone).toMatch(/\.tms-disputes-head \{ flex-wrap: wrap;/)
    expect(phone).toMatch(/\.tms-disputes-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/)
  })

  it('applies none of it on desktop: every rule sits in a max-width block', () => {
    const blocks = css.split('@media').slice(1)
    const base = css.split('@media')[0]
    for (const hook of ['tms-truckmap-row', 'tms-disputes-head', 'tms-appts-dayhead', 'tms-month-grid', 'tms-ivanweek-head', 'tms-expiring-row', 'tms-division-row', 'tms-kpi-card-period']) {
      expect(base).not.toContain(hook)
      for (const block of blocks.filter((b) => b.includes(hook))) expect(block.slice(0, block.indexOf('{'))).toMatch(/max-width: (640|900)px/)
    }
  })
})

describe('responsive.css parses', () => {
  it('closes every block it opens (a missing } failed the production build)', () => {
    let depth = 0
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1
      expect(depth).toBeGreaterThanOrEqual(0)
    }
    expect(depth).toBe(0)
  })
})

describe('iOS Safari: nothing pans the page sideways', () => {
  it('clips sideways overflow at the document root on tablets and phones only', () => {
    const root = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    expect(root).toMatch(/@media \(max-width: 1100px\) \{\s*html \{ overflow-x: clip; \}\s*\}/)
  })
})
