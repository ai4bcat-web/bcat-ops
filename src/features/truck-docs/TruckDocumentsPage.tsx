import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileText, Upload, Eye, RefreshCw, ShieldCheck, CheckCircle2, AlertTriangle, Ban, RotateCcw, ArrowUp, ArrowDown } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { FLEET_GROUP_LABELS } from '@/lib/fleetGroups'
import {
  listAllComplianceDocuments, createComplianceDocument, updateComplianceDocument,
  deleteComplianceDocument, uploadComplianceDocument, getComplianceDocUrl, isAcceptedDoc,
} from '@/lib/complianceClient'
import {
  TRUCK_DOC_SPECS, evaluateTruckDoc, defaultExpiration, iso,
  statusFromExpiration, type TruckDocSpec, type DocState,
} from '@/lib/truckDocs'
import type { ComplianceDocument } from '@/types'

const STATUS_STYLE: Record<DocState, { bg: string; fg: string; label: string }> = {
  VALID:         { bg: '#f0fdf4', fg: '#15803d', label: 'Valid' },
  EXPIRING_SOON: { bg: '#fffbeb', fg: '#b45309', label: 'Expiring soon' },
  EXPIRED:       { bg: '#fef2f2', fg: '#b91c1c', label: 'Expired' },
  MISSING:       { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)', label: 'Missing' },
  WAIVED:        { bg: 'var(--ds-bg)', fg: 'var(--ds-t3)', label: 'Not required' },
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function TruckDocumentsPage() {
  const equipment = useAppStore((s) => s.equipment)
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const { user } = useAuth()
  const isMobile = useIsMobile()

  const [docs, setDocs] = useState<ComplianceDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // after a file is picked, confirm/set the expiration before saving
  const [pending, setPending] = useState<{ truckId: string; spec: TruckDocSpec; file: File; expiration: string } | null>(null)
  // Sorting: 'truck' | 'assignee' | a doc spec key.
  const [sortKey, setSortKey] = useState<string>('truck')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  function toggleSort(k: string) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'truck' || k === 'assignee' ? 'asc' : 'desc') }
  }

  const fileRef = useRef<HTMLInputElement>(null)
  const target = useRef<{ truckId: string; spec: TruckDocSpec } | null>(null)

  useEffect(() => {
    listAllComplianceDocuments()
      .then((all) => setDocs(all.filter((d) => d.entityType === 'TRUCK')))
      .catch((e) => { console.error('[truck-docs] load', e); toast.error('Could not load documents') })
      .finally(() => setLoading(false))
  }, [])

  const trucks = useMemo(
    () => equipment.filter((e) => e.type === 'truck').sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
    [equipment],
  )

  const latest = useMemo(() => {
    const map = new Map<string, ComplianceDocument>()
    for (const d of docs) {
      const k = `${d.entityId}::${d.documentType}`
      const cur = map.get(k)
      if (!cur || d.createdAt > cur.createdAt) map.set(k, d)
    }
    return map
  }, [docs])

  const docFor = (truckId: string, key: string) => latest.get(`${truckId}::${key}`)

  // Sort order for the doc columns — worst status first when sorting descending.
  const DOC_RANK: Record<DocState, number> = { EXPIRED: 4, MISSING: 3, EXPIRING_SOON: 2, VALID: 1, WAIVED: 0 }
  const sortedTrucks = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    const byUnit = (a: typeof trucks[number], b: typeof trucks[number]) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })
    const spec = TRUCK_DOC_SPECS.find((s) => s.key === sortKey)
    return [...trucks].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'truck') cmp = byUnit(a, b)
      else if (sortKey === 'assignee') cmp = (a.fleetManagerAssignee ?? '').localeCompare(b.fleetManagerAssignee ?? '')
      else if (spec) cmp = DOC_RANK[evaluateTruckDoc(a, spec, docFor(a.id, spec.key)).state] - DOC_RANK[evaluateTruckDoc(b, spec, docFor(b.id, spec.key)).state]
      return cmp * dir || byUnit(a, b)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trucks, sortKey, sortDir, latest])

  function setAssignee(truckId: string, value: string) {
    updateEquipment(truckId, { fleetManagerAssignee: value || undefined })
  }

  const fullyDocumented = useMemo(
    () => trucks.filter((t) => TRUCK_DOC_SPECS.every((spec) => {
      const { state } = evaluateTruckDoc(t, spec, latest.get(`${t.id}::${spec.key}`))
      return state !== 'MISSING' && state !== 'EXPIRED'
    })).length,
    [trucks, latest],
  )

  // Everything out of date, missing, or expiring soon on ACTIVE trucks — the red flag banner.
  const issues = useMemo(() => {
    const out: { truck: typeof trucks[number]; spec: TruckDocSpec; kind: 'expired' | 'missing' | 'expiring' }[] = []
    for (const t of trucks) {
      if (!t.active) continue
      for (const spec of TRUCK_DOC_SPECS) {
        const { state } = evaluateTruckDoc(t, spec, latest.get(`${t.id}::${spec.key}`))
        if (state === 'EXPIRED') out.push({ truck: t, spec, kind: 'expired' })
        else if (state === 'MISSING') out.push({ truck: t, spec, kind: 'missing' })
        else if (state === 'EXPIRING_SOON') out.push({ truck: t, spec, kind: 'expiring' })
      }
    }
    return out
  }, [trucks, latest])

  const expiredCount  = issues.filter((i) => i.kind === 'expired').length
  const missingCount  = issues.filter((i) => i.kind === 'missing').length
  const expiringCount = issues.filter((i) => i.kind === 'expiring').length
  const hasCritical   = expiredCount + missingCount > 0

  const busyKey = (truckId: string, key: string) => `${truckId}::${key}`
  const setBusyState = (k: string, on: boolean) =>
    setBusy((prev) => { const n = new Set(prev); if (on) n.add(k); else n.delete(k); return n })

  // ── Actions ─────────────────────────────────────────────────────────────────
  function pickFile(truckId: string, spec: TruckDocSpec) {
    target.current = { truckId, spec }
    fileRef.current?.click()
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const t = target.current
    if (!file || !t) return
    if (!isAcceptedDoc(file)) { toast.error('Upload a PDF, JPG, or PNG (max 15 MB)'); return }
    setPending({ truckId: t.truckId, spec: t.spec, file, expiration: defaultExpiration(t.spec) })
  }

  async function confirmUpload() {
    if (!pending) return
    const { truckId, spec, file, expiration } = pending
    const k = busyKey(truckId, spec.key)
    setBusyState(k, true)
    try {
      const s3Key = await uploadComplianceDocument('TRUCK', truckId, spec.key, file)
      const created = await createComplianceDocument({
        entityType: 'TRUCK', entityId: truckId, documentType: spec.key,
        title: spec.label, s3Key, issueDate: iso(new Date()),
        expirationDate: expiration || null, status: statusFromExpiration(expiration || null),
        uploadedBy: 'INTERNAL', verifiedBy: user?.email ?? 'internal', verifiedAt: new Date().toISOString(),
      })
      setDocs((prev) => [created, ...prev.filter((d) => d.id !== created.id)])
      toast.success(`${spec.label} uploaded`)
      setPending(null)
    } catch (err) {
      console.error('[truck-docs] upload', err); toast.error('Upload failed')
    } finally {
      setBusyState(k, false)
    }
  }

  async function view(doc: ComplianceDocument) {
    if (!doc.s3Key) return
    try { window.open(await getComplianceDocUrl(doc.s3Key), '_blank', 'noopener') }
    catch { toast.error('Could not open document') }
  }

  async function changeExpiration(doc: ComplianceDocument, exp: string) {
    try {
      const updated = await updateComplianceDocument(doc.id, { expirationDate: exp || null, status: statusFromExpiration(exp || null) })
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? updated : d)))
    } catch { toast.error('Could not update expiration') }
  }

  function setDotDate(truckId: string, date: string) {
    updateEquipment(truckId, { dotInspectionDate: date || undefined })
  }

  async function markNotRequired(truckId: string, spec: TruckDocSpec) {
    const k = busyKey(truckId, spec.key)
    setBusyState(k, true)
    try {
      const created = await createComplianceDocument({
        entityType: 'TRUCK', entityId: truckId, documentType: spec.key,
        title: spec.label, s3Key: null, status: 'WAIVED', waivedReason: 'Marked not required',
        uploadedBy: 'INTERNAL', verifiedBy: user?.email ?? 'internal', verifiedAt: new Date().toISOString(),
      })
      setDocs((prev) => [created, ...prev])
    } catch { toast.error('Could not update') } finally { setBusyState(k, false) }
  }

  async function undoNotRequired(doc: ComplianceDocument) {
    const k = busyKey(doc.entityId, doc.documentType)
    setBusyState(k, true)
    try {
      await deleteComplianceDocument(doc.id)
      setDocs((prev) => prev.filter((d) => d.id !== doc.id))
    } catch { toast.error('Could not update') } finally { setBusyState(k, false) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto">
      <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" style={{ display: 'none' }} onChange={onFileChosen} />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              <FileText size={19} style={{ color: 'var(--ds-t3)' }} /> Truck Documents
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
              Insurance, IFTA, IRP &amp; DOT inspection for every truck
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10 }}>
            <ShieldCheck size={16} style={{ color: fullyDocumented === trucks.length ? '#15803d' : 'var(--ds-t3)' }} />
            <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
              <span style={{ fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{fullyDocumented}</span>
              {' '}of{' '}
              <span style={{ fontWeight: 700, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{trucks.length}</span>
              {' '}trucks covered
            </span>
          </div>
        </div>

        {/* Out-of-date flag banner */}
        {issues.length > 0 && (
          <div style={{ border: `1px solid ${hasCritical ? '#fecaca' : '#fde68a'}`, background: hasCritical ? '#fef2f2' : '#fffbeb', borderRadius: 12, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <AlertTriangle size={17} style={{ color: hasCritical ? '#b91c1c' : '#b45309', flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: hasCritical ? '#991b1b' : '#92400e' }}>
                {[
                  expiredCount  && `${expiredCount} expired`,
                  missingCount  && `${missingCount} missing`,
                  expiringCount && `${expiringCount} expiring soon`,
                ].filter(Boolean).join(' · ')}
                {' — action needed'}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {issues.slice(0, 14).map((i, idx) => {
                const crit = i.kind !== 'expiring'
                return (
                  <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 6, background: '#fff', border: `1px solid ${crit ? '#fecaca' : '#fde68a'}`, color: crit ? '#b91c1c' : '#b45309' }}>
                    #{i.truck.unitNumber} · {i.spec.label}
                    <span style={{ opacity: 0.7, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.03em' }}>{i.kind}</span>
                  </span>
                )
              })}
              {issues.length > 14 && <span style={{ fontSize: 11.5, color: 'var(--ds-t3)', alignSelf: 'center' }}>+{issues.length - 14} more</span>}
            </div>
          </div>
        )}

        {/* Matrix */}
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  {(() => {
                    const arrow = (k: string) => sortKey === k ? (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null
                    return (
                      <>
                        <th style={{ ...thStyle, minWidth: 180, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('truck')}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: sortKey === 'truck' ? 'var(--ds-t1)' : undefined }}>Truck {arrow('truck')}</span>
                        </th>
                        <th style={{ ...thStyle, minWidth: 120, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('assignee')}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: sortKey === 'assignee' ? 'var(--ds-t1)' : undefined }}>Assignee {arrow('assignee')}</span>
                        </th>
                        {TRUCK_DOC_SPECS.map((d) => (
                          <th key={d.key} style={{ ...thStyle, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(d.key)}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: sortKey === d.key ? 'var(--ds-t1)' : 'var(--ds-t1)', textTransform: 'none', letterSpacing: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{d.label} {arrow(d.key)}</div>
                            <div style={{ fontSize: 10.5, color: 'var(--ds-t3)', fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginTop: 1 }}>{d.sub}</div>
                          </th>
                        ))}
                      </>
                    )
                  })()}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>Loading…</td></tr>
                ) : sortedTrucks.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>No trucks in the fleet yet. Add trucks on the Fleet page.</td></tr>
                ) : sortedTrucks.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                    {/* Truck identity */}
                    <td style={{ padding: '10px 16px', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>#{t.unitNumber}</span>
                        {t.fleetGroup && (
                          <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', color: 'var(--ds-t2)' }}>
                            {FLEET_GROUP_LABELS[t.fleetGroup]}
                          </span>
                        )}
                        {!t.active && <span style={{ fontSize: 10.5, color: 'var(--ds-t3)' }}>inactive</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 2 }}>
                        {t.nickname || `${t.make} ${t.model}`.trim() || '—'}
                      </div>
                    </td>

                    {/* Assignee — Jason / Ryne (fleet manager on the truck record) */}
                    <td style={{ padding: '10px 16px', verticalAlign: 'top' }}>
                      <select
                        value={t.fleetManagerAssignee ?? ''}
                        onChange={(e) => setAssignee(t.id, e.target.value)}
                        title="Who's responsible for this truck's documents"
                        style={{ height: 30, width: '100%', maxWidth: 120, padding: '0 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: t.fleetManagerAssignee ? 'var(--ds-t1)' : 'var(--ds-t3)', fontSize: 12.5, fontFamily: 'inherit', textTransform: 'capitalize' }}
                      >
                        <option value="">— Unassigned —</option>
                        <option value="jason">Jason</option>
                        <option value="ryne">Ryne</option>
                      </select>
                    </td>

                    {/* One cell per required document */}
                    {TRUCK_DOC_SPECS.map((spec) => {
                      const ev = evaluateTruckDoc(t, spec, docFor(t.id, spec.key))
                      const st = STATUS_STYLE[ev.state]
                      const isBusy = busy.has(busyKey(t.id, spec.key))
                      return (
                        <td key={spec.key} style={{ padding: '10px 16px', verticalAlign: 'top' }}>
                          {ev.state === 'WAIVED' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={chipStyle(st.bg, st.fg)}><Ban size={11} /> Not required</span>
                              <button onClick={() => ev.doc && undoNotRequired(ev.doc)} disabled={isBusy} style={miniBtn}><RotateCcw size={12} /> Mark required</button>
                            </div>
                          ) : spec.dot ? (
                            // DOT — sourced from the truck's own last-inspection date (Fleet tab)
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {ev.lastDot
                                ? <span style={chipStyle(st.bg, st.fg)}>{ev.state === 'VALID' ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}{st.label}</span>
                                : <span style={chipStyle(STATUS_STYLE.MISSING.bg, STATUS_STYLE.MISSING.fg)}>No date set</span>}
                              <label style={dateLabelStyle}>
                                Last
                                <input type="date" value={t.dotInspectionDate ?? ''} onChange={(e) => setDotDate(t.id, e.target.value)} title="Last DOT inspection (syncs with Fleet)" style={dateInputStyle} />
                              </label>
                              {ev.lastDot && (
                                <div style={{ fontSize: 10.5, color: 'var(--ds-t3)' }}>
                                  Next due <b style={{ color: 'var(--ds-t2)' }}>{ev.expiration}</b> · {t.fleetGroup === 'AMAZON' ? 'every 2 mo' : 'yearly'}
                                </div>
                              )}
                              <button onClick={() => markNotRequired(t.id, spec)} disabled={isBusy} style={linkBtn}>Not required</button>
                            </div>
                          ) : ev.doc?.s3Key ? (
                            // Uploaded document
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={chipStyle(st.bg, st.fg)}>{ev.state === 'EXPIRED' || ev.state === 'EXPIRING_SOON' ? <AlertTriangle size={11} /> : <CheckCircle2 size={11} />}{st.label}</span>
                              <label style={dateLabelStyle}>
                                Exp
                                <input type="date" value={ev.doc.expirationDate ?? ''} onChange={(e) => changeExpiration(ev.doc!, e.target.value)} title="Expiration date" style={dateInputStyle} />
                              </label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => view(ev.doc!)} style={miniBtn}><Eye size={12} /> View</button>
                                <button onClick={() => pickFile(t.id, spec)} disabled={isBusy} style={miniBtn}><RefreshCw size={12} className={isBusy ? 'animate-spin' : undefined} /> Replace</button>
                              </div>
                            </div>
                          ) : (
                            // Missing
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                              <button onClick={() => pickFile(t.id, spec)} disabled={isBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7, border: '1px dashed var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', opacity: isBusy ? 0.6 : 1 }}>
                                {isBusy ? <RefreshCw size={13} className="animate-spin" /> : <Upload size={13} />} {isBusy ? 'Uploading…' : 'Upload'}
                              </button>
                              <button onClick={() => markNotRequired(t.id, spec)} disabled={isBusy} style={linkBtn}>Not required</button>
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', margin: '0 2px' }}>
          DOT inspection dates come from each truck’s record on the Fleet tab and drive the next-due date automatically
          (Amazon fleet every 2 months, Ivan yearly). Uploaded files are stored on the truck’s compliance record. Accepted: PDF, JPG, PNG.
        </p>
      </div>

      {/* Confirm expiration before saving an upload */}
      {pending && (() => {
        const truck = trucks.find((t) => t.id === pending.truckId)
        const saving = busy.has(busyKey(pending.truckId, pending.spec.key))
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }} onMouseDown={() => !saving && setPending(null)}>
            <div style={{ background: 'var(--ds-surface)', borderRadius: 10, border: '1px solid var(--ds-border)', boxShadow: '0 8px 32px rgba(0,0,0,0.22)', width: 420, maxWidth: '92vw', overflow: 'hidden' }} onMouseDown={(e) => e.stopPropagation()}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>{pending.spec.label} · #{truck?.unitNumber}</div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pending.file.name}</div>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expiration date</label>
                <input type="date" value={pending.expiration} onChange={(e) => setPending((p) => (p ? { ...p, expiration: e.target.value } : p))} style={{ height: 36, padding: '0 10px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit' }} />
              </div>
              <div style={{ padding: '12px 20px', borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setPending(null)} disabled={saving} style={{ height: 34, padding: '0 14px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                <button onClick={confirmUpload} disabled={saving || !pending.expiration} style={{ height: 34, padding: '0 18px', borderRadius: 6, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: saving || !pending.expiration ? 0.5 : 1 }}>
                  {saving ? 'Uploading…' : 'Save & upload'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function chipStyle(bg: string, fg: string): React.CSSProperties {
  return { alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: bg, color: fg }
}

const thStyle: React.CSSProperties = {
  padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
  letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}

const miniBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', borderRadius: 6,
  border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)',
  fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--ds-t3)', fontSize: 11,
  fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline', alignSelf: 'flex-start',
}

const dateLabelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--ds-t3)', display: 'flex', alignItems: 'center', gap: 5 }
const dateInputStyle: React.CSSProperties = { height: 26, padding: '0 6px', borderRadius: 5, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 11.5, fontFamily: 'inherit' }
