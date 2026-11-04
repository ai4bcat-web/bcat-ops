import { defineFunction } from '@aws-amplify/backend'

/**
 * Step AF. Keeps the DashboardRollup table (one row per calendar month, one legacy-KPI row
 * per month, one live AR/AP row) in step with the shipment, order, load, sample, invoice and
 * carrier-bill tables the dashboards are computed from.
 *
 * Three doors: DynamoDB stream batches (diff the relevant fields, mark `D:` rows dirty,
 * recompute them straight away under a `K:` lease), the five-minute `DashboardRollupSweepRule`
 * (dirty rows, the live row, the surrounding months, progressive backfill) and a manual
 * `{ backfill: { from, to } }` invoke. Every refresh is an idempotent recompute from the
 * source tables, never an incremental counter, so a lost or repeated event repairs itself.
 *
 * Reads the source tables, writes only DashboardRollup — which is why the dev guard leaves its
 * sweep rule enabled (amplify/devRuleGuard.ts).
 */
export const tmsDashboardRollup = defineFunction({
  name: 'tms-dashboard-rollup',
  entry: './handler.ts',
  resourceGroupName: 'data',
  timeoutSeconds: 300,
  memoryMB: 1024,
})
