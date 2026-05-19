import { useState, useMemo } from 'react'
import { RefreshCw, Inbox, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntakeItems } from '@/hooks/useIntakeItems'
import { IntakeCard } from './IntakeCard'
import { IntakeDetail } from './IntakeDetail'
import { cn } from '@/lib/utils'
import type { IntakeItem } from '@/types'

const FOLDERS = [
  { label: 'Ivan Cartage',   source: 'IVAN_CARTAGE'   },
  { label: 'BCAT Logistics', source: 'BCAT_LOGISTICS'  },
] as const

const STATUS_ORDER = { NEED_TO_BUILD: 0, BUILT: 1 }

function FolderSection({
  label,
  source,
  items,
  selectedId,
  onSelect,
}: {
  label: string
  source: string
  items: IntakeItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const folderItems = useMemo(() =>
    items
      .filter((i) => i.source === source)
      .sort((a, b) => {
        const sd = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (sd !== 0) return sd
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      }),
    [items, source],
  )

  const unbuilt = folderItems.filter((i) => i.status !== 'BUILT').length

  return (
    <details open className="group/folder">
      <summary className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-200 cursor-pointer select-none list-none sticky top-0 z-10">
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/folder:rotate-0 -rotate-90" />
        <span className="text-xs font-semibold text-foreground flex-1">{label}</span>
        {unbuilt > 0 && (
          <span className="text-[10px] font-bold bg-primary text-primary-foreground rounded-full px-1.5 min-w-[18px] h-[18px] flex items-center justify-center">
            {unbuilt}
          </span>
        )}
      </summary>

      {folderItems.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-xs gap-1.5">
          <Inbox className="size-4 opacity-30" /> Empty
        </div>
      ) : (
        folderItems.map((item) => (
          <IntakeCard
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onClick={() => onSelect(item.id)}
          />
        ))
      )}
    </details>
  )
}

export function IntakePage() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { items, loading, refresh, updateItem, deleteItem } = useIntakeItems()

  const selectedItem: IntakeItem | undefined = items.find((i) => i.id === selectedId)

  const handleSelect = (id: string) => setSelectedId((prev) => (prev === id ? null : id))

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

      {/* Split panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: folder list */}
        <div className="w-[320px] shrink-0 border-r border-slate-200 overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
              <RefreshCw className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            FOLDERS.map((f) => (
              <FolderSection
                key={f.source}
                label={f.label}
                source={f.source}
                items={items}
                selectedId={selectedId}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>

        {/* Right: detail panel */}
        <div className="flex-1 overflow-hidden">
          {selectedItem ? (
            <IntakeDetail
              key={selectedItem.id}
              item={selectedItem}
              onUpdate={updateItem}
              onDelete={async (id) => { await deleteItem(id); setSelectedId(null) }}
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
