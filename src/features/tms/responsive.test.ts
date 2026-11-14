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
