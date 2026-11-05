/**
 * The header bar (Step AR): breadcrumb, title, Division and Mode pills, status chip, read-only PRO.
 * Division is the top-level revenue division (`ship.revDivision`; Revenue Type in Freight picks the
 * sub-division of the same field). Mode is `values.mode`.
 */
import { ChevronRight } from 'lucide-react'
import { memo } from 'react'
import { TmsBadge } from '@/features/tms/kit'
import type { DivisionTreeRow } from '@/features/tms/settings/taxonomyDrafts'
import { FORM_MODE_OPTIONS } from './constants'
import { LABEL } from './labels'
import { isLocked, lockReason, type FormMode, type LockSet } from './model'
import type { FormApi } from './sectionRegistry'

export interface FormHeaderProps {
  title: string
  status: string
  dirty: boolean
  /** The shipment's own PRO in edit mode; the next counter value in create mode ('' = unknown). */
  pro: string
  mode: 'create' | 'edit'
  formMode: FormMode
  revDivision: string
  divisions: DivisionTreeRow[]
  locked: LockSet
  disabled: boolean
  update: FormApi['update']
  onBack: () => void
}

function FormHeaderImpl({ title, status, dirty, pro, mode, formMode, revDivision, divisions, locked, disabled, update, onBack }: FormHeaderProps) {
  const tops = divisions.filter((r) => r.depth === 0 && (r.division.active || r.division.code === revDivision))
  const modeKnown = FORM_MODE_OPTIONS.some((o) => o.value === formMode)
  const modeLocked = isLocked(locked, 'mode')
  const draft = status === 'NEW' || status === 'DRAFT'
  return (
    <header className="tms-ship-hdr" data-testid="ship-form-header">
      <nav className="tms-ship-hdr-crumb" aria-label="Breadcrumb">
        <button type="button" className="tms-ship-hdr-link" data-testid="ship-form-back" onClick={onBack}>Shipments</button>
        <ChevronRight size={12} aria-hidden="true" />
        <span aria-current="page">{mode === 'create' ? 'New shipment' : 'Edit'}</span>
      </nav>
      <h1 className="tms-ship-hdr-title" data-testid="ship-form-title">{title}</h1>
      <select
        className="tms-ship-pill" aria-label="Division" data-testid="f-header-division" value={revDivision} disabled={disabled}
        onChange={(e) => update((p) => ({ ...p, ship: { ...p.ship, revDivision: e.target.value, revSubdivision: '' } }))}
      >
        <option value="">Division</option>
        {revDivision && !tops.some((r) => r.division.code === revDivision) ? <option value={revDivision}>{revDivision}</option> : null}
        {tops.map((r) => <option key={r.division.id} value={r.division.code}>{r.division.name}</option>)}
      </select>
      <select
        className="tms-ship-pill" aria-label="Mode" data-testid={LABEL.shipping.mode.testId} value={formMode}
        disabled={disabled || modeLocked} title={lockReason(locked, 'mode')}
        onChange={(e) => update((p) => ({ ...p, mode: e.target.value as FormMode }))}
      >
        {!modeKnown && <option value={formMode} disabled>{formMode}</option>}
        {FORM_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="tms-ship-hdr-spacer" />
      {dirty ? <span className="tms-ship-dirty" data-testid="ship-form-dirty" title="Unsaved changes" role="img" aria-label="Unsaved changes" /> : null}
      <TmsBadge tone={draft ? 'gray' : 'blue'} data-testid="ship-form-status">{draft ? 'Draft' : status}</TmsBadge>
      <span className="tms-ship-hdr-pro" data-testid="ship-form-pro" title={mode === 'create' ? 'Preview only: the number is minted when you create' : undefined}>
        PRO {pro || '—'}
      </span>
    </header>
  )
}

export const FormHeader = memo(FormHeaderImpl)
