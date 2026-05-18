import { ChevronLeft, ChevronRight, Search, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/useAppStore'
import type { ViewMode } from '@/types'
import { cn } from '@/lib/utils'

interface CalendarToolbarProps {
  currentView: ViewMode
  dateLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  onViewChange: (view: ViewMode) => void
}

const VIEW_LABELS: Record<ViewMode, string> = {
  'day':       'Day',
  'work-week': 'Work Wk',
  'full-week': 'Full Wk',
  'two-week':  '2 Wks',
  'month':     'Month',
}

const VIEW_ORDER: ViewMode[] = ['day', 'work-week', 'full-week', 'two-week', 'month']

const FILTER_CHIPS = [
  {
    key: 'readyToInvoice', label: 'RTI',
    active:   'bg-emerald-50 border-emerald-300 text-emerald-700',
    inactive: 'border-slate-200 text-slate-500 hover:border-emerald-200 hover:text-emerald-600 hover:bg-emerald-50/50',
  },
  {
    key: 'split', label: 'Split',
    active:   'bg-violet-50 border-violet-300 text-violet-700',
    inactive: 'border-slate-200 text-slate-500 hover:border-violet-200 hover:text-violet-600 hover:bg-violet-50/50',
  },
  {
    key: 'unassigned', label: 'Unassigned',
    active:   'bg-amber-50 border-amber-300 text-amber-700',
    inactive: 'border-slate-200 text-slate-500 hover:border-amber-200 hover:text-amber-600 hover:bg-amber-50/50',
  },
] as const

export function CalendarToolbar({
  currentView, dateLabel, onPrev, onNext, onToday, onViewChange,
}: CalendarToolbarProps) {
  const searchQuery    = useAppStore((s) => s.searchQuery)
  const filters        = useAppStore((s) => s.filters)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const toggleFilter   = useAppStore((s) => s.toggleFilter)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const anyFilter = Object.values(filters).some(Boolean) || searchQuery.length > 0

  return (
    <div className="flex items-center border-b border-border bg-background shrink-0 min-h-[64px]">

      {/* ── Scrollable left section ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 flex-1 overflow-x-auto min-w-0 py-2">

        {/* Date navigation */}
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={onPrev}
                aria-label="Previous period"
              >
                <ChevronLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous</TooltipContent>
          </Tooltip>

          <Button
            variant="outline"
            size="sm"
            className="h-9 px-3 text-sm font-medium shrink-0"
            onClick={onToday}
          >
            Today
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={onNext}
                aria-label="Next period"
              >
                <ChevronRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next</TooltipContent>
          </Tooltip>
        </div>

        {/* Date label */}
        <span
          className="text-sm font-semibold text-foreground shrink-0 tabular-nums min-w-[140px]"
          aria-live="polite"
        >
          {dateLabel}
        </span>

        <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

        {/* View switcher */}
        <ToggleGroup
          type="single"
          value={currentView}
          onValueChange={(v) => v && onViewChange(v as ViewMode)}
          className="shrink-0"
        >
          {VIEW_ORDER.map((view) => (
            <ToggleGroupItem key={view} value={view} aria-label={`${VIEW_LABELS[view]} view`}>
              {VIEW_LABELS[view]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <Separator orientation="vertical" className="h-5 mx-1 shrink-0" />

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 shrink-0">
          {anyFilter && (
            <button
              aria-label="Clear all filters"
              onClick={() => {
                setSearchQuery('')
                FILTER_CHIPS.forEach(({ key }) => { if (filters[key]) toggleFilter(key) })
              }}
              className="h-6 px-2 text-[11px] font-medium text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors"
            >
              <X className="size-3" /> Clear
            </button>
          )}
          {FILTER_CHIPS.map(({ key, label, active, inactive }) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              aria-pressed={filters[key]}
              className={cn(
                'h-6 px-2.5 text-[11px] font-semibold rounded-full border transition-all whitespace-nowrap',
                filters[key] ? active : inactive,
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Fixed right section — always visible ─────────────────────────── */}
      <div className="flex items-center gap-2 px-4 shrink-0 border-l border-border py-2">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search loads…"
            className="h-9 pl-8 w-56 text-sm"
            style={{ background: '#ffffff' }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search loads"
          />
          {searchQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <Button
          size="lg"
          className="gap-1.5 font-semibold whitespace-nowrap"
          onClick={() => setSelectedLoad(null, 'create')}
        >
          <Plus className="size-4" />
          New Load
        </Button>
      </div>
    </div>
  )
}
