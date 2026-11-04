/**
 * Step AG §7.1: link a queued e-mail to one open bill / awaiting assignment / vendor payable.
 *
 * The diff comes from `AP_INBOX_PREVIEW_LINK` (the same planner the write runs), so what is
 * ticked here is what `AP_INBOX_LINK` writes. Only fields that fill a blank are ticked by
 * default; a conflicting field is labelled and unticked. Never offers status, approval or payment.
 */
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { graphqlErrorText, listVendorPayables } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDay } from '@/features/ar/arViews'
import type { ApWorklistRow } from '@/hooks/useApWorklist'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import type { CarrierBillRecord } from '@/types/tms'
import type { VendorPayable } from '@/types/vendorAp'
import { apInboxLink, apInboxPreviewLink, type ApLinkPreview, type ApTargetKind } from './apInboxClient'
import { buildTargetOptions, needsConfirm } from './inboxModel'

const FIELD_LABEL: Record<string, string> = {
  billNumber: 'Invoice #', billDate: 'Invoice date', dueAt: 'Due', billedCents: 'Amount',
  invoiceNumber: 'Invoice #', invoiceDate: 'Invoice date', dueDate: 'Due', amount: 'Amount', vendor: 'Vendor',
}
const SKIP_TEXT: Record<string, string> = {
  STATUS: 'not allowed at this bill status',
  LOW_CONFIDENCE: 'the reader was unsure',
  AMOUNT_FAR: 'the amount is far from the bill',
  DUE_BEFORE_BILL_DATE: 'due date would be before the invoice date',
  NOT_STATED: 'not on the e-mail',
}

const show = (field: string, v: string | number | null): string => {
  if (v == null || v === '') return '—'
  if (field === 'billedCents' || field === 'amount') return formatCents(Number(v))
  if (field.toLowerCase().includes('date') || field === 'dueAt' || field === 'dueDate') return formatDay(String(v))
  return String(v)
}

