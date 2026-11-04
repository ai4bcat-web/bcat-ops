/**
 * Everything a tracker needs about one load on one screen, dense enough to sit above the
 * fold at 1440 × 900: the summary strip, an SMS pane (driver) beside an e-mail pane
 * (dispatcher/carrier), and the last five check calls.
 *
 * The drawer on the Tracking grid and the shipment page's Tracking tab both mount this, so
 * the two can never drift. It reads its own thread, check calls, links and truck phones.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { PhoneCall, Send, Users } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { AuthContext } from '@/hooks/useAuth'
import { useDriverPhones } from '@/hooks/useTruckConfigs'
import { useLoadTracking } from '@/hooks/useLoadTracking'
import { useAppStore } from '@/store/useAppStore'
import {
  getTmsSettings, listDivisions, listShipmentMessages, sendShipmentMessage, textDriver,
} from '@/lib/apiClient'
import { effectiveTrackingPrefs } from '@/lib/trackingPrefs'
import { driverSmsTarget } from '@/lib/workPhone'
import type { ChargeCodeDef, CustomerRecord, ShipmentBundle, ShipmentMessageRecord, TmsSettings } from '@/types/tms'
import { CustomerLinkDialog } from '../../components/CustomerLinkDialog'
import { LogCheckCallDialog, type CheckCallFormValues } from '../../components/LogCheckCallDialog'
import { TrackingLinkDialog } from '../../components/TrackingLinkDialog'
import type { ShipmentActions } from '../../useShipmentActions'
import type { ShipmentRow } from '../../shipmentViews'
import { RecentCheckCalls } from './RecentCheckCalls'
import { TrackingConversation } from './TrackingConversation'
import { TrackingSummaryStrip } from './TrackingSummaryStrip'
import { summaryOf } from './trackingSummary'

type Dialog = 'check_call' | 'carrier_link' | 'customer_link' | null

export function ShipmentTrackingView({ bundle, customer, catalog = [], actions, row = null }: {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  catalog?: ChargeCodeDef[]
  actions: ShipmentActions
  /** The board row, when the caller has one (its POD projection is richer than the bundle's). */
  row?: ShipmentRow | null
}) {
  const shipment = bundle.shipment
  const load = bundle.loads[0] ?? null
  const loadCarrier = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const divisionKey = load?.divisionKey ?? null

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [brokerName, setBrokerName] = useState('BCAT Logistics')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [messages, setMessages] = useState<ShipmentMessageRecord[]>([])
  const auth = useContext(AuthContext)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([getTmsSettings().catch(() => null), listDivisions().catch(() => [])]).then(([s, divisions]) => {
      if (!live) return
      setSettings(s)
      const own = divisionKey ? divisions.find((d) => d.key === divisionKey) : divisions[0]
      if (own?.name) setBrokerName(own.name)
    })
    return () => { live = false }
  }, [divisionKey])

  const reloadMessages = useCallback(async () => {
    try {
      setMessages(await listShipmentMessages(shipment.id))
    } catch {
      // Keep the last good thread: a failed re-read must not erase what was on screen.
    }
  }, [shipment.id])

  useEffect(() => {
    let live = true
    listShipmentMessages(shipment.id)
      .then((rows) => { if (live) setMessages(rows) })
      .catch(() => { /* keep whatever the thread last showed */ })
    return () => { live = false }
  }, [shipment.id])

  const tracking = useLoadTracking({
    loadId: load?.id,
    shipmentId: shipment.id,
    truckId: loadCarrier?.truckId ?? null,
    load: { pickupAppt: load?.pickupAppt, deliveredAt: load?.deliveredAt },
    loadCarrier: { dispatchedAt: loadCarrier?.dispatchedAt },
  })

  // Work phone (the truck's) and personal phone (the driver's), and where a text will go.
  const drivers = useAppStore((s) => s.drivers)
  const driver = loadCarrier?.driverId ? drivers.find((d) => d.id === loadCarrier.driverId) ?? null : null
  const phones = useDriverPhones(driver, {
    loadTruckId: loadCarrier?.truckId ?? null,
    legDriverPhone: loadCarrier?.driverPhone ?? null,
    unitNumber: loadCarrier?.truckNumber ?? null,
  })
  const prefs = useMemo(() => effectiveTrackingPrefs({ shipment, customer }), [shipment, customer])
  const smsTarget = useMemo(() => driverSmsTarget(phones, prefs.driverSms), [phones, prefs.driverSms])

  const summary = useMemo(
    () => summaryOf({ bundle, row, phones, lastKnown: tracking.lastKnown, nowMs: tracking.nowMs, graceMinutes: settings?.checkCallGraceMinutes }),
    [bundle, row, phones, tracking.lastKnown, tracking.nowMs, settings?.checkCallGraceMinutes],
  )

  if (!load) return <p className="text-sm tms-muted">This shipment has no load to track yet.</p>

  const carrierLink = tracking.links.find((l) => l.kind === 'CARRIER_PING' && l.status === 'ACTIVE') ?? null
  const customerLink = tracking.links.find((l) => l.kind === 'CUSTOMER_VIEW' && l.status === 'ACTIVE') ?? null
  const userName = auth?.user?.email ?? null
  const closeDialog = () => { setDialog(null); void tracking.refresh() }

  const send = async (input: { channel: 'EMAIL' | 'SMS'; to: string | null; subject: string | null; body: string; documentIds?: string[]; party?: 'DRIVER' | 'DISPATCHER' }) => {
    await sendShipmentMessage({ shipmentId: shipment.id, ...input })
  }
  const refresh = async () => { await Promise.all([reloadMessages(), actions.reload()]) }
  const driverRecipient = { name: loadCarrier?.driverName, phone: smsTarget.to }
  const dispatcherRecipient = { name: loadCarrier?.dispatcherName, phone: loadCarrier?.dispatcherPhone, email: loadCarrier?.dispatcherEmail }

  return (
    <div className="tms-tracking-view" data-testid="shipment-tracking-view" data-shipment-id={shipment.id}>
      <TrackingSummaryStrip
        summary={summary}
        busy={actions.busy}
        onSetNextCheck={(iso) => { void actions.tracking.setNextCheckCall(iso).catch(() => { /* reported */ }) }}
      />

      <div className="tms-tracking-panes" data-testid="tracking-panes">
        <div className="tms-tracking-pane" data-testid="pane-sms">
          <TrackingConversation
            lockChannel="SMS" conversationKey={shipment.id} messages={messages} userName={userName} bundle={bundle}
            driver={driverRecipient} dispatcher={dispatcherRecipient} smsTarget={smsTarget}
            onSendMessage={send} onRefresh={refresh}
          />
        </div>
        <div className="tms-tracking-pane" data-testid="pane-email">
          <TrackingConversation
            lockChannel="EMAIL" conversationKey={shipment.id} messages={messages} userName={userName} bundle={bundle}
            driver={driverRecipient} dispatcher={dispatcherRecipient}
            onSendMessage={send} onRefresh={refresh}
          />
        </div>
      </div>

      <RecentCheckCalls
        events={tracking.events}
        busy={actions.busy}
        onResolve={(checkCallId) => {
          void actions.tracking.resolveIncident(checkCallId).then(() => tracking.refresh()).catch(() => { /* reported */ })
        }}
        actions={(
          <>
            <TmsButton variant="primary" size="sm" disabled={actions.busy} onClick={() => setDialog('check_call')}>
              <PhoneCall size={13} aria-hidden /> Log check call
            </TmsButton>
            <TmsButton size="sm" disabled={!loadCarrier} onClick={() => setDialog('carrier_link')}>
              <Send size={13} aria-hidden /> Send tracking link
            </TmsButton>
            <TmsButton size="sm" onClick={() => setDialog('customer_link')}>
              <Users size={13} aria-hidden /> Customer link
            </TmsButton>
          </>
        )}
      />

      {dialog === 'check_call' && (
        <LogCheckCallDialog
          load={load}
          loadCarrier={loadCarrier}
          catalog={catalog}
          busy={actions.busy}
          onClose={closeDialog}
          onSubmit={async (values: CheckCallFormValues) => { await actions.tracking.logCheckCall(values) }}
          onTextDriver={async (bodyText) => {
            if (!loadCarrier) return
            await textDriver({ loadCarrierId: loadCarrier.id, body: bodyText })
          }}
        />
      )}
      {dialog === 'carrier_link' && loadCarrier && (
        <TrackingLinkDialog
          loadCarrier={loadCarrier}
          loadNumber={load.loadNumber ?? load.aljexId ?? ''}
          link={carrierLink}
          settings={settings}
          brokerName={brokerName}
          onClose={closeDialog}
          onChanged={() => { void actions.reload(); void tracking.refresh() }}
        />
      )}
      {dialog === 'customer_link' && (
        <CustomerLinkDialog
          shipment={shipment}
          customer={customer}
          link={customerLink}
          settings={settings}
          onClose={closeDialog}
          onChanged={() => { void actions.reload(); void tracking.refresh() }}
        />
      )}
    </div>
  )
}
