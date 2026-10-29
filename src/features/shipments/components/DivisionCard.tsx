/**
 * Who owns the money on this shipment: the revenue division it is tagged with, how it
 * got that tag, and the sales rep who gets credit for it.
 *
 * The tag is normally resolved by the ownership rules at booking time, so the card's
 * first job is to say which rule decided and let an admin see it. A hand tag beats the
 * rules and survives a carrier change, which is why "Back to rules" is a separate,
 * deliberate action rather than a cleared field.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import { listOwnershipDivisions, listOwnershipRules } from '@/lib/apiClient'
import { TmsButton, TmsCard, TmsDialog, TmsField, TmsSelect } from '@/features/tms/kit'
import type { OwnershipDivisionRecord, OwnershipRuleRecord, ShipmentRecord } from '@/types/tms'

export interface DivisionCardProps {
  shipment: ShipmentRecord
  /** Owner, ADMIN or `page-tms`: the three the router accepts for a hand tag. */
  canTag: boolean
  busy: boolean
  onSetRevTag: (input: { divisionCode: string; subdivisionCode?: string }) => Promise<void>
  onClearRevTag: () => Promise<void>
  onSetSalesRep: (repId: string | null) => Promise<void>
}

export function DivisionCard({ shipment, canTag, busy, onSetRevTag, onClearRevTag, onSetSalesRep }: DivisionCardProps) {
  const [divisions, setDivisions] = useState<OwnershipDivisionRecord[]>([])
  const [rules, setRules] = useState<OwnershipRuleRecord[]>([])
  const [editing, setEditing] = useState(false)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    Promise.all([
      listOwnershipDivisions().catch(() => [] as OwnershipDivisionRecord[]),
      listOwnershipRules().catch(() => [] as OwnershipRuleRecord[]),
    ]).then(([d, r]) => {
      if (!live) return
      setDivisions(d)
      setRules(r)
    })
    return () => { live = false }
  }, [])

  const division = divisions.find((d) => d.code === shipment.revDivision) ?? null
  const subdivision = divisions.find((d) => d.code === shipment.revSubdivision) ?? null
  const rule = rules.find((r) => r.id === shipment.revRuleId) ?? null
  const handTagged = shipment.revTagSource === 'HAND'

  const label = division?.name ?? shipment.revDivision ?? 'Untagged'
  const chipColor = division?.color ?? null

  const provenance = handTagged
    ? `Hand-tagged by ${shipment.revTaggedBy ?? shipment.updatedBy}`
    : shipment.revDivision
      ? `Tagged by rule ${rule?.name ?? rule?.id ?? shipment.revRuleId ?? '—'}`
      : 'No rule has tagged this shipment yet.'

  return (
    <TmsCard
      title="Division"
      actions={canTag ? (
        <>
          <TmsButton size="sm" disabled={busy} onClick={() => setEditing(true)}>Set tag…</TmsButton>
          {handTagged && (
            <TmsButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => { void onClearRevTag().catch(() => { /* already reported */ }) }}
            >
              Back to rules
            </TmsButton>
          )}
        </>
      ) : undefined}
    >
      <div className="space-y-3" data-testid="division-card">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="tms-badge"
            data-testid="division-chip"
            style={chipColor ? { background: chipColor, color: '#121212' } : undefined}
          >
            {label}{subdivision ? ` · ${subdivision.name}` : shipment.revSubdivision ? ` · ${shipment.revSubdivision}` : ''}
          </span>
        </div>
        <p className="tms-muted" data-testid="division-provenance">{provenance}</p>

        <TmsField label="Sales rep">
          <RepPicker
            value={shipment.salesRepId ?? ''}
            allowUnknown
            disabled={busy}
            placeholder="Pick a sales rep…"
            onChange={(value) => { void onSetSalesRep(value.trim() || null).catch(() => { /* already reported */ }) }}
          />
        </TmsField>
      </div>

      {editing && (
        <SetTagDialog
          divisions={divisions}
          currentDivision={shipment.revDivision ?? ''}
          currentSubdivision={shipment.revSubdivision ?? ''}
          busy={busy}
          onClose={() => setEditing(false)}
          onConfirm={async (input) => {
            try {
              await onSetRevTag(input)
              setEditing(false)
            } catch { /* already reported */ }
          }}
        />
      )}
    </TmsCard>
  )
}

function SetTagDialog({ divisions, currentDivision, currentSubdivision, busy, onClose, onConfirm }: {
  divisions: OwnershipDivisionRecord[]
  currentDivision: string
  currentSubdivision: string
  busy: boolean
  onClose: () => void
  onConfirm: (input: { divisionCode: string; subdivisionCode?: string }) => Promise<void>
}) {
  const [divisionCode, setDivisionCode] = useState(currentDivision)
  const [subdivisionCode, setSubdivisionCode] = useState(currentSubdivision)

  const active = divisions.filter((d) => d.active)
  const top = active.filter((d) => !d.parentId).sort((a, b) => a.sortOrder - b.sortOrder)
  const parent = active.find((d) => d.code === divisionCode) ?? null
  const children = parent
    ? active.filter((d) => d.parentId === parent.id).sort((a, b) => a.sortOrder - b.sortOrder)
    : []

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Set the division tag"
      description="A hand tag beats the ownership rules and survives a carrier or driver change."
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            disabled={busy || !divisionCode}
            onClick={() => {
              if (!divisionCode) { toast.error('Pick a division.'); return }
              void onConfirm({ divisionCode, subdivisionCode: subdivisionCode || undefined })
            }}
          >
            {busy ? 'Tagging…' : 'Set tag'}
          </TmsButton>
        </>
      }
    >
      <div className="space-y-3">
        <TmsField label="Division">
          <TmsSelect
            aria-label="Division"
            value={divisionCode}
            onChange={(e) => { setDivisionCode(e.target.value); setSubdivisionCode('') }}
          >
            <option value="">— select —</option>
            {top.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Subdivision">
          <TmsSelect
            aria-label="Subdivision"
            value={subdivisionCode}
            disabled={children.length === 0}
            onChange={(e) => setSubdivisionCode(e.target.value)}
          >
            <option value="">{children.length === 0 ? '— none —' : '— whole division —'}</option>
            {children.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
          </TmsSelect>
        </TmsField>
      </div>
    </TmsDialog>
  )
}
