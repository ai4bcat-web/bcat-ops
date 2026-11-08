#!/usr/bin/env node
/**
 * Step AW stage F: palette screenshots. Every product page at 1440x900 and 1280x800, light and dark.
 *
 *   BCAT_STACK=dev node scripts/devShotsPalette.mjs --out before   # the deployed dev site as it is (green accent)
 *   BCAT_STACK=dev node scripts/devShotsPalette.mjs --out after    # the same pages after the blue palette deploys
 *   node scripts/devShotsPalette.mjs --out after --origin http://127.0.0.1:5173   # a local vite on the dev outputs
 *
 * Dev / rehearsal / local vite only (cdpBrowser refuses any other origin; BCAT_STACK is validated by
 * scripts/lib/stackConfig.mjs and never resolves to production). Pages are only navigated, never submitted: no
 * write is made except the temporary admin identity, which is minted in the selected stack's staff pool and
 * deleted at the end. Writes Docs/tms-build/screenshots/palette/<out>/ and rewrites index.txt, which lists each
 * before/after pair (a pair is "missing" until both sides exist).
 *
 *   --only=<substring>   capture only the pages whose slug contains it
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

export const PAGES = [
  ['tms-dashboard', '/tms/dashboard'],
  ['tms-shipments', '/tms/shipments'],
  ['tms-shipments-new', '/tms/shipments/new'],
  ['tms-carrier-sales', '/tms/carrier-sales'],
  ['tms-tracking', '/tms/tracking'],
  ['tms-customers', '/tms/customers'],
  ['tms-carriers-find', '/tms/carriers/find'],
  ['tms-invoicing', '/tms/invoicing'],
  ['calendar', '/calendar'],
  ['dispatch', '/dispatch'],
  ['driver-info', '/driver-info'],
  ['hours', '/hours'],
  ['time-off', '/time-off'],
  ['files', '/files'],
  ['fleet-dashboard', '/fleet-dashboard'],
  ['trucks', '/trucks'],
  ['maintenance', '/maintenance'],
  ['fuel', '/fuel'],
  ['appts', '/appts'],
  ['schedule', '/schedule'],
  ['loads-redirect', '/loads'],
]
export const VIEWPORTS = [[1440, 900], [1280, 800]]
export const THEMES = ['light', 'dark']
const ROOT = resolve('Docs/tms-build/screenshots/palette')

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  if (hit.includes('=')) return hit.slice(name.length + 3)
  const i = process.argv.indexOf(hit)
  return process.argv[i + 1]
}
const nameOf = (slug, [w, h], theme) => `${slug}-${w}x${h}-${theme}.png`

async function writeIndex() {
  const list = async (dir) => (await readdir(`${ROOT}/${dir}`).catch(() => [])).filter((f) => f.endsWith('.png'))
  const [before, after] = [new Set(await list('before')), new Set(await list('after'))]
  const lines = ['# palette screenshots: before = green accent (dev as deployed), after = BCAT blue', '# pair | before | after']
  for (const [slug, path] of PAGES) for (const vp of VIEWPORTS) for (const theme of THEMES) {
    const f = nameOf(slug, vp, theme)
    lines.push(`${path} ${vp.join('x')} ${theme} | ${before.has(f) ? `before/${f}` : 'MISSING'} | ${after.has(f) ? `after/${f}` : 'MISSING'}`)
  }
  await writeFile(`${ROOT}/index.txt`, `${lines.join('\n')}\n`)
}

async function main() {
  const out = arg('out')
  if (out !== 'before' && out !== 'after') throw new Error('usage: node scripts/devShotsPalette.mjs --out before|after [--origin <url>] [--only=<slug>]')
  const only = arg('only')
  const pages = PAGES.filter(([slug]) => !only || slug.includes(only))
  const dir = `${ROOT}/${out}`
  await mkdir(dir, { recursive: true })
  const email = `zz-palette-${Date.now()}@bcatcorp.com`
  const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
  const origin = arg('origin')
  const taken = []
  try {
    for (const theme of THEMES) {
      const b = await launchBrowser({
        ...(origin ? { origin } : {}),
        storage: { ...id.storage, ...(theme === 'dark' ? { 'tms-theme': 'dark' } : { 'tms-theme': 'light' }) },
        profilePrefix: 'bcat-palette-', purpose: 'Palette screenshots', viewport: { width: 1440, height: 900 }, collect: false,
      })
      try {
        for (const vp of VIEWPORTS) {
          await b.setViewport(vp[0], vp[1])
          for (const [slug, path] of pages) {
            await b.navigate(path)
            await b.pause(3500)
            const file = nameOf(slug, vp, theme)
            await b.screenshot(`${dir}/${file}`)
            taken.push(file)
          }
        }
      } finally { await b.close() }
    }
  } finally {
    console.log('temporary identity removed:', await deleteIdentity(email))
  }
  await writeIndex()
  console.log(`captured ${taken.length} screenshots into ${dir}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
