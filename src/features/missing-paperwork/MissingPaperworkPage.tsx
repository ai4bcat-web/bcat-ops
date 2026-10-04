/**
 * Loads Missing Paperwork.
 *
 * Replaces the old Driver Docs page, which listed driver submissions in reverse
 * chronological order. That answered "what came in", which the load drawer already answers
 * better — it shows a load's paperwork on the load. The question nobody could answer was
 * "which delivered loads are still waiting", so that is what this page is.
 *
 * It shows BOTH halves, because in this data they are one problem: on 2026-10-04, 670 of
 * 683 delivered loads had no POD, and 101 of 102 texted PODs were sitting assigned to no
 * load. Most of the missing paperwork is already in the building. Listing only the empty
 * loads would send somebody chasing drivers for documents we already have.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, AlertCircle, Inbox, Link2, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { listPods, assignPod } from '@/lib/podsClient'
import {
  listDriverSubmissions, setDriverSubmissionLoad, type SubmissionWithDocs,
} from '@/lib/driverSubmissionsClient'
import { buildPodIndex } from '@/lib/podPresence'
import { AssignLoadDialog } from '@/features/pods/AssignLoadDialog'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { errorText } from '@/lib/errorText'
import {
  deliveredWithoutPaperwork, unmatchedPaperwork, type UnmatchedDoc,
} from './missingPaperwork'
import type { PodDocument } from '@/types/pods'

const WINDOWS: Array<{ key: string; label: string; days: number | null }> = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time', days: null },
]

const fmtDate = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const SOURCE_LABEL: Record<UnmatchedDoc['source'], string> = {
  JOBSDONE: 'Texted / emailed',
  DRIVER_PWA: 'Driver app',
  STAFF: 'Staff upload',
}

export function MissingPaperworkPage() {
  const loads = useAppStore((s) => s.loads)
  const drivers = useAppStore((s) => s.drivers)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const [pods, setPods] = useState<PodDocument[] | null>(null)
  const [subs, setSubs] = useState<SubmissionWithDocs[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [windowKey, setWindowKey] = useState('30')
  const [driverFilter, setDriverFilter] = useState<string>('ALL')
  const [assigning, setAssigning] = useState<UnmatchedDoc | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let stale = false
    async function run() {
      const all: PodDocument[] = []
      let nextToken: string | null = null
      for (let i = 0; i < 100; i += 1) {
        const page = await listPods({ nextToken: nextToken ?? undefined })
        all.push(...page.items)
        nextToken = page.nextToken ?? null
        if (!nextToken) break
      }
      return { pods: all, subs: await listDriverSubmissions() }
    }
    run()
      .then((r) => { if (!stale) { setPods(r.pods); setSubs(r.subs); setError(null) } })
      .catch((err) => {
        /*
         * A partial read is treated as no knowledge, deliberately. A POD in the half we
         * could not read looks exactly like no POD at all, and this page would then accuse
         * a driver of not sending paperwork they did send.
         */
        if (!stale) { setError(errorText(err)); setPods(null); setSubs(null) }
      })
    return () => { stale = true }
  }, [reloadKey])

  const loading = pods === null && subs === null && error === null
  const known = pods !== null && subs !== null

  const podIndex = useMemo(() => {
    if (!known) return null
    return buildPodIndex({
      jobsdoneLoadIds: pods.filter((p) => p.loadId).map((p) => p.loadId as string),
      submissions: subs.map((s) => ({
        loadId: s.loadId ?? null,
        referenceNumber: s.referenceNumber ?? null,
        hasPodDoc: s.docs.some((d) => d.kind === 'POD'),
        hasRateconDoc: s.docs.some((d) => d.kind === 'RATECON'),
      })),
    })
  }, [known, pods, subs])

  const rows = useMemo(() => {
    if (!podIndex) return []
    const days = WINDOWS.find((w) => w.key === windowKey)?.days ?? 30
    const all = deliveredWithoutPaperwork({
      loads, drivers, asOf: new Date(), withinDays: days,
      pods: { byLoadId: podIndex.pod.byLoadId, byPro: podIndex.pod.byPro },
    })
    return driverFilter === 'ALL' ? all : all.filter((r) => r.load.deliveryDriverId === driverFilter)
  }, [podIndex, loads, drivers, windowKey, driverFilter])

  const unmatched = useMemo(() => {
    if (!known) return []
    return unmatchedPaperwork({ jobsdone: pods, submissions: subs, loads })
  }, [known, pods, subs, loads])

  const driverOptions = useMemo(
    () => drivers.filter((d) => d.active !== false && d.type !== 'broker').sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )

  async function assign(loadId: string) {
    const doc = assigning
    if (!doc) return
    try {
      if (doc.source === 'JOBSDONE') {
        const live = pods?.find((p) => p.id === doc.id)
        await assignPod({ id: doc.id, loadId, expectedVersion: live?.version ?? 0 })
      } else {
        await setDriverSubmissionLoad(doc.id, loadId)
      }
      toast.success('Paperwork filed to the load')
      setAssigning(null)
      reload()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  if (loading) {
    return (
      <div className="page-content" style={{ display: 'grid', placeItems: 'center', minHeight: 320, color: 'var(--ds-t3)' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10 }}>
          <Loader2 className="h-6 w-6 animate-spin" />
          <p>Reading paperwork…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content" style={{ padding: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)' }}>Loads Missing Paperwork</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            {/* Said plainly: there is no delivery event in the data to read. */}
            Loads whose delivery appointment has passed with no POD on file. Based on the
            appointment, not a confirmed delivery — a rescheduled load can appear here.
          </p>
        </div>
        <Button variant="outline" onClick={reload} className="h-9 gap-2">
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {error && (
        <div style={{ margin: '12px 0', padding: 14, borderRadius: 10, background: '#ef44441a', color: '#b91c1c', display: 'flex', gap: 10 }}>
          <AlertCircle className="h-5 w-5 shrink-0" />
          <div>
            <p style={{ fontWeight: 600 }}>Could not read the paperwork stores.</p>
            <p style={{ fontSize: 13, marginTop: 2 }}>
              {error} — nothing is listed rather than showing loads as missing paperwork they may well have.
            </p>
          </div>
        </div>
      )}

      {known && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '14px 0' }}>
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setWindowKey(w.key)}
                style={{
                  height: 32, padding: '0 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit', border: '1px solid var(--ds-border)',
                  background: windowKey === w.key ? 'var(--ds-bg)' : 'var(--ds-surface)',
                  color: windowKey === w.key ? 'var(--ds-t1)' : 'var(--ds-t3)',
                }}
              >
                {w.label}
              </button>
            ))}
            <select
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
              style={{ height: 32, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 13, padding: '0 8px', fontFamily: 'inherit' }}
            >
              <option value="ALL">All drivers</option>
              {driverOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          {/* The other half, first, because it is usually the answer. */}
          {unmatched.length > 0 && (
            <section style={{ marginBottom: 18, border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)' }}>
              <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 14, borderBottom: '1px solid var(--ds-border)' }}>
                <Inbox size={16} style={{ color: '#b45309' }} />
                <p style={{ fontWeight: 650, color: 'var(--ds-t1)' }}>
                  {unmatched.length} document{unmatched.length === 1 ? '' : 's'} on no load
                </p>
                <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>
                  — paperwork that arrived but was never filed. Some of it belongs to the loads below.
                </span>
              </header>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 300, overflowY: 'auto' }}>
                {unmatched.map((d) => (
                  <li key={d.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--ds-border)' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t3)', minWidth: 110 }}>{SOURCE_LABEL[d.source]}</span>
                    <span style={{ fontSize: 13, color: 'var(--ds-t1)' }}>{d.from ?? 'Unknown sender'}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>{fmtDate(d.receivedAt)}</span>
                    {d.reference && <span style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>PRO {d.reference}</span>}
                    {d.suggestedReference && (
                      <span style={{ fontSize: 12.5, color: '#047857', fontWeight: 600 }}>
                        → matches {d.suggestedReference}
                      </span>
                    )}
                    <Button
                      variant={d.suggestedLoadId ? 'default' : 'outline'}
                      className="ml-auto h-8 gap-1.5 text-xs"
                      onClick={() => setAssigning(d)}
                    >
                      <Link2 className="h-3.5 w-3.5" /> Assign to load
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p style={{ fontSize: 13, color: 'var(--ds-t2)', marginBottom: 10 }}>
            <PackageCheck size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: -2 }} />
            {rows.length} load{rows.length === 1 ? '' : 's'} waiting on a POD
          </p>

          {rows.length === 0 ? (
            <p style={{ color: 'var(--ds-t3)', fontSize: 13.5, padding: 14, border: '1px solid var(--ds-border)', borderRadius: 10 }}>
              Nothing delivered in this window is missing paperwork.
            </p>
          ) : (
            <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, overflow: 'hidden', background: 'var(--ds-surface)' }}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {rows.map((r) => (
                  <li key={r.load.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 12, borderBottom: '1px solid var(--ds-border)' }}>
                    <button
                      onClick={() => setSelectedLoad(r.load.id, 'view')}
                      style={{ background: 'none', border: 'none', padding: 0, fontSize: 14, fontWeight: 700, color: 'var(--ds-accent, #1ea8f3)', cursor: 'pointer', fontFamily: 'inherit', minWidth: 76, textAlign: 'left' }}
                    >
                      {r.reference}
                    </button>
                    <span style={{ fontSize: 13, color: 'var(--ds-t1)', minWidth: 120 }}>{r.customer ?? '—'}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ds-t3)', flex: 1, minWidth: 160 }}>{r.lane ?? '—'}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ds-t2)', minWidth: 100 }}>{r.driverName ?? 'Unassigned'}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--ds-t3)', minWidth: 90 }}>{fmtDate(r.deliveryAppt)}</span>
                    <span
                      style={{
                        fontSize: 12, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
                        background: r.ageDays > 14 ? '#ef444422' : r.ageDays > 7 ? '#f59e0b22' : '#64748b22',
                        color: r.ageDays > 14 ? '#b91c1c' : r.ageDays > 7 ? '#b45309' : 'var(--ds-t3)',
                      }}
                    >
                      {r.ageDays}d
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {assigning && (
        <AssignLoadDialog
          assignedLoadId={assigning.suggestedLoadId}
          driver={null}
          senderLabel={assigning.from ?? undefined}
          loads={loads}
          onAssign={(loadId) => void assign(loadId)}
          onUnassign={() => setAssigning(null)}
          onClose={() => setAssigning(null)}
        />
      )}

      <LoadDrawer />
    </div>
  )
}
