/** The auto shipper section's form state and the payload it becomes (Ryne 2026-11-27). Kept out of the component file so fast refresh stays happy. */
import type { CarShippingData } from '@/lib/squareInvoicing'

/** The form's own shape: plain strings the person typed. `normalizeCarShipping` makes them a CarShippingData. */
export interface AutoShipperForm {
  payerName: string
  company: string
  email: string
  phone: string
  year: string
  make: string
  model: string
  vin: string
}

export const EMPTY_AUTO_SHIPPER: AutoShipperForm = {
  payerName: '', company: '', email: '', phone: '', year: '', make: '', model: '', vin: '',
}

/** The shape `normalizeCarShipping` and CREATE_SHIPMENT take. */
export function autoShipperPayload(form: AutoShipperForm): Pick<CarShippingData, 'payer' | 'vehicle'> {
  return {
    payer: { name: form.payerName, company: form.company || null, email: form.email, phone: form.phone },
    vehicle: { year: form.year, make: form.make, model: form.model, vin: form.vin || null },
  }
}

