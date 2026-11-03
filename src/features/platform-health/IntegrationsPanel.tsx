/**
 * Section 1: every provider with the badge `badgeOf` gives it (never a second opinion),
 * its mode, and when it was last checked / OK / heard from. A row opens the provider
 * page; Re-check is the existing live credential check, so it only runs on a click.
 */
import { useNavigate } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsCard, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { categoryLabel, modeLabelOf } from '@/features/tms/integrations/integrationView'
import { routeForProvider } from '@/features/tms/integrations/providerRoute'
import { formatDateTime } from '@/lib/date'
import type { HealthEntry } from '@/lib/platformHealth'

export interface IntegrationsPanelProps {
  entries: HealthEntry[]
  loading: boolean
  recheckingKey: string | null
  onRecheck: (provider: string) => void
}

function when(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : 'Never'
}

export function IntegrationsPanel({ entries, loading, recheckingKey, onRecheck }: IntegrationsPanelProps) {
  const navigate = useNavigate()

  const columns: ColumnDef<HealthEntry>[] = [
    { key: 'provider', header: 'PROVIDER', width: 190, render: (e) => e.descriptor?.label ?? e.provider },
    { key: 'category', header: 'CATEGORY', width: 140, render: (e) => categoryLabel(e.descriptor?.category) },
    {
      key: 'mode',
      header: 'MODE',
      width: 140,
      render: (e) => (e.descriptor ? modeLabelOf(e.descriptor, e.row) : e.row?.mode === 'LIVE' ? 'Live' : 'Stub'),
    },
    {
      key: 'state',
      header: 'STATUS',
      width: 210,
      render: (e) => <TmsBadge tone={e.badge.tone}>{e.badge.label}</TmsBadge>,
    },
    { key: 'check', header: 'LAST CHECK', width: 170, render: (e) => when(e.row?.lastCheckAt) },
    { key: 'ok', header: 'LAST OK', width: 170, render: (e) => when(e.row?.lastOkAt) },
    {
      key: 'webhook',
      header: 'LAST WEBHOOK',
      width: 170,
      render: (e) => (e.row?.lastWebhookAt ? formatDateTime(e.row.lastWebhookAt) : '—'),
    },
    {
      key: 'action',
      header: '',
      width: 110,
      render: (e) => (e.applicable ? (
        <TmsButton
          size="sm"
          disabled={recheckingKey !== null}
          aria-label={`Re-check ${e.descriptor?.label ?? e.provider}`}
          onClick={(event) => { event.stopPropagation(); onRecheck(e.provider) }}
        >
          {recheckingKey === e.provider ? 'Checking…' : 'Re-check'}
        </TmsButton>
      ) : null),
    },
  ]

  return (
    <TmsCard title="Integrations" flush>
      <TmsTable<HealthEntry>
        columns={columns}
        rows={entries}
        rowKey={(e) => e.provider}
        onRowClick={(e) => navigate(routeForProvider(e.provider))}
        empty={loading ? 'Loading…' : 'No integrations'}
      />
    </TmsCard>
  )
}

export default IntegrationsPanel
