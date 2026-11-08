import { CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { TmsButton, TmsDialog, TmsSelect } from '@/features/tms/kit'

export interface BatchTaskAction {
  key: string
  label: string
}

export interface BatchTaskResult {
  rowId: string
  rowLabel: string
  success: boolean
  message?: string
}

export interface BatchTaskDialogProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedRows: T[]
  rowLabel: (row: T) => string
  rowKey: (row: T) => string
  actions: BatchTaskAction[]
  selectedAction: string
  onSelectAction: (key: string) => void
  onRun: () => void
  running?: boolean
  results?: BatchTaskResult[]
}

/** Runs a bulk action against the checked rows and reports per-row success/failure. */
export function BatchTaskDialog<T>({
  open,
  onOpenChange,
  selectedRows,
  rowLabel,
  rowKey,
  actions,
  selectedAction,
  onSelectAction,
  onRun,
  running,
  results,
}: BatchTaskDialogProps<T>) {
  const canRun = selectedAction && selectedRows.length > 0 && !running

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Batch task"
      description={`${selectedRows.length} row${selectedRows.length === 1 ? '' : 's'} selected`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </TmsButton>
          <TmsButton variant="primary" onClick={onRun} disabled={!canRun}>
            Run
          </TmsButton>
        </>
      }
    >
      <div className="tms-board-batch">
        <TmsSelect
          value={selectedAction}
          onChange={(e) => onSelectAction(e.target.value)}
          placeholder="Choose an action"
          options={actions.map((a) => ({ value: a.key, label: a.label }))}
        />

        {selectedRows.length > 0 && (!results || results.length === 0) ? (
          <ul className="tms-board-batch-rows">
            {selectedRows.map((row) => (
              <li key={rowKey(row)}>{rowLabel(row)}</li>
            ))}
          </ul>
        ) : null}

        {results && results.length > 0 ? (
          <div className="tms-board-batch-results">
            {results.map((r) => (
              <div key={r.rowId} className={`tms-board-batch-result${r.success ? '' : ' tms-board-batch-failed'}`}>
                {r.success ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <span className="tms-board-batch-label">{r.rowLabel}</span>
                {r.message ? <span className="tms-board-batch-message">{r.message}</span> : null}
              </div>
            ))}
          </div>
        ) : selectedRows.length === 0 ? (
          <div className="tms-board-batch-empty">
            <AlertCircle size={16} />
            Select one or more rows to run a batch task.
          </div>
        ) : null}
      </div>
    </TmsDialog>
  )
}

export default BatchTaskDialog
