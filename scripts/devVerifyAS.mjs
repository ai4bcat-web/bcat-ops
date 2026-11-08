#!/usr/bin/env node
/**
 * Step AS verification: Carrier Sales MC lookup (directory standing, packet standing, MCP e-mail addresses).
 *
 *   node scripts/devVerifyAS.mjs                  inventory only: no network, no browser, no writes (the default)
 *   node scripts/devVerifyAS.mjs --read           dev walk, READ-ONLY. On Carrier Sales:
 *                                                   - MC 274623 (Ivan Cartage, in the directory): the first line shows
 *                                                     "Set up with us", its status and the packet standing;
 *                                                   - a small carrier that is NOT in the dev directory (found by read-only MCP
 *                                                     previews of deterministic MC candidates, or --mc=MC123456): "Not in
 *                                                     directory", MCP's e-mails listed, Send setup packet ENABLED. The
 *                                                     recipient checklist is opened and CLOSED; confirm is never clicked and
 *                                                     MCP_SEND_INVITE is never called in this mode.
 *                                                 E-mails and phone numbers are masked in the page before every screenshot.
 *   node scripts/devVerifyAS.mjs --live-invite    THE ONE REAL INVITATION (the lead runs it once, after the deploy): MC 274623 only,
 *                                                 to ai4bcat@gmail.com only (or +tags). If every address MCP returns for MC 274623
 *                                                 is ai4bcat (+tags) the default-list path is used; otherwise the call names
 *                                                 ai4bcat@gmail.com explicitly (the default would reach a real carrier). Refuses
 *                                                 anything else, once per run. Appends status / key names to EMAIL_LIVE_TEST.md.
 *
 * RUNS ONLY AFTER THE DEPLOY. Dev only: refuses any AppSync endpoint but dev, any pool but the dev pool, any origin outside
 * ALLOWED_ORIGINS. No SSM, no main / production. One throwaway ADMIN identity (zz-as-admin-<ts>) is created and deleted
 * (and proven gone) in `finally`; passwords and tokens are never printed. Addresses MCP returns for real carriers are
 * never printed or logged (counts only).
 *
 * Screenshots: Docs/tms-build/screenshots/as/<name>.png, 1440x900, listed in index.txt.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { mkdir, writeFile, readFile, access, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN, pause } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, routerAs, gql } from './lib/devIdentity.mjs'
import { createInviteBudget } from './lib/adLive.mjs'
import { AS_INVITE_MC, assertInviteInputSafe, candidateMcs, planInvite } from './lib/asLive.mjs'

const DEV_APPSYNC = APPSYNC_URL_RE
const SHOTS = resolve('Docs/tms-build/screenshots/as')
const EMAIL_LOG = resolve('Docs/tms-build/EMAIL_LIVE_TEST.md')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const liveInvite = flag('live-invite')
const read = flag('read')

const report = []
const written = []
const line = (status, name, detail) => {
  report.push({ status, name, detail })
  console.log(`${status.padEnd(7)}${name}${detail ? ` — ${detail}` : ''}`)
}
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ')
const tid = (id) => `[data-testid="${id}"]`
const expect = (cond, message) => { if (!cond) throw new Error(message) }
async function exists(path) { try { await access(path); return true } catch { return false } }

const FILES = [
  'src/features/carriers/lookup/CarrierLookupCard.tsx', 'src/features/carriers/lookup/lookupModel.ts', 'src/features/carriers/lookup/lookupModel.test.ts',
  'src/features/carriers/find/InviteDialog.tsx', 'src/features/tms/carrierSales/CarrierLookup.tsx', 'src/features/tms/carrierSales/CarrierLookupPanel.tsx',
  'src/features/tms/carrierSales/CarrierLookup.test.tsx', 'amplify/functions/tms-directory-actions/mcpFind.ts', 'scripts/lib/asLive.mjs', 'scripts/lib/asLive.test.mjs',
]

async function inventory() {
  let ok = true
  const check = (cond, name, detail) => { line(cond ? 'PASS' : 'FAIL', name, detail); if (!cond) ok = false }
  for (const file of FILES) check(await exists(file), `file ${file}`)
  const find = await readFile('amplify/functions/tms-directory-actions/mcpFind.ts', 'utf8')
  check(find.includes('explicitRecipients') && find.includes('card?.emails'), 'MCP_SEND_INVITE accepts emails[] and defaults to the MCP list')
  const sales = await readFile('src/features/tms/carrierSales/CarrierSalesPage.tsx', 'utf8')
  check(sales.includes('<CarrierLookup'), 'Carrier Sales mounts the MC lookup')
  const hub = await readFile('src/features/tms/carrierSales/OffersHub.tsx', 'utf8')
  check(!hub.includes('q.carrierEmail') && !hub.includes('sendSetupPacket'), 'Offers Hub no longer requires a hand-typed carrier e-mail')
  console.log(ok ? '\ninventory: ok' : '\ninventory: FAILED')
  return ok
}

/** Replace every e-mail / phone in the page text with a marker before a screenshot. */
const MASK = `(() => {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi
  const phone = /\\(?\\b\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b/g
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const n of nodes) {
    const t = n.nodeValue.replace(email, '[e-mail hidden]').replace(phone, '[phone hidden]')
    if (t !== n.nodeValue) n.nodeValue = t
  }
  for (const el of document.querySelectorAll('input')) if (/@/.test(el.value)) el.value = '[e-mail hidden]'
})()`

