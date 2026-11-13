/**
 * Admin customer removal (Ryne 2026-11-12). One customer at a time — a bulk selection steps
 * through them. The server counts what points at the customer first:
 *  - nothing with history → Delete permanently (snapshotted to the audit log);
 *  - history → Merge into another customer (every record moves, then the duplicate is removed)
 *    or Archive (hidden, reversible with Restore).
 * Delete and merge need the customer's name typed back. Everything is enforced server-side.
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { deleteCustomer, mergeCustomer, previewDeleteCustomer, type CustomerDeletePreview } from '@/lib/apiClient'
import { normalizeCustomerName } from '@/lib/customerDuplicates'
import type { CustomerRecord } from '@/types/tms'

type Mode = 'delete' | 'merge' | 'archive'

export function CustomerRemoveDialog({ queue, customers, onArchive, onRemoved, onClose }: {
  queue: readonly CustomerRecord[]
  /** Everything the page knows (archived too): merge targets come from the active ones. */
  customers: readonly CustomerRecord[]
  onArchive: (c: CustomerRecord) => Promise<unknown>
  /** The customer is gone server-side (deleted or merged away). */
  onRemoved: (id: string) => void
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const current = queue[index] ?? null
  const [preview, setPreview] = useState<CustomerDeletePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('merge')
  const [targetId, setTargetId] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!current) return
    let live = true
    previewDeleteCustomer(current.id)
      .then((p) => {
        if (!live) return
        setPreview(p)
        setMode(p.canHardDelete ? 'delete' : 'merge')
        // A same-name active account is the likely survivor.
        const twin = customers.find((c) => c.id !== current.id && c.active !== false && !c.mergedIntoId && normalizeCustomerName(c.name) === normalizeCustomerName(current.name))
        if (twin) setTargetId(twin.id)
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [current, customers])

  const targets = useMemo(
    () => customers.filter((c) => current && c.id !== current.id && c.active !== false && !c.mergedIntoId).sort((a, b) => a.name.localeCompare(b.name)),
    [customers, current],
  )

  if (!current) return null
  const next = () => {
    if (index + 1 >= queue.length) { onClose(); return }
    setPreview(null); setError(null); setTyped(''); setTargetId('')
    setIndex(index + 1)
  }
  const nameOk = typed.trim().toLowerCase() === current.name.trim().toLowerCase()
  const target = targets.find((c) => c.id === targetId) ?? null
  const ready = !busy && preview != null && (mode === 'archive' || (nameOk && (mode === 'delete' ? preview.canHardDelete : target != null)))

  const run = async () => {
    setBusy(true)
    try {
      if (mode === 'delete') {
        await deleteCustomer(current.id, typed)
        onRemoved(current.id)
        toast.success(`Deleted ${current.name}`)
      } else if (mode === 'merge' && target) {
        const out = await mergeCustomer(current.id, target.id, typed)
        onRemoved(current.id)
        const n = Object.values(out.moved).reduce((a, b) => a + b, 0)
        toast.success(`Merged ${current.name} into ${target.name} — ${n} record${n === 1 ? '' : 's'} moved`)
      } else {
        await onArchive(current)
        toast.success(`Archived ${current.name}`)
      }
      next()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const label = mode === 'delete' ? 'Delete permanently' : mode === 'merge' ? 'Merge and remove' : 'Archive'
  return (
    <TmsDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title={queue.length > 1 ? `Remove customer · ${index + 1} of ${queue.length}` : 'Remove customer'}
      footer={
        <>
          {queue.length > 1 && <TmsButton onClick={next} disabled={busy}>Skip</TmsButton>}
          <TmsButton onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant={mode === 'archive' ? 'primary' : 'destructive'} disabled={!ready} onClick={() => void run()} data-testid="customer-remove-confirm">
            {busy ? 'Working…' : label}
          </TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }} data-testid="customer-remove-dialog">
        <div><strong>{current.name}</strong>{current.active === false && <> <TmsBadge>ARCHIVED</TmsBadge></>}</div>
        {error && <div role="alert" className="tms-field-error">{error}</div>}
        {!preview && !error && <div className="tms-muted">Counting linked records…</div>}
        {preview && (
          <>
            <table className="tms-table" data-testid="customer-remove-links">
              <tbody>
                {preview.links.filter((l) => l.count > 0).map((l) => (
                  <tr key={l.key}><td>{l.label}</td><td style={{ textAlign: 'right' }}>{l.count}</td></tr>
                ))}
                {preview.links.every((l) => l.count === 0) && <tr><td className="tms-muted">Nothing points at this customer.</td></tr>}
              </tbody>
            </table>
            <div role="radiogroup" aria-label="What to do" style={{ display: 'grid', gap: 6 }}>
              {preview.canHardDelete ? (
                <label><input type="radio" name="customer-remove-mode" checked={mode === 'delete'} onChange={() => setMode('delete')} /> Delete permanently — nothing has used this customer</label>
              ) : (
                <div className="tms-muted">It has history, so it can't be deleted outright. Merge it into the right customer, or archive it.</div>
              )}
              <label><input type="radio" name="customer-remove-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge into another customer — every record moves over, AP/NOA e-mails and contacts are kept, then this one is removed</label>
              {current.active !== false && (
                <label><input type="radio" name="customer-remove-mode" checked={mode === 'archive'} onChange={() => setMode('archive')} /> Archive — hidden from lists and pickers, can be restored</label>
              )}
            </div>
            {mode === 'merge' && (
              <TmsField label="Merge into">
                <TmsSelect aria-label="Merge into" value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="customer-merge-target">
                  <option value="">Pick the customer to keep…</option>
                  {targets.map((c) => <option key={c.id} value={c.id}>{c.name}{c.mcNumber ? ` · MC ${c.mcNumber}` : ''}</option>)}
                </TmsSelect>
              </TmsField>
            )}
            {mode !== 'archive' && (
              <TmsField label={`Type "${current.name}" to confirm`}>
                <TmsInput aria-label="Type the customer name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </TmsField>
            )}
            {mode === 'merge' && <div className="tms-muted">Sent invoices keep their number, PDF and bill-to; only which customer they belong to changes.</div>}
          </>
        )}
      </div>
    </TmsDialog>
  )
}
