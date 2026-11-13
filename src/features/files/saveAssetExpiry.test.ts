import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import { saveAssetExpiry } from './saveAssetExpiry'
import type { ComplianceDocument } from '@/types'

const doc: ComplianceDocument = {
  id: 'doc-1', entityType: 'TRUCK', entityId: 'trl-1', documentType: 'insurance_cert', title: 'Insurance',
  s3Key: 'k', expirationDate: '2026-12-31', status: 'VALID', uploadedBy: 'INTERNAL',
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
}

describe('saveAssetExpiry', () => {
  const saveEquipmentDates = vi.fn(async () => {})
  beforeEach(() => {
    saveEquipmentDates.mockClear()
    useAppStore.setState({ saveEquipmentDates })
  })

  it('writes the trailer record and its uploaded certificate', async () => {
    const setExpiration = vi.fn(async () => doc)
    await saveAssetExpiry({ assetId: 'trl-1', documentType: 'insurance_cert', date: '2027-06-30', doc, setExpiration })
    expect(saveEquipmentDates).toHaveBeenCalledWith('trl-1', { insuranceExpirationDate: '2027-06-30' })
    expect(setExpiration).toHaveBeenCalledWith(doc, '2027-06-30')
  })

  it('writes only the record when no file is uploaded', async () => {
    const setExpiration = vi.fn(async () => doc)
    await saveAssetExpiry({ assetId: 'trl-1', documentType: 'insurance_cert', date: '2027-06-30', doc: undefined, setExpiration })
    expect(saveEquipmentDates).toHaveBeenCalledWith('trl-1', { insuranceExpirationDate: '2027-06-30' })
    expect(setExpiration).not.toHaveBeenCalled()
  })

  it('does not touch the certificate when the record write fails', async () => {
    saveEquipmentDates.mockRejectedValueOnce(new Error('denied'))
    const setExpiration = vi.fn(async () => doc)
    await expect(saveAssetExpiry({ assetId: 'trl-1', documentType: 'insurance_cert', date: null, doc, setExpiration })).rejects.toThrow('denied')
    expect(setExpiration).not.toHaveBeenCalled()
  })
})
