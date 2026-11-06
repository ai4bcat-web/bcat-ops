/**
 * The bottom action bar (feedback 19): always visible under the form, 48 px, card background, top
 * border. Left: status chip, "Last saved X ago" / "Unsaved changes", and "N / M required" (click
 * scrolls the rail checklist into view and focuses the first missing row). Right: Cancel, Save draft,
 * Create shipment (create); Save changes, Submit order, Discard (edit). Keeps the old rail test ids.
 */
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { saveStateText } from './saveState'
import { useEffect, useState } from 'react'
import type { RunKind } from './useShipmentForm'

export interface ActionBarProps {
  createMode: boolean
  status: string
  dirty: boolean
  /** ISO: the local draft write (create) or the shipment's updatedAt (edit). */
  savedAt: string | null
  done: number
  total: number
  ready: boolean
  busy: boolean
  voided: boolean
  onRun: (kind: RunKind) => void
  onDiscard: () => void
}

export function ActionBar({ createMode, status, dirty, savedAt, done, total, ready, busy, voided, onRun, onDiscard }: ActionBarProps) {
  const isDraft = status === 'NEW' || status === 'DRAFT'
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const jump = () => {
    const block = document.querySelector<HTMLElement>('[data-testid="rail-required"]')
    block?.scrollIntoView?.({ block: 'center' })
    block?.querySelector<HTMLElement>('[data-done="false"]')?.focus()
  }
  return (
    <div className="tms-ship-actionbar" data-testid="ship-form-actionbar" role="toolbar" aria-label="Shipment actions">
      <div className="tms-ship-actionbar-left">
        <TmsBadge tone={isDraft ? 'gray' : 'blue'} data-testid="ship-form-status">{isDraft ? 'Draft' : status}</TmsBadge>
        <span className="tms-ship-actionbar-save" data-testid="ship-form-savestate" data-dirty={dirty}>{saveStateText(dirty, savedAt, nowMs)}</span>
        <button type="button" className="tms-ship-actionbar-req" data-testid="ship-form-required" data-ready={ready} onClick={jump}>
          {done} / {total} required
        </button>
      </div>
      <div className="tms-ship-actionbar-right">
        <TmsButton size="sm" variant="ghost" data-testid="ship-form-cancel" onClick={onDiscard}>{createMode ? 'Cancel' : 'Discard'}</TmsButton>
        {isDraft ? (
          <TmsButton
            size="sm" data-testid="ship-form-save-draft" disabled={busy || voided} onClick={() => onRun('draft')}
            title={createMode ? 'Autosaves on this browser every 10 s. The first server save consumes a permanent shipment number. ⌘/Ctrl+S' : '⌘/Ctrl+S'}
          >
            Save draft
          </TmsButton>
        ) : null}
        {!createMode && status === 'DRAFT' ? (
          <TmsButton size="sm" data-testid="ship-form-submit" disabled={busy || voided} onClick={() => onRun('submit')}>Submit order</TmsButton>
        ) : null}
        <TmsButton
          size="sm" variant="primary" data-testid={createMode ? 'ship-form-create' : 'ship-form-save'}
          aria-disabled={!ready} data-ready={ready} disabled={busy || voided} onClick={() => onRun(createMode ? 'create' : 'save')}
          title={createMode ? '⌘/Ctrl+Enter' : undefined}
        >
          {createMode ? 'Create shipment' : 'Save changes'}
        </TmsButton>
      </div>
    </div>
  )
}
