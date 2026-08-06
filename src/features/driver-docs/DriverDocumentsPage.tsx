import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { FileSignature, PenLine, Mail, Eye, CheckCircle2, X, Send } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useIsMobile } from '@/hooks/useIsMobile'
import { getComplianceDocUrl, createSignatureRequest } from '@/lib/complianceClient'
import { useAllComplianceDocuments } from '@/hooks/useAllComplianceDocuments'
import { DRIVER_DOC_SPECS, IC_STATUS_SPEC, IC_STATUS_TITLE, MOTOR_CARRIER_NAME } from '@/lib/driverDocs'
import { signingUrl } from './signing'
import { useAuth } from '@/hooks/useAuth'
import type { ComplianceDocument } from '@/types'
import { IndependentContractorFormModal } from './IndependentContractorFormModal'

const thStyle: React.CSSProperties = {
  padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
  letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
}
const miniBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)',
  fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
}

export function DriverDocumentsPage() {
  const drivers = useAppStore((s) => s.drivers)
  const isMobile = useIsMobile()
  const [filling, setFilling] = useState<{ id: string; name: string; email?: string } | null>(null)
  const [emailing, setEmailing] = useState<{ id: string; name: string; email?: string } | null>(null)

  // Shared dataset + shared "current document" rule — was a fourth independent scan.
  const { docFor, loading, refresh } = useAllComplianceDocuments()
  const load = refresh
  const latest = { get: (k: string) => { const [id, type] = k.split('::'); return docFor('DRIVER', id, type) } }

  // The IC Status form applies to owner-operators; show them first, then everyone else.
  const rows = useMemo(
    () => drivers
      .filter((d) => d.active !== false)
      .sort((a, b) => (rank(a.driverType) - rank(b.driverType)) || a.name.localeCompare(b.name)),
    [drivers],
  )
  const signedCount = useMemo(
    () => rows.filter((d) => latest.get(`${d.id}::${IC_STATUS_SPEC.key}`)?.status === 'VALID').length,
    [rows, latest],
  )

  async function viewDoc(doc: ComplianceDocument) {
    if (!doc.s3Key) return
    try { window.open(await getComplianceDocUrl(doc.s3Key), '_blank') }
    catch { toast.error('Could not open document') }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              <FileSignature size={19} style={{ color: 'var(--ds-t3)' }} /> Driver Documents
            </h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Fillable, signable forms saved to each driver’s profile</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10 }}>
            <CheckCircle2 size={16} style={{ color: signedCount ? '#15803d' : 'var(--ds-t3)' }} />
            <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
              <span style={{ fontWeight: 700, color: 'var(--ds-t1)' }}>{signedCount}</span> IC Status signed
            </span>
          </div>
        </div>

        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ds-border)' }}>
                  <th style={{ ...thStyle, minWidth: 200 }}>Driver</th>
                  <th style={{ ...thStyle, minWidth: 130 }}>Type</th>
                  {DRIVER_DOC_SPECS.map((s) => <th key={s.key} style={{ ...thStyle, minWidth: 260 }}>{s.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={2 + DRIVER_DOC_SPECS.length} style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={2 + DRIVER_DOC_SPECS.length} style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>No active drivers.</td></tr>
                ) : rows.map((d) => {
                  const doc = latest.get(`${d.id}::${IC_STATUS_SPEC.key}`)
                  const signed = doc?.status === 'VALID'
                  return (
                    <tr key={d.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                      <td style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>{d.name}</td>
                      <td style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--ds-t3)' }}>{typeLabel(d.driverType)}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {signed ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: '#f0fdf4', color: '#15803d' }}>
                              <CheckCircle2 size={12} /> Signed
                            </span>
                          ) : (
                            <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: 'var(--ds-bg)', color: 'var(--ds-t3)' }}>Not signed</span>
                          )}
                          <button style={miniBtn} onClick={() => setFilling({ id: d.id, name: d.name, email: d.email })}><PenLine size={13} /> {signed ? 'Re-sign' : 'Fill & sign'}</button>
                          <button style={miniBtn} onClick={() => setEmailing({ id: d.id, name: d.name, email: d.email })}><Mail size={13} /> Send for signature</button>
                          {signed && doc && <button style={miniBtn} onClick={() => viewDoc(doc)}><Eye size={13} /> View</button>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', margin: '0 2px' }}>
          The Independent Contractor Status statement applies to owner-operators. Fill &amp; sign captures a typed
          e-signature and saves the completed PDF to the driver’s compliance record.
        </p>
      </div>

      {filling && <IndependentContractorFormModal driver={filling} onClose={() => setFilling(null)} onSaved={() => { setFilling(null); load() }} />}
      {emailing && <EmailComposeModal driver={emailing} onClose={() => setEmailing(null)} />}
    </div>
  )
}

