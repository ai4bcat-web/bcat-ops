import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { Send, Loader2, Eye, Star } from 'lucide-react'
import { buildConfirmationEmailHtml, buildConfirmationSubject, type ConfirmationFields } from '@/lib/confirmationEmail'
import type { GoogleReviews } from '@/lib/emailChrome'
import { sendVehicleQuoteEmail, getGoogleReviews } from '@/lib/apiClient'
import bestCareLogo from '@/assets/best-care-logo.png'

// Inline-image CID the emailer Lambda embeds the logo under. The on-screen
// preview uses the bundled asset URL; the sent email references this CID.
const LOGO_CID = 'cid:bestcarelogo'

const CC = 'cars@bcatcorp.com'
const FROM = 'ruben@bcatcorp.com'

const TRANSPORT_TYPES = ['Open Transport', 'Enclosed Transport']

const EMPTY: ConfirmationFields = {
  totalCost: '',
  fromZip: '',
  toZip: '',
  pickupDate: '',
  deliveryDate: '',
  transportType: 'Open Transport',
}

// ── Small styled primitives (match the app's inline-style convention) ────────
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginBottom: 5, display: 'block',
}
const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 11px', fontSize: 13.5, color: 'var(--tms-text)',
  background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 8,
  fontFamily: 'inherit', boxSizing: 'border-box',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

export function VehicleConfirmationPage() {
  const [f, setF] = useState<ConfirmationFields>(EMPTY)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [sending, setSending] = useState(false)
  const [reviews, setReviews] = useState<GoogleReviews | null>(null)

  // Live Google rating + count, baked into the preview and every sent confirmation.
  useEffect(() => {
    let alive = true
    getGoogleReviews()
      .then((r) => { if (alive && r.url) setReviews({ ok: r.ok, rating: r.rating, total: r.total, url: r.url }) })
      .catch(() => { /* leave the CTA hidden */ })
    return () => { alive = false }
  }, [])

  const set = <K extends keyof ConfirmationFields>(key: K, value: ConfirmationFields[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  const effectiveTo = to

  const previewHtml = useMemo(() => buildConfirmationEmailHtml(f, { reviews, logoSrc: bestCareLogo }), [f, reviews])
  const effectiveSubject = subject.trim() || buildConfirmationSubject(f)

  const canSend = /.+@.+\..+/.test(effectiveTo.trim()) && !!f.pickupDate.trim() && !sending

  async function handleSend() {
    if (!canSend) {
      if (!/.+@.+\..+/.test(effectiveTo.trim())) toast.error('Enter a valid recipient email address')
      else if (!f.pickupDate.trim()) toast.error('Enter the pickup date')
      return
    }
    setSending(true)
    try {
      // Reuses the vehicle-quote emailer — same sender (ruben@) and auto-CC (cars@).
      const res = await sendVehicleQuoteEmail({
        to: effectiveTo.trim(),
        subject: effectiveSubject,
        html: buildConfirmationEmailHtml(f, { reviews, logoSrc: LOGO_CID }),
        replyTo: FROM,
      })
      if (!res.sent) throw new Error(res.error || 'The email service rejected the message')
      toast.success(`Confirmation sent to ${res.to} (CC ${res.cc ?? CC})`)
    } catch (e) {
      toast.error(`Couldn't send: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <TmsScrollPage
      title="Booking Confirmation"
      subtitle={<>Best Care Auto Transport — sends from {FROM}, CC {CC}</>}
      actions={
        <TmsButton variant="primary" onClick={handleSend} disabled={!canSend}>
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {sending ? 'Sending…' : 'Send Confirmation'}
        </TmsButton>
      }
    >
      {/* Two-column: form + live preview */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── Form ── */}
        <div style={{ flex: '1 1 440px', minWidth: 340, display: 'flex', flexDirection: 'column', gap: 22 }}>

          {/* Send-to */}
          <section style={cardStyle}>
            <SectionTitle>Send To</SectionTitle>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Field label="Recipient email">
                <input
                  type="email" style={inputStyle} placeholder="customer@email.com"
                  value={effectiveTo}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </div>
            <div style={{ marginTop: 14 }}>
              <Field label="Subject (optional — auto-generated if blank)">
                <input
                  type="text" style={inputStyle} placeholder={buildConfirmationSubject(f)}
                  value={subject} onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--tms-muted)', marginTop: 10, marginBottom: 0 }}>
              Every confirmation is automatically CC&rsquo;d to <strong>{CC}</strong> and sent from <strong>{FROM}</strong>.
            </p>
          </section>

          {/* Schedule — the point of this email */}
          <section style={cardStyle}>
            <SectionTitle>Estimated Schedule</SectionTitle>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Field label="Estimated Pickup Date">
                <input type="date" style={inputStyle} value={f.pickupDate} onChange={(e) => set('pickupDate', e.target.value)} />
              </Field>
              <Field label="Estimated Delivery Date">
                <input type="date" style={inputStyle} value={f.deliveryDate} onChange={(e) => set('deliveryDate', e.target.value)} />
              </Field>
            </div>
          </section>

          {/* Rate */}
          <section style={cardStyle}>
            <SectionTitle>Confirmed Rate</SectionTitle>
            <Field label="Amount (USD)">
              <input
                type="text" inputMode="decimal" style={inputStyle} placeholder="1088"
                value={f.totalCost} onChange={(e) => set('totalCost', e.target.value)}
              />
            </Field>
          </section>

          {/* Route */}
          <section style={cardStyle}>
            <SectionTitle>Route Details</SectionTitle>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Field label="From ZIP">
                <input type="text" style={inputStyle} placeholder="31601" value={f.fromZip} onChange={(e) => set('fromZip', e.target.value)} />
              </Field>
              <Field label="To ZIP">
                <input type="text" style={inputStyle} placeholder="60014" value={f.toZip} onChange={(e) => set('toZip', e.target.value)} />
              </Field>
            </div>
            <div style={{ marginTop: 14 }}>
              <Field label="Open or Enclosed Transport">
                <select style={inputStyle} value={f.transportType} onChange={(e) => set('transportType', e.target.value)}>
                  {TRANSPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          </section>
        </div>

        {/* ── Live preview ── */}
        <div style={{ flex: '1 1 560px', minWidth: 360, position: 'sticky', top: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--tms-muted)' }}>
              <Eye size={14} />
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Live email preview
              </span>
            </div>
            {reviews?.ok && reviews.rating != null && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--tms-muted)' }}>
                {/* eslint-disable-next-line no-restricted-syntax -- data colour (Google review star) */}
                <Star size={12} fill="#fbbc04" color="#fbbc04" />
                {reviews.rating.toFixed(1)}{reviews.total != null ? ` · ${reviews.total.toLocaleString('en-US')} Google reviews` : ''}
              </span>
            )}
          </div>
          <div data-tms-paper style={{ border: '1px solid var(--tms-border)', borderRadius: 12, overflow: 'hidden', background: 'var(--tms-paper)' }}>
            <iframe
              title="Confirmation email preview"
              srcDoc={previewHtml}
              style={{ width: '100%', height: 900, border: 'none', display: 'block' }}
            />
          </div>
        </div>
      </div>
    </TmsScrollPage>
  )
}

// ── Section scaffolding ──────────────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, padding: '18px 20px',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--tms-text)', marginBottom: 14, letterSpacing: '-0.01em' }}>
      {children}
    </div>
  )
}
