import { ChevronLeft, ChevronRight, Plus, X, CheckCircle2, HelpCircle, SplitSquareHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'compact',  label: 'List'     },
  { value: 'planner',  label: 'Planner'  },
  { value: 'day',      label: 'Day'      },
  { value: 'week',     label: 'Week'     },
  { value: 'two-week', label: '2 Weeks'  },
  { value: 'month',    label: 'Month'    },
]

const FILTER_CHIPS = [
  {
    key: 'readyToInvoice' as const,
    label: 'Ready to Invoice',
    Icon: CheckCircle2,
    active:   'bg-emerald-50 border-emerald-300 text-emerald-700',
    inactive: 'border-slate-300 text-slate-600 bg-white hover:bg-slate-50',
  },
  {
    key: 'split' as const,
    label: 'Split Assignment',
    Icon: SplitSquareHorizontal,
    active:   'bg-violet-50 border-violet-300 text-violet-700',
    inactive: 'border-slate-300 text-slate-600 bg-white hover:bg-slate-50',
  },
  {
    key: 'unassigned' as const,
    label: 'Unassigned',
    Icon: HelpCircle,
    active:   'bg-amber-50 border-amber-300 text-amber-700',
    inactive: 'border-slate-300 text-slate-600 bg-white hover:bg-slate-50',
  },
] as const

export function CalendarToolbar({
  currentView, dateLabel, onPrev, onNext, onToday, onViewChange,
}: CalendarToolbarProps) {
  const searchQuery     = useAppStore((s) => s.searchQuery)
  const filters         = useAppStore((s) => s.filters)
  const setSearchQuery  = useAppStore((s) => s.setSearchQuery)
  const toggleFilter    = useAppStore((s) => s.toggleFilter)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  return (
    <div className="flex items-center h-16 px-8 border-b border-slate-200 bg-white shrink-0 gap-3">

      {/* ── Date navigation ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={onPrev} aria-label="Previous period">
              <ChevronLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Previous</TooltipContent>
        </Tooltip>

        <Button variant="outline" size="sm" className="h-9 px-3 font-medium" onClick={onToday}>
          Today
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={onNext} aria-label="Next period">
              <ChevronRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Next</TooltipContent>
        </Tooltip>
      </div>

      {/* Date label */}
      <span className="text-sm font-semibold text-foreground shrink-0 tabular-nums min-w-[160px]" aria-live="polite">
        {dateLabel}
      </span>

      <Separator orientation="vertical" className="h-8 mx-3 shrink-0" />

      {/* ── View switcher ────────────────────────────────────────────────── */}
      <ToggleGroup
        type="single"
        value={currentView}
        onValueChange={(v) => v && onViewChange(v as ViewMode)}
        className="shrink-0 rounded-lg border border-slate-200 bg-white p-1 gap-1"
      >
        {VIEW_OPTIONS.map(({ value, label }) => (
          <ToggleGroupItem
            key={value}
            value={value}
            aria-label={`${label} view`}
            className="h-8 px-3 text-sm font-medium rounded-md"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Separator orientation="vertical" className="h-8 mx-3 shrink-0" />

      {/* ── Filter chips ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-1 overflow-x-auto min-w-0">
        {FILTER_CHIPS.map(({ key, label, Icon, active, inactive }) => (
          <button
            key={key}
            onClick={() => toggleFilter(key)}
            aria-pressed={filters[key]}
            className={cn(
              'h-10 pl-5 text-sm font-medium rounded-full border transition-all whitespace-nowrap flex items-center gap-2 shrink-0',
              filters[key] ? `${active} pr-3` : `${inactive} pr-5`,
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {label}
            {filters[key] && (
              <span
                className="ml-0.5 flex items-center justify-center size-5 rounded-full bg-black/10 hover:bg-black/20 transition-colors"
                onClick={(e) => { e.stopPropagation(); toggleFilter(key) }}
              >
                <X className="size-3" />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Search ───────────────────────────────────────────────────────── */}
      <div className="relative w-72 shrink-0">
        <input
          type="text"
          placeholder="Search by ALJEX, TMS, or PU#"
          className="h-10 w-full pl-3 pr-4 rounded-lg border border-slate-300 bg-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-shadow"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => setSearchQuery('')}
          aria-label="Search loads"
        />
        {searchQuery && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* ── New Load ─────────────────────────────────────────────────────── */}
      <Button
        className="h-10 px-6 gap-2 font-medium shrink-0 whitespace-nowrap"
        onClick={() => setSelectedLoad(null, 'create')}
      >
        <Plus className="size-4" />
        New Load
      </Button>
    </div>
  )
}
