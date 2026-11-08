/**
 * Step Y — shared context for the end-to-end demo drive (dev only).
 * `withDemoAdmin(fn)` mints one temporary ADMIN identity on the dev pool, hands `fn` a ctx with the API routers,
 * and always deletes the identity afterwards. Passwords and tokens are never printed.
 */
import { STACK } from './stackConfig.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { DEV_API, DEV_POOL, mintIdentity, deleteIdentity, gql, routerAs } from './devIdentity.mjs'
import { DEV_ORIGIN } from './cdpBrowser.mjs'

export const STATE_FILE = '/tmp/demoY-state.json'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 400)

export async function loadState() { try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) } catch { return {} } }
export async function saveState(state) { await writeFile(STATE_FILE, JSON.stringify(state, null, 2)) }

export async function withDemoAdmin(fn, groups = ['ADMIN', 'page-tms']) {
  if (DEV_API !== STACK.apiUrl || DEV_POOL !== STACK.staffPoolId) throw new Error('dev only')
  const email = `ai4bcat+zzdemoy${Date.now()}@gmail.com`
  const id = await mintIdentity(email, groups)
  const ctx = {
    email, id, origin: DEV_ORIGIN, token: id.token,
    ship: routerAs(id.token, 'tmsShipmentActions'),
    dir: routerAs(id.token, 'tmsDirectoryActions'),
    fin: routerAs(id.token, 'tmsFinanceActions'),
    trk: routerAs(id.token, 'tmsTrackingActions'),
    car: routerAs(id.token, 'tmsCarrierActions'),
    spot: routerAs(id.token, 'tmsSpotActions'),
    gql: (q, v) => gql(id.token, q, v),
    state: await loadState(),
    save: async () => saveState(ctx.state),
    minted: [],
    /** Another throwaway login (e.g. a single-grant persona); deleted with the rest. */
    mint: async (suffix, groups) => {
      const e = `ai4bcat+zzdemoy${suffix}${Date.now()}@gmail.com`
      const ident = await mintIdentity(e, groups)
      ctx.minted.push(e)
      return { email: e, ...ident, ship: routerAs(ident.token, 'tmsShipmentActions') }
    },
  }
  try { return await fn(ctx) } finally {
    await ctx.save().catch(() => {})
    for (const e of [email, ...ctx.minted]) console.log('temp identity deleted:', await deleteIdentity(e))
  }
}

/** Real, active staff profiles (read only) for the staff slots. */
export async function demoStaff(ctx) {
  const rows = (await ctx.gql('query { listUserProfiles(limit: 1000) { items { id name email role status } } }', {})).listUserProfiles.items.filter((p) => p.status === 'ACTIVE')
  const pick = (role, n = 0) => rows.filter((p) => p.role === role)[n] ?? rows[0]
  const slots = [pick('CARRIER_REP', 0), pick('CARRIER_REP', 1), pick('MANAGER'), pick('CUSTOMER_REP'), pick('CARRIER_REP', 2), pick('AR_AP')]
  if (slots.some((p) => !p)) throw new Error('dev has no UserProfile rows')
  return slots.map((p) => ({ id: p.id, name: p.name ?? p.email ?? p.id }))
}
