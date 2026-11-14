import { describe, expect, it } from 'vitest'
import { CUSTOMER, filledValues } from './testFixtures'
import { blockingIssues, issueSummary, toRequiredFieldSubject, validateForm } from './validation'
import { emptyValues } from './model'
import { missingRequiredFields } from '@/lib/flowDefaults'
import { LABEL, SECTION_ORDER, SECTION_TITLE, labelFor } from './labels'

const base = { mode: 'create' as const, settings: null }

describe('required fields by action', () => {
  it('Save draft needs only a customer', () => {
    const v = emptyValues()
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer: null })).map((i) => i.label)).toEqual(['Customer'])
    v.customer.useTyped = true; v.customer.typedName = 'Typed'
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer: null }))).toEqual([])
  })

  it('Create on an empty form lists exactly the Aljex reds, plus what OTR needs to factor it', () => {
    const all = blockingIssues(validateForm(emptyValues(), { ...base, level: 'create', customer: null }))
    expect(all.filter((i) => i.id.includes(':factor:')).map((i) => i.id)).toEqual([
      'rates:factor:RATE_MISSING', 'pickup:factor:PICKUP_CITY', 'pickup:factor:PICKUP_STATE', 'pickup:factor:PICKUP_ZIP',
      'consignee:factor:DELIVERY_CITY', 'consignee:factor:DELIVERY_STATE', 'consignee:factor:DELIVERY_ZIP',
    ])
    const issues = all.filter((i) => !i.id.includes(':factor:'))
    expect(issues.map((i) => i.label)).toEqual(
      expect.arrayContaining(['Name', 'Equipment', 'Division', 'Weight', 'Description']))
    const labels = new Set(issues.map((i) => `${i.section}:${i.label}`))
    expect(labels).toContain('pickup:Name')
    expect(labels).toContain('pickup:Ready')
    expect(issues).toHaveLength(8)
    expect(issueSummary(all)).toMatch(/^15 required fields missing — /)
  })

  it('factor-ready at booking: MC and billing method for the customer, and the rule only warns on a load past draft', () => {
    const v = filledValues()
    const noMc = { ...CUSTOMER, mcNumber: '' }
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: noMc })).map((i) => i.id)).toEqual(['customer:factor:CUSTOMER_MC'])
    // A factored shipper needs no MC (Ryne 2026-11-14).
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: { ...noMc, customerType: 'SHIPPER' } }))).toEqual([])
    const unset = { ...CUSTOMER, billingMethod: null }
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: unset })).map((i) => i.id)).toEqual(['customer:factor:BILLING_METHOD'])
    v.stops[2].zip = ''
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER })).map((i) => i.id)).toEqual(['consignee:factor:DELIVERY_ZIP'])
    const old = validateForm(v, { ...base, mode: 'edit', level: 'create', customer: noMc, existingLoad: true })
    expect(blockingIssues(old)).toEqual([])
    expect(old.filter((i) => i.id.includes(':factor:')).map((i) => i.severity)).toEqual(['warn', 'warn'])
    // A factored load past draft keeps its gaps marked as required on the field (Ryne 2026-11-14), still never blocking a save.
    expect(old.filter((i) => i.id.includes(':factor:')).every((i) => i.marked === true)).toBe(true)
    const manual = validateForm(v, { ...base, mode: 'edit', level: 'create', customer: { ...CUSTOMER, billingMethod: 'MANUAL' }, existingLoad: true })
    expect(manual.filter((i) => i.marked)).toEqual([])
  })

  it('a filled form passes Create; LTL does not need equipment', () => {
    const v = filledValues()
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER }))).toEqual([])
    const ltl = filledValues(); ltl.mode = 'LTL'; ltl.ship.equipmentType = ''
    expect(blockingIssues(validateForm(ltl, { ...base, level: 'create', customer: CUSTOMER }))).toEqual([])
  })

  it('carrier origin city/state are optional, even with a carrier set', () => {
    const v = filledValues(); v.carrier.originCity = ''; v.carrier.originState = ''
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER }))).toEqual([])
    v.carrier.carrierId = 'car-1'
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer: CUSTOMER }))).toEqual([])
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER }))).toEqual([])
  })

  it('the customer’s required references block Create but not Save draft', () => {
    const customer = { ...CUSTOMER, requiredReferences: [{ code: 'PO', label: 'PO', level: 'ORDER' as const, display: true, countOnNewOrder: 1 }] }
    const v = filledValues(); v.customer.refNo = ''
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer })).map((i) => i.id)).toEqual(['customer:ref:po'])
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer }))).toEqual([])
  })

  it('Submit blocks on the required list and on a non-truckload mode; warnings never block Create', () => {
    const v = filledValues(); v.roles.salesRepId = ''; v.customer.billToId = ''
    const create = validateForm(v, { ...base, level: 'create', customer: CUSTOMER })
    expect(blockingIssues(create)).toEqual([])
    expect(create.some((i) => i.severity === 'warn' && i.id.startsWith('roles:needs'))).toBe(true)
    const submit = blockingIssues(validateForm(v, { ...base, level: 'submit', customer: CUSTOMER }))
    expect(submit.map((i) => i.id)).toEqual(expect.arrayContaining(['roles:needs:salesRep', 'customer:needs:billTo']))
    const ltl = filledValues(); ltl.mode = 'LTL'
    expect(blockingIssues(validateForm(ltl, { ...base, level: 'submit', customer: CUSTOMER })).map((i) => i.id)).toContain('shipping:shipmentType:submit')
  })

  it('Submit does not ask for a bill-to when the customer has none to choose, and still does when it has some', () => {
    const v = filledValues(); v.customer.billToId = ''
    const ids = (customer: typeof CUSTOMER) => blockingIssues(validateForm(v, { ...base, level: 'submit', customer })).map((i) => i.id)
    expect(ids({ ...CUSTOMER, billToParties: [] })).not.toContain('customer:needs:billTo')
    expect(ids({ ...CUSTOMER, billToParties: undefined })).not.toContain('customer:needs:billTo')
    expect(ids(CUSTOMER)).toContain('customer:needs:billTo')
  })

  it('a shipment type is required for Create and Submit, and a draft only warns', () => {
    const v = filledValues(); v.shipmentType = ''
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER })).map((i) => i.id)).toEqual(['shipping:shipmentType'])
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer: CUSTOMER }))).toEqual([])
    v.shipmentType = 'NOT_A_TYPE'
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER })).map((i) => i.id)).toEqual(['shipping:shipmentType'])
  })

  it('stop format rules: two-letter state and zip digits', () => {
    const v = filledValues(); v.stops[2].state = 'Texas'; v.stops[2].zip = '75'
    const ids = blockingIssues(validateForm(v, { ...base, level: 'submit', customer: CUSTOMER })).map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['consignee:state:2', 'consignee:zip:2']))
    // Create used to let these through; the consignee is now needed to factor the load.
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer: CUSTOMER })).map((i) => i.id))
      .toEqual(['consignee:factor:DELIVERY_STATE', 'consignee:factor:DELIVERY_ZIP'])
  })

  it('the form → RequiredFieldSubject adapter agrees with the gate on what is missing', () => {
    const v = filledValues()
    expect(missingRequiredFields(toRequiredFieldSubject(v, CUSTOMER), ['pickupAddress', 'deliveryAddress', 'pickupAppt', 'billTo', 'salesRep', 'revenueDivision', 'equipmentType', 'commodity', 'weight', 'poNumber', 'pickupNumber', 'deliveryNumber', 'bolNumber', 'customerRate'])).toEqual([])
    v.customer.refNo = ''; v.ship.weightLbs = ''; v.stops[0].ready = ''; v.stops[0].appt = ''
    expect(missingRequiredFields(toRequiredFieldSubject(v, CUSTOMER), ['poNumber', 'weight', 'pickupAppt'])).toEqual(['poNumber', 'weight', 'pickupAppt'])
  })
})

