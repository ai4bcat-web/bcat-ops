#!/usr/bin/env -S npx tsx
/**
 * Split "CITY, ST" text into a real city and state on stops whose state is blank (Ryne 2026-11-16: 14899-style
 * "COCHRANE. WI" with an empty State field).
 *
 * Imported and intake-built stops carry the place as display text ("COCHRANE, WI", "COCHRANE. WI", "COCHRANE WI") and an
 * address snapshot with no state. Every reader now parses that text (stopPlace.ts), so nothing breaks either way; this
 * writes the parts onto the stop so the state is in its own field everywhere (the editor, the rail, OTR, exports).
 *
 * Per stop: when `address.state` is blank and the address city or the stop's display text parses to a city plus a real US
 * state / territory / Canadian province, set address.city, address.state (and address.zip when the text carries one and the
 * address has none) and rewrite the display text as "CITY, ST". A stop whose address city and display text disagree is left
 * alone and listed. Street, ZIP already present, appointment, times and every other stop field are untouched.
 *
 * Only loads on shipments that are not voided and not released to invoicing are written (a released load's place is part of
 * what was invoiced). The released ones are counted, not changed.
 *
 * Dry run by default. `--apply` backs up every changed load's old `stops` to ~/bcat-ops-backups/manual, writes each load
 * conditionally on its updatedAt (updatedAt / version are NOT bumped: this is not an edit), and writes one AuditLog row per
 * load (STOP_STATE_SPLIT).
 *
 *   npx tsx scripts/splitStopStates.mts --suffix 5ucwdyvwivelbo4k4jomvrwel4-NONE [--apply] [--report out.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { cityStateText, isRegionCode, parsePlaceText, stopsList } from '../src/lib/stopPlace.ts'

type Row = Record<string, unknown>
const args = process.argv.slice(2)
const suffix = args[args.indexOf('--suffix') + 1]
if (!suffix || args.indexOf('--suffix') < 0) throw new Error('--suffix is required')
const APPLY = args.includes('--apply')
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } })
const t = (model: string) => `${model}-${suffix}`

async function scanAll(model: string): Promise<Row[]> {
  const out: Row[] = []
  let ExclusiveStartKey: Row | undefined
  do {
    const r = await doc.send(new ScanCommand({ TableName: t(model), ExclusiveStartKey }))
    out.push(...((r.Items ?? []) as Row[]))
    ExclusiveStartKey = r.LastEvaluatedKey as Row | undefined
  } while (ExclusiveStartKey)
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const isReleased = (o: Row): boolean => Boolean(o.invoiceId || o.invoiceNumber || o.invoicedAt || o.factoringItemId || o.readyToInvoiceAt)

const [shipments, orders, loads] = await Promise.all(['Shipment', 'Order', 'Load'].map(scanAll))
const shipmentById = new Map(shipments.map((s) => [String(s.id), s]))
const ordersByShipment = new Map<string, Row[]>()
for (const o of orders) { const k = String(o.shipmentId ?? ''); ordersByShipment.set(k, [...(ordersByShipment.get(k) ?? []), o]) }

interface StopChange { stopId: string; type: string; from: { city: string; address: string }; to: { city: string; state: string; zip: string | null; text: string } }
const changed: { load: Row; number: string; stops: Row[]; wasString: boolean; changes: StopChange[] }[] = []
const skipped = { released: [] as string[], voided: [] as string[], conflict: [] as string[], noParse: 0, alreadyHasState: 0, stops: 0 }
let releasedWouldChange = 0

for (const load of loads) {
  const raw = load.stops
  const stops = stopsList<Row>(raw)
  if (stops.length === 0) continue
  const shipment = shipmentById.get(String(load.shipmentId ?? ''))
  const number = String(shipment?.number ?? load.number ?? load.id)
  const voided = Boolean(shipment && typeof shipment.voidedAt === 'string' && shipment.voidedAt)
  const released = (ordersByShipment.get(String(load.shipmentId ?? '')) ?? []).some(isReleased)
  const wasString = typeof raw === 'string'
  const changes: StopChange[] = []
  const next = stops.map((stop) => {
    skipped.stops++
    const addr = (stop.address && typeof stop.address === 'object' ? stop.address : {}) as Row
    if (/^[A-Za-z]{2}$/.test(str(addr.state))) { skipped.alreadyHasState++; return stop }
    const fromAddr = parsePlaceText(addr.city)
    const fromText = parsePlaceText(stop.city)
    const use = fromAddr.state ? fromAddr : fromText
    if (!use.state || !use.city || !isRegionCode(use.state)) { skipped.noParse++; return stop }
    // The address city and the display text must agree when both name a place.
    if (fromAddr.state && fromText.city && fromAddr.city && fromText.city.toLowerCase() !== fromAddr.city.toLowerCase() && fromText.state) {
      skipped.conflict.push(`${number}:${str(stop.city)} / ${str(addr.city)}`)
      return stop
    }
    const city = use.city
    const text = cityStateText(city, use.state)
    const zip = str(addr.zip) ? null : use.zip
    changes.push({
      stopId: String(stop.id ?? ''), type: str(stop.type),
      from: { city: str(stop.city), address: str(addr.city) },
      to: { city, state: use.state, zip, text },
    })
    return { ...stop, city: text, address: { ...addr, city, state: use.state, ...(zip ? { zip } : {}) } }
  })
  if (changes.length === 0) continue
  if (voided) { skipped.voided.push(number); continue }
  if (released) { skipped.released.push(number); releasedWouldChange += changes.length; continue }
  changed.push({ load, number, stops: next, wasString, changes })
}

const stopCount = changed.reduce((n, c) => n + c.changes.length, 0)
console.log(JSON.stringify({
  apply: APPLY, stopsScanned: skipped.stops, loadsToChange: changed.length, stopsToChange: stopCount,
  releasedLoadsLeftAlone: skipped.released.length, releasedStopsLeftAlone: releasedWouldChange, voidedLoadsLeftAlone: skipped.voided.length,
  conflictsLeftAlone: skipped.conflict, alreadyHadState: skipped.alreadyHasState, noParse: skipped.noParse,
  sample: changed.slice(0, 12).map((c) => ({ pro: c.number, changes: c.changes.map((x) => `${x.type}: "${x.from.city}" | addr "${x.from.address}" -> ${x.to.text}${x.to.zip ? ` ${x.to.zip}` : ''}`) })),
}, null, 2))
if (reportPath) writeFileSync(reportPath, JSON.stringify({ changed: changed.map((c) => ({ pro: c.number, loadId: c.load.id, changes: c.changes })), skipped }, null, 2))

if (APPLY && changed.length > 0) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const dir = `${homedir()}/bcat-ops-backups/manual`
  mkdirSync(dir, { recursive: true })
  const backup = `${dir}/backup-stop-state-split-${stamp}.json`
  writeFileSync(backup, JSON.stringify(changed.map((c) => ({ pro: c.number, loadId: c.load.id, updatedAt: c.load.updatedAt, stops: c.load.stops })), null, 2))
  let written = 0
  const failed: string[] = []
  for (const c of changed) {
    try {
      await doc.send(new UpdateCommand({
        TableName: t('Load'), Key: { id: c.load.id },
        UpdateExpression: 'SET stops = :s',
        ConditionExpression: 'updatedAt = :u',
        ExpressionAttributeValues: { ':s': c.wasString ? JSON.stringify(c.stops) : c.stops, ':u': c.load.updatedAt },
      }))
      const now = new Date().toISOString()
      await doc.send(new PutCommand({
        TableName: t('AuditLog'),
        Item: {
          id: `audit-stop-state-split-${c.load.id}-${stamp}`, __typename: 'AuditLog', entityType: 'Load', entityId: c.load.id,
          action: 'STOP_STATE_SPLIT', user: 'claude (for Ryne)', createdAt: now, updatedAt: now,
          changes: JSON.stringify({ pro: c.number, stops: c.changes }),
        },
      }))
      written++
    } catch (e) {
      failed.push(`${c.number}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(JSON.stringify({ backup, written, failed }, null, 2))
}
