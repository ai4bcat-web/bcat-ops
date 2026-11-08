import { useState } from 'react'
import { Copy, Link2, ExternalLink, Check, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/useAppStore'
import { newTrackingCode, trackingLinkFor } from '@/lib/trackingClient'
import type { Equipment } from '@/types/equipment'

/**
 * The truck's permanent tracking link, on our own domain: /track/<code>. Created once with
 * a click; copied with a click; regenerated to revoke every copy handed out (the old link
 * then says it is no longer active). A legacy Motive share link, if one was pasted before,
 * is shown only until a BCAT link exists.
 */
export function TrackingLinkCell({ equip, unit }: { equip: Equipment | undefined; unit: string }) {
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const [copied, setCopied] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const code = equip?.trackingCode?.trim() || ''
  const url = code ? trackingLinkFor(code) : (equip?.trackingUrl?.trim() || '')

  const copy = async (u: string) => {
    try {
      await navigator.clipboard.writeText(u)
      setCopied(true)
      toast.success(`Tracking link for ${unit} copied`, { description: u })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy; open the link and copy it from the address bar')
    }
  }
  const create = async (regenerating: boolean) => {
    if (!equip) return
    const next = newTrackingCode()
    try {
      await updateEquipment(equip.id, { trackingCode: next })
      setConfirmRegen(false)
      await copy(trackingLinkFor(next))
      if (regenerating) toast.message(`Old tracking link for ${unit} is now dead`, { description: 'Anyone holding it sees "no longer active".' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the link')
    }
  }

  if (!equip) return <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>—</span>

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      {url ? (
        <>
          <button type="button" onClick={() => void copy(url)} title={url} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tms-primary)', fontWeight: 600 }}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={url} target="_blank" rel="noreferrer" title="Open the tracking page" style={{ display: 'inline-flex', color: 'var(--tms-muted)' }}><ExternalLink className="size-3.5" /></a>
          {code ? (
            confirmRegen ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                <span style={{ color: 'var(--tms-badge-orange)' }}>Kill the old link?</span>
                <button type="button" onClick={() => void create(true)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--tms-badge-orange)', fontWeight: 700 }}>Yes</button>
                <button type="button" onClick={() => setConfirmRegen(false)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--tms-muted)' }}>No</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmRegen(true)} title="Regenerate: the current link stops working and a new one is copied" style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', color: 'var(--tms-muted)' }}><RefreshCw className="size-3.5" /></button>
            )
          ) : (
            <button type="button" onClick={() => void create(false)} title="Replace the pasted Motive link with a permanent BCAT link" style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--tms-muted)' }}><Link2 className="size-3.5" /> BCAT link</button>
          )}
        </>
      ) : (
        <button type="button" onClick={() => void create(false)} title="Create this truck's permanent tracking link and copy it" style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--tms-primary)', fontWeight: 600 }}>
          <Link2 className="size-3.5" /> Create link
        </button>
      )}
    </div>
  )
}
