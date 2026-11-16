/**
 * "Who would get the tracking link, and when": today's and tomorrow's pickups as the
 * automatic send sees them. Read-only — loading it never texts anyone.
 */
import { useState } from 'react'
import { Eye } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { previewAutoTrackingLinks, type AutoTrackingPreviewRow } from '@/lib/apiClient'
import { chicagoDateStr, formatBoardDateTime, formatTime } from '@/lib/date'
import { ErrorText, GroupLabel, Hint, Panel } from '../settingsKit'

function whenText(row: AutoTrackingPreviewRow, today: string): string {
  const d = row.decision
  if (d.kind === 'SKIP') return d.reason ?? 'Skipped'
  if (!d.sendAt) return '—'
  if (d.kind === 'SEND') return 'Due now'
  return `${chicagoDateStr(d.sendAt) === today ? 'Today' : 'Tomorrow'} ${formatTime(d.sendAt)}`
}

export function AutoTrackingPreview({ enabled }: { enabled: boolean }) {
  const [rows, setRows] = useState<AutoTrackingPreviewRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = chicagoDateStr(new Date())

  const load = async () => {
    setError(null)
    setLoading(true)
    try {
      setRows(await previewAutoTrackingLinks())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the preview')
    } finally { setLoading(false) }
  }

  const scheduled = rows?.filter((r) => r.decision.kind !== 'SKIP') ?? []
  const skipped = rows?.filter((r) => r.decision.kind === 'SKIP') ?? []

  return (
    <Panel>
      <GroupLabel>Automatic tracking links — preview</GroupLabel>
      <Hint>
        {enabled
          ? 'On (saved). These drivers will be texted at the time shown.'
          : 'Off. Nothing is sent; this shows who would be texted, and when, once you turn it on above and save.'}
      </Hint>
      <div>
        <TmsButton size="sm" onClick={load} disabled={loading} data-testid="auto-tracking-preview">
          <Eye size={14} /> {rows ? 'Refresh preview' : 'Preview today and tomorrow'}
        </TmsButton>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      {rows && (
        <div style={{ overflowX: 'auto' }}>
          <table data-testid="auto-tracking-preview-table" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr><th align="left">Shipment</th><th align="left">Pickup</th><th align="left">Carrier · driver</th><th align="left">Phone</th><th align="left">Sends</th></tr>
            </thead>
            <tbody>
              {scheduled.length === 0 && (
                <tr><td colSpan={5}>No outside-carrier pickups today or tomorrow that would get a link.</td></tr>
              )}
              {scheduled.map((r) => (
                <tr key={r.loadCarrierId}>
                  <td>{r.shipmentNumber}</td>
                  <td>{r.pickupAppt ? formatBoardDateTime(r.pickupAppt) : '—'}</td>
                  <td>{[r.carrierName, r.driverName].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{r.phone}</td>
                  <td>{whenText(r, today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {skipped.length > 0 && (
            <Hint>
              Not sending: {skipped.map((r) => `${r.shipmentNumber} (${r.decision.reason ?? 'skipped'})`).join(', ')}
            </Hint>
          )}
        </div>
      )}
    </Panel>
  )
}
