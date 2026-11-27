/**
 * The auto shipper section of the new-shipment form (Ryne 2026-11-27).
 *
 * Shown only when the chosen customer is invoiced through Square. AUTO SHIPPER is a placeholder customer: the real
 * payer is a different person or company on every shipment, so the form collects who to bill (name, e-mail, phone) and
 * the vehicle here, next to the stops and the price the form already asks for. What Square needs and what BCAT Ops
 * needs are asked once, in one place.
 */
import { Input } from '@/components/ui/input'
import { Field, SectionHeading } from '@/features/loads/legForm'
import type { AutoShipperForm } from '../autoShipperForm'

export function AutoShipperFields({ value, onChange, error }: {
  value: AutoShipperForm
  onChange: (next: AutoShipperForm) => void
  error?: string | null
}) {
  const set = <K extends keyof AutoShipperForm>(key: K, v: string) => onChange({ ...value, [key]: v })
  return (
    <div style={{ marginBottom: 24 }} data-testid="auto-shipper-fields">
      <SectionHeading>Auto shipper · who gets the Square invoice</SectionHeading>
      <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 12 }}>
        <Field label="Payer name">
          <Input aria-label="Payer name" value={value.payerName} onChange={(e) => set('payerName', e.target.value)} placeholder="John Smith" className="h-9" />
        </Field>
        <Field label="Company" hint="Optional.">
          <Input aria-label="Payer company" value={value.company} onChange={(e) => set('company', e.target.value)} className="h-9" />
        </Field>
        <Field label="E-mail" hint="Square e-mails the invoice here.">
          <Input aria-label="Payer e-mail" type="email" value={value.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" className="h-9" />
        </Field>
        <Field label="Phone">
          <Input aria-label="Payer phone" type="tel" value={value.phone} onChange={(e) => set('phone', e.target.value)} placeholder="(847) 555-0100" className="h-9" />
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Year">
          <Input aria-label="Vehicle year" inputMode="numeric" maxLength={4} value={value.year} onChange={(e) => set('year', e.target.value)} placeholder="2018" className="h-9" />
        </Field>
        <Field label="Make">
          <Input aria-label="Vehicle make" value={value.make} onChange={(e) => set('make', e.target.value)} placeholder="Honda" className="h-9" />
        </Field>
        <Field label="Model">
          <Input aria-label="Vehicle model" value={value.model} onChange={(e) => set('model', e.target.value)} placeholder="Civic" className="h-9" />
        </Field>
        <Field label="VIN" hint="Optional.">
          <Input aria-label="Vehicle VIN" maxLength={17} value={value.vin} onChange={(e) => set('vin', e.target.value)} className="h-9" />
        </Field>
      </div>
      <p className="tms-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
        The pickup and delivery addresses and the price are below. Nothing is sent to the payer until someone clicks Send invoice
        on the shipment.
      </p>
      {error && <p style={{ fontSize: 12, color: 'var(--tms-badge-red)', margin: '6px 0 0' }}>{error}</p>}
    </div>
  )
}
