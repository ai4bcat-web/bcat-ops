/**
 * Name a saved view and say who may see it.
 *
 * Columns are not here any more: the Columns picker is the one place a board layout is
 * chosen, and two column editors that could disagree is exactly the confusion R2 set
 * out to remove. This dialog saves the filters the panel is showing under a name.
 */
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import { BoardCheckbox } from './parts'

export interface FilterSetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  name: string
  onNameChange: (name: string) => void
  shared: boolean
  onSharedChange: (shared: boolean) => void
  canDelete: boolean
  onDelete: () => void
  onSave: () => void
}

export function FilterSetDialog({
  open,
  onOpenChange,
  mode,
  name,
  onNameChange,
  shared,
  onSharedChange,
  canDelete,
  onDelete,
  onSave,
}: FilterSetDialogProps) {
  const [confirming, setConfirming] = useState(false)

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'Save as view' : 'Update view'}
      footer={
        <>
          {canDelete ? (
            confirming ? (
              <div className="tms-board-confirm">
                <span>Delete this view?</span>
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
          <TmsButton variant="primary" onClick={onSave} disabled={!name.trim()}>
            {mode === 'create' ? 'Create' : 'Save'}
          </TmsButton>
        </>
      }
    >
      <div className="tms-board-save-dialog">
        <label className="tms-board-save-label" htmlFor="tms-filter-set-name">
          Name
        </label>
        <TmsInput
          id="tms-filter-set-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="View name"
        />

        <div className="tms-board-save-scope">
          <BoardCheckbox
            id="tms-filter-set-shared"
            label="Shared with everyone"
            checked={shared}
            onChange={onSharedChange}
          />
        </div>
      </div>
    </TmsDialog>
  )
}

export default FilterSetDialog
