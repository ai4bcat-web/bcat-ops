import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye } from 'lucide-react'
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { TmsDrawer } from '@/features/tms/kit/TmsDrawer'
import { TmsListPage } from '@/features/tms/kit/TmsListPage'
import { TmsSegmentedTabs } from '@/features/tms/kit/TmsSegmentedTabs'
import { TmsStatRow } from '@/features/tms/kit/TmsStatRow'
import type { ColumnDef } from '@/features/tms/kit/TmsTable'
import { expiringQueue, filterRows, relativeDays, sortForReview, tabCounts } from '@/lib/complianceOverview'
import type { OverviewEntityFilter, OverviewRow, OverviewTab } from '@/lib/complianceOverview'
import { DocumentDetail } from './DocumentDetail'
import { ExpiringQueue } from './ExpiringQueue'
import { SOURCE_LABELS, STATE_LABELS, STATE_TONES } from './labels'
import { useComplianceOverview } from './useComplianceOverview'

const TABS: OverviewTab[] = ['all', 'review', 'expiring', 'expired']
const TAB_LABELS: Record<OverviewTab, string> = { all: 'All', review: 'Needs review', expiring: 'Expiring soon', expired: 'Expired' }
const ENTITY_TABS: Array<{ key: OverviewEntityFilter; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'DRIVER', label: 'Drivers' }, { key: 'TRUCK', label: 'Trucks' }, { key: 'CARRIER', label: 'Carriers' },
]
const ENTITY_NAMES = { DRIVER: 'Driver', TRUCK: 'Truck', CARRIER: 'Carrier' } as const

/** Compliance → Document overview: every dated or reviewable document in one list. */
export function ComplianceOverviewPage() {
  const o = useComplianceOverview()
  const [params, setParams] = useSearchParams()
  const [entity, setEntity] = useState<OverviewEntityFilter>('all')
  const [query, setQuery] = useState('')

  const tabParam = params.get('tab')
  const tab: OverviewTab = TABS.includes(tabParam as OverviewTab) ? (tabParam as OverviewTab) : 'all'
  const docKey = params.get('doc')

  const setParam = useCallback((name: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value); else next.delete(name)
      return next
    }, { replace: true })
  }, [setParams])

  const sorted = useMemo(() => sortForReview(o.rows), [o.rows])
  const counts = useMemo(() => tabCounts(sorted), [sorted])
  const visible = useMemo(() => filterRows(sorted, { tab, entity, query }), [sorted, tab, entity, query])
  const queue = useMemo(() => expiringQueue(sorted), [sorted])
  const selected = docKey ? sorted.find((r) => r.key === docKey) ?? null : null

  const open = (row: OverviewRow) => setParam('doc', row.key)

  const columns: Array<ColumnDef<OverviewRow>> = [
    {
      key: 'entity', header: 'Entity',
      render: (r) => (<><strong>{r.entityName}</strong> <TmsBadge tone="gray">{ENTITY_NAMES[r.entityType]}</TmsBadge></>),
    },
    { key: 'doc', header: 'Document', render: (r) => r.title },
    {
      key: 'expiry', header: 'Expiry',
      render: (r) => (r.expiry ? <>{r.expiry} <span className="tms-meta-empty">{relativeDays(r.daysLeft)}</span></> : '—'),
    },
    { key: 'source', header: 'Source', render: (r) => SOURCE_LABELS[r.source] },
    { key: 'status', header: 'Status', render: (r) => <TmsBadge tone={STATE_TONES[r.state]}>{STATE_LABELS[r.state]}</TmsBadge> },
    { key: 'view', header: '', width: 48, render: () => <Eye size={16} aria-hidden="true" /> },
  ]

  const banner = (
    <div style={{ display: 'grid', gap: 'var(--tms-gap)' }}>
      {o.error ? <TmsAlert tone="red" title="Driver and truck documents failed to load">{o.error}</TmsAlert> : null}
      {o.carrierError ? <TmsAlert tone="red" title="Carrier documents failed to load">{o.carrierError} Carrier rows may be missing below.</TmsAlert> : null}
      <TmsStatRow
        columns={4}
        aria-label="Document summary"
        items={[
          { key: 'total', label: 'Documents on file', value: String(o.counts.total), sub: `drivers ${o.counts.drivers} · trucks ${o.counts.trucks} · carriers ${o.counts.carriers}` },
          { key: 'review', label: 'Needs review', value: String(o.counts.needsReview), tone: 'warn' },
          { key: 'expiring', label: 'Expiring ≤ 30 d', value: String(o.counts.expiring), tone: 'warn' },
          { key: 'expired', label: 'Expired', value: String(o.counts.expired), tone: 'bad' },
        ]}
      />
      <TmsSegmentedTabs
        aria-label="Entity"
        tabs={ENTITY_TABS}
        active={entity}
        onSelect={(k) => setEntity(k as OverviewEntityFilter)}
        size="sm"
      />
      <ExpiringQueue rows={queue} onOpen={open} />
    </div>
  )

  return (
    <>
      <TmsListPage
        title="Document overview"
        quickTabs={{
          tabs: TABS.map((k) => ({ key: k, label: TAB_LABELS[k], count: counts[k] })),
          active: tab,
          onSelect: (k) => setParam('tab', k === 'all' ? null : k),
        }}
        search={{ value: query, onChange: setQuery, placeholder: 'Search documents' }}
        onRefresh={o.refresh}
        banner={banner}
        columns={columns}
        rows={visible}
        rowKey={(r) => r.key}
        onRowClick={open}
        emptyText={o.loading ? 'Loading documents…' : 'No documents match.'}
      />
      <TmsDrawer
        open={!!selected}
        onOpenChange={(isOpen) => { if (!isOpen) setParam('doc', null) }}
        title={selected?.title ?? 'Document'}
        description={selected?.entityName}
        size="xl"
      >
        {selected ? (
          <DocumentDetail
            row={selected}
            canAct={o.canActOn(selected)}
            getUrl={o.urlFor}
            onApprove={o.approve}
            onReject={o.reject}
          />
        ) : null}
      </TmsDrawer>
    </>
  )
}

export default ComplianceOverviewPage
