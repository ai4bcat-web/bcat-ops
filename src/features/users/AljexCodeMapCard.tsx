/**
 * Settings > Users: Aljex rep / staff code -> user crosswalk (Aljex-exit Phase 0).
 *
 * The import stores the verbatim Aljex codes on each shipment (salesRepCode, createdByCode,
 * serviceRepCode, dispatcherCode) and leaves `salesRepId` empty. This table maps a code to a
 * person later, with no re-import. Saving a mapping never touches a shipment; the sales-rep
 * "Reassign" is the only write, it goes through the SET_SALES_REP rules in the Lambda (settled
 * commissions and voided shipments are skipped there), previews its count first, and is safe to
 * run twice. The Lambda enforces owner/ADMIN; every refusal is shown as written.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsCard } from '@/features/tms/kit'
import { RepPicker } from '@/components/RepPicker'
import { listAljexCodes, reassignShipmentsByRepCode, setAljexCodeMap } from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'
import { useOnVisible } from '@/hooks/useOnVisible'
import type { AljexCodeKind, AljexCodeSummary } from '@/types/tms'

const keyOf = (c: Pick<AljexCodeSummary, 'kind' | 'code'>) => `${c.kind}:${c.code}`
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—')

/**
 * The Lambda counts every code across all shipments (seconds), so the card loads only once it
 * scrolls near the viewport (PERF R6) and shows the same loading card until then.
 */
export function AljexCodeMapCard() {
  const [ref, visible] = useOnVisible('200px')
  return (
    <div ref={ref}>
      {visible
        ? <AljexCodeMapBody />
        : <TmsCard title="Aljex code mapping"><Loader2 size={14} /> Loading codes…</TmsCard>}
    </div>
  )
}

function AljexCodeMapBody() {
  const [codes, setCodes] = useState<AljexCodeSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => listAljexCodes().then(
    (rows) => { setCodes(rows); setDraft({}); setError(null) },
    (err: unknown) => { setError(errorMessage(err)) },
  ), [])

  useEffect(() => {
    let canceled = false
    listAljexCodes().then(
      (rows) => { if (!canceled) { setCodes(rows); setError(null) } },
      (err: unknown) => { if (!canceled) setError(errorMessage(err)) },
    )
    return () => { canceled = true }
  }, [])

  const picked = (c: AljexCodeSummary) => draft[keyOf(c)] ?? c.userId ?? ''

  const save = async (c: AljexCodeSummary) => {
    const userId = picked(c) || null
    setBusy(keyOf(c))
    try {
      await setAljexCodeMap({ kind: c.kind, code: c.code, userId })
      toast.success(userId ? `Code ${c.code} mapped` : `Mapping for ${c.code} cleared`)
      await load()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const reassign = async (c: AljexCodeSummary) => {
    const repId = picked(c)
    if (!repId) return
    setBusy(keyOf(c))
    try {
      const preview = await reassignShipmentsByRepCode({ code: c.code, repId, dryRun: true })
      if (preview.updated === 0) {
        toast.info(`Nothing to change for ${c.code}: ${preview.matched} shipment(s) carry it, ${preview.skippedAlreadyAssigned} already assigned, ${preview.skippedVoided} voided.`)
        return
      }
      const ok = window.confirm(
        `Reassign ${preview.updated} shipment(s) with Aljex rep code ${c.code} to this user?\n\n` +
        `${preview.skippedAlreadyAssigned} already assigned and ${preview.skippedVoided} voided shipment(s) are skipped. ` +
        'Commission rules apply: shipments whose commission is settled are refused and listed. Running it again changes nothing.',
      )
      if (!ok) return
      // The Lambda stops at its time budget and says so; the call is idempotent, so go again until it is done.
      let updated = 0
      const failed: Array<{ shipmentId: string; reason: string }> = []
      for (;;) {
        const result = await reassignShipmentsByRepCode({ code: c.code, repId })
        updated += result.updated
        failed.push(...result.failed)
        if (!result.hasMore) break
      }
      if (failed.length > 0) toast.error(`${updated} reassigned, ${failed.length} refused: ${failed[0].reason}`)
      else toast.success(`${updated} shipment(s) reassigned`)
      await load()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <TmsCard title="Aljex code mapping">
        <p role="alert" style={{ margin: 0, color: 'var(--tms-badge-red)' }}>{error}</p>
        <TmsButton size="sm" onClick={() => void load()}>Retry</TmsButton>
      </TmsCard>
    )
  }
  if (codes == null) {
    return <TmsCard title="Aljex code mapping"><Loader2 size={14} /> Loading codes…</TmsCard>
  }
  if (codes.length === 0) return null

  const section = (kind: AljexCodeKind, title: string, hint: string) => {
    const rows = codes.filter((c) => c.kind === kind)
    if (rows.length === 0) return null
    return (
      <div data-testid={`code-map-${kind}`}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 2px' }}>{title}</h3>
        <p className="tms-field-hint" style={{ margin: '0 0 8px' }}>{hint}</p>
        <table className="tms-table">
          <thead>
            <tr>
              <th>Aljex code</th><th>Shipments</th>{kind === 'SALES_REP' ? <th>To change</th> : null}
              <th>User</th><th>Last applied</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const k = keyOf(c)
              const value = picked(c)
              const dirty = value !== (c.userId ?? '')
              const rowBusy = busy === k
              return (
                <tr key={k}>
                  <td><code>{c.code}</code></td>
                  <td>{c.shipmentCount.toLocaleString('en-US')}</td>
                  {kind === 'SALES_REP' ? <td>{c.pendingCount.toLocaleString('en-US')}</td> : null}
                  <td>
                    <RepPicker
                      value={value}
                      placeholder="Unmapped"
                      disabled={busy != null}
                      onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
                    />
                  </td>
                  <td>{c.lastAppliedAt ? `${when(c.lastAppliedAt)} · ${c.lastAppliedCount ?? 0}` : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <TmsButton size="sm" disabled={busy != null || !dirty} onClick={() => void save(c)} aria-label={`Save mapping for ${c.code}`}>
                      {rowBusy ? <Loader2 size={14} /> : null}Save
                    </TmsButton>
                    {kind === 'SALES_REP' ? (
                      <TmsButton
                        size="sm"
                        variant="primary"
                        disabled={busy != null || !value || (c.pendingCount === 0 && !dirty)}
                        onClick={() => void reassign(c)}
                        aria-label={`Reassign shipments for ${c.code}`}
                      >
                        Reassign…
                      </TmsButton>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <TmsCard title="Aljex code mapping">
      <p className="tms-field-hint" style={{ margin: 0 }}>
        Imported shipments keep the Aljex codes. Map a code to a person here; nothing changes on a shipment until you reassign.
      </p>
      {section('SALES_REP', 'Sales rep codes', 'Reassign sets the sales rep on every shipment carrying the code, under the same rules as changing it by hand.')}
      {section('STAFF', 'Staff codes (created by, service rep, dispatcher)', 'The mapping is stored so these can be shown as people later; it does not reassign anything.')}
    </TmsCard>
  )
}
