import { useState } from 'react'
import { Copy, Link2, ExternalLink, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '@/store/useAppStore'
import type { Equipment } from '@/types/equipment'

/**
 * The truck's Motive "Share Live Location" link, ready to paste to a customer.
 *
 * Motive makes these in Fleet View (select the truck → Share Location) and does not
 * expose them through its API, so the office pastes each one here once; from then on
 * it is a click to copy. Set the expiration far out when creating it in Motive.
 */
export function TrackingLinkCell({ equip, unit }: { equip: Equipment | undefined; unit: string }) {
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(equip?.trackingUrl ?? '')
  const [copied, setCopied] = useState(false)
  const url = equip?.trackingUrl?.trim() || ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success(`Tracking link for ${unit} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy; open the link and copy it from the address bar')
    }
  }
  const save = async () => {
    if (!equip) return
    const v = draft.trim()
    if (v && !/^https?:\/\//i.test(v)) { toast.error('Paste the full link, starting with https://'); return }
    try {
      await updateEquipment(equip.id, { trackingUrl: v || null })
      toast.success(v ? `Tracking link saved for ${unit}` : `Tracking link removed for ${unit}`)
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      {url ? (
        <>
          <button type="button" onClick={() => void copy()} title={url} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-blue)', fontWeight: 600 }}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={url} target="_blank" rel="noreferrer" title="Open the live map" style={{ display: 'inline-flex', color: 'var(--ds-t3)' }}><ExternalLink className="size-3.5" /></a>
          {equip ? <button type="button" onClick={() => { setDraft(url); setEditing(true) }} title="Change the link" style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', color: 'var(--ds-t3)' }}><Link2 className="size-3.5" /></button> : null}
        </>
      ) : equip ? (
        <button type="button" onClick={() => { setDraft(''); setEditing(true) }} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-t3)' }}>
          <Link2 className="size-3.5" /> Add link
        </button>
      ) : <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>—</span>}

      {editing && equip ? (
        <Dialog open onOpenChange={(o) => { if (!o) setEditing(false) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Tracking link for truck {unit}</DialogTitle>
              <DialogDescription>
                In Motive Fleet View, select truck {unit}, click Share Location, set the expiration as far out as it allows, copy the link, and paste it here. It only works for trucks with a cellular gateway.
              </DialogDescription>
            </DialogHeader>
            <Input id={`tracking-url-${equip.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://…" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button onClick={() => void save()}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
