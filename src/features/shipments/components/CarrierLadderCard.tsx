/**
 * Step AM — the carrier assignment ladder on a covered load's Carrier tab: five rungs with the time each was
 * reached, the chip for where the load is now, and the buttons that move it up.
 *
 * Where the load stands comes from facts the server records (MyCarrierPackets for setup, the rate-con record for
 * sent / signed, the four driver fields for the last rung); the buttons only do the work that produces those
 * facts. There is no "setup complete" button: setup arrives from MyCarrierPackets or not at all.
 */
import { useEffect, useState } from 'react'
import { Check, Circle, FileSignature, Send, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { InviteDialog } from '@/features/carriers/find/InviteDialog'
import { CarrierLookupCard } from '@/features/carriers/lookup/CarrierLookupCard'
import { TmsAlert, TmsButton, TmsCard } from '@/features/tms/kit'
import { mcpPreviewCarrier, mcpSendInvite } from '@/lib/apiClient'
import type { McpLookupResult } from '@/lib/apiClient'
import {
  CARRIER_ASSIGNMENT_LABELS, CARRIER_ASSIGNMENT_STATUSES, isCarrierAssignmentStatus, parseAssignmentTimes, rungOf,
} from '@/lib/carrierAssignment'
import { formatDateTime } from '@/lib/date'
import { TRACKING_METHOD_LABELS, TRACKING_MODE_LABELS, parseTrackingPrefs } from '@/lib/trackingPrefs'
import type { CarrierRecord, LoadCarrierRecord, ShipmentBundle } from '@/types/tms'
import { dispatchBlock, ladderActions } from '../carrierLadder'
import { TrackingLinkStateChip } from '../trackingModeControl/TrackingLinkStateChip'
import type { ShipmentActions } from '../useShipmentActions'
import { CarrierAssignmentChip } from './CarrierAssignmentChip'
import { isIvanCartageName } from '@/lib/ownFleetDrivers'
import { DriverInfoDialog } from './DriverInfoDialog'
import { MarkSignedDialog } from './MarkSignedDialog'

type Dialog = 'driver' | 'signed' | 'packet' | null

export function CarrierLadderCard({ bundle, loadCarrier, carrier, actions, onRemove }: {
  bundle: ShipmentBundle
  loadCarrier: LoadCarrierRecord
  /** The directory row, when it has loaded; the ladder's own rung stands in until then. */
  carrier: CarrierRecord | null
  actions: ShipmentActions
  onRemove: () => void
}) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [looked, setLooked] = useState<McpLookupResult | null>(null)
  const [nowIso] = useState(() => new Date().toISOString())
  const [working, setWorking] = useState(false)

  const ladder = isCarrierAssignmentStatus(loadCarrier.assignmentStatus) ? loadCarrier.assignmentStatus : null
  const mcRaw = carrier?.mcNumber ?? loadCarrier.carrierMc ?? ''
  const dotRaw = carrier?.dotNumber ?? ''
  const lookupKey = ladder ? `${mcRaw}|${dotRaw}` : ''
  useEffect(() => {
    if (!lookupKey || lookupKey === '|') return
    let alive = true
    mcpPreviewCarrier({ ...(mcRaw ? { mcNumber: mcRaw.replace(/^MC/i, '') } : {}), ...(dotRaw ? { dotNumber: dotRaw } : {}) })
      .then((r) => { if (alive) setLooked(r) })
      .catch(() => { if (alive) setLooked(null) })
    return () => { alive = false }
  // Keyed on the carrier's numbers: one MyCarrierPackets read per carrier shown.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey])
  if (!ladder) return null

  const times = parseAssignmentTimes(loadCarrier.assignmentTimes)
  const reached = rungOf(ladder)
  const carrierActive = carrier ? carrier.status === 'ACTIVE' : ladder !== 'ASSIGNED_SETUP_PENDING'
  const buttons = ladderActions({ ladder, carrierActive, rateConStatus: loadCarrier.rateConStatus, driver: loadCarrier })
  const gate = dispatchBlock(loadCarrier)
  const load = bundle.loads[0]
  const name = loadCarrier.carrierName ?? carrier?.name ?? 'the carrier'
  const busy = actions.busy || working

  const ref = {
    ...((carrier?.mcNumber ?? loadCarrier.carrierMc) ? { mcNumber: (carrier?.mcNumber ?? loadCarrier.carrierMc ?? '').replace(/^MC/i, '') } : {}),
    ...(carrier?.dotNumber ? { dotNumber: carrier.dotNumber } : {}),
  }

  const openPacket = async () => {
    setWorking(true)
    try {
      setLooked(await mcpPreviewCarrier(ref))
      setDialog('packet')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reach MyCarrierPackets')
    } finally {
      setWorking(false)
    }
  }

  const sendPacket = async (emails: string[]) => {
    setWorking(true)
    try {
      const out = await mcpSendInvite({ ...ref, emails, carrierId: carrier?.id ?? loadCarrier.carrierId ?? undefined, carrierName: name, shipmentId: bundle.shipment.id, loadId: load?.id })
      setDialog(null)
      if (out.sent) toast.success(out.message)
      else toast.info(out.message)
      await actions.reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The setup packet could not be sent')
    } finally {
      setWorking(false)
    }
  }

  const press = (key: (typeof buttons)[number]['key']) => {
    if (key === 'SEND_SETUP_PACKET') void openPacket()
    else if (key === 'SEND_RATE_CON') document.getElementById('rate-con-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    else if (key === 'MARK_SIGNED') setDialog('signed')
    else setDialog('driver')
  }

  return (
    <TmsCard
      title={<span className="flex items-center gap-2"><FileSignature size={14} />Carrier assignment<TrackingLinkStateChip shipmentId={bundle.shipment.id} hasCarrier revDivision={bundle.shipment.revDivision} /></span>}
      actions={<CarrierAssignmentChip ladder={ladder} shipmentStatus={bundle.shipment.status} />}
    >
      <div data-testid="carrier-ladder" data-rung={ladder}>
        <ol className="flex flex-wrap gap-x-4 gap-y-2 text-xs" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {CARRIER_ASSIGNMENT_STATUSES.map((s, i) => {
            const done = i <= reached
            const at = times[s]
            return (
              <li key={s} className="flex items-center gap-1" data-testid={`ladder-${s}`} data-done={done ? 'true' : 'false'} style={{ color: done ? 'var(--tms-text)' : 'var(--tms-muted)' }}>
                {done ? <Check size={12} style={{ color: 'var(--tms-badge-green)' }} /> : <Circle size={12} />}
                <span>{CARRIER_ASSIGNMENT_LABELS[s]}</span>
                {at && <span className="tms-muted">{formatDateTime(at)}</span>}
              </li>
            )
          })}
        </ol>

        {(() => {
          const prefs = parseTrackingPrefs(bundle.shipment.trackingPrefs)
          if (prefs?.mode && prefs.confirmedAt) {
            return (
              <p className="mt-3 text-xs" data-testid="ladder-tracking-summary">
                Tracking: <strong>{TRACKING_MODE_LABELS[prefs.mode]}</strong>{prefs.method ? ` · ${TRACKING_METHOD_LABELS[prefs.method]}` : ''}
              </p>
            )
          }
          return null
        })()}

        {ladder === 'ASSIGNED_SETUP_PENDING' && (
          <div className="mt-3">
            <TmsAlert tone="orange" role="status">
              Waiting for {name} to finish setup on MyCarrierPackets. The rate con can go out once MyCarrierPackets reports the packet complete and the carrier is monitored; nothing here can skip that.
            </TmsAlert>
          </div>
        )}
        {gate && (
          <p className="mt-3 text-xs" role="status" data-testid="dispatch-gate" style={{ color: 'var(--tms-badge-orange)' }}>{gate}</p>
        )}

        {looked && (looked.card || carrier) && (
          <div className="mt-3">
            <CarrierLookupCard
              card={looked.card}
              mode={looked.mode}
              carrier={carrier}
              nowIso={nowIso}
              heading={name}
              busy={busy}
              onSendPacket={sendPacket}
              testId="ladder-lookup-card"
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {buttons.map((b) => (
            <TmsButton
              key={b.key}
              size="sm"
              variant={b.key === 'ENTER_DRIVER_INFO' && ladder === 'RATE_CON_SIGNED' ? 'primary' : undefined}
              data-testid={`ladder-${b.key}`}
              disabled={busy || b.blockedBy != null}
              title={b.blockedBy ?? undefined}
              onClick={() => press(b.key)}
            >
              {b.key === 'SEND_RATE_CON' || b.key === 'SEND_SETUP_PACKET' ? <Send size={14} className="mr-1" /> : b.key === 'ENTER_DRIVER_INFO' ? <UserRound size={14} className="mr-1" /> : null}
              {b.label}
            </TmsButton>
          ))}
          <TmsButton size="sm" data-testid="ladder-REMOVE" disabled={busy} onClick={onRemove}>Remove carrier</TmsButton>
        </div>
      </div>

      {dialog === 'driver' && (
        <DriverInfoDialog
          initial={loadCarrier}
          carrierName={name}
          ownFleet={isIvanCartageName(name)}
          busy={actions.busy}
          onClose={() => setDialog(null)}
          onConfirm={async (values) => { await actions.enterDriverInfo({ loadCarrierId: loadCarrier.id, ...values }); setDialog(null) }}
        />
      )}
      {dialog === 'signed' && (
        <MarkSignedDialog
          shipmentId={bundle.shipment.id}
          loadId={load?.id}
          loadCarrierId={loadCarrier.id}
          carrierName={name}
          busy={actions.busy}
          onClose={() => setDialog(null)}
          onConfirm={async (documentId) => { await actions.markRateConSigned({ loadCarrierId: loadCarrier.id, documentId }); setDialog(null) }}
        />
      )}
      {dialog === 'packet' && (
        <InviteDialog
          carrierName={name}
          candidates={looked?.card?.emails ?? []}
          stub={looked?.mode === 'STUB'}
          busy={working}
          onClose={() => setDialog(null)}
          onSend={(emails) => { void sendPacket(emails) }}
        />
      )}
    </TmsCard>
  )
}
