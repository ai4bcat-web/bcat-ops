import {
  Clock,
  Download,
  FileDown,
  KeyRound,
  Map,
  PlusSquare,
  RefreshCw,
  Split,
  ChevronRight,
} from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'

export interface BoardFooterBarProps {
  shown: number
  total: number
  secondsToRefresh: number
  autoRefresh: boolean
  onToggleAutoRefresh: () => void
  onNext50: () => void
  onRefresh: () => void
  onExportCsv: () => void
  onShowMap: () => void
  onIconKey: () => void
  onNewTab: () => void
  onBatchTask: () => void
  onSplitScreen: () => void
  mapVisible?: boolean
  selectedCount?: number
}

/**
 * The board footer: counts, refresh countdown, and every batch action.
 *
 * The page owns the timer; this component only displays the seconds it is given.
 */
export function BoardFooterBar({
  shown,
  total,
  secondsToRefresh,
  autoRefresh,
  onToggleAutoRefresh,
  onNext50,
  onRefresh,
  onExportCsv,
  onShowMap,
  onIconKey,
  onNewTab,
  onBatchTask,
  onSplitScreen,
  mapVisible,
  selectedCount,
}: BoardFooterBarProps) {
  return (
    <footer className="tms-board-footer">
      <span className="tms-board-footer-count">
        Records shown <strong>{shown}</strong> of <strong>{total}</strong>
      </span>

      <span className="tms-board-footer-refresh">
        <Clock size={14} />
        Next refresh: {Math.max(0, secondsToRefresh)}s
        <button
          type="button"
          className={`tms-board-footer-toggle${autoRefresh ? ' tms-active' : ''}`}
          onClick={onToggleAutoRefresh}
          aria-pressed={autoRefresh}
          aria-label="Toggle auto refresh"
        >
          {autoRefresh ? 'On' : 'Off'}
        </button>
      </span>

      <TmsButton size="sm" variant="secondary" onClick={onNext50}>
        <ChevronRight size={14} />
        Get next 50
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onRefresh}>
        <RefreshCw size={14} />
        Refresh
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onExportCsv}>
        <FileDown size={14} />
        Export to CSV
      </TmsButton>

      <TmsButton size="sm" variant={mapVisible ? 'primary' : 'secondary'} onClick={onShowMap}>
        <Map size={14} />
        {mapVisible ? 'Hide map' : 'Show map'}
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onIconKey}>
        <KeyRound size={14} />
        Icon key
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onNewTab}>
        <PlusSquare size={14} />
        New tab
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onBatchTask} disabled={!selectedCount} aria-label="Batch task">
        <Download size={14} />
        Batch task
        {selectedCount ? <span className="tms-board-footer-badge">{selectedCount}</span> : null}
      </TmsButton>

      <TmsButton size="sm" variant="secondary" onClick={onSplitScreen}>
        <Split size={14} />
        Split screen
      </TmsButton>
    </footer>
  )
}

export default BoardFooterBar
