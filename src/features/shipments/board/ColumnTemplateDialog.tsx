import { useState } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { TmsButton, TmsDialog, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { BoardCheckbox } from './parts'

export interface BoardColumnItem {
  key: string
  header: string
  selected: boolean
}

export interface ColumnTemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  name: string
  onNameChange: (name: string) => void
  columns: BoardColumnItem[]
  onToggleColumn: (key: string) => void
  onMoveColumn: (key: string, direction: 'up' | 'down') => void
  shared: boolean
  onSharedChange: (shared: boolean) => void
  canDelete: boolean
  onDelete: () => void
  onSave: () => void
}

/** Create or update a saved column template, with drag-free reordering. */
export function ColumnTemplateDialog({
  open,
  onOpenChange,
  mode,
  name,
  onNameChange,
  columns,
  onToggleColumn,
  onMoveColumn,
  shared,
  onSharedChange,
  canDelete,
  onDelete,
  onSave,
}: ColumnTemplateDialogProps) {
  const [confirming, setConfirming] = useState(false)
  const selectedColumns = columns.filter((c) => c.selected)

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'Create column template' : 'Update column template'}
      className="tms-dialog-wide"
      footer={
        <>
          {canDelete ? (
            confirming ? (
              <div className="tms-board-confirm">
                <span>Delete this template?</span>
                <TmsButton size="sm" variant="destructive" onClick={onDelete}>
                  Confirm
                </TmsButton>
                <TmsButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </TmsButton>
              </div>
            ) : (
              <TmsButton size="sm" variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2 size={14} />
                Delete
              </TmsButton>
            )
          ) : null}
          <span style={{ flex: 1 }} />
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </TmsButton>
          <TmsButton variant="primary" onClick={onSave} disabled={!name.trim() || selectedColumns.length === 0}>
            {mode === 'create' ? 'Create' : 'Save'}
          </TmsButton>
        </>
      }
    >
      <div className="tms-board-save-dialog">
        <label className="tms-board-save-label" htmlFor="tms-col-template-name">
          Name
        </label>
        <TmsInput
          id="tms-col-template-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Template name"
        />

        <div className="tms-board-save-scope">
          <BoardCheckbox
            id="tms-col-template-shared"
            label="Shared with everyone"
            checked={shared}
            onChange={onSharedChange}
          />
        </div>

        <label className="tms-board-save-label">Columns</label>
        <div className="tms-board-column-list">
          {columns.map((col, index) => {
            const active = col.selected
            return (
              <div key={col.key} className={`tms-board-column-row${active ? '' : ' tms-board-column-off'}`}>
                <BoardCheckbox
                  id={`tms-col-${col.key}`}
                  label={col.header}
                  checked={active}
                  onChange={() => onToggleColumn(col.key)}
                />
                {active ? (
                  <div className="tms-board-column-order">
                    <TmsIconButton
                      shape="plain"
                      aria-label={`Move ${col.header} up`}
                      disabled={index === 0}
                      onClick={() => onMoveColumn(col.key, 'up')}
                    >
                      <ArrowUp size={14} />
                    </TmsIconButton>
                    <TmsIconButton
                      shape="plain"
                      aria-label={`Move ${col.header} down`}
                      disabled={index === columns.length - 1}
                      onClick={() => onMoveColumn(col.key, 'down')}
                    >
                      <ArrowDown size={14} />
                    </TmsIconButton>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </TmsDialog>
  )
}

export default ColumnTemplateDialog
