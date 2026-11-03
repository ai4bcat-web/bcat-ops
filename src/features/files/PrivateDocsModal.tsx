import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  DRIVER_FILE_SLOTS, TRUCK_FILE_SLOTS, DEFAULT_PRIVATE_DOC_TYPES, getPrivateDocTypes,
  responsibilityFor, RESPONSIBILITY_LABELS, type Responsibility,
} from '@/lib/fileHub'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
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
  const [owners, setOwners] = useState<Record<string, Responsibility> | null>(null)
  const [saving, setSaving] = useState(false)

  // Every slot a document could occupy, de-duplicated across drivers and assets.
  const allSlots = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; group: string }>()
    for (const s of DRIVER_FILE_SLOTS) if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, group: 'Driver' })
    for (const s of TRUCK_FILE_SLOTS) if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, group: 'Truck & trailer' })
    return [...seen.values()]
  }, [])

  const current = selected ?? new Set(settings?.privateDocumentTypes ?? getPrivateDocTypes())
  const ownerOf = (key: string): Responsibility => owners?.[key] ?? responsibilityFor(key)
  const setOwner = (key: string, value: Responsibility) =>
    setOwners({ ...(owners ?? {}), [key]: value })

  const toggle = (key: string) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    setSelected(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      await patch({
        privateDocumentTypes: [...current],
        ...(owners ? { documentResponsibility: owners } : {}),
      })
      toast.success('Private documents updated')
      onClose()
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : 'unknown error'}`)
      setSaving(false)
    }
  }

  const groups = ['Driver', 'Truck & trailer']

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Document settings"
      description="Tick to hide from non-admins · set who maintains it"
      footer={(
        <>
          <TmsButton onClick={onClose} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={save} disabled={saving || !settings}>
            {saving ? 'Saving…' : 'Save'}
          </TmsButton>
        </>
      )}
    >
    {groups.map((g) => (
      <div key={g} style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{g}</div>
        {allSlots.filter((s) => s.group === g).map((s) => (
          <div key={s.key}
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', fontSize: 12.5, color: 'var(--tms-text)' }}>
            <input type="checkbox" id={`priv-${s.key}`} checked={current.has(s.key)} onChange={() => toggle(s.key)}
              title="Hide from everyone except admins" />
            <label htmlFor={`priv-${s.key}`} style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.label}
            </label>
            <select value={ownerOf(s.key)} onChange={(e) => setOwner(s.key, e.target.value as Responsibility)}
              title="Who is responsible for keeping this current"
              className="tms-select" style={{ width: 'auto', height: 26, fontSize: 11.5 }}>
              <option value="OFFICE">{RESPONSIBILITY_LABELS.OFFICE}</option>
              <option value="DRIVER">{RESPONSIBILITY_LABELS.DRIVER}</option>
            </select>
          </div>
        ))}
      </div>
    ))}

    <div style={{ fontSize: 11.5, color: 'var(--tms-muted)', lineHeight: 1.5, borderTop: '1px solid var(--tms-border)', paddingTop: 10 }}>
      A private document is hidden completely — no tile, no “missing” marker, left out of the
      completeness count and of downloadable packets, so its existence isn’t implied.
      <br /><br />
      <b>This hides documents in the app only.</b> Anyone signed in could still retrieve them
      through the API. Treat it as tidiness, not as a security boundary.
      {settings?.privateDocumentTypes == null && (
        <><br /><br />Currently using the defaults ({DEFAULT_PRIVATE_DOC_TYPES.join(', ')}).</>
      )}
    </div>
    </TmsDialog>
  )
}
