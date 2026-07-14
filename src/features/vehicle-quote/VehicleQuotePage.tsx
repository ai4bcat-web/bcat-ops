import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Car, Send, Loader2, Eye, Star } from 'lucide-react'
import { buildQuoteEmailHtml, buildQuoteSubject, type QuoteFields, type GoogleReviews } from '@/lib/quoteEmail'
import { sendVehicleQuoteEmail, getGoogleReviews } from '@/lib/apiClient'

const BCC = 'cars@bcatcorp.com'
const FROM = 'ruben@bcatcorp.com'

const TRANSPORT_TYPES = ['Open Transport', 'Enclosed Transport']
const VEHICLE_TYPES = ['sedan', 'SUV', 'truck', 'van', 'coupe', 'convertible', 'motorcycle', 'other']

const EMPTY: QuoteFields = {
  estimatedQuote: '',
  fromZip: '',
  toZip: '',
  shipDate: '',
  transportType: 'Open Transport',
  vehicleType: 'sedan',
  year: '',
  make: '',
  model: '',
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  notes: '',
}

// ── Small styled primitives (match the app's inline-style convention) ────────
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginBottom: 5, display: 'block',
}
const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 11px', fontSize: 13.5, color: 'var(--ds-t1)',
  background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 8,
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

export function VehicleQuotePage() {
  const [f, setF] = useState<QuoteFields>(EMPTY)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [sending, setSending] = useState(false)
  const [reviews, setReviews] = useState<GoogleReviews | null>(null)

  // Pull the live Google rating + count once on mount; baked into the preview and
  // every sent quote. Silent no-op if the Places API isn't configured yet.
  useEffect(() => {
    let alive = true
    getGoogleReviews()
      .then((r) => { if (alive && r.configured) setReviews({ ok: r.ok, rating: r.rating, total: r.total, url: r.url }) })
      .catch(() => { /* leave the CTA hidden */ })
    return () => { alive = false }
  }, [])

  const set = <K extends keyof QuoteFields>(key: K, value: QuoteFields[K]) =>
    setF((prev) => ({ ...prev, [key]: value }))

  // Auto-fill the recipient from the customer email until Ruben edits it directly.
  const [toTouched, setToTouched] = useState(false)
  const effectiveTo = toTouched ? to : (to || f.customerEmail)

  const previewHtml = useMemo(() => buildQuoteEmailHtml(f, { reviews }), [f, reviews])
  const effectiveSubject = subject.trim() || buildQuoteSubject(f)

  const canSend = /.+@.+\..+/.test(effectiveTo.trim()) && !!f.estimatedQuote.trim() && !sending

  async function handleSend() {
    if (!canSend) {
      if (!/.+@.+\..+/.test(effectiveTo.trim())) toast.error('Enter a valid recipient email address')
      else if (!f.estimatedQuote.trim()) toast.error('Enter the estimated quote amount')
      return
    }
    setSending(true)
    try {
      const res = await sendVehicleQuoteEmail({
        to: effectiveTo.trim(),
        subject: effectiveSubject,
        html: buildQuoteEmailHtml(f, { reviews }),
        replyTo: FROM,
      })
      if (!res.sent) throw new Error(res.error || 'The email service rejected the message')
      toast.success(`Quote sent to ${res.to} (BCC ${res.bcc ?? BCC})`)
    } catch (e) {
      toast.error(`Couldn't send: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 32px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: '#e11d2a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Car size={18} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Vehicle Quote</h1>
              <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
                Best Care Auto Transport — sends from {FROM}, BCC {BCC}
              </p>
            </div>
          </div>
          <button
            onClick={handleSend}
            disabled={!canSend}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 18px', borderRadius: 9,
              border: 'none', background: canSend ? '#e11d2a' : 'var(--ds-border)', color: '#fff',
              fontSize: 13.5, fontWeight: 600, cursor: canSend ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
            }}
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {sending ? 'Sending…' : 'Send Quote'}
          </button>
        </div>
      </div>

      {/* Two-column: form + live preview */}
      <div style={{ display: 'flex', gap: 24, padding: '24px 32px 48px', alignItems: 'flex-start', flexWrap: 'wrap' }}>

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
                  onChange={(e) => { setToTouched(true); setTo(e.target.value) }}
                />
              </Field>
            </div>
            <div style={{ marginTop: 14 }}>
              <Field label="Subject (optional — auto-generated if blank)">
                <input
                  type="text" style={inputStyle} placeholder={buildQuoteSubject(f)}
                  value={subject} onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 10, marginBottom: 0 }}>
              Every quote is automatically BCC&rsquo;d to <strong>{BCC}</strong> and sent from <strong>{FROM}</strong>.
            </p>
          </section>

          {/* Quote */}
          <section style={cardStyle}>
            <SectionTitle>Estimated Quote</SectionTitle>
            <Field label="Amount (USD)">
              <input
                type="text" inputMode="decimal" style={inputStyle} placeholder="1088"
                value={f.estimatedQuote} onChange={(e) => set('estimatedQuote', e.target.value)}
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
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 14 }}>
              <Field label="Ship Date">
                <input type="date" style={inputStyle} value={f.shipDate} onChange={(e) => set('shipDate', e.target.value)} />
              </Field>
              <Field label="Transport Type">
                <select style={inputStyle} value={f.transportType} onChange={(e) => set('transportType', e.target.value)}>
                  {TRANSPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            </div>
          </section>

          {/* Vehicle */}
          <section style={cardStyle}>
            <SectionTitle>Vehicle Information</SectionTitle>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Field label="Vehicle Type">
                <select style={inputStyle} value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
                  {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Year">
                <input type="text" inputMode="numeric" style={inputStyle} placeholder="2015" value={f.year} onChange={(e) => set('year', e.target.value)} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 14 }}>
              <Field label="Make">
                <input type="text" style={inputStyle} placeholder="Toyota" value={f.make} onChange={(e) => set('make', e.target.value)} />
              </Field>
              <Field label="Model">
                <input type="text" style={inputStyle} placeholder="Prius" value={f.model} onChange={(e) => set('model', e.target.value)} />
              </Field>
            </div>
          </section>

          {/* Customer contact */}
          <section style={cardStyle}>
            <SectionTitle>Customer Contact</SectionTitle>
            <Field label="Name">
              <input type="text" style={inputStyle} placeholder="Robert Ash" value={f.customerName} onChange={(e) => set('customerName', e.target.value)} />
            </Field>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 14 }}>
              <Field label="Email">
                <input type="email" style={inputStyle} placeholder="bobash46@gmail.com" value={f.customerEmail} onChange={(e) => set('customerEmail', e.target.value)} />
              </Field>
              <Field label="Phone">
                <input type="tel" style={inputStyle} placeholder="8474099511" value={f.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} />
              </Field>
            </div>
          </section>

          {/* Notes */}
          <section style={cardStyle}>
            <SectionTitle>Additional Notes</SectionTitle>
            <textarea
              style={{ ...inputStyle, height: 88, padding: '9px 11px', resize: 'vertical' as const }}
              placeholder="Anything the customer should know…"
              value={f.notes} onChange={(e) => set('notes', e.target.value)}
            />
          </section>
        </div>

        {/* ── Live preview ── */}
        <div style={{ flex: '1 1 560px', minWidth: 360, position: 'sticky', top: 92 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--ds-t3)' }}>
              <Eye size={14} />
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Live email preview
              </span>
            </div>
            {reviews?.ok && reviews.rating != null && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--ds-t3)' }}>
                <Star size={12} fill="#fbbc04" color="#fbbc04" />
                {reviews.rating.toFixed(1)}{reviews.total != null ? ` · ${reviews.total.toLocaleString('en-US')} Google reviews` : ''}
              </span>
            )}
          </div>
          <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, overflow: 'hidden', background: '#eef1f5' }}>
            <iframe
              title="Quote email preview"
              srcDoc={previewHtml}
              style={{ width: '100%', height: 900, border: 'none', display: 'block' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Section scaffolding ──────────────────────────────────────────────────────
const cardStyle: React.CSSProperties = {
  background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '18px 20px',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ds-t1)', marginBottom: 14, letterSpacing: '-0.01em' }}>
      {children}
    </div>
  )
}
