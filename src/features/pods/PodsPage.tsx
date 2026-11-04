/**
 * PODs — the review queue for proof of delivery from the driver apps.
 *
 * Every POD a driver sends from the Ivan driver app or the owner operator app lands here
 * and waits for a person: right addresses, every page, readable. Each one is read first
 * against the load's rate confirmation (pod-actions/podCheck.ts) so the reviewer starts
 * from what looks wrong. The reviewer approves it, or asks the driver for a better one.
 *
 * This page used to be the JobsDone inbox (texted images imported from app.jobsdone.io).
 * That connection is gone; PODs already imported from it stay on their loads.
 */
import { TmsAlert } from '@/features/tms/kit/TmsAlert'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsEmptyState } from '@/features/tms/kit/TmsEmptyState'
import { TmsInput } from '@/features/tms/kit/TmsInput'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Search, RefreshCw, Loader2, Upload, X, CheckCircle2, AlertTriangle, HelpCircle, Clock } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { DriverDocUploadDialog } from '@/features/driver-docs'
import { normalizePro } from '@/lib/proNumber'
import { useResolveLoads } from '@/hooks/useResolveLoads'
import { formatDateTime } from '@/lib/date'
import { graphqlErrorText } from '@/lib/apiClient'
import { listReviewSubmissions } from '@/lib/podReviewClient'
import {
  appLabel,
  isDriverAppPod,
  pagesLabel,
  parseCheck,
  podPages,
  proOf,
  reviewStatusOf,
  supersededBy,
  type CheckVerdict,
  type PodReviewStatus,
  type ReviewSubmission,
} from '@/lib/podReview'
import { PodReviewPanel } from './PodReviewPanel'
import type { Load } from '@/types'

type Tab = PodReviewStatus | 'ALL'
const TABS: { key: Tab; label: string }[] = [
  { key: 'PENDING', label: 'To review' },
  { key: 'NEEDS_REPLACEMENT', label: 'Waiting on driver' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'ALL', label: 'All' },
]

