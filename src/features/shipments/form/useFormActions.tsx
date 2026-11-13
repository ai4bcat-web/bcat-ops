/**
 * The immediate (post-save) actions of the form — Cover, Dispatch, Send Rate Conf, Send Info,
 * TONU, check calls, documents — and the existing dialogs they open (AH-plan §3.5, §8.3). Each
 * is a thin call to an existing wrapper; every one is a no-op while a pipeline runs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { AssignDriverDialog } from '@/features/shipments/components/AssignDriverDialog'
import { DispatchDialog } from '@/features/shipments/components/DispatchDialog'
import { RemoveCarrierDialog } from '@/features/shipments/components/StatusActions'
import { TrackingLinkDialog } from '@/features/shipments/components/TrackingLinkDialog'
import { useShipmentActions } from '@/features/shipments/useShipmentActions'
import { useDrivers } from '@/hooks/useDrivers'
import { useTrucks } from '@/hooks/useTrucks'
import {
  commitDocument, logCheckCall, prepareDocumentUpload, putPresignedFile, sendCarrierSetupPacket,
} from '@/lib/apiClient'
import type { CarrierRecord, ShipmentBundle, ShipmentDocumentType, TmsSettings } from '@/types/tms'
import { financialPreview } from './mapping'
import { carrierSlotsOf, coveredCarrierBlock, emptyCarrierBlock, emptyCarrierRate, liveCarriers, type ShipmentFormValues } from './model'
import { RateConDialog } from './RateConDialog'
import { toLogCheckCallInput } from './checkCallNote'
import { runAddCarrier, runCover } from './pipelines'
import type { FormActions } from './sectionProps'

type DialogKind = 'book' | 'assign' | 'dispatch' | 'rateCon' | 'info' | 'tonu' | 'uncover' | null

const COMMIT_RETRY_MS = 1500

export function useFormActions(o: {
  values: ShipmentFormValues
  update: (fn: (prev: ShipmentFormValues) => ShipmentFormValues) => void
  bundle: ShipmentBundle | null
  setBundle: (b: ShipmentBundle) => void
  /** A pipeline is running. */
  busy: boolean
  settings: TmsSettings | null
  /** The carrier directory: the carrier picked on the form seeds Cover's lookup. */
  carriers: CarrierRecord[]
  isAdmin: boolean
  brokerName: string
}): { actions: FormActions; dialogs: ReactNode; busy: boolean } {
  const { values, update, bundle, setBundle, settings, carriers, isAdmin, brokerName } = o
  // The bundle BOOK_CARRIER answered with: runCover applies the form's seal / PU ETA on top of it.
  const latestBundle = useRef(bundle)
  const track = useCallback((b: ShipmentBundle) => { latestBundle.current = b; setBundle(b) }, [setBundle])
  const sa = useShipmentActions(bundle, track)
  const [dialog, setDialog] = useState<DialogKind>(null)
  /** The assignment a dialog acts on; unset = the primary one. */
  const [target, setTarget] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const busy = o.busy || sa.busy || adding
  const { drivers } = useDrivers()
  const { equipment } = useTrucks()

  const ref = useRef({ values, bundle, busy })
  useEffect(() => { ref.current = { values, bundle, busy } })

  const load = bundle?.loads[0]
  const live = liveCarriers(bundle)
  const active = live.find((lc) => lc.id === target) ?? live[0] ?? null

  const actions = useMemo<FormActions>(() => ({
    cover: (slotKey) => {
      const r = ref.current
      if (r.busy || !r.bundle) return
      const bundleNow = r.bundle
      const slots = carrierSlotsOf(r.values)
      const index = slots.findIndex((sl) => sl.slot === slotKey)
      if (index <= 0) { setDialog(r.values.carrier.isOwnFleet ? 'assign' : 'book'); return }
      // Another carrier: ADD_CARRIER straight from the slot (its directory carrier, rate, charges and legs).
      const known = new Set(slots.map((sl) => sl.loadCarrierId).filter(Boolean))
      setAdding(true)
      void runAddCarrier(r.values, bundleNow, slots[index].slot).then((res) => {
        if (res.bundle) track(res.bundle)
        const added = res.bundle ? liveCarriers(res.bundle).find((lc) => !known.has(lc.id)) : undefined
        if (added) {
          update((p) => ({
            ...p,
            carriers: p.carriers.map((sl) => (sl.slot === slots[index].slot ? { ...sl, loadCarrierId: added.id, carrierName: added.carrierName ?? '' } : sl)),
          }))
        }
        if (res.ok) toast.success('Carrier added')
        else toast.error(res.message ?? 'The carrier was not added')
      }).finally(() => setAdding(false))
    },
    openDispatch: () => { if (!ref.current.busy) { setTarget(undefined); setDialog('dispatch') } },
    openSendRateCon: () => { if (!ref.current.busy) { setTarget(undefined); setDialog('rateCon') } },
    openSendInfo: () => { if (!ref.current.busy) { setTarget(undefined); setDialog('info') } },
    openTonu: () => { if (!ref.current.busy) { setTarget(undefined); setDialog('tonu') } },
    openUncover: () => { if (!ref.current.busy) { setTarget(undefined); setDialog('uncover') } },
    openFor: (kind, id) => { if (!ref.current.busy) { setTarget(id); setDialog(kind) } },
    async sendSetupPacket(carrierId, email) {
      const res = await sendCarrierSetupPacket({ carrierId, email })
      toast.success(res.message)
    },
    async addCheckCall(draft) {
      const b = ref.current.bundle
      const l = b?.loads[0]
      if (!b || !l) throw new Error('Save the shipment before logging a check call')
      const input = toLogCheckCallInput(draft, {
        loadId: l.id, expectedUpdatedAt: l.updatedAt ?? '', stops: l.stops ?? [], tempUnit: ref.current.values.ship.temp.unit,
      })
      try {
        setBundle((await logCheckCall(input)).bundle)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Check call failed')
        throw err
      }
    },
    async uploadDocument(file: File, audience: 'ALL' | 'INTERNAL', type: ShipmentDocumentType) {
      const b = ref.current.bundle
      if (!b) throw new Error('Save the shipment before uploading')
      const base = { name: file.name, contentType: file.type, sizeBytes: file.size }
      try {
        const prepared = await prepareDocumentUpload({ shipmentId: b.shipment.id, type, ...base })
        await putPresignedFile(prepared.uploadUrl, file, file.type)
        const commit = () => commitDocument({
          shipmentId: b.shipment.id, documentId: prepared.documentId, s3Key: prepared.s3Key, type, ...base,
          orderId: b.orders[0]?.id ?? null, loadId: null, loadCarrierId: null, audience,
        })
        let res
        try { res = await commit() } catch (err) {
          if (!(err instanceof Error) || !/has not landed/i.test(err.message)) throw err
          await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_RETRY_MS) })
          res = await commit()
        }
        setBundle(res.bundle)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed')
        throw err
      }
    },
    queueDocument(file, audience, type) {
      update((p) => ({ ...p, docs: { queued: [...p.docs.queued, { file, audience, type }] } }))
    },
    unqueueDocument(index) {
      update((p) => ({ ...p, docs: { queued: p.docs.queued.filter((_, i) => i !== index) } }))
    },
  }), [setBundle, update, track])

  const close = () => { setDialog(null); setTarget(undefined) }
  // Cover starts from what the form already says: the picked carrier's MC / DOT and the typed carrier rate.
  const picked = dialog === 'book' ? carriers.find((c) => c.id === values.carrier.carrierId) : undefined
  const coverSeed = {
    query: picked?.mcNumber ? picked.mcNumber.replace(/^MC/i, '') : (picked?.dotNumber ?? ''),
    rateCents: dialog === 'book' ? financialPreview(values, null, null).carrierTotalLhCents : 0,
  }
  let node: ReactNode = null
  if (dialog === 'book' && bundle) {
    // Step AM ladder: directory carrier assigned straight away, otherwise an MCP lookup and invite.
    node = (
      <CoverCarrierDialog
        shipmentId={bundle.shipment.id}
        shipmentNumber={bundle.shipment.number}
        initialQuery={coverSeed.query}
        initialRateCents={coverSeed.rateCents}
        onClose={close}
        onCovered={async (covered) => {
          track(covered)
          const after = await runCover(ref.current.values, covered)
          if (after.bundle) track(after.bundle)
          if (!after.ok) toast.error(after.message ?? 'Covered, but the carrier details did not all save')
          // The dialog books the load without touching the form: point the carrier block at what was covered,
          // so it shows the carrier straight away and a later save cannot send an empty carrier back.
          const booked = liveCarriers(after.bundle ?? covered)[0]
          if (booked) update((p) => ({ ...p, carrier: coveredCarrierBlock(p.carrier, booked) }))
          close()
        }}
      />
    )
  } else if (dialog === 'assign' && bundle && load) {
    node = (
      <AssignDriverDialog
        load={load} activeLeg={active} drivers={drivers}
        trucks={equipment.filter((e) => e.type === 'truck')} trailers={equipment.filter((e) => e.type === 'trailer')}
        isAdmin={isAdmin} busy={busy} onClose={close} onConfirm={sa.load.onAssignAsset}
      />
    )
  } else if (dialog === 'dispatch' && active) {
    node = (
      <DispatchDialog
        loadCarrier={active} busy={busy} onClose={close}
        onConfirm={async (input) => { await sa.dispatchLoad(input); close() }}
      />
    )
  } else if (dialog === 'tonu' && active) {
    node = (
      <RemoveCarrierDialog
        outcome="TONU" loadCarrier={active} busy={busy} onClose={close}
        onConfirm={(reason, note) => { void sa.load.onRemoveCarrier(active.id, 'TONU', reason, note).then(close).catch(() => { /* reported */ }) }}
      />
    )
  } else if (dialog === 'uncover' && active) {
    // Same as Bounce carrier: the assignment comes off (BOUNCED), its rate con is voided and any tracking link stops, and the load goes back to open.
    node = (
      <RemoveCarrierDialog
        outcome="BOUNCED" loadCarrier={active} busy={busy} onClose={close}
        onConfirm={(reason, note, repostToDat) => {
          const onlyOne = live.length === 1
          void sa.load.onRemoveCarrier(active.id, 'BOUNCED', reason, note, repostToDat).then(() => {
            // The form keeps what it was typed with: clear the carrier it showed so a save cannot put it back.
            if (onlyOne) update((p) => ({ ...p, carrier: emptyCarrierBlock(), rates: { ...p.rates, carrier: emptyCarrierRate() } }))
            close()
          }).catch(() => { /* reported */ })
        }}
      />
    )
  } else if (dialog === 'info' && active && load) {
    node = (
      <TrackingLinkDialog
        loadCarrier={active} loadNumber={load.loadNumber ?? load.aljexId ?? ''} link={null} settings={settings}
        brokerName={brokerName} onClose={close} onChanged={() => { void sa.reload() }}
      />
    )
  } else if (dialog === 'rateCon' && bundle && active) {
    node = <RateConDialog bundle={bundle} loadCarrierId={active.id} settings={settings} busy={busy} onClose={close} sa={sa} />
  }
  return { actions, dialogs: node, busy }
}
