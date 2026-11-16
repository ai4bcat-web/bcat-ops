/**
 * "Marked built" (Ryne 2026-11-16): intake e-mails linked to a shipment in the last 14 days, by hand or by the already-built
 * auto-link, with Unlink to put one back in the queue when the wrong PRO was used.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton } from '@/features/tms/kit'
import { unlinkIntakeShipment } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import type { IntakeLoadRecord } from '@/types/intake'
import { useIntakeLoads } from './useIntakeLoads'
import { recentlyBuilt } from './markBuilt'

export function RecentlyBuiltPanel({ onUnlinked }: { onUnlinked: () => void }) {
  const moved = useIntakeLoads({ status: 'MOVED' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = recentlyBuilt(moved.rows)

  async function unlink(row: IntakeLoadRecord) {
    setBusy(true)
    try {
      await unlinkIntakeShipment({ intakeId: row.id })
      toast.success('Back in the Intake queue')
      setConfirming(null)
      moved.refresh()
      onUnlinked()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="tms-intake-built-panel" data-testid="intake-built-panel" aria-label="Marked built">
      <header className="tms-intake-built-head">Marked built · last 14 days</header>
      {moved.loading ? <TmsBadge tone="gray">Loading…</TmsBadge> : null}
      {!moved.loading && rows.length === 0 ? <p className="tms-intake-built-empty">Nothing linked in the last 14 days.</p> : null}
      <ul className="tms-intake-built-list">
        {rows.map((r) => (
          <li key={r.id} className="tms-intake-built-row" data-testid="intake-built-row">
            <span className="tms-intake-built-subject">{r.fromName || r.fromEmail} · {r.subject || '(no subject)'}</span>
            <span className="tms-intake-built-pro">
              → {r.shipmentId ? <Link to={shipmentEditorPath(r.shipmentId)}>PRO {r.shipmentNumber ?? '—'}</Link> : '—'}
            </span>
            <span className="tms-intake-built-when">{formatDateTime(r.updatedAt)} · {r.updatedBy || '—'}</span>
            {confirming === r.id ? (
              <span className="tms-intake-built-actions">
                <span>Put back in the queue?</span>
                <TmsButton size="sm" onClick={() => setConfirming(null)}>Cancel</TmsButton>
                <TmsButton size="sm" variant="destructive" data-testid="intake-unlink-confirm" disabled={busy} onClick={() => { void unlink(r) }}>Unlink</TmsButton>
              </span>
            ) : (
              <TmsButton size="sm" variant="ghost" data-testid="intake-unlink" onClick={() => setConfirming(r.id)}>Unlink</TmsButton>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
