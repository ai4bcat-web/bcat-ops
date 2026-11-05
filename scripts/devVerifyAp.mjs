#!/usr/bin/env node
/**
 * Step AP verification (UI half): Shipments board filter chips with counts, the Push to Load
 * Review batch bar (nine at a time), Release only inside Load Review, and the per-customer
 * Load Review requirements editor.
 *
 *   node scripts/devVerifyAP.mjs              inventory only: no network, no browser, no writes (the default)
 *   node scripts/devVerifyAP.mjs --inventory  the same, spelled out
 *   node scripts/devVerifyAP.mjs --walk       dev walk, read-only: screenshots the board chips, the nine-row cap message
 *                                             (ticking boxes is client-only) and the Load Review page. It NEVER clicks Push
 *                                             to Load Review, Release, Move to billing, Save or Confirm.
 *   DEV_VERIFY_UI_URL=http://127.0.0.1:5173 node scripts/devVerifyAP.mjs --walk
 *
 * Dev only: the walk mints one throwaway ADMIN identity on the dev pool (zz-ap-<ts>), deletes it and proves it gone in
 * `finally`. No SSM, no main / production, no invoice_*.json, no Aljex export. Passwords and tokens are never printed.
 *
 * Screenshots: Docs/tms-build/screenshots/ap/<name>.png, 1440x900.
 */
import { mkdir, readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN } from './lib/cdpBrowser.mjs'
import { mintIdentity, deleteIdentity } from './lib/devIdentity.mjs'

const SHOTS = resolve('Docs/tms-build/screenshots/ap')
const args = process.argv.slice(2)
const walk = args.includes('--walk')

