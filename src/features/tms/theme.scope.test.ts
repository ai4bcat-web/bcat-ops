import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8')

/** Every selector in the file, with comments and at-rule preludes removed. */
function selectors(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim()
    if (!prelude || prelude.startsWith('@')) continue
    for (const sel of prelude.split(',')) {
      const trimmed = sel.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

describe('tms theme.css', () => {
  it('scopes every rule to .tms-shell or .tms-portal so the rest of the app is untouched', () => {
    const leaks = selectors(css).filter((sel) => !sel.startsWith('.tms-shell') && !sel.startsWith('.tms-portal'))
    expect(leaks).toEqual([])
  })

  it('defines the MVMNT tokens on both scopes', () => {
    expect(css).toContain('--tms-bg: #232323')
    expect(css).toContain('--tms-sidebar-w: 175px')
    expect(css).toContain('--tms-topbar-h: 38px')
    expect(css).toContain('--tms-primary: #f4c50c')
    expect(css).toContain('--tms-badge-turquoise: #09e2e5')
    expect(selectors(css).filter((sel) => sel === '.tms-portal').length).toBeGreaterThan(0)
  })
})
