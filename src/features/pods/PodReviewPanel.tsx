import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, AlertTriangle, HelpCircle, Loader2, RefreshCw, ExternalLink, Copy, Truck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useAppStore } from '@/store/useAppStore'
import { getDriverDocUrl } from '@/lib/driverSubmissionsClient'
import { queueDriverPodCheck } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import {
  approvalBlocker,
  appLabel,
  parseCheck,
  parseChecks,
  podPages,
  pagesLabel,
  proOf,
  replacementText,
  reviewStatusOf,
  worstPageLegibility,
  type CheckVerdict,
  type PodReviewChecks,
  type ReviewSubmission,
} from '@/lib/podReview'
import { recordReplacementRequest, saveReview } from '@/lib/podReviewClient'
import type { Driver, Load } from '@/types'

function Verdict({ v }: { v: CheckVerdict | null | undefined }) {
  if (v === 'PASS') return <span className="inline-flex items-center gap-1 text-green-700 text-xs font-semibold"><CheckCircle2 size={13} /> Looks right</span>
  if (v === 'FAIL') return <span className="inline-flex items-center gap-1 text-red-700 text-xs font-semibold"><AlertTriangle size={13} /> Problem</span>
  return <span className="inline-flex items-center gap-1 text-amber-700 text-xs font-semibold"><HelpCircle size={13} /> Can't tell</span>
}

function CheckRow(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  verdict?: CheckVerdict | null
  children?: React.ReactNode
}) {
  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 10, padding: '10px 12px', background: 'var(--ds-surface)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)', flex: 1 }}>{props.label}</span>
        {props.verdict !== undefined && <Verdict v={props.verdict} />}
      </label>
      {props.children && <div style={{ marginTop: 6, marginLeft: 26, fontSize: 12.5, color: 'var(--ds-t2)', lineHeight: 1.45 }}>{props.children}</div>}
    </div>
  )
}

