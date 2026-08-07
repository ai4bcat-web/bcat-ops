import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { X, EyeOff } from 'lucide-react'
import { DRIVER_FILE_SLOTS, TRUCK_FILE_SLOTS, DEFAULT_PRIVATE_DOC_TYPES, getPrivateDocTypes } from '@/lib/fileHub'
import { useComplianceSettings } from '@/hooks/useComplianceSettings'

/**
 * Admin-only control over which document types are hidden from everyone else.
 *
 * The list lives in ComplianceSettings rather than in code, so it changes without a
 * deploy. Hidden documents disappear completely — no tile, no "missing" placeholder,
 * excluded from the completeness dots and from downloadable packets.
 *
 * This is presentation-level: hidden documents remain readable through the API by any
 * authenticated user. The modal says so, so nobody mistakes it for real access control.
 */
export function PrivateDocsModal({ onClose }: { onClose: () => void }) {
  const { settings, patch } = useComplianceSettings()
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)

  // Every slot a document could occupy, de-duplicated across drivers and assets.
  const allSlots = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; group: string }>()
    for (const s of DRIVER_FILE_SLOTS) if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, group: 'Driver' })
    for (const s of TRUCK_FILE_SLOTS) if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, group: 'Truck & trailer' })
    return [...seen.values()]
  }, [])

  const current = selected ?? new Set(settings?.privateDocumentTypes ?? getPrivateDocTypes())

  const toggle = (key: string) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    setSelected(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      await patch({ privateDocumentTypes: [...current] })
      toast.success('Private documents updated')
      onClose()
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : 'unknown error'}`)
      setSaving(false)
    }
  }

  const groups = ['Driver', 'Truck & trailer']

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--ds-surface)', borderRadius: 14, width: 520, maxWidth: '94vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
          <EyeOff size={17} style={{ color: 'var(--ds-t3)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>Private documents</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Hidden from everyone except admins</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{g}</div>
              {allSlots.filter((s) => s.group === g).map((s) => (
                <label key={s.key}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', fontSize: 13, color: 'var(--ds-t1)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={current.has(s.key)} onChange={() => toggle(s.key)} />
                  {s.label}
                  <span style={{ fontSize: 11, color: 'var(--ds-t3)', fontFamily: 'var(--font-mono, monospace)' }}>{s.key}</span>
                </label>
              ))}
            </div>
          ))}

          <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.5, borderTop: '1px solid var(--ds-border)', paddingTop: 10 }}>
            A private document is hidden completely — no tile, no “missing” marker, left out of the
            completeness count and of downloadable packets, so its existence isn’t implied.
            <br /><br />
            <b>This hides documents in the app only.</b> Anyone signed in could still retrieve them
            through the API. Treat it as tidiness, not as a security boundary.
            {settings?.privateDocumentTypes == null && (
              <><br /><br />Currently using the defaults ({DEFAULT_PRIVATE_DOC_TYPES.join(', ')}).</>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--ds-border)' }}>
          <button onClick={onClose} disabled={saving}
            style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={save} disabled={saving || !settings}
            style={{ height: 34, padding: '0 18px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: saving ? 'wait' : 'pointer', opacity: saving || !settings ? 0.6 : 1, fontFamily: 'inherit' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
