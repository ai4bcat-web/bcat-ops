// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { OWN_ROW_CLASS, fadeEdges, tabsNeedOwnRow, watchOneRowTabs } from './oneRowTabs'

describe('tabsNeedOwnRow', () => {
  it('keeps a strip that fits beside the search box inline', () => {
    expect(tabsNeedOwnRow({ needed: 400, rowWidth: 1300, othersWidth: 600, gaps: 48 })).toBe(false)
  })
  it('gives Accounting (eight tabs) its own row at 1440', () => {
    expect(tabsNeedOwnRow({ needed: 1250, rowWidth: 1300, othersWidth: 600, gaps: 48 })).toBe(true)
  })
})

describe('fadeEdges', () => {
  it('fades nothing when every tab is visible', () => {
    expect(fadeEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({ start: false, end: false })
  })
  it('fades the end at the start of a scrolling row, both edges in the middle, the start at the end', () => {
    expect(fadeEdges({ scrollLeft: 0, scrollWidth: 1200, clientWidth: 800 })).toEqual({ start: false, end: true })
    expect(fadeEdges({ scrollLeft: 200, scrollWidth: 1200, clientWidth: 800 })).toEqual({ start: true, end: true })
    expect(fadeEdges({ scrollLeft: 400, scrollWidth: 1200, clientWidth: 800 })).toEqual({ start: true, end: false })
  })
})

describe('watchOneRowTabs', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function topbarWith(needed: number, topbarWidth: number): HTMLElement {
    document.body.innerHTML = `
      <header class="tms-topbar">
        <nav class="crumbs"></nav>
        <nav class="tms-lifecycle"><ol class="tms-lifecycle-list"></ol></nav>
        <div class="tms-topbar-spacer"></div>
        <form class="tms-search"></form>
      </header>`
    const topbar = document.querySelector<HTMLElement>('.tms-topbar')!
    const list = document.querySelector<HTMLElement>('.tms-lifecycle-list')!
    Object.defineProperty(topbar, 'clientWidth', { value: topbarWidth })
    Object.defineProperty(list, 'scrollWidth', { value: needed })
    Object.defineProperty(list, 'clientWidth', { value: Math.min(needed, topbarWidth) })
    for (const el of [document.querySelector('.crumbs')!, document.querySelector('.tms-search')!]) {
      el.getBoundingClientRect = () => ({ width: 300 }) as DOMRect
    }
    return topbar
  }

  it('puts a strip too wide for the row on its own line, and takes it off again on cleanup', () => {
    const topbar = topbarWith(1200, 1400)
    const stop = watchOneRowTabs(topbar)
    expect(topbar).toHaveProperty('className', expect.stringContaining(OWN_ROW_CLASS))
    stop()
    expect(topbar.classList.contains(OWN_ROW_CLASS)).toBe(false)
  })

  it('leaves a short strip beside the search box', () => {
    const topbar = topbarWith(500, 1400)
    watchOneRowTabs(topbar)
    expect(topbar.classList.contains(OWN_ROW_CLASS)).toBe(false)
  })
})

describe('kit.css', () => {
  const css = readFileSync('src/features/tms/kit/kit.css', 'utf8')
  it('never wraps the tab strip to a second row', () => {
    const rule = css.match(/\.tms-shell \.tms-lifecycle-list \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('flex-wrap: nowrap')
    expect(rule).toContain('overflow-x: auto')
  })
})
