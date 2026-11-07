#!/usr/bin/env node
/**
 * WCAG AA contrast gate for the accent family in src/features/tms/theme.css (light and dark token blocks).
 * Text pairs need 4.5:1, UI-component pairs 3:1. Disabled controls are exempt under WCAG 1.4.3; their ratio is
 * printed but never fails. Exits 1 when any checked pair is below its floor.
 *
 *   node scripts/contrastCheck.mjs [--markdown]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/features/tms/theme.css')

/** Token map of one block: the first `{…}` after the selector line that starts with `start`. */
function block(css, start) {
  const from = css.indexOf(start)
  if (from < 0) throw new Error(`block not found: ${start}`)
  const body = css.slice(css.indexOf('{', from) + 1, css.indexOf('\n}', from))
  const tokens = {}
  for (const m of body.matchAll(/(--tms-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2].toLowerCase()
  return tokens
}

export function themes(css = readFileSync(CSS, 'utf8')) {
  const light = block(css, ':root,\n.tms-shell,\n.tms-portal {')
  const dark = { ...light, ...block(css, ":root[data-tms-theme='dark'],") }
  return { light, dark }
}

const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
export const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
export const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** [label, foreground token, background token, floor (0 = informational / exempt)] */
export const PAIRS = [
  ['primary button text on fill', '--tms-on-primary', '--tms-primary', 4.5],
  ['primary button text on hover fill', '--tms-on-primary', '--tms-primary-hover', 4.5],
  ['primary button fill vs card', '--tms-primary', '--tms-card', 3],
  ['link on card', '--tms-primary-ink', '--tms-card', 4.5],
  ['link on page bg', '--tms-primary-ink', '--tms-bg', 4.5],
  ['active tab text (quick tab) on card', '--tms-primary-ink', '--tms-card', 4.5],
  ['active tab underline vs card', '--tms-primary', '--tms-card', 3],
  ['tab count ink on tint', '--tms-primary-ink', '--tms-primary-tint', 4.5],
  ['focus ring vs card', '--tms-primary', '--tms-card', 3],
  ['focus ring vs page bg', '--tms-primary', '--tms-bg', 3],
  ['selected row text', '--tms-text', '--tms-surface-selected', 4.5],
  ['link on selected row', '--tms-primary-ink', '--tms-surface-selected', 4.5],
  ['chart series 1 vs card', '--tms-chart-1', '--tms-card', 3],
  ['disabled text on card (exempt)', '--tms-disabled', '--tms-card', 0],
]

export function evaluate(all = themes()) {
  return Object.entries(all).flatMap(([theme, tokens]) => PAIRS.map(([label, fg, bg, floor]) => {
    if (!tokens[fg] || !tokens[bg]) throw new Error(`${theme}: missing ${!tokens[fg] ? fg : bg}`)
    const r = ratio(tokens[fg], tokens[bg])
    return { theme, label, fg, bg, fgHex: tokens[fg], bgHex: tokens[bg], ratio: r, floor, pass: floor === 0 || r >= floor }
  }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = evaluate()
  const md = process.argv.includes('--markdown')
  if (md) console.log('| theme | pair | fg | bg | ratio | floor | result |\n|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const floor = r.floor === 0 ? 'exempt' : `${r.floor}:1`
    const verdict = r.floor === 0 ? 'info' : r.pass ? 'PASS' : 'FAIL'
    console.log(md
      ? `| ${r.theme} | ${r.label} | \`${r.fgHex}\` | \`${r.bgHex}\` | ${r.ratio.toFixed(2)} | ${floor} | ${verdict} |`
      : `${verdict.padEnd(4)} ${r.theme.padEnd(5)} ${r.ratio.toFixed(2).padStart(5)} (${floor.padEnd(6)}) ${r.label}  ${r.fgHex} on ${r.bgHex}`)
  }
  const failed = rows.filter((r) => !r.pass)
  if (failed.length) { console.error(`${failed.length} pair(s) below WCAG AA`); process.exit(1) }
}