async function main() {
  if (!(await inventory())) { process.exitCode = 1; return }
  if (!read && !liveInvite) { console.log('(no --read / --live-invite: nothing was called)'); return }
  if (read && liveInvite) throw new Error('run --read and --live-invite separately')

  if (!DEV_APPSYNC.test(DEV_API)) throw new Error('devVerifyAS refuses any endpoint other than the dev AppSync URL')
  if (DEV_POOL !== STACK.staffPoolId) throw new Error('devVerifyAS refuses any staff pool other than the dev pool')
  const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`devVerifyAS only permits ${ALLOWED_ORIGINS.join(', ')} (got ${origin})`)

  await mkdir(SHOTS, { recursive: true })
  const email = `zz-as-admin-${Date.now()}@example.invalid`
  let made = false
  try {
    const identity = await mintIdentity(email, ['ADMIN', 'page-tms'])
    made = true
    console.log('identity: temporary ADMIN identity created')
    const dir = routerAs(identity.token, 'tmsDirectoryActions')
    if (liveInvite) await runLiveInvite(identity, dir)
    else await runRead(identity, dir, origin)
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
  if (written.length) await writeFile(join(SHOTS, 'index.txt'), `${written.map((f) => f.replace(`${process.cwd()}/`, '')).join('\n')}\n`)
  if (failed > 0) process.exitCode = 1
}

