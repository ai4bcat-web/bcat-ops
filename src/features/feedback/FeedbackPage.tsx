import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ImageIcon, Loader2, X, ArrowUp, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useAuth } from '@/hooks/useAuth'
import { NAV_ITEMS } from '@/lib/navItems'
import { cn } from '@/lib/utils'
import {
  createFeedback, listFeedback, updateFeedback, uploadFeedbackScreenshot, getFeedbackScreenshotUrl,
} from '@/lib/feedbackClient'
import {
  STATUSES, STATUS_LABEL, filterFeedback, groupByPage, screenshotsOf, sortFeedback, statusOf, statusPatch,
  type FeedbackItem, type FeedbackStatus, type SortKey,
} from './feedbackLogic'

const OTHER = 'Other'
const PAGE_OPTIONS = [...new Set(NAV_ITEMS.map((i) => i.label)), OTHER]
const SELECT_CLS = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
const STATUS_CLS: Record<FeedbackStatus, string> = {
  NEW: 'bg-red-50 text-red-700 border-red-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-700 border-amber-200',
  DONE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <span className={cn('inline-block rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_CLS[status])}>{STATUS_LABEL[status]}</span>
}

function fmtDate(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function nameFromEmail(email: string) {
  const local = email.split('@')[0] ?? email
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || email
}

/** Loads signed URLs for a set of S3 keys. */
function useScreenshotUrls(keys: string[]) {
  const [urls, setUrls] = useState<string[]>([])
  const sig = keys.join('|')
  useEffect(() => {
    let live = true
    Promise.all(keys.map((k) => getFeedbackScreenshotUrl(k).catch(() => '')))
      .then((u) => { if (live) setUrls(u.filter(Boolean)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return urls
}

function Screenshots({ keys }: { keys: string[] }) {
  const urls = useScreenshotUrls(keys)
  if (keys.length === 0) return <p className="text-sm text-muted-foreground">No screenshots.</p>
  return (
    <div className="grid grid-cols-1 gap-3">
      {urls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Screenshot" className="max-h-[60vh] w-full rounded-md border object-contain" /></a>)}
      {urls.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
    </div>
  )
}

function SubmitForm({ onCreated }: { onCreated: () => void }) {
  const { user } = useAuth()
  const [page, setPage] = useState(PAGE_OPTIONS[0]!)
  const [summary, setSummary] = useState('')
  const [details, setDetails] = useState('')
  const [files, setFiles] = useState<{ file: File; url: string }[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = (list: File[]) => {
    const imgs = list.filter((f) => f.type.startsWith('image/'))
    if (imgs.length) setFiles((prev) => [...prev, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))])
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (imgs.length) {
      e.preventDefault()
      addFiles(imgs.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }))))
    }
  }
  const removeFile = (i: number) => setFiles((prev) => { URL.revokeObjectURL(prev[i]!.url); return prev.filter((_, j) => j !== i) })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!summary.trim() || busy) return
    setBusy(true)
    try {
      const email = user?.email ?? 'unknown'
      const row = await createFeedback({ page, summary: summary.trim(), details: details.trim(), submittedBy: email, submittedByName: nameFromEmail(email) })
      if (files.length) {
        try {
          const keys = await Promise.all(files.map((f, i) => uploadFeedbackScreenshot(row.id, f.file, i)))
          await updateFeedback(row.id, { screenshotKeys: keys })
        } catch {
          toast.error('Feedback saved, but the screenshots failed to upload')
        }
      }
      toast.success('Thanks — feedback submitted')
      files.forEach((f) => URL.revokeObjectURL(f.url))
      setFiles([]); setSummary(''); setDetails(''); setPage(PAGE_OPTIONS[0]!)
      onCreated()
    } catch {
      toast.error('Could not submit feedback')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} onPaste={onPaste} className="space-y-3 rounded-xl border bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold">Report something that is not working</h2>
      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
        <label className="space-y-1 text-sm font-medium">Page
          <select aria-label="Page" value={page} onChange={(e) => setPage(e.target.value)} className={cn(SELECT_CLS, 'w-full')}>
            {PAGE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">What is not working <span className="text-red-600">*</span>
          <Textarea aria-label="What is not working" required value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
        </label>
      </div>
      <label className="block space-y-1 text-sm font-medium">Details (optional)
        <Textarea aria-label="Details" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} placeholder="What did you click? What did you expect to happen?" />
      </label>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><ImageIcon /> Add screenshots</Button>
          <span className="text-xs text-muted-foreground">or paste an image anywhere in this form (Ctrl/Cmd+V)</span>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <div key={f.url} className="relative">
                <img src={f.url} alt={f.file.name} className="h-20 w-20 rounded-md border object-cover" />
                <button type="button" aria-label="Remove screenshot" onClick={() => removeFile(i)} className="absolute -right-1.5 -top-1.5 rounded-full border bg-white p-0.5 shadow"><X className="size-3" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      <Button type="submit" disabled={busy || !summary.trim()}>{busy && <Loader2 className="animate-spin" />} Submit feedback</Button>
    </form>
  )
}

function DetailDialog({ item, isAdmin, onClose, onSaved }: {
  item: FeedbackItem | null; isAdmin: boolean; onClose: () => void; onSaved: (f: FeedbackItem) => void
}) {
  return (
    <Dialog open={!!item} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        {item && <DetailBody key={item.id} item={item} isAdmin={isAdmin} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function DetailBody({ item, isAdmin, onSaved }: { item: FeedbackItem; isAdmin: boolean; onSaved: (f: FeedbackItem) => void }) {
  const [notes, setNotes] = useState(item?.adminNotes ?? '')
  const [busy, setBusy] = useState(false)
  const keys = useMemo(() => screenshotsOf(item), [item])

  const save = async (patch: Parameters<typeof updateFeedback>[1], msg: string) => {
    setBusy(true)
    try {
      onSaved(await updateFeedback(item.id, patch))
      toast.success(msg)
    } catch {
      toast.error('Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item.summary}</DialogTitle>
        <DialogDescription>{item.page} · {item.submittedByName || item.submittedBy} · {fmtDate(item.createdAt)}</DialogDescription>
      </DialogHeader>
      {item.details && <p className="whitespace-pre-wrap text-sm">{item.details}</p>}
      <Screenshots keys={keys} />
      {isAdmin ? (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <Button key={s} size="sm" variant={statusOf(item) === s ? 'default' : 'outline'} disabled={busy}
                onClick={() => save(statusPatch(s), `Marked ${STATUS_LABEL[s]}`)}>{STATUS_LABEL[s]}</Button>
            ))}
          </div>
          <label className="block space-y-1 text-sm font-medium">Admin notes
            <Textarea aria-label="Admin notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <Button size="sm" disabled={busy || notes === (item.adminNotes ?? '')} onClick={() => save({ adminNotes: notes }, 'Notes saved')}>Save notes</Button>
        </div>
      ) : (
        <div className="space-y-1 border-t pt-3 text-sm">
          <div>Status: <StatusBadge status={statusOf(item)} /></div>
          {item.adminNotes && <p className="whitespace-pre-wrap text-muted-foreground">Notes: {item.adminNotes}</p>}
        </div>
      )}
    </>
  )
}

function GroupRows({ page, count, isCollapsed, onToggle, children }: {
  page: string; count: number; isCollapsed: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <>
      <tr className="cursor-pointer border-t bg-slate-100" onClick={onToggle}>
        <td colSpan={7} className="px-3 py-2 font-semibold">
          <span className="inline-flex items-center gap-1">{isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}{page} ({count})</span>
        </td>
      </tr>
      {!isCollapsed && children}
    </>
  )
}

function SortHead({ k, active, dir, onSort, children }: {
  k: SortKey; active: SortKey; dir: 'asc' | 'desc'; onSort: (k: SortKey) => void; children: string
}) {
  return (
    <th className="cursor-pointer select-none px-3 py-2 text-left font-medium" onClick={() => onSort(k)}>
      <span className="inline-flex items-center gap-1">{children}{active === k && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</span>
    </th>
  )
}

export function FeedbackPage() {
  const { isAdmin } = useAuth()
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | 'ALL'>('ALL')
  const [pageFilter, setPageFilter] = useState('ALL')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [grouped, setGrouped] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string[] | null>(null)

  const load = useCallback(() => {
    listFeedback()
      .then(setItems)
      .catch(() => toast.error('Could not load feedback'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const pages = useMemo(() => [...new Set(items.map((i) => i.page))].sort(), [items])
  const visible = useMemo(
    () => sortFeedback(filterFeedback(items, { status: statusFilter, page: pageFilter, query }), sortKey, sortDir),
    [items, statusFilter, pageFilter, query, sortKey, sortDir],
  )
  const groups = useMemo(() => groupByPage(visible), [visible])
  const open = items.find((i) => i.id === openId) ?? null

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'createdAt' ? 'desc' : 'asc') }
  }
  const toggleGroup = (page: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(page)) n.delete(page); else n.add(page); return n })

  const row = (f: FeedbackItem) => {
    const keys = screenshotsOf(f)
    return (
      <tr key={f.id} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => setOpenId(f.id)}>
        <td className="whitespace-nowrap px-3 py-2">{fmtDate(f.createdAt)}</td>
        <td className="px-3 py-2">{f.page}</td>
        <td className="max-w-md px-3 py-2">{f.summary}</td>
        <td className="px-3 py-2">{f.submittedByName || f.submittedBy}</td>
        <td className="px-3 py-2"><StatusBadge status={statusOf(f)} /></td>
        <td className="px-3 py-2">
          {keys.length > 0 && (
            <button type="button" className="inline-flex items-center gap-1 text-blue-600 hover:underline"
              onClick={(e) => { e.stopPropagation(); setLightbox(keys) }}><ImageIcon className="size-3.5" />{keys.length}</button>
          )}
        </td>
        <td className="max-w-xs truncate px-3 py-2 text-muted-foreground">{f.adminNotes}</td>
      </tr>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <h1 className="text-xl font-semibold">Feedback</h1>
      <SubmitForm onCreated={load} />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['ALL', ...STATUSES] as const).map((s) => (
            <Button key={s} size="sm" variant={statusFilter === s ? 'default' : 'outline'} className="h-8 px-3"
              onClick={() => setStatusFilter(s)}>{s === 'ALL' ? 'All' : STATUS_LABEL[s]}</Button>
          ))}
          <select aria-label="Filter by page" value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} className={SELECT_CLS}>
            <option value="ALL">All pages</option>
            {pages.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <Input aria-label="Search feedback" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 w-48" />
          <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by page</label>
        </div>

        <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <SortHead k="createdAt" active={sortKey} dir={sortDir} onSort={toggleSort}>Created</SortHead>
                <SortHead k="page" active={sortKey} dir={sortDir} onSort={toggleSort}>Page</SortHead>
                <th className="px-3 py-2 text-left font-medium">Summary</th>
                <th className="px-3 py-2 text-left font-medium">Submitted by</th>
                <SortHead k="status" active={sortKey} dir={sortDir} onSort={toggleSort}>Status</SortHead>
                <th className="px-3 py-2 text-left font-medium">Screenshots</th>
                <th className="px-3 py-2 text-left font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>}
              {!loading && visible.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No feedback yet.</td></tr>}
              {grouped
                ? groups.map((g) => (
                  <GroupRows key={g.page} page={g.page} count={g.items.length} isCollapsed={collapsed.has(g.page)} onToggle={() => toggleGroup(g.page)}>
                    {g.items.map(row)}
                  </GroupRows>
                ))
                : visible.map(row)}
            </tbody>
          </table>
        </div>
      </div>

      <DetailDialog item={open} isAdmin={isAdmin} onClose={() => setOpenId(null)}
        onSaved={(f) => setItems((prev) => prev.map((i) => (i.id === f.id ? { ...i, ...f } : i)))} />
      <Dialog open={!!lightbox} onOpenChange={(o) => { if (!o) setLightbox(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Screenshots</DialogTitle><DialogDescription>Click an image to open it full size.</DialogDescription></DialogHeader>
          {lightbox && <Screenshots keys={lightbox} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
