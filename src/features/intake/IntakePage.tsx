import { useState, useMemo } from 'react'
import { RefreshCw, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { IntakeCard } from './IntakeCard'
import { IntakeDetail } from './IntakeDetail'
import { cn } from '@/lib/utils'
import type { IntakeItem } from '@/types'

// Which tab a user defaults to based on their assignment
const DEFAULT_TAB: Record<string, 'ivan' | 'bcat'> = {
  'dennis@bcatcorp.com': 'ivan',
  'arcie@bcatcorp.com':  'bcat',
}

type TabId = 'ivan' | 'bcat'

const TABS: { id: TabId; label: string; source: string; assignedTo: string }[] = [
  { id: 'ivan', label: 'Ivan Cartage',   source: 'IVAN_CARTAGE',   assignedTo: 'dennis@bcatcorp.com' },
  { id: 'bcat', label: 'BCAT Logistics', source: 'BCAT_LOGISTICS', assignedTo: 'arcie@bcatcorp.com'  },
]

const STATUS_ORDER = { NEW: 0, IN_PROGRESS: 1, BUILT: 2, ARCHIVED: 3 }

export function IntakePage() {
  const { user } = useAuth()

  const defaultTab = DEFAULT_TAB[user?.email ?? ''] ?? 'ivan'
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Load ALL intake items — filter client-side so switching tabs is instant
  const { items, loading, refresh, updateItem } = useIntakeItems()

  const tab = TABS.find((t) => t.id === activeTab)!

  const visibleItems = useMemo(() => {
    return items
      .filter((i) => i.source === tab.source && i.status !== 'ARCHIVED')
      .sort((a, b) => {
        const sd = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (sd !== 0) return sd
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      })
  }, [items, tab.source])

  const archivedItems = useMemo(() =>
    items.filter((i) => i.source === tab.source && i.status === 'ARCHIVED'),
    [items, tab.source],
  )

  const selectedItem: IntakeItem | undefined = items.find((i) => i.id === selectedId)

  const counts: Record<TabId, number> = {
    ivan: items.filter((i) => i.source === 'IVAN_CARTAGE'   && i.status !== 'ARCHIVED').length,
    bcat: items.filter((i) => i.source === 'BCAT_LOGISTICS' && i.status !== 'ARCHIVED').length,
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-4 border-b border-slate-200 bg-white shrink-0">
        <h1 className="text-xl font-semibold text-foreground tracking-tight">Load Intake</h1>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white shrink-0 px-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setActiveTab(t.id); setSelectedId(null) }}
            className={cn(
              'px-5 py-3 text-sm font-medium border-b-2 transition-colors relative',
              activeTab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {counts[t.id] > 0 && (
              <span className={cn(
                'ml-2 inline-flex items-center justify-center text-[10px] font-bold rounded-full px-1.5 min-w-[18px] h-[18px]',
                activeTab === t.id ? 'bg-primary text-primary-foreground' : 'bg-slate-200 text-slate-600',
              )}>
                {counts[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Split panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: queue list */}
        <div className="w-[320px] shrink-0 border-r border-slate-200 overflow-y-auto">
          {loading && visibleItems.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
              <RefreshCw className="size-4 animate-spin" /> Loading…
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <Inbox className="size-8 opacity-20" />
              <p className="text-sm">No items in queue</p>
            </div>
          ) : (
            visibleItems.map((item) => (
              <IntakeCard
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
              />
            ))
          )}

          {/* Archived section */}
          {archivedItems.length > 0 && (
            <details className="group">
              <summary className="px-4 py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground list-none flex items-center gap-1">
                Archived ({archivedItems.length})
              </summary>
              {archivedItems.map((item) => (
                <IntakeCard
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                />
              ))}
            </details>
          )}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 overflow-hidden">
          {selectedItem ? (
            <IntakeDetail
              key={selectedItem.id}
              item={selectedItem}
              onUpdate={updateItem}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <Inbox className="size-10 opacity-15" />
              <p className="text-sm">Select an item to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
