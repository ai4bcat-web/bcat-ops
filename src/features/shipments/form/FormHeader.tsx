/**
 * The header strip (Step AR, feedback 7): title, the Customer type-ahead, the Bill To
 * summary chip (its Details chevron drops the full panel under the strip, collapsed by default),
 * status chip and read-only PRO. Division (the revenue division and ownership tag, one field) and
 * the shipment type are the first two fields of the Freight card.
 */
import { memo } from 'react'
import { TmsBadge } from '@/features/tms/kit'
import type { CardProps } from './cards/cardRegistry'
import { HEADER_PARTS } from './defaultSections'

export interface FormHeaderProps {
  title: string
  status: string
  dirty: boolean
  /** The shipment's own PRO in edit mode; the next counter value in create mode ('' = unknown). */
  pro: string
  mode: 'create' | 'edit'
  /** The page's card props: the Customer picker and the Bill To panel read the same values / ctx. */
  common: CardProps
  panelOpen: boolean
  onPanelToggle: () => void
}

function FormHeaderImpl({ title, status, dirty, pro, mode, common, panelOpen, onPanelToggle }: FormHeaderProps) {
  const draft = status === 'NEW' || status === 'DRAFT'
  return (
    <header className="tms-ship-hdr" data-testid="ship-form-header">
      <h1 className="tms-ship-hdr-title" data-testid="ship-form-title">{title}</h1>
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
