/**
 * The shipment tools under the edit form. Mounted only once someone opens it, so the edit page does
 * not fetch a second copy of the shipment for people who never use these tools.
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { parseToVoidFlag } from '@/lib/toVoidFlag'
import { useShipmentContext, type ShipmentContextOptions } from '../useShipmentContext'
import { ShipmentTools } from './ShipmentTools'
import { ShipmentRowActions } from './StatusActions'
import { ToVoidDialog } from './ToVoid'
import type { DetailTabKey } from './detailTabs'

interface Props {
  shipmentId: string
  options: ShipmentContextOptions
  /** Opens the panel on load, on this tab (a link carried `?tab=`). */
  initialTab?: DetailTabKey
  onOpen?: () => void
  onChanged: () => void
  onDeleted: () => void
}

function Body({ shipmentId, options, initialTab, onChanged, onDeleted, onOpen }: Props) {
  useEffect(() => { onOpen?.() }, [onOpen])
  const ctx = useShipmentContext(shipmentId, options, onChanged)
  const shipment = ctx.bundle?.shipment ?? null
  // Ryne 2026-11-18: flag the shipment to be voided from its own page, as the board's row menu does.
  const [toVoidOpen, setToVoidOpen] = useState(false)
  return (
    <div className="space-y-3" data-testid="ship-tools-body">
      {ctx.loading && <p className="tms-muted text-sm">Loading…</p>}
      {ctx.error && <p className="text-sm text-[color:var(--tms-badge-red)]">{ctx.error}</p>}
      {shipment && (
        <div className="flex justify-end">
          <ShipmentRowActions
            shipment={shipment}
            isAdmin={options.isAdmin}
            cancelDeleteAdminOnly={ctx.cancelDeleteAdminOnly}
            handlers={{ ...ctx.actions.shipment, onToVoid: () => setToVoidOpen(true), toVoidFlagged: parseToVoidFlag(shipment.toVoidFlag) != null }}
            onDeleted={onDeleted}
          />
        </div>
      )}
      {shipment && toVoidOpen && (
        <ToVoidDialog target={shipment} onClose={() => setToVoidOpen(false)} onSaved={onChanged} onVoided={onChanged} />
      )}
      {ctx.bundle && <ShipmentTools {...ctx.detailProps} initialTab={initialTab} />}
    </div>
  )
}

export function ShipmentToolsPanel(props: Props) {
  const [open, setOpen] = useState(props.initialTab != null)
  return (
    <section className="tms-ship-tools" data-testid="ship-tools">
      <TmsButton size="sm" variant="ghost" aria-expanded={open} data-testid="ship-tools-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Shipment tools: division, carrier sourcing, tracking, documents, financials, invoicing, carrier pay, history
      </TmsButton>
      {open && <Body {...props} />}
    </section>
  )
}
