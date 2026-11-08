import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYNTHETIC_ALLOWLIST, SYNTHETIC_EIN, SYNTHETIC_SSN } from '@/test/syntheticTaxIds'

/**
 * Repo-wide guard (AW_TAXID_DESIGN §7): no tax-ID-shaped literal may sit in source, fixtures,
 * scripts or docs unless it is one of the IRS-impossible values in src/test/syntheticTaxIds.ts.
 * A real EIN/SSN pasted into a test, a doc or a script fails here, whichever file it is in.
 */

const ROOT = join(__dirname, '..', '..')
const SCAN_DIRS = ['src', 'amplify', 'scripts', 'Docs']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.amplify', 'coverage', '.vite', 'cdk.out'])
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|amplify_outputs.*\.json)$/
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|xlsx?|docx?|mp4|mov|wasm|bin|node|map)$/i
const MAX_BYTES = 4 * 1024 * 1024

const EIN_SHAPE = /(?<![\d-])\d{2}-\d{7}(?![\d-])/g
const SSN_SHAPE = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g
const NINE_DIGITS = /(?<![\d.])\d{9}(?![\d.])/g
const TAX_WORD = /tax|\bein\b|einnumber|ssn|fed\/ss/i
const NEAR = 40

export interface Leak {
  value: string
  kind: 'EIN-shape' | 'SSN-shape' | '9-digit near tax word'
}

/** Every tax-ID-shaped literal in `text` that is not on the synthetic allowlist. Pure, so the scanner itself is testable. */
export function findTaxIdLeaks(text: string): Leak[] {
  const leaks: Leak[] = []
  for (const m of text.matchAll(EIN_SHAPE)) if (!SYNTHETIC_ALLOWLIST.has(m[0])) leaks.push({ value: m[0], kind: 'EIN-shape' })
  for (const m of text.matchAll(SSN_SHAPE)) if (!SYNTHETIC_ALLOWLIST.has(m[0])) leaks.push({ value: m[0], kind: 'SSN-shape' })
  for (const m of text.matchAll(NINE_DIGITS)) {
    if (SYNTHETIC_ALLOWLIST.has(m[0])) continue
    const at = m.index ?? 0
    if (TAX_WORD.test(text.slice(Math.max(0, at - NEAR), at + m[0].length + NEAR))) leaks.push({ value: m[0], kind: '9-digit near tax word' })
  }
  return leaks
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) yield* walk(path)
    else if (info.size <= MAX_BYTES && !BINARY.test(name) && !SKIP_FILES.test(path.replaceAll('\\', '/'))) yield path
  }
}

describe('tax-ID leak scanner', () => {
  // Built from parts so this file itself never holds a realistic literal.
  const realEin = ['12', '3456789'].join('-')
  const realSsn = ['123', '45', '6789'].join('-')
  const realNine = ['987', '654', '321'].join('')

  it('flags realistic EINs, SSNs and bare 9-digit numbers beside a tax word', () => {
    expect(findTaxIdLeaks(`ein: '${realEin}'`)).toEqual([{ value: realEin, kind: 'EIN-shape' }])
    expect(findTaxIdLeaks(`ssn ${realSsn}`)).toEqual([{ value: realSsn, kind: 'SSN-shape' }])
    expect(findTaxIdLeaks(`Fed/SS # ${realNine}`)).toEqual([{ value: realNine, kind: '9-digit near tax word' }])
  })

  it('accepts only the synthetic IRS-impossible values, in either spelling', () => {
    expect(findTaxIdLeaks(`ein ${SYNTHETIC_EIN} ssn ${SYNTHETIC_SSN} tax ${SYNTHETIC_EIN.replace('-', '')}`)).toEqual([])
  })

  it('ignores 9-digit numbers far from any tax word, and longer digit runs', () => {
    expect(findTaxIdLeaks(`balance ${realNine} cents`)).toEqual([])
    expect(findTaxIdLeaks(`tax id ${realNine}0`)).toEqual([])
  })

  it('finds nothing in src/, amplify/, scripts/ or Docs/ (synthetic values excepted)', () => {
    const hits: string[] = []
    let scanned = 0
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const buf = readFileSync(file)
        if (buf.includes(0)) continue
        scanned++
        // Report file + kind only: never echo the matched value into test output.
        for (const leak of findTaxIdLeaks(buf.toString('utf8'))) hits.push(`${relative(ROOT, file)}: ${leak.kind}`)
      }
    }
    expect(scanned).toBeGreaterThan(500)
    expect(hits).toEqual([])
  })
})
