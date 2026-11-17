/**
 * Waiting-for-detention / waiting-for-TONU flags on one row of a list that is not the Shipments board (the Calendar): the two
 * pills a flagged shipment wears, and a small menu that raises, edits or clears either. The dialogs and the writes are the
 * board's own (`Detention.tsx`, `Tonu.tsx`), so a flag set here is the flag the board, Load Review and the shipment page show.
 */
import { useState } from 'react'
import { Flag, Hourglass, PackageX } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { parseDetentionFlag } from '@/lib/detentionFlag'
import { parseTonuFlag } from '@/lib/tonuFlag'
import { DetentionDialog, DetentionPill, type DetentionTarget } from './Detention'
import { TonuDialog, TonuPill } from './Tonu'

export type AccessorialFlagTarget = DetentionTarget & { tonuFlag?: unknown }

export function AccessorialFlags({ target, onChanged, disabled }: {
  target: AccessorialFlagTarget
  /** Called after a flag is raised, edited or cleared, so the list can re-read the shipment. */
  onChanged?: () => void
  disabled?: boolean
}) {
  const [dialog, setDialog] = useState<'detention' | 'tonu' | null>(null)
  const detained = parseDetentionFlag(target.detentionFlag) != null
  const tonu = parseTonuFlag(target.tonuFlag) != null
  return (
    <span className="flex items-center gap-1 shrink-0" data-testid="accessorial-flags" onClick={(e) => e.stopPropagation()}>
      <DetentionPill flag={target.detentionFlag} onClick={() => setDialog('detention')} />
      <TonuPill flag={target.tonuFlag} onClick={() => setDialog('tonu')} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Flag waiting for detention or TONU"
            title="Flag waiting for detention or TONU"
            disabled={disabled}
            className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground disabled:opacity-30"
            data-testid="accessorial-flag-menu"
          >
            <Flag className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="tms-portal w-56">
          <DropdownMenuLabel>Billing flags</DropdownMenuLabel>
          <DropdownMenuItem data-testid="flag-detention" onSelect={() => setDialog('detention')}>
            <Hourglass size={14} className="mr-2" />{detained ? 'Edit detention…' : 'Flag waiting for detention…'}
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="flag-tonu" onSelect={() => setDialog('tonu')}>
            <PackageX size={14} className="mr-2" />{tonu ? 'Edit TONU…' : 'Flag waiting for TONU…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'detention' && <DetentionDialog target={target} onClose={() => setDialog(null)} onSaved={() => onChanged?.()} />}
      {dialog === 'tonu' && <TonuDialog target={target} onClose={() => setDialog(null)} onSaved={() => onChanged?.()} />}
    </span>
  )
}