describe('Aljex wording', () => {
  it('section headings and field labels are Aljex’s verbatim', () => {
    expect(SECTION_ORDER.map((k) => SECTION_TITLE[k])).toEqual([
      'Shipping Requirements', 'Customer', 'Pick Up', 'Consignee', 'Historical Rates', 'Roles',
      'More Information', 'Rates', 'Carrier Information', 'Picks & Stops', 'Documents', 'Check Calls',
    ])
    const texts = [
      LABEL.shipping.equipmentType, LABEL.shipping.revDivision, LABEL.shipping.customerMiles, LABEL.shipping.billableWeightLbs,
      LABEL.shipping.calculateTotals, LABEL.flags.customsBonded, LABEL.flags.strapsChains, LABEL.flags.massRelease,
      LABEL.roles.dispatcherAssigned ?? LABEL.roles.dispatcherAssignedId, LABEL.rates.fscPerMile, LABEL.rates.maxRate,
      LABEL.carrier.originCity, LABEL.carrier.carrierRef, LABEL.carrier.sendRateConf, LABEL.checkCalls.nextAt, LABEL.checkCalls.ediReason,
    ].map((d) => d.text)
    expect(texts).toEqual([
      'Equipment', 'Division', 'Customer Miles', 'Billable wt', 'Calculate Totals from Picks', 'Customs Bonded',
      'Straps/Chains', 'Mass Release', 'Tracking', 'FSC/Mile', 'Max Rate', 'Origin City', 'Carrier Ref #',
      'Send Rate Confirmation', 'Next Chk Call Date And Time', 'EDI Reason',
    ])
    expect(labelFor(LABEL.shipping.weightLbs)).toBe('Weight (required)')
    expect(labelFor(LABEL.shipping.pieces)).toBe('Pieces')
  })
})

describe('customer ref (PO) is required when the customer demands it', () => {
  it('blocks Create with a Customer ref row on the header input; a draft never blocks', () => {
    const v = filledValues(); v.customer.refNo = ''
    const customer = { ...CUSTOMER, reviewRequirements: ['referenceNumber'] }
    const issues = blockingIssues(validateForm(v, { ...base, level: 'create', customer }))
    expect(issues.map((i) => [i.id, i.label, i.fieldKey])).toEqual([['customer:ref:po', 'Customer ref', 'f-customer-refNo']])
    expect(blockingIssues(validateForm(v, { ...base, level: 'draft', customer }))).toEqual([])
    v.customer.refNo = 'PO-1'
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer }))).toEqual([])
  })
  it('the required-reference path and this one never produce two rows', () => {
    const v = filledValues(); v.customer.refNo = ''
    const customer = { ...CUSTOMER, reviewRequirements: ['referenceNumber'], requiredReferences: [{ code: 'PO', label: 'PO', level: 'ORDER' as const, display: true, countOnNewOrder: 1 }] }
    expect(blockingIssues(validateForm(v, { ...base, level: 'create', customer })).filter((i) => i.id === 'customer:ref:po')).toHaveLength(1)
  })
})