const report = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)} ${name}${detail ? `: ${detail}` : ''}`)
}
const exists = (file) => access(resolve(file)).then(() => true, () => false)
const read = (file) => readFile(resolve(file), 'utf8')

const FILES = [
  'src/lib/reviewRequirements.ts',
  'src/features/shipments/boardChips.ts', 'src/features/shipments/boardChips.test.ts',
  'src/features/shipments/batchReview.ts', 'src/features/shipments/batchReview.test.ts',
  'src/features/shipments/board/BatchActionBar.tsx',
  'src/features/shipments/ShipmentsBoard.tsx', 'src/features/shipments/intake/IntakeBoard.tsx',
  'src/features/tms/loadReview/LoadReviewPage.tsx',
  'src/features/directory/components/ReviewRequirementsField.tsx',
  'src/features/directory/components/ReviewRequirementsField.test.tsx',
  'src/features/directory/components/CustomerProfile.tsx', 'src/features/directory/components/CustomerOrgDefaults.tsx',
]

/** [file, regex that must match, regex that must NOT match, label] */
const CHECKS = [
  ['src/features/shipments/boardChips.ts', /Missing reference #/, /Open exceptions/, 'chips: Missing reference #, no Open exceptions'],
  ['src/features/shipments/boardChips.ts', /'docsMissing',\s*'checkCallOverdue',?\s*\]/, null, 'chips: Check call overdue is last'],
  ['src/features/shipments/ShipmentsBoard.tsx', /PUSH_TO_LOAD_REVIEW/, /RELEASE_TO_BILLING|massRelease|Release to billing/, 'board: Push only, no Release'],
  ['src/features/shipments/intake/IntakeBoard.tsx', /PUSH_TO_LOAD_REVIEW/, /RELEASE_TO_BILLING|Release/, 'intake: Push only, no Release'],
  ['src/features/tms/loadReview/LoadReviewPage.tsx', /RELEASE_TO_BILLING/, /slice\(0, 100\)/, 'load review: Release lives here, capped'],
  ['src/features/tms/loadReview/LoadReviewPage.tsx', /MAX_REVIEW_BATCH/, null, 'load review: nine at a time'],
  ['src/features/shipments/components/ArCard.tsx', /PushToLoadReview/, null, 'ArCard: Push to Load Review (Ready to invoice only for imported history)'],
  ['src/features/shipments/components/DocumentsSection.tsx', /PushToLoadReview/, /readyToInvoice/, 'documents tab: no release call, Push to Load Review'],
  ['src/features/ar/ArPage.tsx', /ReadyForBillingReviewCell/, /readyToInvoice|Release to billing/, 'AR page: opens Load Review, never releases'],
  ['src/features/shipments/batchReview.ts', /@\/lib\/reviewRequirements/, null, 'one shared requirements module'],
  ['src/features/directory/components/CustomerProfile.tsx', /ReviewRequirementsField/, null, 'customer profile edits requirements'],
  ['src/features/directory/components/CustomerOrgDefaults.tsx', /ReviewRequirementsField/, null, 'org default editor'],
]

async function inventory() {
  let ok = true
  for (const file of FILES) {
    if (!(await exists(file))) { line('FAIL', `file ${file}`, 'missing'); ok = false }
  }
  for (const [file, must, mustNot, label] of CHECKS) {
    const text = (await exists(file)) ? await read(file) : ''
    if (!must.test(text)) { line('FAIL', label, `${file} does not match ${must}`); ok = false; continue }
    if (mustNot && mustNot.test(text)) { line('FAIL', label, `${file} still matches ${mustNot}`); ok = false; continue }
    line('PASS', label)
  }
  return ok
}

async function runWalk() {
  const origin = process.env.DEV_VERIFY_UI_URL || DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} is not an allowed dev origin`)
  await mkdir(SHOTS, { recursive: true })
  const email = `zz-ap-${Date.now()}@bcatcorp.com`
  const id = await mintIdentity(email, ['ADMIN', 'page-tms'])
  let b
  try {
    b = await launchBrowser({ origin, storage: id.storage, profilePrefix: 'bcat-ap-', purpose: 'AP verification', viewport: { width: 1440, height: 900 } })
    await b.navigate('/tms/shipments?list=all')
    await b.waitFor('.tms-dg-scroll', 60_000)
    await b.pause(3000)
    const chips = await b.evaluate(`[...document.querySelectorAll('.tms-dense-bar button[aria-pressed]')].map((x) => x.textContent.trim())`)
    line(chips.some((c) => /^Open exceptions/.test(c)) ? 'FAIL' : 'PASS', 'board chips', chips.join(' | '))
    await b.screenshot(`${SHOTS}/AP01-board-chips.png`)

    // Tick up to ten rows (client only): the tenth is refused with a message. Nothing is sent.
    const ticked = await b.evaluate(`(() => { const boxes = [...document.querySelectorAll('tbody input[type=checkbox]')].slice(0, 10); boxes.forEach((x) => x.click()); return boxes.length })()`)
    await b.pause(500)
    const capShown = await b.evaluate(`!!document.querySelector('[data-testid="batch-cap-message"]')`)
    line(ticked >= 10 ? (capShown ? 'PASS' : 'FAIL') : 'SKIP', 'nine-row cap message', `ticked ${ticked}`)
    await b.screenshot(`${SHOTS}/AP02-batch-bar-cap.png`)

    await b.navigate('/tms/shipments/intake')
    await b.waitFor('.tms-dg-scroll', 60_000)
    await b.pause(2000)
    await b.screenshot(`${SHOTS}/AP03-intake.png`)

    await b.navigate('/tms/load-review?tab=all')
    await b.pause(4000)
    await b.screenshot(`${SHOTS}/AP04-load-review.png`)
    const hasSelectAll = await b.evaluate(`[...document.querySelectorAll('button')].some((x) => /Select all looks ready \\(up to 9\\)/.test(x.textContent))`)
    line(hasSelectAll ? 'PASS' : 'FAIL', 'load review: select up to 9')
    console.log('problems', JSON.stringify(b.problems().exceptions.slice(0, 5)))
  } finally {
    if (b) await b.close()
    console.log('temporary identity removed:', await deleteIdentity(email))
  }
}

const ok = await inventory()
if (!ok) process.exitCode = 1
else if (walk) await runWalk()
