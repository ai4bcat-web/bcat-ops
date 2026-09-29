import { useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { matchPodDriver } from '@/lib/podDriver'
import type { Driver } from '@/types'
import type { PodDocument, PodSenderMapping } from '@/types/pods'

interface SenderRow {
  phoneDigits: string
  senderName: string
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
  const rows = useMemo<SenderRow[]>(() => {
    const seen = new Map<string, SenderRow>()
    for (const doc of docs) {
      const digits = (doc.senderContact ?? '').replace(/\D/g, '').slice(-10)
      if (digits.length !== 10) continue
      const key = `${digits}|${doc.senderName}`
      if (!seen.has(key)) {
        const existing = mappings.find((m) => m.phoneDigits === digits)
        const auto = matchPodDriver(doc, drivers, mappings)
        seen.set(key, {
          phoneDigits: digits,
          senderName: doc.senderName,
          currentDriverId: existing?.driverId ?? auto?.id ?? null,
        })
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      (a.senderName || a.phoneDigits).localeCompare(b.senderName || b.phoneDigits)
    )
  }, [docs, drivers, mappings])

  const [selections, setSelections] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      for (const row of rows) {
        const selected = selections[row.phoneDigits]
        if (selected === undefined) continue
        const driverId = selected === '' ? null : selected
        await onSave({ phone: row.phoneDigits, senderName: row.senderName, driverId })
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map senders to drivers</DialogTitle>
          <DialogDescription>
            Choose which driver each sender name + phone should be matched to. Setting to “(auto / unmapped)” removes the override.
          </DialogDescription>
        </DialogHeader>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Sender</th>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Phone</th>
              <th style={{ textAlign: 'left', padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>Driver</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.phoneDigits}>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>
                  {row.senderName || <span style={{ color: 'var(--ds-t3)' }}>Unknown sender</span>}
                </td>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)', fontFamily: 'monospace' }}>
                  {row.phoneDigits}
                </td>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid var(--ds-border)' }}>
                  <select
                    value={selections[row.phoneDigits] ?? row.currentDriverId ?? ''}
                    onChange={(e) => setSelections((prev) => ({ ...prev, [row.phoneDigits]: e.target.value }))}
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

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || rows.length === 0}>
            {saving ? 'Saving…' : 'Save mappings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
