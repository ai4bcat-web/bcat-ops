/**
 * Shipments › Intake: the tender e-mails that arrived at a division's intake address and became
 * partially built loads. One tab per active division (+ Unrouted), status chips, a table; a row
 * opens the review page.
 */
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsEmptyState, TmsPage, TmsSegmentedTabs, TmsTable, TmsTabs } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { flattenDivisions } from '@/features/tms/settings/taxonomyDrafts'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { formatDateTime } from '@/lib/date'
import { intakeCounts } from '@/lib/intakeLoad'
import type { IntakeLoadRecord, IntakeStatus } from '@/types/intake'
import { ShipmentsSectionTabs } from '../ShipmentsSectionTabs'
import { useIntakeLoads } from './useIntakeLoads'
import { useIntakePermissions } from './useIntakePermissions'
import './intake.css'

const UNROUTED = 'unrouted'

type StatusChip = 'open' | 'moved' | 'dismissed'
const CHIP_STATUS: Record<StatusChip, IntakeStatus> = { open: 'OPEN', moved: 'MOVED', dismissed: 'DISMISSED' }

function cityState(stop: { city: string | null; state: string | null } | undefined): string {
  if (!stop) return '—'
  const parts = [stop.city, stop.state].filter(Boolean)
  return parts.length ? parts.join(', ') : '—'
}

function route(row: IntakeLoadRecord): string {
  const stops = row.fields.stops
  const pickup = stops.find((s) => s.type === 'pickup')
  const delivery = [...stops].reverse().find((s) => s.type === 'delivery')
  return `${cityState(pickup)} → ${cityState(delivery)}`
}

function completeness(row: IntakeLoadRecord): string {
  const { required, missing, toCheck } = intakeCounts(row)
  const base = `${required - missing} of ${required} required`
  return toCheck > 0 ? `${base} · ${toCheck} to check` : base
}

