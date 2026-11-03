/**
 * The bell's conditions, as pure data: what is wrong right now, grouped by kind and cut down
 * to what this person may open. No fetching and no clock reads — `useNotifications` feeds it
 * and `nowMs` is a parameter.
 *
 * These are *conditions*, not events: they clear when the underlying record is fixed, so
 * there is no read state. `total` counts every item the user may see; `items` is capped so
 * the drawer stays short, which means the badge never under-counts.
 */

export type NotificationKind =
  | 'CHECK_CALLS'
  | 'PODS'
  | 'DOCUMENTS'
  | 'CREDIT'
  | 'REVIEW'
  | 'WORKFLOWS'

export type NotificationSeverity = 'critical' | 'warn' | 'info'

export interface NotificationItem {
  id: string
  kind: NotificationKind
  severity: NotificationSeverity
  title: string
  detail: string
  /** ISO time the condition started (or the nearest honest stand-in); null when unknown. */
  at: string | null
  to: string
}

export interface NotificationGroup {
  kind: NotificationKind
  label: string
  /** Every item the user may see, including those beyond the cap. */
  total: number
  items: NotificationItem[]
  /** The owning page, offered when `total > items.length`. */
  moreTo: string
  moreLabel: string
}

export const GROUP_CAP = 10

export interface NotificationAccess {
  /** Owner or ADMIN. */
  admin: boolean
  hasPage: (pageKey: string) => boolean
}

export interface CheckCallInput {
  shipmentId: string | null
  /** The load's own label (TMS id, falling back to the pickup number). */
  label: string
  state: 'NONE' | 'SCHEDULED' | 'DUE' | 'OVERDUE'
  nextCheckCallAt: string | null
  carrierName: string | null
}

export interface ShipmentInput {
  id: string
  number: string
  status: string
  voidedAt?: string | null
  deletedAt?: string | null
  customerName?: string | null
  deliveredAt?: string | null
  updatedAt?: string | null
  docsMissing: string[] | null
  legDocsMissing: string[] | null
  creditHold: boolean | null
  cargoInsuranceExpiresAt: string | null
  liabilityInsuranceExpiresAt: string | null
  carrierName: string | null
}

/** The slice of `complianceOverview.OverviewRow` this lib reads. */
export interface DocRowInput {
  key: string
  kind: 'cd' | 'carrier' | 'policy' | 'rec'
  entityType: 'DRIVER' | 'TRUCK' | 'CARRIER'
  entityName: string
  title: string
  expiry: string | null
  daysLeft: number | null
  state: 'PENDING_REVIEW' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REJECTED' | 'WAIVED'
  createdAt?: string | null
}

export interface ReviewDocInput {
  id: string
  shipmentId: string
  name: string
  createdAt?: string | null
}

