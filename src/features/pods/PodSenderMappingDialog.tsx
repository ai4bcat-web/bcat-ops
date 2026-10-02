import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { graphqlErrorText } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import { matchPodDriver } from '@/lib/podDriver'
import { senderKey } from '@/lib/podSenderKey'
import type { Driver } from '@/types'
import type { PodDocument, PodSenderMapping } from '@/types/pods'

interface SenderRow {
  senderKey: string
  senderName: string
  senderContact: string
  currentDriverId: string | null
}

export function PodSenderMappingDialog({
  open,
  onClose,
  docs,
  drivers,
  mappings,
  onSave,
}: {
  open: boolean
  onClose: () => void
  docs: PodDocument[]
  drivers: Driver[]
  mappings: PodSenderMapping[]
  onSave: (input: { phone: string; senderName: string; driverId: string | null }) => Promise<void>
}) {
  const { hasPageAccess } = useAuth()
  const rows = useMemo<SenderRow[]>(() => {
    const seen = new Map<string, SenderRow>()
    // Walk oldest first so a more recent doc's name overwrites stale ones.
    for (const doc of [...docs].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) {
      const key = senderKey(doc)
      if (!key) continue
      const existing = mappings.find((m) => m.senderKey === key)
      const auto = matchPodDriver(doc, drivers, mappings)
      seen.set(key, {
        senderKey: key,
        senderName: doc.senderName,
        senderContact: doc.senderContact,
        currentDriverId: existing?.driverId ?? auto?.id ?? null,
      })
    }
    return Array.from(seen.values()).sort((a, b) =>
      (a.senderName || a.senderKey).localeCompare(b.senderName || b.senderKey)
    )
  }, [docs, drivers, mappings])

  const [selections, setSelections] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const noDrivers = drivers.length === 0

  const handleClose = () => {
    setSelections({})
    setSaveError(null)
    onClose()
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const row of rows) {
        const selected = selections[row.senderKey]
        if (selected === undefined) continue
        const current = row.currentDriverId ?? ''
        if (selected === current) continue
        const driverId = selected === '' ? null : selected
        await onSave({ phone: row.senderContact, senderName: row.senderName, driverId })
      }
      setSelections({})
      setSaveError(null)
      onClose()
    } catch (err) {
      setSaveError(graphqlErrorText(err) || 'Could not save mapping')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map senders to drivers</DialogTitle>
          <DialogDescription>
            Choose which driver each sender should be matched to. Setting to “(auto / unmapped)” removes the override.
          </DialogDescription>
        </DialogHeader>

        {noDrivers && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--ds-red-bg)',
              color: 'var(--ds-red)',
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            <AlertCircle size={16} />
            <span>
              No driver roster available. {hasPageAccess('files') ? (
                <>Add drivers in the <Link to="/files" style={{ textDecoration: 'underline', fontWeight: 600 }}>Files hub</Link>.</>
              ) : (
                'Ask an administrator to add drivers to the roster.'
              )}
            </span>
          </div>
        )}

        {/* Its own scroller, so the dialog never forces the page sideways on a phone. */}
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Sender</th>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Key</th>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Driver</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.senderKey}>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>
                  {row.senderName || <span style={{ color: 'var(--ds-t3)' }}>Unknown sender</span>}
                </td>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)', fontFamily: 'monospace' }}>
                  {row.senderKey}
                </td>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>
                  <select
                    aria-label={`Driver for ${row.senderName || row.senderKey}`}
                    value={selections[row.senderKey] ?? row.currentDriverId ?? ''}
                    onChange={(e) => setSelections((prev) => ({ ...prev, [row.senderKey]: e.target.value }))}
                    disabled={noDrivers || saving}
                    style={{
                      width: '100%',
                      height: 32,
                      borderRadius: 6,
                      border: '1px solid var(--ds-border)',
                      padding: '0 8px',
                      background: 'var(--ds-surface)',
                      color: 'var(--ds-t1)',
                      fontFamily: 'inherit',
                    }}
                  >
                    <option value="">(auto / unmapped)</option>
                    {drivers.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        {saveError && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--ds-red-bg)',
              color: 'var(--ds-red)',
              fontSize: 13,
              marginTop: 12,
            }}
          >
            <AlertCircle size={16} />
            <span>{saveError}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || rows.length === 0 || noDrivers}>
            {saving ? 'Saving…' : 'Save mappings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
