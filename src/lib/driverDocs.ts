// Driver document registry — the driver-side analogue of truckDocs.ts. Each spec is a
// form that can be filled + signed and stored on a driver's compliance record
// (entityType: 'DRIVER'). The Driver Documents page renders one column per spec.
//
// Start: the Wisconsin "Statement of Independent Contractor Status" (owner-operators).
// Add specs here as new driver forms are defined.

export interface DriverDocSpec {
  /** documentType key on the stored ComplianceDocument. */
  key: string
  label: string
  sub: string
  /** Only relevant for these driver types (omit = all). Owner-op form → OWNER_OPERATOR. */
  appliesToDriverType?: 'COMPANY' | 'OWNER_OPERATOR'
  /** Signed statements carry no expiration (valid while leased); true → ask for one. */
  hasExpiration?: boolean
}

/** The 14 statutory statements the owner-operator initials "yes" (verbatim, WI 02/2008). */
export const IC_STATUS_STATEMENTS: readonly string[] = [
  'I operate my own business, a sole proprietorship, and as an owner-operator I either own my tractor (“vehicle”) or lease the tractor pursuant to the terms of a bona fide lease. The vehicle is licensed and registered as a truck, road tractor, or truck tractor by a governmental agency.',
  'I am leased onto a for-hire motor carrier pursuant to the terms of a written contract, and the contract states that I am an independent contractor of the motor carrier and not an employee.',
  'I am responsible for the maintenance of my vehicle and I incur the main operating expenses of my vehicle including, but not limited to, fuel, repairs, supplies, collision insurance, and my travel expenses while I am operating the vehicle.',
  'I do not have any employees or independent contractors performing work that is required under the written contract with the motor carrier.',
  'I hold a federal employer identification number with the federal internal revenue service and have filed self-employment income tax returns with the federal internal revenue service for the previous year.',
  'I am not compensated by the number of hours or time spent hauling for the motor carrier as I am paid pursuant to the terms of the written contract and am paid by the job or commission or on a competitive bid basis and not any other basis. I receive an IRS Form 1099 from the motor carrier each year.',
  'I either realize a profit or a loss under the contracts I enter into to perform services and work for motor carriers.',
  'I have recurring business liabilities and obligations including, but not limited to, bob tail insurance, physical damage insurance, vehicle licenses and fees.',
  'The success or failure of my business depends upon the relationship of business receipts to expenditures.',
  'I determine the details and means of performing the services I have contracted to do and do so in conformance with regulatory requirements and shipper specifications.',
  'I am responsible for the satisfactory completion of the work and services that I have contracted to perform for motor carrier and am liable for any failure to complete such work and services.',
  'I have the option of refusing loads offered by the motor carrier.',
  'I understand that as an independent contractor I am NOT an employee of the motor carrier and I am NOT eligible to receive workers compensation benefits under any policy the motor carrier has. I am responsible for obtaining my own workers’ compensation policy if I want such benefits or I may choose to obtain an occupational accident policy available to self employed individuals like myself.',
  'I declare that all of the above statements are true and correct and will remain true and correct as long as I am leased onto the motor carrier I provide this statement to.',
]

export const IC_STATUS_TITLE = 'Statement of Independent Contractor Status — Wisconsin'
export const MOTOR_CARRIER_NAME = 'Ivan Cartage Co.'

export const IC_STATUS_SPEC: DriverDocSpec = {
  key: 'ic_status_wi',
  label: 'IC Status (WI)',
  sub: 'Independent Contractor Statement',
  appliesToDriverType: 'OWNER_OPERATOR',
}

export const DRIVER_DOC_SPECS: readonly DriverDocSpec[] = [IC_STATUS_SPEC]

/** The filled + signed form values captured from the owner-operator (and carrier ack). */
export interface ICStatusValues {
  initials: boolean[]     // length 14, one per statement
  printName: string
  date: string            // YYYY-MM-DD (contractor signature date)
  ein: string             // Federal Employer Tax Identification #
  signature: string       // typed-name e-signature of the sole proprietor
  carrierName: string     // motor carrier (defaults to Ivan Cartage Co.)
  carrierDate: string     // YYYY-MM-DD
  carrierBy: string       // carrier signer printed name
  carrierTitle: string    // carrier signer title
}

export function emptyICStatus(): ICStatusValues {
  return {
    initials: IC_STATUS_STATEMENTS.map(() => false),
    printName: '', date: '', ein: '', signature: '',
    carrierName: MOTOR_CARRIER_NAME, carrierDate: '', carrierBy: '', carrierTitle: '',
  }
}

/** Contractor section is complete when every statement is initialed + name/EIN/signature present. */
export function icStatusContractorComplete(v: ICStatusValues): boolean {
  return v.initials.every(Boolean) && !!v.printName.trim() && !!v.ein.trim() && !!v.signature.trim()
}
