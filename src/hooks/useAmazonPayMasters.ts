import { useState, useEffect, useCallback } from 'react'
import {
  listAmazonPayMasters, createAmazonPayMaster, deleteAmazonPayMaster,
  uploadPayMasterFile, getPayMasterUrl, deletePayMasterFile,
  type AmazonPayMaster,
} from '@/lib/apiClient'

export type { AmazonPayMaster }

/** Archive of uploaded master CSVs — list, store (S3 + record), download, delete. */
export function useAmazonPayMasters() {
  const [masters, setMasters] = useState<AmazonPayMaster[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { setMasters(await listAmazonPayMasters()) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const archive = useCallback(async (m: {
    fileName: string; periodStart: string; text: string
    uploadedBy?: string | null; rowCount: number; tripCount: number; driverCount: number
  }): Promise<AmazonPayMaster> => {
    const { key, size } = await uploadPayMasterFile(m.periodStart, m.fileName, m.text)
    const created = await createAmazonPayMaster({
      fileName:   m.fileName,
      periodStart: m.periodStart,
      s3Key:      key,
      uploadedAt: new Date().toISOString(),
      uploadedBy: m.uploadedBy ?? null,
      rowCount:   m.rowCount,
      tripCount:  m.tripCount,
      driverCount: m.driverCount,
      sizeBytes:  size,
      notes:      null,
    })
    setMasters((p) => [created, ...p])
    return created
  }, [])

  const remove = useCallback(async (m: AmazonPayMaster) => {
    try { await deletePayMasterFile(m.s3Key) } catch { /* file may already be gone */ }
    await deleteAmazonPayMaster(m.id)
    setMasters((p) => p.filter((x) => x.id !== m.id))
  }, [])

  const download = useCallback(async (m: AmazonPayMaster) => {
    const url = await getPayMasterUrl(m.s3Key)
    window.open(url, '_blank', 'noopener')
  }, [])

  return { masters, loading, refresh: load, archive, remove, download }
}
