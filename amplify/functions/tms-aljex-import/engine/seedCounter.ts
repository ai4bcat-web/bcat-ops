/**
 * IMPORT_SEED_COUNTER (DECIDED-1): move `TmsSettings.nextShipmentNumber` ("last issued") forward to the
 * highest numeric PRO known, so the next new shipment is max+1. Forward-only and atomic: one conditional
 * UpdateItem; a failed condition means the counter is already at or above the target.
 */
import type { AljexImportJob, EngineStore, SeedProCounterResult } from '../../../../src/types/tms'
import { auditRow, scanRows, text } from './directory'
import { readJson, stageKey, type StageData } from './stage'

/** PROs 900000..999999 are the reserved fixture band: never counted toward the counter target. */
const FIXTURE_BAND = { min: 900000, max: 999999 }
const MAX_COUNTER = 2_147_483_647

const numericPro = (id: string): number | null => (/^\d{1,9}$/.test(id) ? Number(id) : null)
const inFixtureBand = (n: number): boolean => n >= FIXTURE_BAND.min && n <= FIXTURE_BAND.max

export class SeedRefused extends Error {}

export async function seedProCounter(
  store: EngineStore,
  opts: { apply?: boolean; enableNumericScheme?: boolean; jobId?: string | null; actor?: string },
): Promise<SeedProCounterResult> {
  let stagedMax = 0
  if (opts.jobId) {
    const [job] = (await store.getMany('aljexImportJob', [opts.jobId])) as unknown as AljexImportJob[]
    if (job?.synthetic === true) throw new SeedRefused('The counter is never seeded from a synthetic run')
    if (job?.stageHash) {
      let root = job
      for (let hops = 0; root.parentJobId && hops < 5; hops++) {
        const [parent] = (await store.getMany('aljexImportJob', [root.parentJobId])) as unknown as AljexImportJob[]
        if (!parent) break
        root = parent
      }
      const index = await readJson<StageData['index'] & { maxProNumber?: number }>(store, stageKey(root.id, 'stage-index.json')).catch(() => null)
      stagedMax = index?.maxProNumber ?? 0
    }
  }
  let tableMax = 0
  for (const c of await scanRows(store, 'proClaim', ['id'])) {
    const n = numericPro(text(c.id))
    if (n != null && !inFixtureBand(n)) tableMax = Math.max(tableMax, n)
  }
  for (const l of await scanRows(store, 'load', ['aljexId'])) {
    const n = numericPro(text(l.aljexId).trim())
    if (n != null && !inFixtureBand(n)) tableMax = Math.max(tableMax, n)
  }
  const target = Math.min(MAX_COUNTER, Math.max(stagedMax, tableMax))
  const [settings] = await store.getMany('settings', ['default'])
  const current = typeof settings?.nextShipmentNumber === 'number' ? settings.nextShipmentNumber : null
  const wouldChange = current == null || current < target
  const schemeEnabled = settings?.proScheme === 'NUMERIC'
  if (!opts.apply) return { current, target, wouldChange, applied: false, schemeEnabled }

  let applied = false
  if (wouldChange) {
    applied = await store.update('settings', 'default', { nextShipmentNumber: target }, {
      expression: 'attribute_not_exists(nextShipmentNumber) OR nextShipmentNumber < :target',
      values: { ':target': target },
    })
  }
  let enabled = schemeEnabled
  if (opts.enableNumericScheme && !schemeEnabled) {
    // Only once the counter is at or above every claimed numeric PRO (guaranteed by the update above).
    await store.update('settings', 'default', { proScheme: 'NUMERIC' })
    enabled = true
  }
  await store.batchPut('auditLog', [
    auditRow(`seed-counter:${opts.jobId ?? 'manual'}:${target}:${current ?? 'none'}:${applied}:${enabled}`, 'TmsSettings', 'default', 'IMPORT_SEED_COUNTER', { from: current, target, applied, numericScheme: enabled }),
  ])
  return { current, target, wouldChange, applied, schemeEnabled: enabled }
}