export function IntakeBoard() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { divisions } = useOwnershipDivisions()
  const { isOwnerOrAdmin } = useIntakePermissions()

  const chip: StatusChip = params.get('status') === 'moved' ? 'moved' : params.get('status') === 'dismissed' ? 'dismissed' : 'open'
  const open = useIntakeLoads({ status: 'OPEN' })
  const other = useIntakeLoads({ status: CHIP_STATUS[chip], enabled: chip !== 'open' })
  const shown = chip === 'open' ? open : other

  const activeDivisions = useMemo(
    () => flattenDivisions(divisions ?? []).filter((r) => r.division.active).map((r) => r.division),
    [divisions],
  )
  const activeCodes = useMemo(() => new Set(activeDivisions.map((d) => d.code)), [activeDivisions])
  const isUnrouted = (row: IntakeLoadRecord) => row.divisionCode == null || !activeCodes.has(row.divisionCode)

  const openCounts = useMemo(() => {
    const counts: Record<string, number> = { [UNROUTED]: 0 }
    for (const d of activeDivisions) counts[d.code] = 0
    for (const row of open.rows) {
      if (row.divisionCode != null && activeCodes.has(row.divisionCode)) counts[row.divisionCode] += 1
      else counts[UNROUTED] += 1
    }
    return counts
  }, [open.rows, activeDivisions, activeCodes])

  const unroutedShown = isOwnerOrAdmin || openCounts[UNROUTED] > 0 || (chip !== 'open' && other.rows.some(isUnrouted))
  const tabs = [
    ...activeDivisions.map((d) => ({ key: d.code, label: d.name, count: openCounts[d.code] })),
    ...(unroutedShown ? [{ key: UNROUTED, label: 'Unrouted', count: openCounts[UNROUTED] }] : []),
  ]

  const requested = params.get('division')
  const selected = tabs.some((t) => t.key === requested)
    ? (requested as string)
    : (tabs.find((t) => (t.count ?? 0) > 0) ?? tabs[0])?.key

  const division = activeDivisions.find((d) => d.code === selected)
  const rows = shown.rows.filter((r) => (selected === UNROUTED ? isUnrouted(r) : r.divisionCode === selected))
  const missingAddress = activeDivisions.filter((d) => !d.intakeEmail)

  function update(next: Record<string, string | null>) {
    const copy = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v == null) copy.delete(k)
      else copy.set(k, v)
    }
    setParams(copy, { replace: true })
  }

  const columns: Array<ColumnDef<IntakeLoadRecord>> = [
    { key: 'received', header: 'Received', render: (r) => formatDateTime(r.receivedAt) },
    {
      key: 'from',
      header: 'From / Subject',
      render: (r) => (
        <div className="tms-intake-from">
          <span className="tms-intake-from-name">{r.fromName || r.fromEmail}</span>
          <span className="tms-intake-from-subject">{r.subject || '(no subject)'}</span>
        </div>
      ),
    },
    { key: 'customer', header: 'Customer', render: (r) => r.fields.customerName ?? '—' },
    { key: 'reference', header: 'Reference', render: (r) => r.fields.reference ?? '—' },
    { key: 'route', header: 'Pickup → Delivery', render: route },
    { key: 'completeness', header: 'Completeness', render: (r) => <span className="tms-intake-completeness">{completeness(r)}</span> },
    {
      key: 'review',
      header: 'Review',
      render: (r) => {
        if (r.reviewedAt && r.reviewedBy) return <TmsBadge tone="green">Reviewed</TmsBadge>
        return r.status === 'OPEN' ? <TmsBadge tone="orange">Needs review</TmsBadge> : '—'
      },
    },
    {
      key: 'source',
      header: 'E-mail',
      render: (r) => (
        <Link
          className="tms-intake-source-link"
          to={`/tms/workflows/runs/${r.runId}`}
          aria-label="Open the source e-mail run"
          onClick={(e) => e.stopPropagation()}
        >
          <Mail size={14} aria-hidden="true" />
        </Link>
      ),
    },
  ]

  const noAddress = division != null && !division.intakeEmail
  const emptyBody = noAddress ? (
    <TmsEmptyState
      compact
      title={`No intake e-mail set for ${division.name}`}
      message={
        isOwnerOrAdmin ? (
          <Link to="/tms/brokerage/divisions">Set one under Divisions &amp; ownership</Link>
        ) : (
          'Ask an owner to set the address tender e-mails for this division arrive at.'
        )
      }
    />
  ) : (
    <TmsEmptyState compact title="No tender e-mails waiting." message={chip === 'open' ? null : `Nothing ${chip} here.`} />
  )

  return (
    <TmsPage title="Shipments">
      <ShipmentsSectionTabs current="intake" />
      {isOwnerOrAdmin && missingAddress.length > 0 ? (
        <TmsAlert tone="orange" title="Divisions without an intake e-mail" className="tms-intake-banner">
          {missingAddress.map((d) => d.name).join(', ')} cannot receive tender e-mails yet.{' '}
          <Link to="/tms/brokerage/divisions">Open Divisions</Link>
        </TmsAlert>
      ) : null}
      {shown.error ? <TmsAlert tone="red" title="Could not load intake">{shown.error}</TmsAlert> : null}
      {tabs.length > 0 ? (
        <TmsTabs
          className="tms-intake-tabs"
          tabs={tabs}
          active={selected ?? ''}
          onSelect={(key) => update({ division: key })}
        />
      ) : null}
      <TmsSegmentedTabs
        className="tms-intake-chips"
        size="sm"
        aria-label="Intake status"
        active={chip}
        onSelect={(key) => update({ status: key === 'open' ? null : key })}
        tabs={[
          { key: 'open', label: 'Open' },
          { key: 'moved', label: 'Moved' },
          { key: 'dismissed', label: 'Dismissed' },
        ]}
      />
      <TmsTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/tms/shipments/intake/${encodeURIComponent(r.id)}`)}
        empty={shown.loading ? <TmsBadge tone="gray">Loading…</TmsBadge> : emptyBody}
      />
    </TmsPage>
  )
}

export default IntakeBoard