export function PodReviewPanel(props: {
  submission: ReviewSubmission
  load: Load | null
  driver: Driver | null
  reviewer: string
  onSaved: (next: ReviewSubmission) => void
  onClose: () => void
}) {
  const { submission: sub, load, driver } = props
  const updateLoad = useAppStore((s) => s.updateLoad)
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const check = parseCheck(sub)
  const pages = podPages(sub)
  const pageLegibility = worstPageLegibility(pages)
  const pro = proOf(sub, load)
  const status = reviewStatusOf(sub)

  const [checks, setChecks] = useState<PodReviewChecks>(() => parseChecks(sub))
  // The load's note is the one that matters downstream; the submission's is its copy.
  const [note, setNote] = useState(() => load?.podNotes ?? sub.podReviewNote ?? '')
  const [view, setView] = useState<'pod' | 'ratecon'>('pod')
  const [podUrl, setPodUrl] = useState<string | null>(null)
  const [pageUrls, setPageUrls] = useState<string[]>([])
  const [rateConUrl, setRateConUrl] = useState<string | null>(load?.rateConfirmUrl ?? null)
  const [saving, setSaving] = useState<null | 'approve' | 'request' | 'note' | 'recheck'>(null)
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    if (sub.combinedPodKey) {
      getDriverDocUrl(sub.combinedPodKey).then((u) => { if (!cancelled) setPodUrl(u) }).catch(() => {})
    } else {
      // Not merged yet: show the pages as they arrived.
      Promise.all(pages.map((p) => getDriverDocUrl(p.scanStatus === 'READY' && p.enhancedKey ? p.enhancedKey : p.s3Key)))
        .then((urls) => { if (!cancelled) setPageUrls(urls) })
        .catch(() => {})
    }
    if (!load?.rateConfirmUrl && load?.rateConfirmKey) {
      getDriverDocUrl(load.rateConfirmKey).then((u) => { if (!cancelled) setRateConUrl(u) }).catch(() => {})
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.id, sub.combinedPodKey, load?.id])

  const blocker = approvalBlocker(checks, note)
  const defaultMessage = useMemo(
    () => replacementText({ driverName: sub.driverName, pro, checks, note: '', check }),
    [sub.driverName, pro, checks, check],
  )

  /** The note belongs to the load, so it shows wherever the load's paperwork does. */
  const saveNoteToLoad = async () => {
    if (!load) return
    const next = note.trim() || null
    if ((load.podNotes ?? null) === next) return
    await updateLoad(load.id, { podNotes: next })
  }

  const approve = async () => {
    if (blocker) return toast.error(blocker)
    setSaving('approve')
    try {
      const next = await saveReview({ id: sub.id, status: 'APPROVED', note, checks, reviewer: props.reviewer })
      await saveNoteToLoad()
      toast.success(`POD approved${pro ? ` · PRO ${pro}` : ''}`)
      props.onSaved({ ...sub, ...next, docs: sub.docs })
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not save the review')
    } finally {
      setSaving(null)
    }
  }

  const saveNoteOnly = async () => {
    setSaving('note')
    try {
      const next = await saveReview({ id: sub.id, status, note, checks, reviewer: props.reviewer })
      await saveNoteToLoad()
      toast.success('Notes saved')
      props.onSaved({ ...sub, ...next, docs: sub.docs })
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not save the notes')
    } finally {
      setSaving(null)
    }
  }

  /*
   * Marks the POD and keeps a suggested message for dispatch. Nothing is sent from here:
   * a person in dispatch reaches the driver, the way they handle everything else with them.
   */
  const requestNew = async () => {
    const body = (message || defaultMessage).trim()
    setSaving('request')
    try {
      const next = await recordReplacementRequest({ id: sub.id, note, checks, reviewer: props.reviewer, message: body })
      await saveNoteToLoad()
      toast.success(`Marked as needing a new POD — dispatch to contact ${sub.driverName}`)
      props.onSaved({ ...sub, ...next, docs: sub.docs })
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not record the request')
    } finally {
      setSaving(null)
    }
  }

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText((message || defaultMessage).trim())
      toast.success('Message copied for dispatch')
    } catch {
      toast.error('Could not copy — select the text and copy it by hand')
    }
  }

  const recheck = async () => {
    setSaving('recheck')
    try {
      const r = await queueDriverPodCheck(sub.id)
      if (!r.queued) throw new Error(r.error || 'Could not start the check')
      toast.success('Checking again — the result appears here in about a minute')
      props.onSaved({ ...sub, podCheckStatus: 'RUNNING' })
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not start the check')
    } finally {
      setSaving(null)
    }
  }

  const running = sub.podCheckStatus === 'RUNNING'
  const tab = (key: 'pod' | 'ratecon', label: string) => (
    <button
      onClick={() => setView(key)}
      className={`h-8 px-3 rounded-md text-xs font-semibold border ${view === key ? 'bg-foreground text-background border-foreground' : 'bg-background'}`}
    >
      {label}
    </button>
  )

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose() }}>
      <DialogContent className="max-w-[1200px] w-[96vw] h-[90vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-4 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            POD {pro ? `· PRO ${pro}` : '· no PRO yet'}
            <span className="text-xs font-medium text-muted-foreground">
              {sub.driverName} · {appLabel(driver)} · sent {formatDateTime(sub.createdAt)}
            </span>
          </DialogTitle>
          <DialogDescription>
            {load ? `${load.customer ?? 'Load'} · ${load.originCity ?? '?'} → ${load.destinationCity ?? '?'}` : 'Not linked to a load yet — the PRO the driver typed is shown above.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 400px' }}>
          {/* Document */}
          <div className="min-h-0 flex flex-col border-r">
            <div className="flex items-center gap-2 px-4 py-2 border-b">
              {tab('pod', `POD · ${pagesLabel(check?.pages.received ?? pages.length, check)}`)}
              {tab('ratecon', 'Rate confirmation')}
            </div>
            <div className="flex-1 min-h-0 bg-muted/40">
              {view === 'pod' && (podUrl
                ? <iframe title="POD" src={podUrl} className="w-full h-full" />
                : pageUrls.length
                  ? <div className="h-full overflow-y-auto p-4 space-y-4">{pageUrls.map((u, i) => <img key={u} src={u} alt={`POD page ${i + 1}`} className="max-w-full mx-auto shadow" />)}</div>
                  : <div className="h-full flex items-center justify-center text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin mr-2" /> Loading the POD…</div>)}
              {view === 'ratecon' && (rateConUrl
                ? <iframe title="Rate confirmation" src={rateConUrl} className="w-full h-full" />
                : <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-6 text-center">No rate confirmation on this load. Compare against the stops on the load instead.</div>)}
            </div>
          </div>

          {/* Review */}
          <div className="min-h-0 overflow-y-auto p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Automated check</div>
              <button onClick={recheck} disabled={saving !== null || running} className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50">
                {running || saving === 'recheck' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {running ? 'Checking…' : 'Check again'}
              </button>
            </div>
            {check
              ? <p className="text-xs text-muted-foreground leading-relaxed">{check.summary} <span className="opacity-70">({formatDateTime(check.checkedAt)})</span></p>
              : <p className="text-xs text-muted-foreground">
                  {running ? 'Reading the POD against the rate confirmation…'
                    : sub.podCheckStatus === 'FAILED' ? `The check failed: ${sub.podCheckError ?? 'unknown error'}. Review it by eye or check again.`
                    : 'Not checked yet. Review it by eye, or run the check.'}
                </p>}

            <CheckRow label="Addresses match the rate confirmation" checked={checks.addresses} onChange={(v) => setChecks({ ...checks, addresses: v })} verdict={check?.addresses.verdict ?? null}>
              {check && (
                <>
                  <div><b>POD:</b> {check.addresses.pod.shipper || '—'} → {check.addresses.pod.consignee || '—'}</div>
                  <div><b>{check.addresses.fromLoadStops ? 'Load' : 'Rate con'}:</b> {check.addresses.rateCon.pickup || '—'} → {check.addresses.rateCon.delivery || '—'}</div>
                  {check.addresses.notes && <div className="mt-1">{check.addresses.notes}</div>}
                </>
              )}
            </CheckRow>

            <CheckRow label="All pages are here" checked={checks.allPages} onChange={(v) => setChecks({ ...checks, allPages: v })} verdict={check?.pages.verdict ?? null}>
              <div>
                Received {check?.pages.received ?? pages.length} page{(check?.pages.received ?? pages.length) === 1 ? '' : 's'}
                {check?.pages.markers ? <> · the paperwork says “{check.pages.markers}”</> : check ? ' · no page numbering printed' : ''}
              </div>
              {check?.pages.notes && <div className="mt-1">{check.pages.notes}</div>}
              {check?.pages.statedTotal && check.pages.received < check.pages.statedTotal && (
                <div className="mt-1 text-red-700 font-semibold">Missing {check.pages.statedTotal - check.pages.received} page(s).</div>
              )}
            </CheckRow>

            <CheckRow label="Legible" checked={checks.legible} onChange={(v) => setChecks({ ...checks, legible: v })} verdict={check?.legibility.verdict ?? null}>
              {check?.legibility.notes && <div>{check.legibility.notes}</div>}
              {pageLegibility.level !== 'UNKNOWN' && (
                <div className="mt-1">
                  Scanner: {pageLegibility.level === 'OK' ? 'every page reads clearly' : pageLegibility.level === 'LOW' ? 'at least one page is hard to read' : 'at least one page is unreadable'}
                  {pageLegibility.notes ? ` — ${pageLegibility.notes}` : ''}
                </div>
              )}
              {check && check.signed !== 'PASS' && <div className="mt-1 text-amber-700">Receiver signature: {check.signed === 'FAIL' ? 'not signed' : 'can’t tell'}</div>}
            </CheckRow>

            <div>
              <label className="text-sm font-semibold" htmlFor="pod-notes">Notes <span className="font-normal text-muted-foreground text-xs">— saved on the load</span></label>
              <textarea
                id="pod-notes"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="e.g. Receiver's BOL is one page only — no page 2 exists."
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
              />
            </div>

            {status !== 'PENDING' && (
              <p className="text-xs text-muted-foreground">
                {status === 'APPROVED' ? 'Approved' : 'New POD requested'} by {sub.podReviewedBy ?? 'someone'}
                {sub.podReviewedAt ? ` · ${formatDateTime(sub.podReviewedAt)}` : ''}
              </p>
            )}

            {!asking ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={approve} disabled={saving !== null} title={blocker ?? undefined}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-green-700 text-white text-sm font-semibold disabled:opacity-50">
                  {saving === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approve
                </button>
                <button onClick={() => { setMessage(defaultMessage); setAsking(true) }} disabled={saving !== null}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-red-300 text-red-700 text-sm font-semibold disabled:opacity-50">
                  <AlertTriangle size={14} /> Request new POD
                </button>
                <button onClick={saveNoteOnly} disabled={saving !== null} className="inline-flex items-center gap-2 h-9 px-3 rounded-md border text-sm font-semibold disabled:opacity-50">
                  {saving === 'note' && <Loader2 size={14} className="animate-spin" />} Save notes
                </button>
                {load && (
                  <button onClick={() => { props.onClose(); setSelectedLoad(load.id, 'view') }} className="inline-flex items-center gap-1 h-9 px-3 rounded-md text-sm font-semibold text-muted-foreground hover:text-foreground">
                    <Truck size={14} /> Open load <ExternalLink size={12} />
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2 border rounded-md p-3">
                <div className="text-sm font-semibold">New POD needed from {sub.driverName}</div>
                <p className="text-xs text-muted-foreground">Dispatch contacts the driver. Here is a suggested message they can send.</p>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="w-full rounded-md border px-3 py-2 text-sm bg-background" aria-label="Suggested message for dispatch" />
                <div className="flex gap-2 flex-wrap">
                  <button onClick={requestNew} disabled={saving !== null}
                    className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-red-700 text-white text-sm font-semibold disabled:opacity-50">
                    {saving === 'request' ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />} Mark as needing a new POD
                  </button>
                  <button onClick={copyMessage} className="inline-flex items-center gap-1 h-9 px-3 rounded-md border text-sm"><Copy size={13} /> Copy message</button>
                  <button onClick={() => setAsking(false)} disabled={saving !== null} className="h-9 px-3 rounded-md border text-sm">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
