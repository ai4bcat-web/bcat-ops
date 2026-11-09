/**
 * Which letterhead an invoice carries. Fixed per revenue division — Ryne's two reference invoices
 * (BCAT Logistics and Ivan Cartage Co.) differ only in this block; every other field on the page is
 * pulled from the shipment. The company block is a constant, not the `Division` record's
 * `remitToAddress`/`physicalAddress`/`phone`: those are the remit-to and billing-entity fields (and
 * `logoKey` is an S3 key the pure renderer cannot fetch), and the printed letterhead must not move
 * because someone edited a settings card.
 *
 * Pure and import-light: the finance Lambda bundles this file by relative path.
 */
import { BCAT_LOGO, IVAN_LOGO, type InvoiceLogoAsset } from './invoiceLogos'

export type InvoiceTemplateKey = 'BCAT' | 'IVAN'

export interface InvoiceBranding {
  key: InvoiceTemplateKey
  /** First line of the company block. */
  name: string
  /** Street and city lines, as printed. */
  addressLines: string[]
  phone: string
  logo: InvoiceLogoAsset
}

const BRANDS: Record<InvoiceTemplateKey, InvoiceBranding> = {
  BCAT: {
    key: 'BCAT',
    name: 'BCAT LOGISTICS',
    addressLines: ['1193 E HIGGINS RD', 'ELK GROVE VILLAGE, IL 60007'],
    phone: '(847) 450-0899',
    logo: BCAT_LOGO,
  },
  IVAN: {
    key: 'IVAN',
    name: 'IVAN CARTAGE CO',
    addressLines: ['1193 E HIGGINS RD', 'ELK GROVE VILLAGE IL 60007'],
    phone: '(847) 450-0899',
    logo: IVAN_LOGO,
  },
}

/** Top-level divisions and subdivisions that bill on the Ivan Cartage letterhead. */
const IVAN_DIVISIONS: Record<string, true> = { ASSETS: true, OWNER_OPERATOR: true }
const IVAN_SUBDIVISIONS: Record<string, true> = { BOX_TRUCK: true, LOCAL: true, OWNER_OPERATOR: true }

/**
 * ASSETS, BOX_TRUCK, LOCAL and OWNER_OPERATOR bill as Ivan Cartage Co; BROKERAGE, and anything
 * missing or unknown, as BCAT Logistics. CAR_SHIPPING does not invoice through this template at
 * all (it goes through Square); callers skip it before rendering, and the BCAT default here is only
 * what a preview of one would show.
 */
export function invoiceBrandingFor(
  revDivision: string | null | undefined,
  revSubdivision?: string | null,
): InvoiceBranding {
  const division = (revDivision ?? '').trim().toUpperCase()
  const sub = (revSubdivision ?? '').trim().toUpperCase()
  if (IVAN_DIVISIONS[division] || IVAN_SUBDIVISIONS[sub]) return BRANDS.IVAN
  return BRANDS.BCAT
}
