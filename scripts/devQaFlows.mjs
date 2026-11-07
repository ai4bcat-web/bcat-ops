#!/usr/bin/env node
/**
 * QAFlows sweep: Ryne's 2026-11-03/04 BEHAVIOUR rules, verified on the deployed dev app (API + browser).
 *
 *   node scripts/devQaFlows.mjs --list
 *   node scripts/devQaFlows.mjs [--only=S1,S7]  (sections S1..S7; default all)
 *
 * Dev only: refuses any AppSync endpoint but the dev one and any origin outside ALLOWED_ORIGINS. No SSM, no main /
 * production. Temporary identities (admin, loads-only dispatcher, Load-Review-only reviewer, tms-only, no-grants) are
 * minted on the dev pool and deleted (proven gone) in `finally`; ZZ fixtures are voided / archived. Output is counts and
 * yes/no only (no names, phones, tokens). Section checks live in scripts/lib/qaFlows/*.mjs.
 */
import { APPSYNC_URL_RE, STACK } from './lib/stackConfig.mjs'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { launchBrowser, ALLOWED_ORIGINS, DEV_ORIGIN } from './lib/cdpBrowser.mjs'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './lib/devIdentity.mjs'
import { accessTokenOf, record, results, short, installRecorder } from './lib/qaFlowsKit.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
const SECTIONS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']
const selected = only.length ? SECTIONS.filter((s) => only.includes(s)) : SECTIONS
if (args.includes('--list')) { console.log(SECTIONS.join(' ')); process.exit(0) }

if (!APPSYNC_URL_RE.test(DEV_API)) throw new Error('refuses any endpoint but the dev AppSync URL')
if (DEV_POOL !== STACK.staffPoolId) throw new Error('refuses any pool but the dev pool')
const origin = process.env.DEV_VERIFY_UI_URL ?? DEV_ORIGIN
if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} not allowed`)

const SHOTS = resolve('Docs/tms-build/screenshots/qa')
const ts = Date.now()
const PERSONAS = {
  admin: ['ADMIN', 'page-tms'],
  loads: ['page-loads'],
  reviewer: ['page-loadReview'],
  tms: ['page-tms'],
  none: [],
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  const emails = {}
  const ctx = { ts, origin, SHOTS, gql, id: {}, cleanup: [], browser: null }
  try {
    for (const [name, groups] of Object.entries(PERSONAS)) {
      const email = `zz-qaf-${name}-${ts}@example.invalid`
      emails[name] = email
      const identity = await mintIdentity(email, groups)
      const access = accessTokenOf(identity.storage)
      ctx.id[name] = {
        name, email, storage: identity.storage, access, idToken: identity.token,
        ship: routerAs(access, 'tmsShipmentActions'),
        dir: routerAs(access, 'tmsDirectoryActions'),
        car: routerAs(access, 'tmsCarrierActions'),
        fin: routerAs(access, 'tmsFinanceActions'),
        gql: (q, v) => gql(access, q, v),
      }
    }
    console.log(`identities: ${Object.keys(emails).length} temporary identities created (access tokens in use)`)
    ctx.newBrowser = async (persona, viewport = { width: 1440, height: 900, deviceScaleFactor: 1 }) => {
      const b = await launchBrowser({ origin, storage: ctx.id[persona].storage, screenshots: SHOTS, profilePrefix: 'bcat-qaf-', viewport, purpose: 'QAFlows sweep' })
      await installRecorder(b)
      return b
    }
    for (const section of selected) {
      const mod = await import(`./lib/qaFlows/${section}.mjs`)
      console.log(`\n== ${section} ${mod.TITLE}`)
      try { await mod.run(ctx) } catch (err) { record('FAIL', `${section}.crash`, mod.TITLE, short(err)); process.exitCode = 1 }
    }
  } finally {
    for (const fn of ctx.cleanup.reverse()) {
      await fn().then(() => record('PASS', 'cleanup', 'step'), (err) => { record('FAIL', 'cleanup', 'step', short(err)); process.exitCode = 1 })
    }
    for (const email of Object.values(emails)) {
      const gone = await deleteIdentity(email)
      if (!gone) { record('FAIL', 'cleanup', 'identity not confirmed deleted'); process.exitCode = 1 }
    }
    if (Object.keys(emails).length) console.log('cleanup: temporary identities deleted and confirmed gone')
  }
  const count = (s) => results.filter((r) => r.status === s).length
  console.log(`\nsummary: ${JSON.stringify({ pass: count('PASS'), fail: count('FAIL'), partial: count('PARTIAL'), skipped: count('SKIPPED') })}`)
  if (count('FAIL')) process.exitCode = 1
}

main().catch((err) => { console.error(`devQaFlows failed: ${short(err)}`); process.exit(1) })