/**
 * Create a tokenized signing request for this driver, then hand the office a ready email
 * (with the secure signing link + their own context) to send. The driver opens the link,
 * fills + e-signs, and it lands back on their profile automatically — no office step.
 */
function EmailComposeModal({ driver, onClose }: { driver: { id: string; name: string; email?: string }; onClose: () => void }) {
  const { user } = useAuth()
  const [to, setTo] = useState(driver.email ?? '')
  const [subject, setSubject] = useState(`Please sign: ${IC_STATUS_TITLE}`)
  const [context, setContext] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const bodyText = () =>
    `Hi ${driver.name.split(' ')[0] || ''},\n\n` +
    (context.trim() ? `${context.trim()}\n\n` : '') +
    `Please complete and sign the ${IC_STATUS_TITLE} at the secure link below. Initial each statement, fill in your details, and type your name to sign — it returns to us automatically.\n\n` +
    `${link ?? '[signing link]'}\n\nThank you,\n${MOTOR_CARRIER_NAME}`

  async function createAndSend() {
    if (!/.+@.+\..+/.test(to.trim())) { toast.error('Enter a valid recipient email'); return }
    setCreating(true)
    try {
      let url = link
      if (!url) {
        const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
        await createSignatureRequest({
          driverId: driver.id, driverName: driver.name, documentType: IC_STATUS_SPEC.key,
          documentTitle: IC_STATUS_TITLE, token, sentTo: to.trim(), createdBy: user?.email ?? undefined,
        })
        url = signingUrl(token)
        setLink(url)
      }
      const body = bodyText().replace('[signing link]', url!)
      window.open(`mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_self')
      toast.success('Signing link created — your email is ready to send')
      onClose()
    } catch (e) {
      toast.error(`Couldn’t create signing request: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setCreating(false)
    }
  }

  const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit' }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 }} onMouseDown={onClose}>
      <div style={{ background: 'var(--ds-surface)', borderRadius: 12, border: '1px solid var(--ds-border)', width: 520, maxWidth: '95vw', overflow: 'hidden' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)' }}>Send for signature · {driver.name}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)' }}><X size={18} /></button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', marginBottom: 4 }}>TO</div><input style={field} value={to} onChange={(e) => setTo(e.target.value)} placeholder="driver@email.com" /></div>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', marginBottom: 4 }}>SUBJECT</div><input style={field} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', marginBottom: 4 }}>YOUR MESSAGE (optional context)</div><textarea style={{ ...field, height: 110, resize: 'vertical' }} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Add a note for the driver…" /></div>
          <p style={{ fontSize: 11, color: 'var(--ds-t3)', margin: 0 }}>A secure signing link is generated and added to the email. The driver signs online and it saves to their profile automatically.</p>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--ds-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={createAndSend} disabled={creating} style={{ height: 34, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}><Send size={13} /> {creating ? 'Creating…' : 'Create link & open email'}</button>
        </div>
      </div>
    </div>
  )
}

function rank(t?: string | null): number { return t === 'OWNER_OPERATOR' ? 0 : t === 'COMPANY' ? 1 : 2 }
function typeLabel(t?: string | null): string { return t === 'OWNER_OPERATOR' ? 'Owner-operator' : t === 'COMPANY' ? 'Company' : 'Unclassified' }