export interface WorkflowRunInput {
  id: string
  agent: string
  subject?: string | null
  error?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface CollectInput {
  access: NotificationAccess
  nowMs: number
  checkCalls: CheckCallInput[]
  shipments: ShipmentInput[]
  docRows: DocRowInput[]
  /** Carrier-portal uploads awaiting a person (`useDocumentReviewQueue`). */
  reviewDocuments: ReviewDocInput[]
  workflowRuns: WorkflowRunInput[]
}

const DELIVERED_OR_LATER = new Set(['DELIVERED'])
const INSURANCE_WARN_DAYS = 30
const DAY_MS = 86_400_000

const SEVERITY_RANK: Record<NotificationSeverity, number> = { critical: 0, warn: 1, info: 2 }

function isVoided(s: Pick<ShipmentInput, 'voidedAt' | 'deletedAt'>): boolean {
  return Boolean(s.voidedAt || s.deletedAt)
}

function isOpenShipment(s: ShipmentInput): boolean {
  return !isVoided(s) && s.status !== 'DELIVERED' && s.status !== 'CANCELED'
}

/** Same rule as `podMissing` in the dashboard strips: delivered, not voided, POD on the gate. */
export function shipmentPodMissing(s: ShipmentInput): boolean {
  if (isVoided(s) || !DELIVERED_OR_LATER.has(s.status)) return false
  return (s.docsMissing ?? []).includes('POD') || (s.legDocsMissing ?? []).includes('POD')
}

function atMs(at: string | null): number {
  if (!at) return Number.POSITIVE_INFINITY
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

function compareItems(a: NotificationItem, b: NotificationItem): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  const byAge = atMs(a.at) - atMs(b.at)
  if (byAge !== 0 && !Number.isNaN(byAge)) return byAge
  return a.id.localeCompare(b.id)
}

function group(
  kind: NotificationKind,
  label: string,
  moreTo: string,
  moreLabel: string,
  items: NotificationItem[],
): NotificationGroup | null {
  if (items.length === 0) return null
  const sorted = [...items].sort(compareItems)
  return { kind, label, total: sorted.length, items: sorted.slice(0, GROUP_CAP), moreTo, moreLabel }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function daysUntilIso(iso: string, nowMs: number): number | null {
  const ms = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(ms)) return null
  const todayUtc = Math.floor(nowMs / DAY_MS) * DAY_MS
  const thatUtc = Math.floor(ms / DAY_MS) * DAY_MS
  return Math.round((thatUtc - todayUtc) / DAY_MS)
}

export function collectNotifications(input: CollectInput): NotificationGroup[] {
  const { access, nowMs } = input
  const canLoads = access.admin || access.hasPage('loads') || access.hasPage('tms')
  const canDocs = access.admin || access.hasPage('compliance') || access.hasPage('files')
  const canCarriers = access.admin || access.hasPage('carriers')
  const canTms = access.admin || access.hasPage('tms')
  const canReviewDrivers = access.admin || access.hasPage('compliance') || access.hasPage('files')
  const canReviewCarrierUploads = access.admin || access.hasPage('loads') || access.hasPage('tms')

  const groups: Array<NotificationGroup | null> = []

  // (1) Check calls
  if (canLoads) {
    const items: NotificationItem[] = []
    for (const row of input.checkCalls) {
      if (row.state !== 'DUE' && row.state !== 'OVERDUE') continue
      items.push({
        id: `cc:${row.shipmentId ?? row.label}`,
        kind: 'CHECK_CALLS',
        severity: row.state === 'OVERDUE' ? 'critical' : 'warn',
        title: `${row.label} — check call ${row.state === 'OVERDUE' ? 'overdue' : 'due'}`,
        detail: row.carrierName ?? 'No carrier on the load',
        at: row.nextCheckCallAt,
        to: row.shipmentId ? `/tms/shipments/${row.shipmentId}?tab=tracking` : '/tms/check-calls',
      })
    }
    groups.push(group('CHECK_CALLS', 'Check calls', '/tms/check-calls', 'Open worklist', items))
  }

  // (2) PODs missing
  if (canLoads) {
    const items: NotificationItem[] = []
    for (const s of input.shipments) {
      if (!shipmentPodMissing(s)) continue
      items.push({
        id: `pod:${s.id}`,
        kind: 'PODS',
        severity: 'warn',
        title: `${s.number} — POD missing`,
        detail: [s.customerName, s.carrierName].filter(Boolean).join(' · ') || 'Delivered without a signed POD',
        at: s.deliveredAt ?? s.updatedAt ?? null,
        to: `/tms/shipments/${s.id}?tab=documents`,
      })
    }
    groups.push(group('PODS', 'PODs missing', '/tms/shipments', 'Open shipments', items))
  }

  // (3) Documents expiring: driver/truck rows (equal to the overview's Expiring + Expired)
  // plus carrier insurance on carriers hauling open shipments.
  if (canDocs || canCarriers) {
    const items: NotificationItem[] = []
    if (canDocs) {
      for (const row of input.docRows) {
        if (row.kind === 'carrier' || row.kind === 'policy' || row.entityType === 'CARRIER') continue
        if (row.state !== 'EXPIRING_SOON' && row.state !== 'EXPIRED') continue
        const expired = row.state === 'EXPIRED'
        items.push({
          id: `doc:${row.key}`,
          kind: 'DOCUMENTS',
          severity: expired ? 'critical' : 'warn',
          title: `${row.entityName} — ${row.title}`,
          detail: expired
            ? `Expired${row.expiry ? ` ${row.expiry}` : ''}`
            : `Expires ${row.expiry ?? 'soon'}${row.daysLeft != null ? ` (${plural(row.daysLeft, 'day')})` : ''}`,
          at: row.expiry,
          to: `/compliance?doc=${encodeURIComponent(row.key)}`,
        })
      }
    }
    if (canCarriers) {
      for (const s of input.shipments) {
        if (!isOpenShipment(s) || !s.carrierName) continue
        const policies: Array<[string, string | null]> = [
          ['Cargo insurance', s.cargoInsuranceExpiresAt],
          ['Liability insurance', s.liabilityInsuranceExpiresAt],
        ]
        for (const [label, expiry] of policies) {
          if (!expiry) continue
          const days = daysUntilIso(expiry, nowMs)
          if (days == null || days > INSURANCE_WARN_DAYS) continue
          items.push({
            id: `ins:${s.id}:${label}`,
            kind: 'DOCUMENTS',
            severity: days < 0 ? 'critical' : 'warn',
            title: `${s.carrierName} — ${label}`,
            detail: `${days < 0 ? 'Expired' : 'Expires'} ${expiry.slice(0, 10)} · on ${s.number}`,
            at: expiry,
            to: `/tms/shipments/${s.id}?tab=carrier`,
          })
        }
      }
    }
    groups.push(group('DOCUMENTS', 'Documents expiring', canDocs ? '/compliance' : '/tms/carriers', 'Open documents', items))
  }

  // (4) Credit holds: one item per customer
  if (canLoads) {
    const byCustomer = new Map<string, { open: number; at: string | null }>()
    for (const s of input.shipments) {
      if (s.creditHold !== true || !s.customerName || !isOpenShipment(s)) continue
      const entry = byCustomer.get(s.customerName) ?? { open: 0, at: null }
      entry.open += 1
      if (s.updatedAt && (!entry.at || s.updatedAt < entry.at)) entry.at = s.updatedAt
      byCustomer.set(s.customerName, entry)
    }
    const items: NotificationItem[] = [...byCustomer].map(([name, v]) => ({
      id: `credit:${name}`,
      kind: 'CREDIT',
      severity: 'warn',
      title: `${name} — on credit hold`,
      detail: plural(v.open, 'open shipment'),
      at: v.at,
      to: `/tms/shipments?q=${encodeURIComponent(name)}`,
    }))
    groups.push(group('CREDIT', 'Credit holds', '/tms/shipments', 'Open shipments', items))
  }

  // (5) Documents to review
  {
    const items: NotificationItem[] = []
    if (canReviewCarrierUploads && input.reviewDocuments.length > 0) {
      const oldest = input.reviewDocuments.reduce<string | null>(
        (acc, d) => (d.createdAt && (!acc || d.createdAt < acc) ? d.createdAt : acc), null,
      )
      items.push({
        id: 'review:carrier',
        kind: 'REVIEW',
        severity: 'info',
        title: `${plural(input.reviewDocuments.length, 'carrier upload')} waiting for review`,
        detail: 'Nothing a carrier sends counts until someone accepts it',
        at: oldest,
        to: '/tms/documents',
      })
    }
    if (canReviewDrivers) {
      const pending = input.docRows.filter(
        (r) => r.state === 'PENDING_REVIEW' && (r.entityType === 'DRIVER' || r.entityType === 'TRUCK'),
      )
      if (pending.length > 0) {
        const oldest = pending.reduce<string | null>(
          (acc, d) => (d.createdAt && (!acc || d.createdAt < acc) ? d.createdAt : acc), null,
        )
        items.push({
          id: 'review:compliance',
          kind: 'REVIEW',
          severity: 'info',
          title: `${plural(pending.length, 'driver/truck document')} waiting for review`,
          detail: 'Uploaded from the driver app or the office',
          at: oldest,
          to: '/compliance?tab=review',
        })
      }
    }
    groups.push(group('REVIEW', 'Documents to review', '/compliance?tab=review', 'Open review queue', items))
  }

  // (6) Workflow errors
  if (canTms) {
    const items: NotificationItem[] = input.workflowRuns.map((run) => ({
      id: `wf:${run.id}`,
      kind: 'WORKFLOWS',
      severity: 'critical',
      title: `${run.agent} — ${run.subject?.trim() || 'workflow run'}`,
      detail: run.error?.split('\n')[0]?.slice(0, 120) || 'Needs a person',
      at: run.createdAt ?? run.updatedAt ?? null,
      to: '/tms/workflows?tab=errors',
    }))
    groups.push(group('WORKFLOWS', 'Workflow errors', '/tms/workflows?tab=errors', 'Open Errors tab', items))
  }

  return groups.filter((g): g is NotificationGroup => g !== null)
}

export function notificationCount(groups: NotificationGroup[]): number {
  return groups.reduce((sum, g) => sum + g.total, 0)
}
