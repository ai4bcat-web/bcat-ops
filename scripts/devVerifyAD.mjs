#!/usr/bin/env node
/**
 * Step AD verification: Carriers › Find & Invite (MyCarrierPackets review-and-invite).
 *
 *   node scripts/devVerifyAD.mjs              inventory only: no network, no browser, no writes (the default)
 *   node scripts/devVerifyAD.mjs --read       dev walk, READ-ONLY: PreviewCarrier + GetCarrierData for MC 274623 only, the
 *                                             review card, launch points, the invite dialog opened (never sent), screenshots
 *   node scripts/devVerifyAD.mjs --live       --read, then exactly ONE EmailPacketInvitation to ai4bcat@gmail.com, and the
 *                                             MCP response status / body key names appended to Docs/tms-build/MCP_LIVE_TEST.md
 *   DEV_VERIFY_UI_URL=http://localhost:5173 node scripts/devVerifyAD.mjs --read
 *
 * RUNS ONLY AFTER THE DEPLOY (the actions MCP_PREVIEW_CARRIER / MCP_GET_CARRIER / MCP_SEND_INVITE must exist on dev).
 * Dev only: refuses any AppSync endpoint but the dev one, any staff pool but the dev pool and any origin outside
 * ALLOWED_ORIGINS. No SSM, no main / production, no invoice_*.json, no Aljex export. One throwaway ADMIN identity
 * (zz-ad-admin-<ts>) is created and deleted (and proven gone) in `finally`; passwords and tokens are never printed.
 *
 * What `--live` may touch is hard-coded in scripts/lib/adLive.mjs and tested there: the only carrier is MC 274623
 * (Ivan Cartage, Ryne's own company; a DOT-only or any other MC is refused, and the card must be Ivan Cartage before
 * anything is sent), the only recipient is ai4bcat@gmail.com (anything else is refused), at most one invitation per run.
 * The harness never calls "Add to carriers": it would create a directory row, and the live test needs none.
 *
 * Screenshots: Docs/tms-build/screenshots/ad/<name>.png, 1440x900, listed in index.txt.
 */
import { mkdir, writeFile, readFile, access, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, routerAs } from './lib/devIdentity.mjs'
import {
  LIVE_INVITE_ALLOW_LIST, LIVE_TEST_MC, assertLiveCardIsIvan, assertLiveCarrierAllowed, assertLiveInviteAllowed,
  createInviteBudget, keysOf, liveLogSection,
} from './lib/adLive.mjs'

const DEV_APPSYNC = /^https:\/\/f5iqzdpidzalvjys7yxijn5ave\.appsync-api\.us-east-1\.amazonaws\.com\/graphql$/
const SHOTS = resolve('Docs/tms-build/screenshots/ad')
const LIVE_LOG = resolve('Docs/tms-build/MCP_LIVE_TEST.md')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const live = flag('live')
const read = live || flag('read')

