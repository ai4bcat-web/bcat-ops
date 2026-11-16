// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { OWN_ROW_CLASS, fitLevel, watchOneRowTabs, type FitLevel } from './oneRowTabs'

describe('fitLevel', () => {
  it('keeps normal tabs when they fit', () => {
    expect(fitLevel(() => 900, 1200)).toBe(0)
  })
  it('steps through tighter padding and smaller text until the tabs fit', () => {
    const needed: Record<FitLevel, number> = { 0: 1400, 1: 1250, 2: 1150, 3: 900 }
    expect(fitLevel((l) => needed[l], 1300)).toBe(1)
    expect(fitLevel((l) => needed[l], 1200)).toBe(2)
  })
  it('ends on truncated labels when nothing else fits (never scrolls)', () => {
    expect(fitLevel(() => 2000, 700)).toBe(3)
  })
})

describe('watchOneRowTabs', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function topbarWith(neededByLevel: (level: number) => number, available: number): { topbar: HTMLElement; nav: HTMLElement } {
    document.body.innerHTML = `
      <header class="tms-topbar">
        <nav class="crumbs"></nav>
        <nav class="tms-lifecycle"><ol class="tms-lifecycle-list"></ol></nav>
        <form class="tms-search"></form>
      </header>`
    const topbar = document.querySelector<HTMLElement>('.tms-topbar')!
    const nav = document.querySelector<HTMLElement>('.tms-lifecycle')!
    const list = document.querySelector<HTMLElement>('.tms-lifecycle-list')!
    Object.defineProperty(list, 'clientWidth', { value: available })
    Object.defineProperty(list, 'scrollWidth', { get: () => neededByLevel(Number(nav.getAttribute('data-fit') ?? 0)) })
    return { topbar, nav }
  }

  it('always gives the strip its own line, even when the tabs are few', () => {
    const { topbar, nav } = topbarWith(() => 400, 1300)
    const stop = watchOneRowTabs(topbar)
    expect(topbar.classList.contains(OWN_ROW_CLASS)).toBe(true)
    expect(nav.getAttribute('data-fit')).toBe('0')
    stop()
    expect(topbar.classList.contains(OWN_ROW_CLASS)).toBe(false)
    expect(nav.hasAttribute('data-fit')).toBe(false)
  })

  it('compresses Accounting until every tab fits the line', () => {
    const { topbar, nav } = topbarWith((l) => [1500, 1350, 1220, 1000][l], 1240)
    watchOneRowTabs(topbar)
    expect(nav.getAttribute('data-fit')).toBe('2')
  })
})

describe('tab strip CSS', () => {
  const kit = readFileSync('src/features/tms/kit/kit.css', 'utf8')
  const responsive = readFileSync('src/features/tms/responsive.css', 'utf8')
  it('never scrolls the tab strip sideways', () => {
    const rule = kit.match(/\.tms-shell \.tms-lifecycle-list \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('flex-wrap: nowrap')
    expect(rule).toContain('overflow: hidden')
    expect(`${kit}\n${responsive}`).not.toMatch(/tms-lifecycle-list[^}]*overflow-x: auto/)
  })
  it('truncates labels at the last step and wraps on phones', () => {
    expect(kit).toMatch(/data-fit='3'\] \.tms-lifecycle-label \{[^}]*text-overflow: ellipsis/)
    expect(responsive).toMatch(/max-width: 640px\) \{\s*\.tms-shell \.tms-topbar \.tms-lifecycle-list \{ flex-wrap: wrap/)
  })
})
