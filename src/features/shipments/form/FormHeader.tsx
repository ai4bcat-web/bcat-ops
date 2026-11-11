/**
 * The header strip (Step AR, feedback 7/11): title, the Customer type-ahead, the Customer ref (PO), the Bill To
 * summary chip (its Details chevron drops the full panel under the strip, collapsed by default),
 * read-only PRO. Division (the revenue division and ownership tag, one field) and
 * the shipment type are the first two fields of the Freight card.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import type { CardProps } from './cards/cardRegistry'
import { deliveryPhase } from '@/lib/deliveryPhase'
import { DeliveryTimeline } from '../DeliveryTimeline'
import { phaseInputOfBundle } from '../deliveryPhaseInputs'
import { HEADER_PARTS } from './defaultSections'
import { buildShipmentSteps, nextStepOf } from '@/lib/shipmentSteps'

export interface FormHeaderProps {
  title: string
  dirty: boolean
  /** The shipment's own PRO in edit mode; the next counter value in create mode ('' = unknown). */
  pro: string
  mode: 'create' | 'edit'
  /** The page's card props: the Customer picker and the Bill To panel read the same values / ctx. */
  common: CardProps
  panelOpen: boolean
  onPanelToggle: () => void
}

function FormHeaderImpl({ title, dirty, pro, mode, common, panelOpen, onPanelToggle }: FormHeaderProps) {
  const bundle = common.ctx.bundle
  // The timeline's clock: re-read once a minute so a late truck turns amber without a reload.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const phase = useMemo(() => deliveryPhase(phaseInputOfBundle(bundle, nowMs)), [bundle, nowMs])
  const next = useMemo(() => nextStepOf(buildShipmentSteps(bundle, [], [])), [bundle])
  return (
    <header className="tms-ship-hdr" data-testid="ship-form-header">
      <h1 className="tms-ship-hdr-title" data-testid="ship-form-title">{title}</h1>
      <HEADER_PARTS.CustomerPicker {...common} />
      <HEADER_PARTS.CustomerRef {...common} />
      <HEADER_PARTS.BillToStrip {...common} open={panelOpen} onToggle={onPanelToggle} />
      <span className="tms-ship-hdr-spacer" />
      {next ? <span className="tms-ship-next" data-testid="ship-form-next" title={next.action ?? undefined}>Next: {next.short}</span> : null}
      <DeliveryTimeline result={phase} />
      {dirty ? <span className="tms-ship-dirty" data-testid="ship-form-dirty" title="Unsaved changes" role="img" aria-label="Unsaved changes" /> : null}
      <span className="tms-ship-hdr-pro" data-testid="ship-form-pro" title={mode === 'create' ? 'Preview only: the number is minted when you create' : undefined}>
        PRO {pro || '—'}
      </span>
    </header>
  )
}

export const FormHeader = memo(FormHeaderImpl)
