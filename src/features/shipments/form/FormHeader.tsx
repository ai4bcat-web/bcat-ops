/**
 * The header strip (Step AR, feedback 7): title, Division pill, the Customer type-ahead, the Bill To
 * summary chip (its Details chevron drops the full panel under the strip, collapsed by default),
 * status chip and read-only PRO. Division is the top-level revenue division (`ship.revDivision`;
 * Revenue Type in Freight picks the sub-division of the same field). The shipment type lives in the
 * Freight card now.
 */
import { memo } from 'react'
import { TmsBadge } from '@/features/tms/kit'
import type { DivisionTreeRow } from '@/features/tms/settings/taxonomyDrafts'
import type { CardProps } from './cards/cardRegistry'
import { HEADER_PARTS } from './defaultSections'
import type { FormApi } from './sectionRegistry'
import { typeForDivisionChange } from './shipmentType'

export interface FormHeaderProps {
  title: string
  status: string
  dirty: boolean
  /** The shipment's own PRO in edit mode; the next counter value in create mode ('' = unknown). */
  pro: string
  mode: 'create' | 'edit'
  revDivision: string
  divisions: DivisionTreeRow[]
  disabled: boolean
  update: FormApi['update']
  /** The page's card props: the Customer picker and the Bill To panel read the same values / ctx. */
  common: CardProps
  panelOpen: boolean
  onPanelToggle: () => void
}

function FormHeaderImpl({ title, status, dirty, pro, mode, revDivision, divisions, disabled, update, common, panelOpen, onPanelToggle }: FormHeaderProps) {
  const tops = divisions.filter((r) => r.depth === 0 && (r.division.active || r.division.code === revDivision))
  const draft = status === 'NEW' || status === 'DRAFT'
  return (
    <header className="tms-ship-hdr" data-testid="ship-form-header">
      <h1 className="tms-ship-hdr-title" data-testid="ship-form-title">{title}</h1>
      <select
        className="tms-ship-pill" aria-label="Division" data-testid="f-header-division" value={revDivision} disabled={disabled}
        onChange={(e) => update((p) => typeForDivisionChange(p, { ...p, ship: { ...p.ship, revDivision: e.target.value, revSubdivision: '' } }))}
      >
        <option value="">Division</option>
        {revDivision && !tops.some((r) => r.division.code === revDivision) ? <option value={revDivision}>{revDivision}</option> : null}
        {tops.map((r) => <option key={r.division.id} value={r.division.code}>{r.division.name}</option>)}
      </select>
      <HEADER_PARTS.CustomerPicker {...common} />
      <HEADER_PARTS.BillToStrip {...common} open={panelOpen} onToggle={onPanelToggle} />
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
