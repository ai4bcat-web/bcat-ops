import { useState } from 'react'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { SPEC_LIMITS } from '@/lib/dashboards/spec'
import type { DashboardAccess, DashboardScope, DashOptions } from '@/lib/dashboards/types'
import { ScopePicker } from './ScopePicker'
import { scopeSummary } from './scopeLabels'

export interface SaveDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  scope: DashboardScope
  options: DashOptions | null
  access: DashboardAccess
  saving: boolean
  error: string | null
  onSave: (input: { title: string; scope: DashboardScope }) => void
}

/** Title + audience recap. Sharing lists come from the scope: users/teams chosen here ARE the share list. */
export function SaveDashboardDialog(props: SaveDashboardDialogProps) {
  // Mounted only while open, so every opening starts from the current title and scope.
  return props.open ? <SaveForm {...props} /> : null
}

function SaveForm({
  open,
  onOpenChange,
  title,
  scope,
  options,
  access,
  saving,
  error,
  onSave,
}: SaveDashboardDialogProps) {
  const [name, setName] = useState(title)
  const [chosen, setChosen] = useState<DashboardScope>(scope)

  const trimmed = name.trim()
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save dashboard"
      description="Everyone who opens it sees their own numbers: only the customers they own or their team covers."
      footer={
        <>
          <TmsButton onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </TmsButton>
          <TmsButton
            variant="primary"
            disabled={saving || !trimmed}
            data-testid="dash-save-confirm"
            onClick={() => onSave({ title: trimmed, scope: chosen })}
          >
            {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        </>
      }
    >
      <TmsField label="Title">
        <TmsInput
          value={name}
          maxLength={SPEC_LIMITS.maxTitle}
          onChange={(e) => setName(e.target.value)}
          data-testid="dash-save-title"
        />
      </TmsField>
      <TmsField label="Who can open it" hint={`Now: ${scopeSummary(chosen, options)}`}>
        <ScopePicker value={chosen} onChange={setChosen} options={options} access={access} disabled={saving} />
      </TmsField>
      {error ? <TmsAlert tone="red">{error}</TmsAlert> : null}
    </TmsDialog>
  )
}

export default SaveDashboardDialog
