/**
 * The Documents card's Generate row (Step AU): Generate BOL (primary, owns the BolDialog), Rate Con and
 * Send Info (the existing dialogs through `ctx.actions`). A BOL prints what is saved, so the row is
 * off while the form is dirty; a DRAFT shipment may generate a BOL (Rate Con / Send Info still need a carrier).
 */
import { useState } from 'react'
import { TmsButton } from '@/features/tms/kit'
import { BolDialog } from '@/features/shipments/components/BolDialog'
import { LABEL } from '../labels'
import { activeLoadCarrier } from '../model'
import type { FormCtx } from '../sectionProps'

const SAVE_FIRST = 'Save first'

export function GenerateRow({ ctx }: { ctx: FormCtx }) {
  const [open, setOpen] = useState(false)
  const { bundle } = ctx
  const saved = ctx.mode === 'edit' && bundle != null
  const voided = ctx.locked.voided || bundle?.shipment.status === 'CANCELED'
  const active = activeLoadCarrier(bundle) != null

  const gate = !saved
    ? 'Create the shipment first'
    : voided
      ? 'This shipment is voided'
      : ctx.dirty
        ? SAVE_FIRST
        : ctx.busy
          ? 'Another action is running'
          : null
  const carrierGate = gate ?? (active ? null : 'Cover a carrier first')

  return (
    <div className="tms-card-generate" data-testid="card-documents-generate">
      <TmsButton
        size="sm" variant="primary" data-testid="card-documents-generate-bol"
        disabled={gate != null} title={gate ?? undefined}
        onClick={() => { ctx.directory.ensureLocations?.(); setOpen(true) }}
      >
        {LABEL.documents.generateBol.text}
      </TmsButton>
      <TmsButton
        size="sm" data-testid="card-documents-generate-ratecon"
        disabled={carrierGate != null} title={carrierGate ?? undefined} onClick={ctx.actions.openSendRateCon}
      >
        {LABEL.documents.rateCon.text}
      </TmsButton>
      <TmsButton
        size="sm" data-testid="card-documents-generate-info"
        disabled={carrierGate != null} title={carrierGate ?? undefined} onClick={ctx.actions.openSendInfo}
      >
        {LABEL.documents.sendInfo.text}
      </TmsButton>
      {gate === SAVE_FIRST && <span className="tms-muted text-xs" data-testid="card-documents-generate-hint">{SAVE_FIRST}</span>}
      {open && bundle && (
        <BolDialog
          bundle={bundle}
          customer={ctx.customer}
          locations={ctx.directory.locations}
          settings={ctx.settings}
          onClose={() => setOpen(false)}
          onSaved={() => { void ctx.refreshBundle() }}
        />
      )}
    </div>
  )
}
