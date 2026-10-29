/**
 * The Errors tab — one list of everything that is stuck.
 *
 * The rows are derived, never stored: `collectExceptions` reads the open AI runs, the
 * shipments with no customer record, the loads whose check call is late, the carrier-ping
 * links that have gone silent, and the integrations whose credentials stopped working,
 * and returns them in one shape. A second opinion about what counts as stuck is how a
 * DELIVERED-but-unresolved shipment walks into AR, so this page contributes no rules of
 * its own: it supplies the inputs and renders what comes back.
 *
 * Nothing here deletes anything. Retry re-runs an agent, Resolve clears the exception
 * flag and leaves the run, Re-check asks a provider whether its credentials still work.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  TmsButton,
  TmsDialog,
  TmsListPage,
  TmsTextarea,
} from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useCheckCallWorklist } from '@/hooks/useCheckCallWorklist'
import { useDirectory } from '@/hooks/useDirectory'
import { useIntegrations } from '@/hooks/useIntegrations'
import { useShipments } from '@/hooks/useShipments'
import { useWorkflowExceptions } from '@/hooks/useWorkflowExceptions'
import {
  getTmsSettings,
  listCarrierPingLinks,
  resolveWorkflowException,
  retryWorkflowRun,
  setShipmentCustomer,
  validateIntegration,
} from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import {
  EXCEPTION_TABS,
  actionsFor,
  collectExceptions,
  countsByIntegration,
  defaultAgentsFor,
  defaultFilterFor,
} from '@/lib/workflows/exceptions'
import type { ExceptionKind, ExceptionRow } from '@/lib/workflows/exceptions'
import type { IntegrationRecord } from '@/lib/integrations/types'
import type { TmsSettings, TrackingLinkRecord, WorkflowRunRecord } from '@/types/tms'
import { IdentifyCustomerDialog } from './IdentifyCustomerDialog'

type QuickTabKey = ExceptionKind | 'ALL'

/**
 * What an empty tab means. "Nothing here" is only reassuring when the reader knows why,
 * and three of these are empty for reasons that have nothing to do with the freight.
 */
const EMPTY_TEXT: Record<QuickTabKey, string> = {
  ALL: 'Nothing is stuck — no agent run failed, every shipment has a customer, every check call is on time and every provider answered.',
  AI: 'No agent run is waiting on a person. A run only lands here when it failed or could not name the sender.',
  ACCOUNTING: 'No accounting sync errors — QuickBooks sync is preview-only until it is live.',
  TRACKING: 'No late check calls and no silent tracking links. A load only appears here while it is actually moving.',
  PARADE: 'No Parade errors. Parade only reports one when a posting or a quote request is refused.',
  UNKNOWN_CUSTOMER: 'Every shipment has a customer record linked. Voided and canceled shipments are never counted here.',
  EDI: 'No EDI errors. Orderful failures are fixed at Orderful, so nothing here would be actionable anyway.',
  INTEGRATION: 'Every provider answered its last credential check.',
}

/** The one tab whose zero can be a permission rather than a fact. */
const INTEGRATIONS_HIDDEN_TEXT =
  'These counts read zero because LIST_INTEGRATIONS is owner/ADMIN only — this page does not ask for a list it would be refused, and a refused list would read as "every provider is broken".'

const KIND_LABELS: Record<ExceptionKind, string> = {
  AI: 'AI agents',
  UNKNOWN_CUSTOMER: 'Unknown customers',
  TRACKING: 'Tracking',
  ACCOUNTING: 'Accounting',
  PARADE: 'Parade',
  EDI: 'EDI',
  INTEGRATION: 'Integrations',
}

export function ErrorsTab() {
  const { isAdmin, isOwner } = useAuth()
  // LIST_INTEGRATIONS is owner/ADMIN only, the same gate the shipment detail carries.
  // Anyone else must not even mount the hook: the refused list would read as "every
  // provider is not connected", which is a lie, and would retry on every poll.
  return isAdmin || isOwner ? <ErrorsTabWithIntegrations /> : <ErrorsTabBody integrations={[]} integrationsVisible={false} />
}

