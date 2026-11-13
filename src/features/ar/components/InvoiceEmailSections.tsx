/**
 * The invoice e-mail laid out so each part reads as what it is (Ryne, 2026-11-12: "make the
 * fields more clear of what is what"): an envelope (From / To / CC / Subject, every address a
 * chip, our own addresses tagged Internal), the attachments as file rows, and the message in an
 * e-mail-style box. Shared by the send review and the invoice drawer so the two look the same.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Info, Mail, Paperclip } from 'lucide-react'
import { isInternalAddress } from '../sendReview'
import './invoiceEmail.css'


export function InvoiceEmailSection({ title, icon, children, label }: { title: string; icon: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="inv-email-card" aria-label={label ?? title}>
      <h4 className="inv-email-card-title">{icon}{title}</h4>
      {children}
    </section>
  )
}

function AddressChips({ addresses, kind, empty, label }: { addresses: readonly string[]; kind: 'to' | 'cc' | 'from'; empty: ReactNode; label?: string }) {
  if (addresses.length === 0) return <dd aria-label={label}>{empty}</dd>
  return (
    <dd className="inv-email-chips" aria-label={label}>
      {addresses.map((a) => {
        const internal = kind !== 'from' && isInternalAddress(a)
        return (
          <span key={a} className={`inv-email-chip inv-email-chip-${internal ? 'internal' : kind}`} title={internal ? 'BCAT internal copy' : kind === 'from' ? 'Sent from' : 'Customer'}>
            {a}
            {internal && <span className="inv-email-chip-tag" aria-hidden="true">Internal</span>}
          </span>
        )
      })}
    </dd>
  )
}

/** From / To / CC / Subject as an envelope. */
export function InvoiceEnvelope({ from, to, cc, subject }: { from: string; to: readonly string[]; cc: readonly string[]; subject: string }) {
  return (
    <InvoiceEmailSection title="Email" icon={<Mail size={14} />} label="Email envelope">
      <dl className="inv-email-envelope">
        <dt>From</dt>
        <AddressChips addresses={[from]} kind="from" empty="—" />
        <dt>To</dt>
        <AddressChips addresses={to} kind="to" label="Invoice to"
          empty={<span className="inv-email-missing"><AlertTriangle size={13} /> No AP e-mail on file</span>} />
        <dt>CC</dt>
        <AddressChips addresses={cc} kind="cc" label="Invoice cc" empty={<span className="tms-muted">None</span>} />
        <dt>Subject</dt>
        <dd className="inv-email-subject" aria-label="Invoice subject">{subject}</dd>
      </dl>
      <p className="inv-email-legend">
        <span className="inv-email-chip inv-email-chip-to">Customer</span>
        <span className="inv-email-chip inv-email-chip-internal">BCAT internal</span>
      </p>
    </InvoiceEmailSection>
  )
}

export interface AttachmentRowProps {
  name: string
  type: string
  size?: string
  /** Pages merged into the invoice PDF rather than a file of its own. */
  nested?: boolean
  note?: string
}

/** One file the e-mail carries; nested rows are the POD pages inside the invoice PDF. */
export function AttachmentRow({ name, type, size, nested, note }: AttachmentRowProps) {
  return (
    <li className={`inv-email-file${nested ? ' inv-email-file-nested' : ''}`}>
      {nested ? <CheckCircle2 size={14} className="inv-email-file-check" /> : <FileText size={16} className="inv-email-file-icon" />}
      <span className="inv-email-file-name">{name}</span>
      <span className="inv-email-file-type">{type}</span>
      {note && <span className="inv-email-file-note">{note}</span>}
      {size && <span className="inv-email-file-size">{size}</span>}
    </li>
  )
}

export function AttachmentsSection({ children }: { children: ReactNode }) {
  return (
    <InvoiceEmailSection title="Attachments" icon={<Paperclip size={14} />} label="Invoice attachments">
      {children}
    </InvoiceEmailSection>
  )
}

export function AttachmentInfo({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'error' }) {
  return (
    <p className={`inv-email-info inv-email-info-${tone}`} {...(tone === 'error' ? { role: 'alert' } : {})}>
      {tone === 'muted' ? <Info size={13} /> : <AlertTriangle size={13} />}
      <span>{children}</span>
    </p>
  )
}

/** The body as the customer reads it. */
export function MessageSection({ body }: { body: string }) {
  return (
    <InvoiceEmailSection title="Message" icon={<Mail size={14} />} label="Email message">
      <div className="inv-email-body" aria-label="Invoice body">{body}</div>
    </InvoiceEmailSection>
  )
}
