import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const root = fileURLToPath(new URL('./', import.meta.url))
const srcRoot = fileURLToPath(new URL('../../', import.meta.url))

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(full)
    return entry.name.endsWith('.css') ? [full] : []
  })
}

/** Every stylesheet under src/ (index.css, calendar.css, the TMS sheets, driver.css …). */
const allFiles = cssFiles(srcRoot).map((path) => ({
  name: relative(srcRoot, path),
  inTms: path.startsWith(root),
  source: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}))
const files = allFiles.filter((f) => f.inTms).map((f) => ({ ...f, name: relative(root, join(srcRoot, f.name)) }))
const theme = files.find((f) => f.name === 'theme.css')!.source

const DARK_PREFIX = ":root[data-tms-theme='dark'] "

/** Every selector in the file, with comments and at-rule preludes removed. */
function selectors(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim()
    if (!prelude || prelude.startsWith('@')) continue
    for (const sel of prelude.split(',')) {
      const trimmed = sel.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

/** Declarations of the block whose selector list is exactly `selectorList`. */
function blockBody(source: string, selectorList: string): string {
  const start = source.indexOf(selectorList)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  return source.slice(open + 1, source.indexOf('}', open))
}

const LIGHT_SELECTOR = ':root,\n.tms-shell,\n.tms-portal {'
const DARK_SELECTOR = `:root[data-tms-theme='dark'],\n${DARK_PREFIX}.tms-shell,\n${DARK_PREFIX}.tms-portal {`

/** The only selectors in the TMS sheets allowed to reach outside the shell/portal scope:
 *  the two token blocks + shadcn bridge (`:root`) and the layered `*` border default. */
const GLOBAL_SELECTORS = new Set([':root', ":root[data-tms-theme='dark']", '*', '::before', '::after'])

const light = blockBody(theme, LIGHT_SELECTOR.slice(0, -2))
const dark = blockBody(theme, DARK_SELECTOR.slice(0, -2))

const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

function declaredTokens(body: string, colourOnly: boolean): string[] {
  return [...body.matchAll(/^\s*(--tms-[a-z0-9-]+):\s*([^;]+);/gm)]
    .filter((m) => !colourOnly || COLOUR.test(m[2]))
    .map((m) => m[1])
}

describe('tms stylesheets', () => {
  it('finds the stylesheets under src/features/tms', () => {
    expect(files.map((f) => f.name)).toContain('theme.css')
    expect(light).not.toBe('')
    expect(dark).not.toBe('')
  })

  it('scopes every rule to .tms-shell or .tms-portal, except the token blocks, the bridge and the border default', () => {
    const leaks = files.flatMap(({ name, source }) =>
      selectors(source)
        .filter((sel) => !GLOBAL_SELECTORS.has(sel))
        .map((sel) => (sel.startsWith(DARK_PREFIX) ? sel.slice(DARK_PREFIX.length) : sel))
        .filter((sel) => !sel.startsWith('.tms-shell') && !sel.startsWith('.tms-portal'))
        .map((sel) => `${name}: ${sel}`),
    )
    expect(leaks).toEqual([])
  })

  it('has a .tms-portal rule for content rendered into document.body', () => {
    expect(selectors(theme).filter((sel) => sel === '.tms-portal').length).toBeGreaterThan(0)
  })

  it('declares every colour token of the light theme in the dark theme too', () => {
    const darkTokens = new Set(declaredTokens(dark, false))
    const missing = declaredTokens(light, true).filter((token) => !darkTokens.has(token))
    expect(missing).toEqual([])
  })

  it('keeps colour literals inside the two token blocks, in every stylesheet under src/', () => {
    const offenders = allFiles.flatMap(({ name, source }) => {
      let body = source
      for (const block of [light, dark]) body = body.replace(block, '')
      return body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => COLOUR.test(line))
        .map((line) => `${name}: ${line}`)
    })
    expect(offenders).toEqual([])
  })
})
