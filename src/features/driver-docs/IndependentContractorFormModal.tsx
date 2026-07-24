import { useState } from 'react'
import { toast } from 'sonner'
import { X, Loader2, Download } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { uploadComplianceDocument, createComplianceDocument } from '@/lib/complianceClient'
import {
  IC_STATUS_TITLE, IC_STATUS_SPEC,
  emptyICStatus, icStatusContractorComplete, type ICStatusValues,
} from '@/lib/driverDocs'
import { buildICStatusPdf, icStatusPdfFile } from './independentContractorPdf'
import { ICStatusFields } from './ICStatusFields'

interface Props {
  driver: { id: string; name: string; email?: string }
  onClose: () => void
  onSaved: () => void
}

/**
 * Fill + sign the WI Independent Contractor Status form for one driver (office, on behalf),
 * then save the generated PDF to their compliance record. Typed name = e-signature.
 * The public /sign/:token page reuses the same ICStatusFields for driver self-signing.
 */
export function IndependentContractorFormModal({ driver, onClose, onSaved }: Props) {
  const { user } = useAuth()
  const [v, setV] = useState<ICStatusValues>(() => ({ ...emptyICStatus(), printName: driver.name }))
  const [saving, setSaving] = useState(false)
  const allInitialed = v.initials.every(Boolean)

  async function save() {
    if (!icStatusContractorComplete(v)) {
      toast.error('Initial all 14 statements and fill in name, EIN, and signature')
      return
    }
    setSaving(true)
    try {
      const file = icStatusPdfFile(v, driver.name)
      const s3Key = await uploadComplianceDocument('DRIVER', driver.id, IC_STATUS_SPEC.key, file)
      await createComplianceDocument({
        entityType: 'DRIVER', entityId: driver.id, documentType: IC_STATUS_SPEC.key,
        title: IC_STATUS_TITLE, s3Key, issueDate: v.date || new Date().toISOString().slice(0, 10),
        expirationDate: null, status: 'VALID',
        uploadedBy: 'INTERNAL', verifiedBy: user?.email ?? 'internal', verifiedAt: new Date().toISOString(),
      })
      toast.success(`Signed IC Status saved to ${driver.name}’s profile`)
      onSaved()
    } catch (e) {
      toast.error(`Couldn’t save: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 }} onMouseDown={onClose}>
      <div style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', boxShadow: '0 8px 40px rgba(0,0,0,0.25)', width: 720, maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{IC_STATUS_TITLE}</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{driver.name} · initial each statement, then sign</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', padding: 2 }}><X size={18} /></button>
        </div>

        <div style={{ padding: '18px 22px', overflowY: 'auto' }}>
          <ICStatusFields value={v} onChange={setV} />
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => buildICStatusPdf(v).save(`IC-Status-WI-${driver.name.replace(/\s+/g, '-')}.pdf`)}
            style={{ height: 36, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}
          >
            <Download size={14} /> Download PDF
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={saving} style={{ height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={save} disabled={saving || !allInitialed} style={{ height: 36, padding: '0 18px', borderRadius: 8, border: 'none', background: allInitialed ? 'var(--ds-blue)' : 'var(--ds-border)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: allInitialed ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save to driver profile
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
