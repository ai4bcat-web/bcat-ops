/**
 * The staff app lays itself out in inline styles written for a 1440px desktop, and a
 * stylesheet cannot normally touch those. These rules reach them by matching the
 * serialized `style` attribute — which works, and is also invisible: nothing in a
 * component file hints that index.css is holding its layout together on a phone.
 *
 * So this walks the source for the inline patterns that break on a 390px screen and checks
 * a rule exists for each. A new page with a five-column KPI row fails here rather than on
 * somebody's phone.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')

/** Everything inside the phone breakpoint, so a desktop rule cannot satisfy these. */
const mobileBlock = (() => {
  const start = css.indexOf('@media (max-width: 900px)')
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  return ''
})()

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

const sources = sourceFiles(join(process.cwd(), 'src/features')).map((f) => readFileSync(f, 'utf8'))
const allSource = sources.join('\n')

describe('the phone layout reaches the inline styles', () => {
  it('collapses every fixed grid of three or more columns', () => {
    // A row of KPI tiles at 390px is one column, whatever it is on a desktop.
    const counts = new Set(
      [...allSource.matchAll(/repeat\((\d+)\s*,/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 3 && n <= 12),
    )
    expect(counts.size).toBeGreaterThan(0)
    for (const n of counts) {
      expect(mobileBlock, `no mobile rule for repeat(${n}, …)`).toContain(`[style*="repeat(${n}"]`)
    }
  })

  it('trims page padding written for a wide screen', () => {
    for (const pad of ['padding: 20px 32px', 'padding: 16px 32px']) {
      expect(mobileBlock).toContain(`[style*="${pad}"]`)
    }
    expect(mobileBlock).toContain('padding-left: 14px !important')
  })

  it('releases containers that insist on being wider than a phone', () => {
    const wide = new Set(
      [...allSource.matchAll(/minWidth: (\d{3,})/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 500),
    )
    for (const n of wide) {
      expect(mobileBlock, `no mobile rule for min-width: ${n}px`).toContain(`min-width: ${n}px`)
    }
  })

  it('does not release a minimum small enough to be deliberate', () => {
    // Matching on a prefix would also catch a 160px field, which has every right to its
    // minimum — that is why these are exact values rather than `min-width: 1`.
    expect(mobileBlock).not.toContain('div[style*="min-width: 1"]')
    expect(mobileBlock).not.toContain('div[style*="min-width: 2"]')
  })

  it('lets the page scroll, which is what made the rest reachable at all', () => {
    expect(mobileBlock).toContain('.page-content')
    expect(mobileBlock).toMatch(/\.page-content\s*\{[^}]*overflow:\s*auto/)
  })

  it('leaves the desktop alone', () => {
    // Every one of these is inside the breakpoint; none is loose in the stylesheet.
    const outside = css.replace(mobileBlock, '')
    expect(outside).not.toContain('[style*="repeat(4"]')
    expect(outside).not.toContain('padding-left: 14px !important')
  })
})