export function LinkBillDialog({ item, bills, assignments, onOpenChange, onDone }: {
  item: ApInboxItemRecord
  bills: readonly CarrierBillRecord[]
  assignments: readonly ApWorklistRow[]
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [vendors, setVendors] = useState<VendorPayable[]>([])
  const [search, setSearch] = useState('')
  const top = item.match?.top
  const initialPick = top ? `${top.targetKind}:${top.targetId}` : ''
  const [pick, setPick] = useState<string>(initialPick)
  const [preview, setPreview] = useState<ApLinkPreview | null>(null)
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(!!top)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listVendorPayables().then((rows) => { if (alive) setVendors(rows) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const options = useMemo(() => buildTargetOptions({ bills, assignments, vendors }), [bills, assignments, vendors])
  const q = search.trim().toLowerCase()
  const shown = options.filter((o) => o.key === pick || !q || o.hay.includes(q))
  const target = options.find((o) => o.key === pick) ?? null

  // No synchronous setState: this runs from the mount effect as well as from the picker.
  const runPreview = (key: string) => {
    const [kind, ...rest] = key.split(':')
    return apInboxPreviewLink(item.id, { kind: kind as ApTargetKind, id: rest.join(':') })
      .then((p) => {
        setPreview(p)
        const next: Record<string, boolean> = {}
        for (const c of p.plan.changes) next[c.field] = true
        for (const c of p.plan.conflicts) next[c.field] = false
        setTicks(next)
      })
      .catch((e: unknown) => setError(graphqlErrorText(e)))
      .finally(() => setLoading(false))
  }

  const choose = (key: string) => {
    setPick(key)
    setPreview(null)
    setConfirmed(false)
    setError(null)
    if (!key) return
    setLoading(true)
    void runPreview(key)
  }

  // The suggested match previews as soon as the dialog opens.
  useEffect(() => {
    if (initialPick) void runPreview(initialPick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = preview
    ? [
        ...preview.plan.changes.map((c) => ({ ...c, conflict: false as const })),
        ...preview.plan.conflicts.map((c) => ({ ...c, conflict: true as const })),
      ]
    : []
  const skipped = preview?.plan.skipped ?? []
  const confirmNeeded = needsConfirm(item, target?.id ?? null)
  const anyTicked = rows.some((r) => ticks[r.field])
  // An assignment with no bill yet only gets the e-mail attached; a link with nothing ticked attaches too.
  const canApply = !!target && !!preview && !preview.blocked && !saving && (!confirmNeeded || confirmed)

  const apply = () => {
    if (!target) return
    setSaving(true)
    setError(null)
    apInboxLink(item.id, { kind: target.kind, id: target.id }, ticks, preview?.version)
      .then((r) => {
        toast.success(r.fields.length ? `Updated ${r.fields.map((f) => FIELD_LABEL[f] ?? f).join(', ')} from the e-mail` : 'E-mail attached; no field changed')
        onDone()
      })
      .catch((e: unknown) => {
        const text = graphqlErrorText(e)
        setError(text)
        toast.error(text)
      })
      .finally(() => setSaving(false))
  }

  return (
    <TmsDialog
      open
      onOpenChange={onOpenChange}
      title="Link e-mail to a bill"
      description={`${item.extraction.issuer.name ?? item.fromEmail ?? 'E-mail'} · invoice ${item.extraction.invoiceNumber ?? '—'}`}
      footer={
        <>
          <TmsButton onClick={() => onOpenChange(false)} disabled={saving}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="ap-inbox-link-apply" disabled={!canApply} onClick={apply}>
            {anyTicked ? 'Apply' : 'Attach e-mail only'}
          </TmsButton>
        </>
      }
    >
      <div data-testid="ap-inbox-link-dialog" className="space-y-3">
        <TmsField label="Find a bill">
          <TmsInput aria-label="Search bills" placeholder="Carrier, PRO, shipment #, invoice #" value={search} onChange={(e) => setSearch(e.target.value)} />
        </TmsField>
        <TmsField label="Link to">
          <TmsSelect
            aria-label="Link target"
            value={pick}
            placeholder="Choose…"
            options={shown.map((o) => ({ value: o.key, label: o.label }))}
            onChange={(e) => choose(e.target.value)}
          />
        </TmsField>

        {loading && <p className="tms-muted text-sm">Working out the changes…</p>}
        {preview?.blocked && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{preview.blocked}</p>}
        {preview && !preview.blocked && (
          <table className="w-full text-sm" aria-label="Changes">
            <thead><tr className="text-left text-xs tms-muted"><th /><th>Field</th><th>Now</th><th>E-mail</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.field}>
                  <td>
                    <input
                      type="checkbox"
                      data-testid={`ap-inbox-pick-${r.field}`}
                      aria-label={`Write ${FIELD_LABEL[r.field] ?? r.field}`}
                      checked={!!ticks[r.field]}
                      onChange={(e) => setTicks({ ...ticks, [r.field]: e.target.checked })}
                    />
                  </td>
                  <td>{FIELD_LABEL[r.field] ?? r.field}{r.conflict && <span style={{ color: 'var(--tms-badge-red)' }}> · differs</span>}</td>
                  <td>{show(r.field, r.current)}</td>
                  <td>{show(r.field, r.incoming)}</td>
                </tr>
              ))}
              {skipped.map((s) => (
                <tr key={s.field} className="tms-muted">
                  <td><input type="checkbox" disabled aria-label={`${FIELD_LABEL[s.field] ?? s.field} not written`} /></td>
                  <td>{FIELD_LABEL[s.field] ?? s.field}</td>
                  <td colSpan={2} data-testid={`ap-inbox-skip-${s.field}`}>{SKIP_TEXT[s.reason] ?? s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview && !preview.blocked && target?.kind === 'LOAD_CARRIER' && (
          <p className="tms-muted text-xs">This assignment has no bill yet — only the e-mail and PDF are filed. Use Create bill to record it.</p>
        )}
        {confirmNeeded && preview && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" data-testid="ap-inbox-confirm" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I checked this e-mail belongs to the selected bill (the match was not certain).</span>
          </label>
        )}
        {error && <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      </div>
    </TmsDialog>
  )
}
