/**
 * Every integration the brokerage can hold, in one list.
 *
 * The rows are the registry, not the database: a provider nobody has touched is still
 * a row here, with the credentials it is waiting for spelled out. The database only
 * supplies state — the badge, the mode, the last check — so adding a provider is
 * adding a descriptor and nothing on this page changes.
 *
 * `BrokeragePage` owns the h1, so this is an embedded list with no title row.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy } from 'lucide-react'
import { TmsBadge, TmsButton, TmsListPage } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { useIntegrations } from '@/hooks/useIntegrations'
import { badgeOf } from '@/lib/integrations/health'
import { CATEGORIES, PROVIDERS } from '@/lib/integrations/registry'
import type { IntegrationBadge, IntegrationRecord, ProviderDescriptor } from '@/lib/integrations/types'
import { formatDateTime } from '@/lib/date'
import { MODE_LABELS, SOURCE_LABELS, categoryLabel, missingFor, modeLabelOf } from './integrationView'
import type { ModeLabel } from './integrationView'
import { routeForProvider } from './providerRoute'

interface IndexRow {
  descriptor: ProviderDescriptor
  row?: IntegrationRecord
  badge: IntegrationBadge
  mode: ModeLabel
  missing: string[]
}

/** A provider nobody has connected yet still has a state: the badge says which. */
const UNSEEN: Pick<IntegrationRecord, 'status' | 'health' | 'mode'> = {
  status: 'NOT_CONNECTED',
  health: 'UNKNOWN',
  mode: 'STUB',
}

/**
 * The filter values are the badge's own labels, and a row is classified by calling
 * `badgeOf` — a second opinion about what "connected" means is how a filter ends up
 * listing a row whose badge says the opposite.
 */
const STATE_FILTERS = [
  'Connected',
  'Not connected',
  'Not checked',
  'Invalid credentials',
  'Unable to verify',
  'Live on main · neutered on dev',
  'Not applicable',
  'Disconnected',
] as const
type StateFilter = (typeof STATE_FILTERS)[number]

/** Click a chip to step through its values; the empty step is "no filter". */
function cycle<T>(values: readonly T[], current: T | null): T | null {
  if (current === null) return values[0] ?? null
  const next = values.indexOf(current) + 1
  return next >= values.length ? null : values[next]
}

export function IntegrationsIndex() {
  const navigate = useNavigate()
  const { byKey, loading, error, refresh } = useIntegrations()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [state, setState] = useState<StateFilter | null>(null)
  const [mode, setMode] = useState<ModeLabel | null>(null)
  const [copied, setCopied] = useState(false)

  const all = useMemo<IndexRow[]>(
    () => PROVIDERS.map((descriptor) => {
      const row = byKey[descriptor.key]
      return {
        descriptor,
        row,
        badge: badgeOf({ ...UNSEEN, ...row, applicability: descriptor.applicability }),
        mode: modeLabelOf(descriptor, row),
        missing: missingFor(descriptor, row),
      }
    }),
    [byKey],
  )

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const entry of all) map[entry.descriptor.category] = (map[entry.descriptor.category] ?? 0) + 1
    return map
  }, [all])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return all.filter((entry) => {
      if (category !== 'all' && entry.descriptor.category !== category) return false
      if (state && entry.badge.label !== state) return false
      if (mode && entry.mode !== mode) return false
      if (!needle) return true
      const hay = `${entry.descriptor.label} ${entry.descriptor.key} ${categoryLabel(entry.descriptor.category)} ${entry.descriptor.feeds}`
      return hay.toLowerCase().includes(needle)
    })
  }, [all, category, state, mode, search])

  // The same list the build log carries: what Ryne still has to supply before a
  // provider can be anything but a stub. PAGE credentials are entered on the page;
  // STACK ones are `npx ampx secret set` in the Amplify console.
  const waiting = useMemo(
    () => all.filter((entry) => entry.missing.length > 0 && (entry.descriptor.credentialSource === 'PAGE' || entry.descriptor.credentialSource === 'STACK')),
    [all],
  )
  const waitingText = waiting
    .map((entry) => `${entry.descriptor.label} (${entry.descriptor.key}): ${entry.missing.join(', ')}`)
    .join('\n')

  const columns: ColumnDef<IndexRow>[] = [
    { key: 'provider', header: 'PROVIDER', width: 200, render: (entry) => entry.descriptor.label },
    { key: 'category', header: 'CATEGORY', width: 150, render: (entry) => categoryLabel(entry.descriptor.category) },
    {
      key: 'state',
      header: 'STATE',
      width: 150,
      render: (entry) => <TmsBadge tone={entry.badge.tone}>{entry.badge.label}</TmsBadge>,
    },
    { key: 'mode', header: 'MODE', width: 130, render: (entry) => entry.mode },
    {
      key: 'source',
      header: 'SOURCE',
      width: 130,
      render: (entry) => SOURCE_LABELS[entry.descriptor.credentialSource] ?? entry.descriptor.credentialSource,
    },
    {
      key: 'lastCheck',
      header: 'LAST CHECK',
      width: 170,
      render: (entry) => (entry.row?.lastCheckAt ? formatDateTime(entry.row.lastCheckAt) : 'Never'),
    },
    {
      key: 'missing',
      header: 'MISSING CREDENTIALS',
      render: (entry) => (entry.missing.length ? entry.missing.join(', ') : '—'),
    },
  ]

  return (
    <>
      {error ? <p className="tms-field-error">{error}</p> : null}
      <TmsListPage<IndexRow>
        embedded
        title="Integrations"
        columns={columns}
        rows={rows}
        rowKey={(entry) => entry.descriptor.key}
        onRowClick={(entry) => navigate(routeForProvider(entry.descriptor.key))}
        onRefresh={() => void refresh()}
        search={{ value: search, onChange: setSearch, placeholder: 'Search providers' }}
        quickTabs={{
          tabs: [
            { key: 'all', label: 'All', count: all.length },
            ...CATEGORIES.filter((c) => counts[c.key]).map((c) => ({ key: c.key, label: c.label, count: counts[c.key] })),
          ],
          active: category,
          onSelect: setCategory,
        }}
        filterChips={[
          { key: 'state', label: 'State is', value: state, onClick: () => setState(cycle(STATE_FILTERS, state)) },
          { key: 'mode', label: 'Mode is', value: mode, onClick: () => setMode(cycle(MODE_LABELS, mode)) },
        ]}
        onClearFilters={
          state || mode || search || category !== 'all'
            ? () => { setState(null); setMode(null); setSearch(''); setCategory('all') }
            : undefined
        }
        emptyText={loading ? 'Loading…' : 'No provider matches these filters'}
        page={{ from: rows.length ? 1 : 0, to: rows.length, total: rows.length, pageSize: rows.length || 20 }}
        banner={
          waiting.length ? (
            <div className="tms-card">
              <div className="tms-card-head">
                <h3>Missing credentials</h3>
                <div className="tms-card-actions">
                  <TmsButton
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(waitingText)
                      setCopied(true)
                    }}
                  >
                    <Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy list'}
                  </TmsButton>
                </div>
              </div>
              <div className="tms-card-body">
                <p className="tms-muted">
                  {waiting.length} provider{waiting.length === 1 ? '' : 's'} cannot leave stub mode until these arrive.
                </p>
                <ul>
                  {waiting.map((entry) => (
                    <li key={entry.descriptor.key}>
                      <strong>{entry.descriptor.label}</strong> — {entry.missing.join(', ')}
                      {entry.descriptor.credentialSource === 'STACK' ? ' (npx ampx secret set)' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null
        }
      />
    </>
  )
}

export default IntegrationsIndex