async function runRead(identity, dir, origin) {
  const b = await launchBrowser({ origin, storage: identity.storage, profilePrefix: 'bcat-as-', purpose: 'AS verification', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } })
  try {
    const shot = async (name) => { await b.evaluate(MASK); const file = join(SHOTS, `${name}.png`); await b.screenshot(file, { clipToContent: true }); written.push(file) }
    const has = (selector) => b.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
    const text = (id) => b.evaluate(`document.querySelector(${JSON.stringify(tid(id))})?.textContent ?? ''`)
    const lookUp = async (mc) => {
      await b.navigate('/tms/carrier-sales')
      await b.poll(() => has(tid('cs-lookup-input')), 'the Carrier Sales lookup box', 60_000)
      await b.evaluate(`(() => {
        const input = document.querySelector('[data-testid="cs-lookup-input"]')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, ${JSON.stringify(mc)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await pause(200)
      await b.evaluate(`document.querySelector('[data-testid="cs-lookup-go"]').click()`)
      await b.poll(() => has(tid('cs-lookup-card')), `the lookup card for ${mc}`, 90_000)
      await pause(500)
    }

    // AS01 — an MC that is in the directory.
    try {
      // MC 274623 (Ivan Cartage) is not in the dev directory right now, so the in-directory case uses a real dev
      // directory carrier with an MC (ACTIVE preferred); read-only query.
      const rows = await gql(identity.token, 'query { listCarriers(limit: 1000, filter: { mcNumber: { attributeExists: true } }) { items { id name mcNumber status mcpStatus } } }')
      const items = rows.listCarriers.items.filter((c) => /\d/.test(c.mcNumber ?? ''))
      const pick = items.find((c) => c.status === 'ACTIVE' && /ACCEPTABLE|MODERATE|PENDING_REVIEW/.test(c.mcpStatus ?? '')) ?? items.find((c) => c.status === 'ACTIVE') ?? items[0]
      expect(pick, 'the dev directory has no carrier with an MC to look up')
      await lookUp(pick.mcNumber)
      const standing = await text('cs-lookup-card-standing')
      expect(/Set up with us/.test(standing), `first line does not say Set up with us: "${standing}"`)
      expect(/ACTIVE|INACTIVE|PENDING|REVIEW|DO NOT USE/.test(standing), `no directory status on the first line: "${standing}"`)
      expect(/Packet|No packet|Stub, no MCP call/.test(standing), `no packet standing on the first line: "${standing}"`)
      await shot('AS01-carrier-sales-in-directory')
      line('PASS', `AS01 directory carrier (${pick.status}, packet ${pick.mcpStatus ?? 'none'})`, standing.replace(/\s+/g, ' '))
    } catch (err) {
      line('FAIL', 'AS01 MC 274623 in directory', short(err).slice(0, 220))
      process.exitCode = 1
    }

    // AS02 — a small carrier that is not in the directory.
    try {
      const candidates = arg('mc') ? [arg('mc')] : candidateMcs(15)
      let found = null
      for (const mc of candidates) {
        const preview = await dir('MCP_PREVIEW_CARRIER', { mcNumber: mc })
        if (preview.mode !== 'LIVE') throw new Error(`MyCarrierPackets is ${preview.mode} on dev: ${preview.reason ?? 'no reason'}`)
        if (!preview.card || (preview.card.emails ?? []).length === 0) continue
        await lookUp(mc)
        const standing = await text('cs-lookup-card-standing')
        if (/^Not in directory/.test(standing.trim())) { found = { mc, emails: preview.card.emails.length }; break }
      }
      expect(found, 'no candidate MC was both known to MyCarrierPackets with an e-mail and outside the dev directory (pass --mc=MC123456)')
      const listed = await text('cs-lookup-card-emails')
      expect(/MyCarrierPackets e-mails: .+@/.test(listed), 'the card does not list MCP’s e-mail addresses')
      const sendDisabled = await b.evaluate(`document.querySelector('[data-testid="cs-lookup-card-send"]').disabled`)
      expect(sendDisabled === false, 'Send setup packet is disabled for a carrier MCP returns e-mails for')
      // Open the recipient checklist, assert every address is ticked, close it: confirm is never clicked.
      await b.evaluate(`document.querySelector('[data-testid="cs-lookup-card-send"]').click()`)
      await b.poll(() => has(tid('mcp-invite-recipients')), 'the recipient checklist', 15_000)
      const ticked = await b.evaluate(`[...document.querySelectorAll('[data-testid="mcp-invite-recipients"] input[type=checkbox]')].map((c) => c.checked)`)
      expect(ticked.length === found.emails && ticked.every(Boolean), `the checklist is not all ticked by default (${JSON.stringify(ticked)} vs ${found.emails} addresses)`)
      await pause(300)
      await shot('AS02-carrier-sales-not-in-directory-send-popover')
      await b.evaluate(`document.querySelector('.tms-dialog-close')?.click()`)
      line('PASS', 'AS02 MC not in directory', `${found.mc}: Not in directory; ${found.emails} MCP e-mail(s) listed; Send setup packet enabled; checklist all ticked; not confirmed`)
    } catch (err) {
      line('FAIL', 'AS02 MC not in directory', short(err).slice(0, 220))
      process.exitCode = 1
    }
  } finally {
    await b.close()
  }
}

async function runLiveInvite(identity, dir) {
  try {
    const ref = { mcNumber: AS_INVITE_MC }
    const preview = await dir('MCP_PREVIEW_CARRIER', ref)
    expect(preview.mode === 'LIVE', `needs a LIVE MyCarrierPackets integration on dev (the server answered ${preview.mode}: ${preview.reason ?? 'no reason given'})`)
    expect(/\bivan\b/i.test(preview.card?.identity?.legalName ?? ''), 'MC 274623 is not Ivan Cartage: no invitation is sent')
    const mcpAddresses = (preview.card.emails ?? []).map((e) => e.address)
    const plan = planInvite(mcpAddresses)
    const found = await gql(identity.token, 'query($f: ModelCarrierFilterInput) { listCarriers(filter: $f, limit: 5) { items { id name } } }', { f: { mcNumber: { contains: '274623' } } })
    const carrierId = found.listCarriers.items.find((c) => /\bivan\b/i.test(c.name))?.id
    const ships = await gql(identity.token, 'query { listShipments(limit: 1) { items { id number } } }')
    const shipment = ships.listShipments.items[0]
    expect(shipment, 'no dev shipment to note the invitation on')
    const input = assertInviteInputSafe({ ...ref, shipmentId: shipment.id, ...(carrierId ? { carrierId } : { ensureCarrier: true }), carrierName: preview.card.identity.legalName, ...(plan.emails ? { emails: plan.emails } : {}) }, mcpAddresses)
    createInviteBudget(1).take()
    const res = await dir('MCP_SEND_INVITE', input)
    expect(res.sent === true, `MyCarrierPackets did not send the invitation (${res.message ?? 'no message'})`)
    line('PASS', 'AS03 live invitation', `${plan.mode}; ${(res.emails ?? []).length} recipient(s), all ai4bcat; MCP status ${res.mcpResponse?.status ?? 'n/a'}; carrier row logged=${res.carrierLogged === true}`)
    // Read back through the API: carrier row, audit, thread.
    const back = {}
    if (res.carrierId) {
      const c = await gql(identity.token, 'query($id: ID!) { getCarrier(id: $id) { id status mcpStatus mcpInvitedAt mcpInvitedTo mcpInvitedBy } }', { id: res.carrierId })
      back.carrier = { invitedTo: c.getCarrier?.mcpInvitedTo ?? null, mcpStatus: c.getCarrier?.mcpStatus ?? null, hasInvitedAt: !!c.getCarrier?.mcpInvitedAt }
    }
    const auditId = res.carrierId ?? 'MYCARRIERPACKETS'
    let tok = null
    const auditRows = []
    do {
      const r = await gql(identity.token, 'query($f: ModelAuditLogFilterInput, $n: String) { listAuditLogs(filter: $f, limit: 10000, nextToken: $n) { items { action changes } nextToken } }', { f: { entityId: { eq: auditId } }, n: tok })
      auditRows.push(...r.listAuditLogs.items); tok = r.listAuditLogs.nextToken
    } while (tok)
    back.audit = auditRows.some((a) => a.action === 'MCP_SEND_INVITE' && String(a.changes).includes('ai4bcat'))
    const th = await gql(identity.token, 'query($s: String!) { listShipmentMessageByShipmentIdAndAt(shipmentId: $s, limit: 200) { items { subject to } } }', { s: shipment.id })
    back.thread = th.listShipmentMessageByShipmentIdAndAt.items.some((m) => /packet invitation/i.test(m.subject ?? '') && /ai4bcat/i.test(m.to ?? ''))
    const onlyAllowed = (v) => !v || String(v).split(',').every((a) => /^\s*ai4bcat(\+[a-z0-9._-]+)?@gmail\.com\s*$/i.test(a))
    const readBackOk = back.audit && back.thread && (!res.carrierId || (back.carrier.hasInvitedAt && onlyAllowed(back.carrier.invitedTo) && /ai4bcat/i.test(back.carrier.invitedTo ?? '')))
    line(readBackOk ? 'PASS' : 'FAIL', 'AS04 read-back', `carrier row ${JSON.stringify({ ...back.carrier, invitedTo: undefined })}; audit=${back.audit}; thread=${back.thread}`)
    if (!readBackOk) process.exitCode = 1
    await appendFile(EMAIL_LOG, `${await exists(EMAIL_LOG) ? '\n' : ''}## ${new Date().toISOString()} — Step AS live invitation (MC 274623, Ivan Cartage)\n\n- Recipient plan: ${plan.mode} (MCP returned ${mcpAddresses.length} address(es) for the carrier${plan.mode === 'EXPLICIT' ? '; the default list was NOT used because it contains an address other than ai4bcat@gmail.com' : ''}).\n- Sent to: ${(res.emails ?? []).join(', ')}\n- EmailPacketInvitation: sent=${res.sent}, mode=${res.mode}, MCP HTTP status ${res.mcpResponse?.status ?? '(n/a)'}, response keys: ${(res.mcpResponse?.bodyKeys ?? []).join(', ') || '(none)'}\n- Logged: carrier row=${res.carrierLogged === true}, shipment thread=${res.threadLogged === true}. Read-back through the API: carrier row stamped=${back.carrier?.hasInvitedAt ?? 'n/a'} (mcpStatus ${back.carrier?.mcpStatus ?? 'n/a'}), audit row=${back.audit}, thread note=${back.thread}.\n- Result: ${readBackOk ? 'ALL PASSED' : 'NOT ALL PASSED (see harness output)'}\n`)
    console.log('log: appended to Docs/tms-build/EMAIL_LIVE_TEST.md')
  } catch (err) {
    line('FAIL', 'AS03 live invitation', short(err).slice(0, 240))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`devVerifyAS failed: ${err?.message ?? err}`); process.exit(1) })
}