const report = []
const written = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)}${name}${detail ? ` — ${detail}` : ''}`)
}
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const tid = (id) => `[data-testid="${id}"]`
const expect = (cond, message) => { if (!cond) throw new Error(message) }

/** The two files the page is built from, the server action names, and the places that launch it. */
const FILES = [
  'src/lib/integrations/mcpReview.ts', 'src/lib/integrations/mcpReview.test.ts',
  'src/features/carriers/find/FindInvitePage.tsx', 'src/features/carriers/find/McpReviewCardView.tsx', 'src/features/carriers/find/InviteDialog.tsx',
  'src/features/carriers/find/FindInvitePage.render.test.tsx',
  'amplify/functions/tms-directory-actions/mcpFind.ts', 'amplify/functions/tms-directory-actions/mcpFind.test.ts',
  'scripts/lib/adLive.mjs', 'scripts/lib/adLive.test.mjs',
]
const ACTIONS = ['MCP_PREVIEW_CARRIER', 'MCP_GET_CARRIER', 'MCP_SEND_INVITE', 'MCP_ADD_CARRIER']
const LAUNCH_POINTS = [
  ['Carriers header', 'src/features/carriers/CarriersPage.tsx', 'launch-find-invite'],
  ['Carrier Sales', 'src/features/tms/carrierSales/CarrierSalesPage.tsx', 'launch-find-invite'],
  ['Cover / assign dialog', 'src/features/carriers/components/BookCarrierDialog.tsx', 'launch-find-invite'],
]

async function exists(path) { try { await access(path); return true } catch { return false } }

async function inventory() {
  let ok = true
  const check = (cond, name, detail) => { line(cond ? 'PASS' : 'FAIL', name, detail); if (!cond) ok = false }
  for (const file of FILES) check(await exists(file), `file ${file}`)
  const handler = await readFile('amplify/functions/tms-directory-actions/mcpFind.ts', 'utf8')
  const router = await readFile('amplify/functions/tms-directory-actions/handler.ts', 'utf8')
  const api = await readFile('src/lib/apiClient.ts', 'utf8')
  for (const action of ACTIONS) {
    check(handler.includes(action), `action ${action} in mcpFind.ts`)
    check(api.includes(`'${action}'`), `action ${action} in apiClient.ts`)
  }
  check(router.includes('isMcpFindAction'), 'handler authorizes and routes the Find & Invite actions')
  check(/path="carriers\/find"/.test(await readFile('src/App.tsx', 'utf8')), 'route /tms/carriers/find')
  check((await readFile('src/lib/navSections.ts', 'utf8')).includes("'/tms/carriers/find'"), 'nav: Carriers > Find & Invite')
  for (const [name, file, id] of LAUNCH_POINTS) check((await readFile(file, 'utf8')).includes(id), `launch point: ${name}`)

  // The guards the live run leans on, exercised here so a broken allow-list fails offline.
  const refused = (fn) => { try { fn(); return false } catch { return true } }
  check(LIVE_INVITE_ALLOW_LIST.length === 1 && LIVE_INVITE_ALLOW_LIST[0] === 'ai4bcat@gmail.com', 'invite allow-list is exactly ai4bcat@gmail.com')
  check(refused(() => assertLiveInviteAllowed('someone@else.com')), '--live refuses any other address')
  check(refused(() => assertLiveCarrierAllowed({ mcNumber: 'MC1' })), '--live refuses any other carrier')
  check(!refused(() => assertLiveCarrierAllowed({ mcNumber: LIVE_TEST_MC })), '--live accepts MC 274623')
  console.log(ok ? '\ninventory: ok' : '\ninventory: FAILED')
  return ok
}

async function main() {
  if (!(await inventory())) { process.exitCode = 1; return }
  if (!read) { console.log('(no --read / --live: nothing was called)'); return }

  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAD refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== 'us-east-1_UKhMNVAG1') throw new Error('devVerifyAD refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAD only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  await mkdir(SHOTS, { recursive: true })
  const email = `zz-ad-admin-${Date.now()}@example.invalid`
  let made = false
  const budget = createInviteBudget(1)
  const summary = { mode: null, preview: { found: false, cardKeys: [] }, data: { found: false, packetStatus: null }, risk: null, insuranceRows: 0, approvedEmails: 0 }
  let invite = null
  try {
    const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary ADMIN identity created')
    const dir = routerAs(identity.token, 'tmsDirectoryActions')
    const ref = assertLiveCarrierAllowed({ mcNumber: LIVE_TEST_MC })

    // AD01 — the two lookups, for the one allowed carrier.
    let card = null
    try {
      const preview = await dir('MCP_PREVIEW_CARRIER', ref)
      const data = await dir('MCP_GET_CARRIER', ref)
      summary.mode = preview.mode
      summary.preview = { found: !!preview.card, cardKeys: keysOf(preview.card) }
      summary.data = { found: !!data.card, packetStatus: data.card?.packet?.status ?? null }
      card = data.card ?? preview.card
      summary.risk = card?.risk?.totalPoints ?? null
      summary.insuranceRows = card?.insurance?.length ?? 0
      summary.approvedEmails = card?.approvedEmails?.length ?? 0
      expect(card, 'MyCarrierPackets returned no card for MC 274623')
      expect(preview.mode === data.mode, 'PreviewCarrier and GetCarrierData disagree on LIVE / STUB')
      if (live) expect(preview.mode === 'LIVE', `--live needs a LIVE MyCarrierPackets integration on dev (the server answered ${preview.mode}: ${preview.reason ?? 'no reason given'})`)
      line('PASS', 'AD01 lookups', `${preview.mode}; packet ${summary.data.packetStatus ?? 'unknown'}; risk ${summary.risk ?? 'n/a'}; insurance rows ${summary.insuranceRows}`)
    } catch (err) {
      line('FAIL', 'AD01 lookups', short(err).slice(0, 200))
      process.exitCode = 1
      return
    }

    // AD02-AD04 — the page, the launch points and the dialog, in a real browser.
    const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-ad-', purpose: 'AD verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
    try {
      const shot = async (name) => { const file = join(SHOTS, `${name}.png`); await b.screenshot(file, { clipToContent: true }); written.push(file) }
      const has = (selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)

      await b.navigate(`/tms/carriers/find?mc=${LIVE_TEST_MC}`)
      await b.poll(() => has(tid('mcp-review-card')), 'the review card', 90_000)
      await pause(800)
      const facts = await b.evaluate(`(() => ({
        name: document.querySelector('[data-testid="mcp-card-name"]')?.textContent ?? '',
        source: document.querySelector('[data-testid="mcp-review-card"]')?.dataset.source ?? '',
        gauge: !!document.querySelector('[data-testid="mcp-card-risk"] svg'),
        insurance: !!document.querySelector('[data-testid="mcp-card-insurance"]'),
        timeline: !!document.querySelector('[data-testid="mcp-card-timeline"]'),
        contacts: !!document.querySelector('[data-testid="mcp-card-contacts"]'),
      }))()`)
      try {
        expect(facts.name, 'the card has no name')
        expect(facts.gauge && facts.insurance && facts.timeline && facts.contacts, `the card is missing a section: ${JSON.stringify(facts)}`)
        expect(facts.source === summary.mode, `the card says ${facts.source}, the server said ${summary.mode}`)
        await shot('AD01-find-card')
        line('PASS', 'AD02 review card', `${facts.source}; ${facts.name}`)
      } catch (err) {
        line('FAIL', 'AD02 review card', short(err).slice(0, 200))
        process.exitCode = 1
      }

      try {
        await b.evaluate(`document.querySelector('[data-testid="mcp-send-invite"]').click()`)
        await b.poll(() => has(tid('mcp-invite-send')), 'the invite dialog', 15_000)
        await pause(300)
        await shot('AD02-invite-dialog')
        line('PASS', 'AD03 invite dialog opened (not sent)')
        await b.evaluate(`document.querySelector('.tms-dialog-close')?.click()`)
      } catch (err) {
        line('FAIL', 'AD03 invite dialog', short(err).slice(0, 200))
        process.exitCode = 1
      }

      try {
        await b.navigate('/tms/carriers')
        await b.poll(() => has(tid('launch-find-invite')), 'Carriers launch point', 60_000)
        await b.navigate('/tms/carrier-sales')
        await b.poll(() => has(tid('launch-find-invite')), 'Carrier Sales launch point', 60_000)
        await pause(400)
        await shot('AD03-carrier-sales-launch')
        line('PASS', 'AD04 launch points', 'Carriers and Carrier Sales')
      } catch (err) {
        line('FAIL', 'AD04 launch points', short(err).slice(0, 200))
        process.exitCode = 1
      }
    } finally {
      await b.close()
    }

    // AD05 — the one live invitation.
    if (live) {
      try {
        const to = assertLiveInviteAllowed('ai4bcat@gmail.com')
        assertLiveCardIsIvan(card)
        budget.take()
        const res = await dir('MCP_SEND_INVITE', { ...ref, email: to, carrierName: card.identity.legalName })
        invite = { to, sent: res.sent === true, mode: res.mode, status: res.mcpResponse?.status ?? null, bodyKeys: res.mcpResponse?.bodyKeys ?? [], carrierLogged: res.carrierLogged === true }
        expect(invite.sent, `MyCarrierPackets did not send the invitation (${res.message ?? 'no message'})`)
        line('PASS', 'AD05 live invitation', `to ${to}; MCP status ${invite.status}; keys ${invite.bodyKeys.join(',') || '(none)'}`)
      } catch (err) {
        line('FAIL', 'AD05 live invitation', short(err).slice(0, 200))
        process.exitCode = 1
      }
      await appendFile(LIVE_LOG, `${await exists(LIVE_LOG) ? '\n' : '# MCP live test log\n\nWritten by `node scripts/devVerifyAD.mjs --live`: MyCarrierPackets status codes and response key names only, never a value, a token or a credential.\n\n'}${liveLogSection({ at: new Date().toISOString(), mode: summary.mode, lookup: summary, invite })}`)
      console.log(`log: appended to ${LIVE_LOG.replace(`${process.cwd()}/`, '')}`)
    }
  } finally {
    if (made) {
      const gone = await deleteIdentity(email)
      console.log(`cleanup: temporary identity ${gone ? 'deleted and confirmed gone' : 'NOT confirmed deleted'}`)
      if (!gone) process.exitCode = 1
    }
  }

  const pass = report.filter((r) => r.status === 'PASS').length
  const failed = report.filter((r) => r.status === 'FAIL').length
  console.log(`\nsummary: ${JSON.stringify({ pass, fail: failed })}`)
  await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAD failed: ${err?.message ?? err}`); process.exit(1) })
}
