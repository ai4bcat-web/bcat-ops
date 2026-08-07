/**
 * Shared packet logic for the Files hub. Both the "Download full PDF" button on a truck
 * row and the "Download packet" button inside the profile panel go through here, so the
 * two produce byte-identical PDFs — including the assigned driver's phone and CDL on a
 * truck packet.
 */
import { slotsForAsset, slotsForDriver, isUnslottedDoc, visibleSlots, isPrivateDoc } from '@/lib/fileHub'
import { buildFilePacket, packetFilename, type PacketField, type PacketItem, type PacketResult } from '@/lib/filePacketPdf'
import { formatPhone, formatVin } from '@/lib/utils'
import type { FileHubState } from '@/hooks/useFileHub'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

export type FileEntity =
  | { kind: 'DRIVER'; driver: Driver }
  | { kind: 'TRUCK';  truck: Equipment }

export const entityId = (e: FileEntity) => (e.kind === 'DRIVER' ? e.driver.id : e.truck.id)
export const entityTitle = (e: FileEntity) => (e.kind === 'DRIVER' ? e.driver.name : `Truck ${e.truck.unitNumber}`)

export const fmtDate = (d?: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''

/**
 * A truck's driver, resolved from either side of the relationship.
 *
 * `Driver.assignedTruckId` is checked FIRST because that is the field the assignment
 * UI writes (Drivers page, truck map, revenue audit). `Equipment.assignedDriverId` is
 * the mirror — kept in sync by assignTruckToDriver, but older records predate that, so
 * it can be stale. Reading the stale side first is what left trucks showing no driver.
 */
export function driverForTruck(truck: Equipment, drivers: Driver[]): Driver | undefined {
  return drivers.find((d) => d.assignedTruckId === truck.id)
    ?? drivers.find((d) => d.id === truck.assignedDriverId)
}

/** The detail rows shown in the panel AND printed on the packet cover. */
export function entityFields(entity: FileEntity, drivers: Driver[], equipment: Equipment[]): PacketField[] {
  if (entity.kind === 'DRIVER') {
    const d = entity.driver
    const truck = equipment.find((e) => e.id === d.assignedTruckId)
    const trailer = equipment.find((e) => e.id === d.assignedTrailerId)
    return [
      { label: 'Phone', value: d.phone ? formatPhone(d.phone) : '' },
      { label: 'CDL', value: d.cdl ?? '' },
      { label: 'CDL expires', value: fmtDate(d.cdlExpiration) },
      { label: 'Med card expires', value: fmtDate(d.medCardExpiration) },
      { label: 'Truck', value: truck?.unitNumber ?? '' },
      { label: 'Trailer', value: trailer?.unitNumber ?? 'TBD' },
    ]
  }

  const t = entity.truck
  const driver = driverForTruck(t, drivers)
  return [
    { label: 'VIN', value: formatVin(t.vin) },
    { label: 'Plate', value: t.plate ?? '' },
    { label: 'Make / model', value: [t.make, t.model].filter(Boolean).join(' ') },
    { label: 'Year', value: t.year ? String(t.year) : '' },
    { label: 'Driver', value: driver?.name ?? '' },
    // Whoever receives this packet (insurer, auditor, broker) needs to reach the driver
    // and see their license — only included when the truck actually has one assigned.
    ...(driver ? [
      { label: 'Driver phone', value: driver.phone ? formatPhone(driver.phone) : '' },
      { label: 'Driver CDL', value: driver.cdl ?? '' },
    ] : []),
  ]
}

/**
 * The assigned driver's own documents, surfaced on the TRUCK record — the same
 * ComplianceDocument rows the driver file shows, never a second copy. A truck packet
 * going to an insurer or auditor is incomplete without the driver's licence.
 */
export const DRIVER_DOCS_ON_TRUCK = ['cdl_copy', 'medical_card'] as const

/** Every document to include, slots first (in slot order), then anything else on file. */
export function packetItems(
  entity: FileEntity,
  hub: FileHubState,
  drivers: Driver[] = [],
  /** A packet built by a non-admin must not contain private documents. */
  canSeePrivate = false,
): PacketItem[] {
  const type = entity.kind
  const id = entityId(entity)
  const items: PacketItem[] = []

  const slots = visibleSlots(
    entity.kind === 'TRUCK'
      ? slotsForAsset(entity.truck.type, entity.truck.fleetGroup)
      : slotsForDriver(entity.kind === 'DRIVER' ? entity.driver.fleetGroup : null),
    canSeePrivate,
  )
  for (const slot of slots) {
    const doc = hub.docFor(type, id, slot.key)
    if (doc?.s3Key) {
      items.push({
        label: slot.label,
        s3Key: doc.s3Key,
        note: doc.expirationDate ? `Expires ${fmtDate(doc.expirationDate)}` : undefined,
      })
    }
  }

  for (const doc of hub.docsForEntity(type, id)) {
    if (isUnslottedDoc(doc.documentType) && doc.s3Key && (canSeePrivate || !isPrivateDoc(doc.documentType))) {
      items.push({
        label: doc.title || doc.documentType,
        s3Key: doc.s3Key,
        note: doc.expirationDate ? `Expires ${fmtDate(doc.expirationDate)}` : undefined,
      })
    }
  }

  if (entity.kind === 'TRUCK') {
    const driver = driverForTruck(entity.truck, drivers)
    if (driver) {
      for (const key of DRIVER_DOCS_ON_TRUCK) {
        const doc = hub.docFor('DRIVER', driver.id, key)
        if (doc?.s3Key) {
          items.push({
            label: `${driver.name} — ${doc.title || key}`,
            s3Key: doc.s3Key,
            note: doc.expirationDate ? `Expires ${fmtDate(doc.expirationDate)}` : undefined,
          })
        }
      }
    }
  }

  return items
}

function saveBlob(name: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface PacketOutcome extends PacketResult {
  itemCount: number
}

/** Build the packet and hand it to the browser as a download. */
export async function downloadEntityPacket(params: {
  entity: FileEntity
  hub: FileHubState
  drivers: Driver[]
  equipment: Equipment[]
  todayIso: string
  canSeePrivate?: boolean
}): Promise<PacketOutcome> {
  const { entity, hub, drivers, equipment, todayIso, canSeePrivate = false } = params
  const items = packetItems(entity, hub, drivers, canSeePrivate)
  const title = entityTitle(entity)

  const result = await buildFilePacket({
    title,
    subtitle: entity.kind === 'DRIVER' ? 'Driver file' : 'Truck file',
    fields: entityFields(entity, drivers, equipment),
    items,
    getUrl: hub.urlFor,
    generatedAt: fmtDate(todayIso),
  })

  saveBlob(packetFilename(title, entity.kind === 'DRIVER' ? 'driver' : 'truck', todayIso), result.bytes)
  return { ...result, itemCount: items.length }
}

/** One toast message describing how the packet turned out. */
export function packetToast(outcome: PacketOutcome): { level: 'success' | 'info' | 'warning'; message: string } {
  const problems = outcome.outcomes.filter((o) => o.outcome !== 'pdf' && o.outcome !== 'image')
  if (problems.length) {
    return {
      level: 'warning',
      message: `Packet built — ${problems.length} file${problems.length !== 1 ? 's' : ''} couldn't be embedded (${problems.map((p) => p.label).join(', ')}). Download those individually.`,
    }
  }
  if (outcome.itemCount === 0) {
    return { level: 'info', message: 'Packet built — no documents on file yet, so it is just the cover sheet.' }
  }
  return { level: 'success', message: `Packet built — ${outcome.itemCount} document${outcome.itemCount !== 1 ? 's' : ''}` }
}
