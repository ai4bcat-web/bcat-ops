#!/usr/bin/env tsx
/**
 * Chad Salerno's leased truck (decided 2026-09-15):
 *   • Unit 423166 — 2023 Volvo VNL760, VIN 4V4NC9EH7PN609779, leased, Amazon fleet.
 *   • Lease is $892/week; Chad and the company split it 50/50. Under his
 *     "50% AFTER expenses" model that is one fixed expense of $892 (the % halves it).
 *     The existing "$446" line was his HALF entered as the whole — he only bore $223.
 *     Corrected from the lease start, 2026-08-30, via the same revision helper the UI uses.
 *   • Lease mileage (from the lessor's invoice) and the quarterly IFTA bill are 100%
 *     Chad's: entered weekly by the office as DEBITs (LEASE_MILEAGE / IFTA) — not here.
 *
 * Usage:
 *   BCAT_EMAIL=... BCAT_PASSWORD=... npx tsx scripts/setupChadLeasedTruck.ts [--dry-run]
 */
import { readFileSync } from 'fs'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'
import { prepareFixedExpenses, applyFixedExpenseChange } from '../src/lib/fixedExpenseHistory'
import { effectiveFixedExpenses } from '../src/lib/driverPay'
import type { FixedExpenseInput } from '../src/lib/driverPay'

const DRY_RUN = process.argv.includes('--dry-run')
const outputs = JSON.parse(readFileSync(new URL('../amplify_outputs.json', import.meta.url), 'utf8'))
Amplify.configure(outputs)

const LEASE_START = '2026-08-30'
const LEASE_TOTAL = 892
const LEASE_LABEL = 'TRUCK LEASE 423166 (split 50/50)'
const TRUCK = { unitNumber: '423166', vin: '4V4NC9EH7PN609779', make: 'VOLVO', model: 'VNL760', year: 2023 }

const { isSignedIn } = await signIn({ username: process.env.BCAT_EMAIL, password: process.env.BCAT_PASSWORD })
if (!isSignedIn) throw new Error('sign-in failed')
const idToken = (await fetchAuthSession()).tokens!.idToken!.toString()

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(outputs.data.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors))
  return json.data
}

interface DriverRow { id: string; name: string; active?: boolean | null; assignedTruckId?: string | null }
interface SettingRow { id: string; driverId: string; payGroup?: string | null; fixedExpenses: unknown; updatedAt: string }
interface EquipmentRow { id: string; type: string; unitNumber: string; vin?: string | null; assignedDriverId?: string | null; fuelCardNumbers?: string[] | null }

const data = await gql<{
  listDrivers: { items: DriverRow[] }
  listDriverPaySettings: { items: SettingRow[] }
  listEquipment: { items: EquipmentRow[] }
}>(`{
  listDrivers(limit: 1000) { items { id name active assignedTruckId } }
  listDriverPaySettings(limit: 1000) { items { id driverId payGroup fixedExpenses updatedAt } }
  listEquipment(limit: 1000) { items { id type unitNumber vin assignedDriverId fuelCardNumbers } }
}`)

const chads = data.listDrivers.items.filter((d) => /\bchad\b/i.test(d.name) && d.active !== false)
if (chads.length !== 1) throw new Error(`expected exactly one active Chad, found ${chads.length}`)
const chad = chads[0]
const setting = data.listDriverPaySettings.items.find((s) => s.driverId === chad.id && (s.payGroup ?? 'AMAZON') === 'AMAZON')
if (!setting) throw new Error('no AMAZON pay setting for Chad')

// ── 1. Lease: $446 (his half) → $892 (the whole lease), from the lease start ──────
const unwrap = (v: unknown) => { for (let i = 0; i < 4 && typeof v === 'string'; i++) { try { v = JSON.parse(v) } catch { break } } return v }
const current = prepareFixedExpenses((unwrap(setting.fixedExpenses) ?? []) as FixedExpenseInput[])
const half = current.filter((e) => /lease/i.test(e.label) && e.amount === LEASE_TOTAL / 2 && e.endedAt == null)
if (half.length !== 1) throw new Error(`expected one open $${LEASE_TOTAL / 2} lease line, found ${half.length}: ${JSON.stringify(current)}`)
const audit = { at: new Date().toISOString(), by: process.env.BCAT_EMAIL ?? null }
const next = applyFixedExpenseChange(current, {
  kind: 'change', revisionId: half[0].revisionId!, label: LEASE_LABEL, amount: LEASE_TOTAL, effectiveFrom: LEASE_START,
}, audit)

const weekOf = (start: string) => {
  const d = new Date(`${start}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10)
}
for (const ws of ['2026-08-23', '2026-08-30', '2026-09-06']) {
  const before = effectiveFixedExpenses(current, ws, weekOf(ws)).reduce((s, f) => s + f.amount, 0)
  const after  = effectiveFixedExpenses(next,    ws, weekOf(ws)).reduce((s, f) => s + f.amount, 0)
  console.log(`week ${ws}: fixed expenses $${before.toFixed(2)} → $${after.toFixed(2)}`)
}

// ── 2. Truck 423166 ────────────────────────────────────────────────────────────
const existing = data.listEquipment.items.find((e) => e.unitNumber === TRUCK.unitNumber || e.vin === TRUCK.vin)
const oldTruck = data.listEquipment.items.find((e) => e.id === chad.assignedTruckId)
const cards: string[] = oldTruck?.fuelCardNumbers ?? []
const truckId = existing?.id ?? `equip-${Date.now()}`
console.log(existing ? `truck ${TRUCK.unitNumber} exists (${existing.id})` : `creating truck ${TRUCK.unitNumber} as ${truckId}`)
console.log(`Chad: ${oldTruck?.unitNumber ?? 'no truck'} → ${TRUCK.unitNumber}; fuel cards moving: ${cards.join(', ') || 'none'}`)

if (DRY_RUN) { console.log('dry run — nothing written'); process.exit(0) }

await gql(`mutation U($input: UpdateDriverPaySettingInput!, $condition: ModelDriverPaySettingConditionInput) {
  updateDriverPaySetting(input: $input, condition: $condition) { id updatedAt } }`,
  { input: { id: setting.id, fixedExpenses: JSON.stringify(next) }, condition: { updatedAt: { eq: setting.updatedAt } } })
console.log('pay setting updated')

if (!existing) {
  await gql(`mutation C($input: CreateEquipmentInput!) { createEquipment(input: $input) { id } }`, {
    input: {
      id: truckId, type: 'truck', ...TRUCK, ownership: 'leased', active: true, insured: true,
      fleetGroup: 'AMAZON', assignedDriverId: chad.id, fuelCardNumbers: cards,
    },
  })
  console.log('truck created')
}
await gql(`mutation D($input: UpdateDriverInput!) { updateDriver(input: $input) { id } }`, { input: { id: chad.id, assignedTruckId: truckId } })
if (oldTruck && oldTruck.id !== truckId) {
  await gql(`mutation E($input: UpdateEquipmentInput!) { updateEquipment(input: $input) { id } }`, { input: { id: oldTruck.id, assignedDriverId: null, fuelCardNumbers: [] } })
  console.log(`released ${oldTruck.unitNumber}`)
}
console.log('done')
