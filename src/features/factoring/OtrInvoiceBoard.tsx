/**
 * OTR's invoice board: every PRO we have sent them, and where it stands.
 *
 * Built from what the hourly poller already mirrored onto each queue row, so opening this
 * costs nothing. OTR is a paid API and polling it on a timer would bill us for answers
 * that rarely change — an invoice sits in one status for days. So there is one explicit
 * Refresh, which asks OTR about the invoices on screen and nothing else, and the time of
 * the last sync is shown so nobody has to guess how current it is.
 */
import { useMemo, useState } from 'react'
import { RefreshCw, ExternalLink, AlertTriangle, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { syncOtrStatus } from '@/lib/otrClient'
import { cn } from '@/lib/utils'
import type { FactoringItem } from '@/types'

/** OTR's own board values, grouped by what they mean for us. */
const STATUS_TONE: Record<string, { bg: string; fg: string; border: string }> = {
  paid:             { bg: '#dcfce7', fg: '#15803d', border: '#86efac' },
  'advance paid':   { bg: '#dcfce7', fg: '#15803d', border: '#86efac' },
  approved:         { bg: '#dbeafe', fg: '#1d4ed8', border: '#93c5fd' },
  pending:          { bg: '#fef3c7', fg: '#b45309', border: '#fcd34d' },
  'advance pending':{ bg: '#fef3c7', fg: '#b45309', border: '#fcd34d' },
  'client request': { bg: '#fee2e2', fg: '#b91c1c', border: '#fca5a5' },
  'otr follow-up':  { bg: '#fee2e2', fg: '#b91c1c', border: '#fca5a5' },
  duplicate:        { bg: '#fee2e2', fg: '#b91c1c', border: '#fca5a5' },
}

function tone(status: string | null | undefined) {
  return STATUS_TONE[(status ?? '').trim().toLowerCase()] ?? { bg: 'var(--ds-bg)', fg: 'var(--ds-t2)', border: 'var(--ds-border)' }
}

const money = (cents: number | null | undefined) =>
  cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const TH: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600,
  color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: 'var(--ds-t1)', whiteSpace: 'nowrap' }

export function OtrInvoiceBoard({
  items, onChanged,
}: {
  items: FactoringItem[]
  onChanged: () => void
}) {
  const [syncing, setSyncing] = useState(false)

  // Only rows that actually reached OTR have a board position.
  const submitted = useMemo(
    () => items
      .filter((i) => (i.otrInvoiceId ?? '').trim())
      .sort((a, b) => String(b.otrSubmittedAt ?? '').localeCompare(String(a.otrSubmittedAt ?? ''))),
    [items],
  )

  const lastSynced = useMemo(() => {
    const stamps = submitted.map((i) => i.otrStatusSyncedAt).filter((s): s is string => !!s).sort()
    return stamps[stamps.length - 1] ?? null
  }, [submitted])

  const totals = useMemo(() => {
    const cents = submitted.reduce((sum, i) => sum + (i.otrAmount ?? 0), 0)
    const unpaid = submitted.filter((i) => !/paid/i.test(i.otrStatus ?? '')).length
    return { cents, unpaid }
  }, [submitted])

  const refreshFromOtr = async () => {
    if (submitted.length === 0) return
    setSyncing(true)
    try {
      const { synced } = await syncOtrStatus(submitted.map((i) => i.id))
      const failed = synced.filter((s) => s.error)
      if (failed.length) {
        toast.warning(`${synced.length - failed.length} of ${synced.length} refreshed`, {
          description: failed.map((f) => `${f.id}: ${f.error}`).join('; ').slice(0, 200),
        })
      } else {
        toast.success(`Refreshed ${synced.length} invoice${synced.length === 1 ? '' : 's'} from OTR`)
      }
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reach OTR')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12.5, color: 'var(--ds-t2)' }}>
          <span><b style={{ color: 'var(--ds-t1)' }}>{submitted.length}</b> at OTR</span>
          <span><b style={{ color: 'var(--ds-t1)' }}>{money(totals.cents)}</b> submitted</span>
          {totals.unpaid > 0 && (
            <span style={{ color: '#b45309', fontWeight: 600 }}>{totals.unpaid} not paid yet</span>
          )}
          <span style={{ color: 'var(--ds-t3)' }}>
            {/* Said out loud, because this view is deliberately not live. */}
            Synced {when(lastSynced)} · the hourly poller keeps this current
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => void refreshFromOtr()}
          disabled={syncing || submitted.length === 0}
          title="Ask OTR about these invoices now. Each refresh is a paid API call per invoice."
        >
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
          Refresh from OTR
        </Button>
      </div>

      {submitted.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 0', color: 'var(--ds-t3)' }}>
          <Inbox size={32} style={{ opacity: 0.4 }} />
          <p style={{ fontSize: 14, fontWeight: 500 }}>Nothing submitted to OTR yet</p>
          <p style={{ fontSize: 12.5, maxWidth: 420, textAlign: 'center' }}>
            Invoices appear here once a row in the queue is submitted. Their status then
            follows OTR's own board.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--ds-border)', borderRadius: 10, background: 'var(--ds-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-bg)' }}>
                {['PRO #', 'OTR status', 'Invoice', 'Amount', 'Schedule', 'Submitted', 'By', 'Docs', 'Synced'].map((c) => (
                  <th key={c} style={TH}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {submitted.map((item) => {
                const t = tone(item.otrStatus)
                const docs = item.otrDocsUploaded ?? {}
                return (
                  <tr key={item.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    <td style={{ ...TD, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{item.proNumber}</td>
                    <td style={TD}>
                      <span style={{
                        fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                        background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
                      }}>
                        {item.otrStatus || 'Pending'}
                      </span>
                      {item.otrError && (
                        <span title={item.otrError} style={{ marginLeft: 6, color: '#b45309', verticalAlign: '-2px' }}>
                          <AlertTriangle size={13} />
                        </span>
                      )}
                    </td>
                    <td style={{ ...TD, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
                      {item.otrInvoiceId}
                    </td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{money(item.otrAmount)}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{item.otrScheduleId || '—'}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{when(item.otrSubmittedAt)}</td>
                    <td style={{ ...TD, color: 'var(--ds-t2)' }}>{item.otrSubmittedBy || '—'}</td>
                    <td style={TD}>
                      <span style={{ display: 'inline-flex', gap: 4 }}>
                        <DocChip label="POD" ok={!!docs.pod} />
                        <DocChip label="RC" ok={!!docs.rateConfirmation} />
                      </span>
                    </td>
                    <td style={{ ...TD, color: 'var(--ds-t3)', fontSize: 12 }}>{when(item.otrStatusSyncedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <ExternalLink size={12} />
        Statuses are OTR's own: Pending, Advance Pending, Advance Paid, Approved, Client
        Request, Duplicate, OTR Follow-Up and Paid.
      </p>
    </div>
  )
}

/** Which documents actually reached OTR, so a partial upload is visible. */
function DocChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      title={ok ? `${label} reached OTR` : `${label} did not reach OTR`}
      style={{
        fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, border: '1px solid',
        ...(ok
          ? { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' }
          : { background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }),
      }}
    >
      {label}
    </span>
  )
}
