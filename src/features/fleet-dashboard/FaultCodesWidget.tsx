import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { listTruckFaultCodes, type TruckFaultCode } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'

const REFRESH_MS = 5 * 60 * 1000  // the sync writes hourly; this just keeps a left-open tab honest

function shortStamp(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function daysSince(iso?: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000)
}

interface TruckFaults {
  truckId: string
  unitNumber: string
  vehicle: string          // "Freightliner Cascadia" when Motive reports it
  codes: TruckFaultCode[]
}

/**
 * Engine fault codes (DTCs) Motive currently reports as OPEN, per truck — the
 * maintenance side of the same telematics feed the PM tracker reads, so a code that
 * lands between services is visible next to the miles-until-PM countdown.
 *
 * Only trucks marked active in Equipment appear here; inactive and unmatched
 * Motive vehicles are excluded from both the cards and the summary counts.
 */
export function FaultCodesWidget() {
  const { hasPageAccess } = useAuth()
  const equipment = useAppStore((s) => s.equipment)
  const [faults, setFaults] = useState<TruckFaultCode[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = () => listTruckFaultCodes()
      .then((f) => { if (alive) setFaults(f) })
      .catch(() => { /* dashboard keeps working without the feed */ })
      .finally(() => { if (alive) setLoading(false) })
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const trucks = useMemo<TruckFaults[]>(() => {
    const byUnit = new Map(equipment.map((e) => [e.id, e]))
    const grouped = new Map<string, TruckFaults>()
    for (const f of faults) {
      const eq = byUnit.get(f.truckId)
      if (!eq || eq.type !== 'truck' || eq.active === false) continue
      const entry = grouped.get(f.truckId) ?? {
        truckId: f.truckId,
        unitNumber: eq.unitNumber,
        vehicle: [f.vehicleMake, f.vehicleModel].filter(Boolean).join(' ') || (eq.nickname ?? ''),
        codes: [],
      }
      entry.codes.push(f)
      grouped.set(f.truckId, entry)
    }
    for (const t of grouped.values()) {
      // Freshest observation first — that's the one a mechanic chases.
      t.codes.sort((a, b) => (b.lastObservedAt ?? '').localeCompare(a.lastObservedAt ?? ''))
    }
    // Most faults first, then by unit number.
    return [...grouped.values()].sort(
      (a, b) => b.codes.length - a.codes.length || a.unitNumber.localeCompare(b.unitNumber),
    )
  }, [faults, equipment])
  const faultCount = trucks.reduce((count, truck) => count + truck.codes.length, 0)

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} style={{ color: faultCount > 0 ? '#dc2626' : 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Active Fault Codes · Motive</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>
              {loading
                ? 'Loading engine diagnostics…'
                : faultCount === 0
                  ? 'No open codes on active vehicles'
                  : `${faultCount} open code${faultCount === 1 ? '' : 's'} on ${trucks.length} active vehicle${trucks.length === 1 ? '' : 's'}`}
            </div>
          </div>
        </div>
        {hasPageAccess('maintenance') && (
          <Link to="/maintenance" style={{ fontSize: 12, color: 'var(--ds-blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            Maintenance <ChevronRight size={13} />
          </Link>
        )}
      </div>

      {trucks.length === 0 ? (
        <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          {loading
            ? <span style={{ opacity: 0.7 }}>Checking Motive…</span>
            : <><CheckCircle2 size={22} style={{ opacity: 0.35, color: '#15803d' }} />All active vehicles are clear.</>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12, padding: 16 }}>
          {trucks.map((t) => (
            <div key={t.truckId} style={{ border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 14px', background: 'var(--ds-bg)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>#{t.unitNumber}</div>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#dc2626' }}>
                  {t.codes.length} code{t.codes.length === 1 ? '' : 's'}
                </div>
              </div>
              {t.vehicle && (
                <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>{t.vehicle}</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {t.codes.map((c) => {
                  const age = daysSince(c.firstObservedAt)
                  return (
                    <div key={c.faultId} style={{ borderTop: '1px solid var(--ds-border)', paddingTop: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, color: '#b45309' }}>{c.code}</span>
                        {c.sourceLabel && (
                          <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{c.sourceLabel}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 2, lineHeight: 1.4 }}>
                        {c.description || 'No description from Motive'}
                      </div>
                      {c.fmiDescription && (
                        <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 2, lineHeight: 1.4 }}>{c.fmiDescription}</div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 3 }}>
                        Last seen {shortStamp(c.lastObservedAt)}
                        {age != null ? ` · open ${age} day${age === 1 ? '' : 's'}` : ''}
                        {c.occurrenceCount ? ` · ${c.occurrenceCount}×` : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
