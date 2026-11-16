/**
 * Upload one file to a shipment's Documents: presign, PUT the bytes, then COMMIT_DOCUMENT
 * (which writes the ShipmentDocument row and re-runs the order's document gate). The shipment
 * editor's Documents card and the tracking view's POD box both call this, so a POD uploaded
 * from Tracking is the same document the editor, the board, Load Review and settlements read.
 */
import { commitDocument, prepareDocumentUpload, putPresignedFile } from '@/lib/apiClient'
import type { ShipmentBundle, ShipmentDocumentType } from '@/types/tms'

/** A commit right after the PUT can beat S3's read-after-write; one retry covers it. */
export const COMMIT_RETRY_MS = 1500

export async function uploadShipmentDocument(
  bundle: Pick<ShipmentBundle, 'shipment' | 'orders'>,
  file: File,
  audience: 'ALL' | 'INTERNAL',
  type: ShipmentDocumentType,
): Promise<ShipmentBundle> {
  const base = { name: file.name, contentType: file.type, sizeBytes: file.size }
  const prepared = await prepareDocumentUpload({ shipmentId: bundle.shipment.id, type, ...base })
  await putPresignedFile(prepared.uploadUrl, file, file.type)
  const commit = () => commitDocument({
    shipmentId: bundle.shipment.id, documentId: prepared.documentId, s3Key: prepared.s3Key, type, ...base,
    orderId: bundle.orders[0]?.id ?? null, loadId: null, loadCarrierId: null, audience,
  })
  try {
    return (await commit()).bundle
  } catch (err) {
    if (!(err instanceof Error) || !/has not landed/i.test(err.message)) throw err
    await new Promise<void>((resolve) => { setTimeout(resolve, COMMIT_RETRY_MS) })
    return (await commit()).bundle
  }
}
