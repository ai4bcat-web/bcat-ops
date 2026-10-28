/**
 * Single click on a board row opens this drawer; double click opens the same content as
 * a full page. Everything heavy (the bundle, the customer's credit) is fetched here, so
 * the board stays a list and the page stays a route.
 */
import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { ShipmentDetail } from './ShipmentDetail'
import { type DetailTabKey } from '../shipmentViews'
import { ShipmentRowActions } from './StatusActions'
import { useShipmentContext, type ShipmentContextOptions } from '../useShipmentContext'

interface ShipmentDrawerProps extends ShipmentContextOptions {
  shipmentId: string | null
  onClose: () => void
  /** Board rows refresh after a mutation so the list reflects the new status. */
  onChanged: () => void
}

export function ShipmentDrawer({ shipmentId, onClose, onChanged, ...options }: ShipmentDrawerProps) {
  const ctx = useShipmentContext(shipmentId, options, onChanged)

  return (
    <Sheet open={shipmentId != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full max-w-3xl overflow-hidden p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <SheetTitle className="text-base">{ctx.bundle?.shipment.number ?? 'Shipment'}</SheetTitle>
            {ctx.bundle && (
              <Badge variant="outline">{SHIPMENT_STATUS_LABELS[ctx.bundle.shipment.status]}</Badge>
            )}
            <div className="ml-auto flex items-center gap-1">
              {shipmentId && (
                <Button asChild variant="ghost" size="icon" className="h-7 w-7" aria-label="Open full page">
                  <Link to={`/shipments/${shipmentId}`}><ExternalLink size={14} /></Link>
                </Button>
              )}
              {ctx.bundle && (
                <ShipmentRowActions
                  shipment={ctx.bundle.shipment}
                  isAdmin={options.isAdmin}
                  cancelDeleteAdminOnly={ctx.cancelDeleteAdminOnly}
                  handlers={ctx.actions.shipment}
                />
              )}
            </div>
          </div>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-56px)]">
          <div className="p-5">
            {ctx.loading && <p className="text-sm text-muted-foreground">Loading shipment…</p>}
            {ctx.error && <p className="text-sm text-destructive">{ctx.error}</p>}
            {ctx.bundle && <ShipmentDetail {...ctx.detailProps} />}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

/** Standalone route body: same content, no sheet. */
export function ShipmentPageBody({ shipmentId, options, initialTab }: {
  shipmentId: string
  options: ShipmentContextOptions
  /** `?tab=` on the route, so an AR worklist row can land on Documents. */
  initialTab?: DetailTabKey
}) {
  const ctx = useShipmentContext(shipmentId, options)

  if (ctx.loading) return <p className="p-6 text-sm text-muted-foreground">Loading shipment…</p>
  if (ctx.error) return <p className="p-6 text-sm text-destructive">{ctx.error}</p>
  if (!ctx.bundle) return <p className="p-6 text-sm text-muted-foreground">Shipment not found.</p>

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{ctx.bundle.shipment.number}</h1>
        <Badge variant="outline">{SHIPMENT_STATUS_LABELS[ctx.bundle.shipment.status]}</Badge>
        <div className="ml-auto">
          <ShipmentRowActions
            shipment={ctx.bundle.shipment}
            isAdmin={options.isAdmin}
            cancelDeleteAdminOnly={ctx.cancelDeleteAdminOnly}
            handlers={ctx.actions.shipment}
          />
        </div>
      </div>
      <ShipmentDetail {...ctx.detailProps} initialTab={initialTab} />
    </div>
  )
}