/** The integrations read, mounted only for the people the server will answer. */
function ErrorsTabWithIntegrations() {
  const { rows } = useIntegrations()
  return <ErrorsTabBody integrations={rows} integrationsVisible />
}

function ErrorsTabBody({ integrations, integrationsVisible }: {
  integrations: IntegrationRecord[]
  integrationsVisible: boolean
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const groups = user?.groups ?? []
  const exceptions = useWorkflowExceptions()
  const { shipments } = useShipments()
  const worklist = useCheckCallWorklist()
  const { customers } = useDirectory()

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [trackingLinks, setTrackingLinks] = useState<TrackingLinkRecord[]>([])
  const [quickTab, setQuickTab] = useState<QuickTabKey>('ALL')
  const [search, setSearch] = useState('')
  // Chips are a seed, never a gate: a kind a person drops off the list is gone, and when
  // the last one goes the filter goes with it and every row is shown.
  const [droppedKinds, setDroppedKinds] = useState<ExceptionKind[]>([])
  const [identify, setIdentify] = useState<ExceptionRow | null>(null)
  const [resolving, setResolving] = useState<{ runId: string; reason: string } | null>(null)
  const [busyRow, setBusyRow] = useState<string | null>(null)
  // The clock the rows are graded against, frozen into state and advanced by a refresh:
  // a `Date.now()` read during render would make the derivation impure and the staleness
  // of a tracking link would change under the reader mid-scroll.
  const [nowIso, setNowIso] = useState(() => new Date().toISOString())

  useEffect(() => {
    // The tracking rule needs the ping interval; everything else works without settings,
    // so a refused or failed read leaves the default interval rather than an error page.
    let alive = true
    getTmsSettings()
      .then((next) => { if (alive) setSettings(next) })
      .catch(() => { if (alive) setSettings(null) })
    return () => { alive = false }
  }, [])

  // Non-async on purpose, like `useCheckCallWorklist`: the lint rule that guards state
  // writes in effects cannot see through an `async` function, so the writes stay in an
  // explicit promise chain. A silent truck is one of six sources — a failed read drops
  // those rows and leaves the other five rather than blanking the page.
  const loadTrackingLinks = useCallback(() => (
    listCarrierPingLinks()
      .then((rows) => { setTrackingLinks(rows) })
      .catch(() => { setTrackingLinks([]) })
  ), [])

  useEffect(() => { void loadTrackingLinks() }, [loadTrackingLinks])

  const refresh = useCallback(async () => {
    setNowIso(new Date().toISOString())
    await Promise.all([exceptions.refresh(), worklist.refresh(), loadTrackingLinks()])
  }, [exceptions, worklist, loadTrackingLinks])

  /** The run behind an AI row, for its version and its retry. */
  const runsById = useMemo(() => {
    const map: Record<string, WorkflowRunRecord> = {}
    for (const run of exceptions.runs) map[run.id] = run
    return map
  }, [exceptions.runs])

  /** `collectExceptions` keys an integration row by row id; Re-check needs its provider. */
  const providerByRowId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const row of integrations) map[`integration:${row.id}`] = row.provider
    return map
  }, [integrations])

  const numberByShipmentId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of shipments) if (s.number) map[s.id] = s.number
    return map
  }, [shipments])

  /**
   * A ping link only counts while the freight is still moving, and the load row behind
   * it is rarely on this page. The parent shipment's status is the movement the link is
   * tracking and uses the same vocabulary, so it is what the rule grades the link on.
   */
  const statusByShipmentId = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of shipments) if (s.status) map[s.id] = s.status
    return map
  }, [shipments])

  const allRows = useMemo(() => collectExceptions({
    runs: exceptions.runs,
    shipments,
    // The check-call worklist is the sparse `checkCallOpen` index — exactly the loads a
    // reminder is set on, which is the half of the tracking rule a list can see from
    // here. The carrier name rides on the active assignment, not on the load.
    loads: worklist.rows.map(({ load, carrier }) => ({
      id: load.id,
      shipmentId: load.shipmentId ?? null,
      shipmentNumber: load.shipmentId ? numberByShipmentId[load.shipmentId] ?? null : null,
      status: load.status ?? null,
      carrierName: carrier?.carrierName ?? load.carrierName ?? null,
      checkCallOpen: load.checkCallOpen ?? null,
      nextCheckCallAt: load.nextCheckCallAt ?? null,
    })),
    // Every ACTIVE carrier-ping link on the board, in one filtered list rather than a
    // query per in-transit shipment. The load behind a link is usually not in `loads`
    // above (that is only the check-call worklist), so each link carries the parent
    // shipment's number and movement status for the rule to grade it on.
    trackingLinks: trackingLinks.map((link) => ({
      id: link.id,
      kind: link.kind,
      status: link.status,
      shipmentId: link.shipmentId,
      loadId: link.loadId ?? null,
      sentAt: link.sentAt ?? null,
      lastPingAt: link.lastPingAt ?? null,
      contactName: link.contactName ?? null,
      movementStatus: statusByShipmentId[link.shipmentId] ?? null,
      shipmentNumber: numberByShipmentId[link.shipmentId] ?? null,
    })),
    integrations,
    settings,
    nowIso,
  }), [exceptions.runs, shipments, worklist.rows, numberByShipmentId, statusByShipmentId, trackingLinks, integrations, settings, nowIso])

  const seededKinds = defaultFilterFor(groups)
  const activeKinds = seededKinds.filter((kind) => !droppedKinds.includes(kind))
  // The AI chip is one kind covering four agents, and a role only opens on its own
  // (A4: AR/AP on AP, customer reps on quote and tender, carrier reps on AP and
  // capacity). Narrowing only applies while the AI chip is still seeded — dropping
  // every chip widens to every row, agents included.
  const seededAgents = defaultAgentsFor(groups)

  // Three cheap passes over at most a few hundred derived rows: the chips, then the
  // counts the quick tabs show, then the tab and the search box. Memoising these would
  // cost more in dependency bookkeeping than the filters themselves.
  const kindRows = activeKinds.length === 0 ? allRows : allRows.filter((row) => (
    activeKinds.includes(row.kind) && (row.kind !== 'AI' || !row.agent || seededAgents.includes(row.agent))
  ))
  const counts = countsByIntegration(kindRows)
  const needle = search.trim().toLowerCase()
  const rows = kindRows.filter((row) => {
    if (quickTab !== 'ALL' && row.kind !== quickTab) return false
    if (!needle) return true
    return `${row.shipmentNumber ?? ''} ${row.party} ${row.integration} ${row.error}`.toLowerCase().includes(needle)
  })

  const identifyShipment = identify?.shipmentId
    ? shipments.find((s) => s.id === identify.shipmentId) ?? null
    : null

  const runAction = useCallback(async (row: ExceptionRow, label: string, work: () => Promise<unknown>) => {
    setBusyRow(row.id)
    try {
      await work()
      toast.success(label)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`)
    } finally {
      setBusyRow(null)
    }
  }, [refresh])

  const columns: ColumnDef<ExceptionRow>[] = [
    { key: 'at', header: 'TIME', width: 170, render: (row) => formatDateTime(row.at) },
    { key: 'shipment', header: 'SHIPMENT', width: 130, render: (row) => row.shipmentNumber ?? '—' },
    { key: 'party', header: 'PARTY', width: 200, render: (row) => row.party },
    { key: 'integration', header: 'INTEGRATION', width: 170, render: (row) => row.integration },
    { key: 'error', header: 'ERROR', render: (row) => row.error },
    {
      key: 'actions',
      header: 'ACTIONS',
      width: 280,
      render: (row) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {actionsFor(row).map((action) => {
            const disabled = Boolean(action.disabledReason) || busyRow === row.id
            const run = row.runId ? runsById[row.runId] : undefined

            // The three tracking moves are the shipment's Tracking tab, link and all:
            // resending a link, texting a driver and logging a check call are already
            // built there, and a second copy of those dialogs would be a second set of
            // rules about who may do them.
            if (action.key === 'RESEND_LINK' || action.key === 'TEXT_DRIVER' || action.key === 'LOG_CHECK_CALL') {
              return (
                <TmsButton
                  key={action.key}
                  size="sm"
                  disabled={!row.shipmentId}
                  onClick={() => { if (row.shipmentId) navigate(`/tms/shipments/${row.shipmentId}?tab=tracking`) }}
                >
                  {action.label}
                </TmsButton>
              )
            }

            return (
              <TmsButton
                key={action.key}
                size="sm"
                disabled={disabled}
                title={action.disabledReason}
                onClick={() => {
                  if (action.key === 'IDENTIFY_CUSTOMER') { setIdentify(row); return }
                  if (action.key === 'OPEN') { if (row.href) navigate(row.href); return }
                  if (action.key === 'RESOLVE' && row.runId) { setResolving({ runId: row.runId, reason: '' }); return }
                  if (action.key === 'RETRY' && run) {
                    void runAction(row, 'Run retried', () => retryWorkflowRun(run.id, run.version ?? 0))
                    return
                  }
                  if (action.key === 'RECHECK') {
                    const provider = providerByRowId[row.id]
                    if (provider) void runAction(row, 'Credentials re-checked', () => validateIntegration(provider))
                  }
                }}
              >
                {action.label}
              </TmsButton>
            )
          })}
        </div>
      ),
    },
  ]

  const emptyText = quickTab === 'INTEGRATION' && !integrationsVisible
    ? INTEGRATIONS_HIDDEN_TEXT
    : EMPTY_TEXT[quickTab]

  return (
    <>
      {exceptions.error ? <p className="tms-field-error">{exceptions.error}</p> : null}
      <TmsListPage<ExceptionRow>
        embedded
        title="Errors"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => {
          // An unknown customer has no record to open yet — the point of the row is to
          // give it one, so the form comes to the reader instead.
          if (row.kind === 'UNKNOWN_CUSTOMER') { setIdentify(row); return }
          if (row.href) navigate(row.href)
        }}
        onRefresh={() => void refresh()}
        search={{ value: search, onChange: setSearch, placeholder: 'Search errors' }}
        quickTabs={{
          tabs: EXCEPTION_TABS.map((tab) => ({ key: tab.key, label: tab.label, count: counts[tab.key] })),
          active: quickTab,
          onSelect: (key) => setQuickTab(key as QuickTabKey),
        }}
        filterChips={activeKinds.map((kind) => ({
          key: kind,
          label: 'Kind is',
          value: KIND_LABELS[kind],
          onClick: () => setDroppedKinds((prev) => [...prev, kind]),
        }))}
        onClearFilters={
          droppedKinds.length > 0 || search || quickTab !== 'ALL'
            ? () => { setDroppedKinds([]); setSearch(''); setQuickTab('ALL') }
            : undefined
        }
        emptyText={exceptions.loading ? 'Loading…' : emptyText}
        page={{ from: rows.length ? 1 : 0, to: rows.length, total: rows.length, pageSize: rows.length || 20 }}
      />

      {identify && identifyShipment ? (
        <IdentifyCustomerDialog
          open
          onOpenChange={(open) => { if (!open) setIdentify(null) }}
          shipment={identifyShipment}
          customers={customers}
          frozen={Boolean(identifyShipment.voidedAt)}
          onLink={async (customerId) => {
            await setShipmentCustomer({ shipmentId: identifyShipment.id, customerId })
            toast.success('Customer linked')
            await refresh()
          }}
        />
      ) : null}

      <TmsDialog
        open={resolving !== null}
        onOpenChange={(open) => { if (!open) setResolving(null) }}
        title="Resolve this error"
        description="The run stays on file with its trace; only the open-exception flag is cleared."
        footer={
          <>
            <TmsButton onClick={() => setResolving(null)}>Cancel</TmsButton>
            <TmsButton
              variant="primary"
              disabled={!resolving?.reason.trim()}
              onClick={async () => {
                if (!resolving?.reason.trim()) return
                const { runId, reason } = resolving
                setResolving(null)
                try {
                  await resolveWorkflowException(runId, reason.trim())
                  toast.success('Error resolved')
                  await refresh()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not resolve that error')
                }
              }}
            >
              Resolve
            </TmsButton>
          </>
        }
      >
        <TmsTextarea
          aria-label="Resolution reason"
          rows={3}
          placeholder="Why is this no longer a problem?"
          value={resolving?.reason ?? ''}
          onChange={(e) => setResolving((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
        />
      </TmsDialog>
    </>
  )
}

export default ErrorsTab