function Dot({ v, label }: { v: CheckVerdict | null | undefined; label: string }) {
  const color = v === 'PASS' ? 'var(--tms-badge-green)' : v === 'FAIL' ? 'var(--tms-badge-red)' : 'var(--tms-badge-orange)'
  const Icon = v === 'PASS' ? CheckCircle2 : v === 'FAIL' ? AlertTriangle : HelpCircle
  return (
    <span title={`${label}: ${v === 'PASS' ? 'looks right' : v === 'FAIL' ? 'problem' : 'can’t tell'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color, fontSize: 11.5, fontWeight: 600 }}>
      <Icon size={12} /> {label}
    </span>
  )
}

export function PodsPage() {
  const { user } = useAuth()
  // The identity table on purpose: a POD is matched to a load by Pro #, and a voided load
  // keeps its Pro #, so its paperwork must still find it rather than land nowhere.
  const loads = useAppStore((s) => s.loads)
  const drivers = useAppStore((s) => s.drivers)

  const [subs, setSubs] = useState<ReviewSubmission[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('PENDING')
  const [app, setApp] = useState<'ALL' | 'IVAN' | 'OO'>('ALL')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [showUploadPod, setShowUploadPod] = useState(false)

  // Bumped to reload; `loadedKey` trails it, so the two differ exactly while a load is in flight.
  const [reloadKey, setReloadKey] = useState(0)
  const [loadedKey, setLoadedKey] = useState(-1)
  const loading = loadedKey !== reloadKey
  const refresh = useCallback(() => setReloadKey((n) => n + 1), [])

  // A promise chain, not an async function: every state write lands after the fetch.
  useEffect(() => {
    let cancelled = false
    listReviewSubmissions()
      .then((rows) => { if (!cancelled) { setSubs(rows); setError(null) } })
      .catch((err: unknown) => { if (!cancelled) setError(graphqlErrorText(err) || 'Could not load the POD queue — try Refresh.') })
      .finally(() => { if (!cancelled) setLoadedKey(reloadKey) })
    return () => { cancelled = true }
  }, [reloadKey])

  // A check still running finishes in about a minute; look again until it has.
  const running = (subs ?? []).some((s) => s.podCheckStatus === 'RUNNING')
  useEffect(() => {
    if (!running) return
    const t = setTimeout(refresh, 15_000)
    return () => clearTimeout(t)
  }, [running, refresh, subs])

  const loadFor = useCallback((s: ReviewSubmission): Load | null => {
    if (s.loadId) {
      const byId = loads.find((l) => l.id === s.loadId)
      if (byId) return byId
    }
    const pro = normalizePro(s.referenceNumber)
    return pro ? loads.find((l) => normalizePro(l.aljexId) === pro) ?? null : null
  }, [loads])
  const driverFor = useCallback((s: ReviewSubmission) => drivers.find((d) => d.id === s.driverId) ?? null, [drivers])

  const queue = useMemo(() => (subs ?? []).filter(isDriverAppPod), [subs])
  useResolveLoads(queue.map((s) => s.loadId), queue.filter((s) => !s.loadId).map((s) => s.referenceNumber))

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return queue
      .filter((s) => tab === 'ALL' || reviewStatusOf(s) === tab)
      .filter((s) => {
        if (app === 'ALL') return true
        const oo = driverFor(s)?.driverType === 'OWNER_OPERATOR'
        return app === 'OO' ? oo : !oo
      })
      .filter((s) => !q || [s.driverName, s.referenceNumber, loadFor(s)?.aljexId, loadFor(s)?.customer]
        .some((v) => (v ?? '').toLowerCase().includes(q)))
      // Oldest first while there is work to do: the POD waiting longest is the invoice waiting longest.
      .sort((a, b) => tab === 'PENDING'
        ? String(a.createdAt).localeCompare(String(b.createdAt))
        : String(b.createdAt).localeCompare(String(a.createdAt)))
  }, [queue, tab, app, query, loadFor, driverFor])

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { PENDING: 0, NEEDS_REPLACEMENT: 0, APPROVED: 0, ALL: queue.length }
    for (const s of queue) c[reviewStatusOf(s)]++
    return c
  }, [queue])

  const open = openId ? queue.find((s) => s.id === openId) ?? null : null

  return (
    <TmsScrollPage
      title="POD review"
      subtitle="From the Ivan driver app and the owner operator app"
      stickyHead
      actions={(
        <>
          <TmsButton onClick={refresh} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </TmsButton>
          <TmsButton onClick={() => setShowUploadPod(true)}><Upload size={14} /> Upload POD</TmsButton>
        </>
      )}
      toolbar={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {TABS.map(({ key, label }) => {
            const active = tab === key
            return (
              <TmsButton key={key} size="sm" variant={active ? 'primary' : 'secondary'} onClick={() => setTab(key)}>
                {label} <span style={{ fontSize: 11.5, opacity: 0.8, fontWeight: 500 }}>{counts[key]}</span>
              </TmsButton>
            )
          })}
          <select value={app} onChange={(e) => setApp(e.target.value as typeof app)} className="tms-select" style={{ width: 'auto' }} aria-label="App">
            <option value="ALL">Both apps</option>
            <option value="IVAN">Ivan driver app</option>
            <option value="OO">Owner operator app</option>
          </select>
          <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)' }} />
            <TmsInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search PRO, driver, customer…"
              style={{ paddingLeft: 30 }} />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}
    >
      <div>
        {error && <TmsAlert tone="red" className="mb-3">{error}</TmsAlert>}
        {subs == null && !error && (
          <div className="text-sm text-muted-foreground flex items-center gap-2 py-4"><Loader2 size={14} className="animate-spin" /> Loading PODs…</div>
        )}
        {subs != null && rows.length === 0 && (
          <TmsEmptyState
            title={tab === 'PENDING' ? 'Nothing to review. New PODs from the driver apps appear here.' : 'No PODs match.'}
            message={null}
          />
        )}
        {rows.length > 0 && (
          <div style={{ border: '1px solid var(--tms-border)', borderRadius: 12, background: 'var(--tms-card)', overflowX: 'auto' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-4 py-2 font-semibold">PRO</th>
                  <th className="px-4 py-2 font-semibold">Driver</th>
                  <th className="px-4 py-2 font-semibold">Sent</th>
                  <th className="px-4 py-2 font-semibold">Pages</th>
                  <th className="px-4 py-2 font-semibold">Automated check</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const load = loadFor(s)
                  const driver = driverFor(s)
                  const check = parseCheck(s)
                  const status = reviewStatusOf(s)
                  const newer = status === 'NEEDS_REPLACEMENT' ? supersededBy(s, queue) : null
                  return (
                    <tr key={s.id} onClick={() => setOpenId(s.id)} className="border-b last:border-0 hover:bg-muted/40 cursor-pointer">
                      <td className="px-4 py-2.5">
                        <div className="font-semibold">{proOf(s, load) ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{load?.customer ?? (load ? '' : 'no load linked')}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div>{s.driverName}</div>
                        <div className="text-xs text-muted-foreground">{appLabel(driver)}</div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{formatDateTime(s.createdAt)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{pagesLabel(check?.pages.received ?? podPages(s).length, check)}</td>
                      <td className="px-4 py-2.5">
                        {check ? (
                          <span className="inline-flex gap-3 flex-wrap">
                            <Dot v={check.addresses.verdict} label="Addresses" />
                            <Dot v={check.pages.verdict} label="Pages" />
                            <Dot v={check.legibility.verdict} label="Legible" />
                          </span>
                        ) : s.podCheckStatus === 'RUNNING' ? (
                          <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Checking…</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{s.podCheckStatus === 'FAILED' ? 'Check failed' : 'Not checked'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {status === 'APPROVED' && <TmsBadge tone="green"><CheckCircle2 size={12} /> Approved</TmsBadge>}
                        {status === 'PENDING' && <TmsBadge tone="orange"><Clock size={12} /> To review</TmsBadge>}
                        {status === 'NEEDS_REPLACEMENT' && (
                          <TmsBadge tone="red">
                            {newer ? 'Driver resent — review the new one' : `New POD requested${s.podReplacementRequestedAt ? ` ${formatDateTime(s.podReplacementRequestedAt)}` : ''}`}
                          </TmsBadge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <PodReviewPanel
          key={open.id}
          submission={open}
          load={loadFor(open)}
          driver={driverFor(open)}
          reviewer={user?.email ?? 'unknown'}
          onSaved={(next) => {
            setSubs((prev) => (prev ?? []).map((s) => (s.id === next.id ? { ...s, ...next, docs: s.docs } : s)))
            if (reviewStatusOf(next) !== 'PENDING' && next.podCheckStatus !== 'RUNNING') setOpenId(null)
          }}
          onClose={() => setOpenId(null)}
        />
      )}
      <DriverDocUploadDialog
        open={showUploadPod}
        onClose={() => setShowUploadPod(false)}
        drivers={drivers}
        preselectedKind="POD"
        staffEmail={user?.email ?? ''}
        onSubmitted={() => toast.success("POD uploaded on the driver's behalf")}
      />
      <LoadDrawer />
    </TmsScrollPage>
  )
}
