/**
 * `mapAljexRow(cells, layout, opts)`: one positional CSV row -> CanonicalRow. Pure, never throws.
 * Columns are read by fixed index from the layout (header names repeat, so nothing is looked up
 * by name). Rows are right-truncated in the export: missing trailing cells are blank. A row wider
 * than the header is an error row (`ROW_TOO_LONG`).
 */
import type {
  CanonicalCarrier,
  CanonicalCharge,
  CanonicalDates,
  CanonicalParty,
  CanonicalRow,
  JunkDate,
  RowWarning,
} from './canonical'
import { parseAljexDate, parseAljexTime } from './dates'
import { buildRawRow } from './rawRow'
import type { AljexLayout, ScalarKey } from './layout'
import { parseMoney } from './money'
import { DEFAULT_ALJEX_PROFILE, isMemoType, type AljexProfile } from './profile'
import { buildStops, type RawStop } from './stops'
import { statusKeyOf } from './status'
import { normalizePro } from '../proNumber'

export interface MapOptions {
  /** 1-based data row number (header excluded). */
  rowNumber: number
  /** Only `stopMarkerMap` is read here; everything else is the engine's business. */
  profile?: AljexProfile
}

/** NFC, control characters to spaces, whitespace collapsed, trimmed. */
export function cleanText(value: string | undefined): string {
  if (!value) return ''
  // eslint-disable-next-line no-control-regex
  return value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

const DATE_KEYS = [
  'invoiceDate',
  'shipDate',
  'carrierCaIntrastateExp',
  'carrierTxPucExp',
  'etaDate',
  'deliveryApptDate',
  'mustDeliverDate',
  'deliveredDate',
  'releaseDate',
  'createdDate',
  'coveredDate',
  'confRecdDate',
] as const satisfies readonly ScalarKey[]

export function mapAljexRow(cells: readonly string[], layout: AljexLayout, opts: MapOptions): CanonicalRow {
  const profile = opts.profile ?? DEFAULT_ALJEX_PROFILE
  const warnings: RowWarning[] = []
  const errors: RowWarning[] = []
  const warn = (code: string, column?: string) => warnings.push(column ? { code, column } : { code })
  const fail = (code: string, column?: string) => errors.push(column ? { code, column } : { code })

  if (cells.length > layout.headerCount) fail('ROW_TOO_LONG')

  const at = (i: number | undefined): string => (i === undefined || i < 0 || i >= layout.headerCount ? '' : cleanText(cells[i]))
  const s = (key: ScalarKey): string => at(layout.scalar[key])
  const cents = (text: string, column: string): number | null => {
    const r = parseMoney(text)
    if (r.flag === 'INVALID' || r.flag === 'OVERFLOW') fail(`MONEY_${r.flag}`, column)
    else if (r.flag === 'ROUNDED') warn('MONEY_ROUNDED', column)
    return r.cents
  }
  const money = (key: ScalarKey): number => cents(s(key), key) ?? 0


  // Dates -------------------------------------------------------------------------------
  const junkDates: JunkDate[] = []
  const dateOf = (key: ScalarKey): string | null => {
    const raw = s(key)
    const r = parseAljexDate(raw)
    if (r.junk) {
      junkDates.push({ column: key, value: r.parsed })
      warn('JUNK_DATE', key)
    }
    return r.date
  }
  const d = Object.fromEntries(DATE_KEYS.map((k) => [k, dateOf(k)])) as Record<(typeof DATE_KEYS)[number], string | null>
  const dates: CanonicalDates = {
    invoice: d.invoiceDate,
    ship: d.shipDate,
    eta: d.etaDate,
    deliveryAppt: d.deliveryApptDate,
    deliveryApptTime: parseAljexTime(s('deliveryApptTime')),
    mustDeliver: d.mustDeliverDate,
    delivered: d.deliveredDate,
    release: d.releaseDate,
    releaseTime: parseAljexTime(s('releaseTime')),
    created: d.createdDate,
    createdTime: parseAljexTime(s('createdTime')),
    covered: d.coveredDate,
    coveredTime: parseAljexTime(s('coveredTime')),
    confRecd: d.confRecdDate,
  }
  if (dates.ship && dates.delivered && dates.ship > dates.delivered) warn('SHIP_AFTER_DELIVERED')
  if (dates.invoice && dates.ship && dates.invoice < dates.ship) warn('INVOICE_BEFORE_SHIP')

  // Identity ----------------------------------------------------------------------------
  const pro = s('proNo')
  if (!pro) fail('NO_PRO')
  const typeOfShipment = s('typeOfShipment').toUpperCase()
  const kind: CanonicalRow['kind'] = isMemoType(typeOfShipment) ? (typeOfShipment === 'DEBT' ? 'MEMO_DEBT' : 'MEMO_CRED') : 'LOAD'
  const statusRaw = s('dispatchStatus')
  const rep = s('salesrepId')

  const party = (a: ScalarKey, n: ScalarKey, st: ScalarKey, c: ScalarKey, ss: ScalarKey, z: ScalarKey, contact: string): CanonicalParty => ({
    account: s(a),
    name: s(n),
    street: s(st),
    city: s(c),
    state: s(ss),
    zip: s(z),
    contact,
  })
  const customer = party('customerId', 'customerName', 'customerAddress', 'customerCity', 'customerState', 'customerZip', s('customerContact'))
  const billTo = party('billToId', 'billToName', 'billToAddress', 'billToCity', 'billToState', 'billToZip', '')

  // Money -------------------------------------------------------------------------------
  const balText = s('balDue')
  const moneyBlock = {
    lhRevenueCents: money('lhRevenue'),
    accRevenueCents: money('accRevenue'),
    fscRevenueCents: money('fscRevenue'),
    invoiceAmountCents: money('invoiceAmount'),
    paymentsReceivedCents: money('paymentsReceived'),
    creditsCents: money('credits'),
    debitsCents: money('debits'),
    balDueCents: balText === '' ? null : cents(balText, 'balDue'),
    projectedCarrierExpenseCents: money('projectedCarrierExpense'),
    carrierLhCents: money('carrierLh'),
    carrierAccessorialCents: money('carrierAccessorial'),
    actualCarrierExpCents: money('actualCarrierExp'),
    quickPayFeesCents: money('quickPayFees'),
    advanceFeesCents: money('advanceFees'),
    declaredValueCents: money('declaredValue'),
  }

  // Charges, payments, expenses ----------------------------------------------------------
  const charges: CanonicalCharge[] = []
  for (const g of layout.charges) {
    const f = g.fields
    const code = at(f.code)
    const description = at(f.description)
    const units = at(f.units)
    const weight = at(f.weight)
    const rateText = at(f.rate)
    const extText = at(f.extension)
    if (!(code || description || units || weight || rateText || extText)) continue
    charges.push({
      line: g.ordinal,
      code,
      description,
      units,
      weight,
      rateCents: cents(rateText, `charge${g.ordinal}.rate`),
      extensionCents: cents(extText, `charge${g.ordinal}.extension`) ?? 0,
    })
  }

  // The `Acc Charge n` / `Acc n` pair is a partial mirror of charge lines 7-14 and is only a
  // cross-check. Which column holds the label and which the amount is not confirmed, so whichever
  // parses as money is the amount; a pair never raises a money error.
  const accessorialPairs = layout.accessorials.flatMap((g) => {
    const a = at(g.fields.charge)
    const b = at(g.fields.label)
    const pa = parseMoney(a).cents
    const pb = parseMoney(b).cents
    const [label, amount] = pb != null && pa == null ? [a, pb] : pa != null && pb == null ? [b, pa] : [a, pb ?? 0]
    return label || amount ? [{ n: g.ordinal, label, amountCents: amount }] : []
  })

  const payments = layout.customerPayments.flatMap((g) => {
    const dateText = at(g.fields.date)
    const pd = parseAljexDate(dateText)
    if (pd.junk) warn('JUNK_DATE', `paidDate${g.ordinal}`)
    const amount = cents(at(g.fields.amount), `paidAmount${g.ordinal}`) ?? 0
    const checkNo = at(g.fields.checkNo)
    return amount || pd.parsed || checkNo ? [{ n: g.ordinal, date: pd.date, amountCents: amount, checkNo }] : []
  })

  const projectedExpenses = layout.projectedExpenses.flatMap((g) => {
    const payee = at(g.fields.expense)
    const amount = cents(at(g.fields.amount), `projAmt${g.ordinal}`) ?? 0
    const type = at(g.fields.type)
    return payee || amount || type ? [{ n: g.ordinal, payee, amountCents: amount, type }] : []
  })

  const paidExpenses = layout.paidExpenses.flatMap((g) => {
    const name = at(g.fields.name)
    const pd = parseAljexDate(at(g.fields.date))
    if (pd.junk) warn('JUNK_DATE', `paidExpDate${g.ordinal}`)
    const amount = cents(at(g.fields.amount), `paidExpAmt${g.ordinal}`) ?? 0
    const checkNo = at(g.fields.checkNo)
    const gl = at(g.fields.gl)
    return name || amount || pd.parsed || checkNo ? [{ n: g.ordinal, name, amountCents: amount, date: pd.date, checkNo, gl }] : []
  })

  const commissions = layout.commissions.flatMap((g) => {
    const r = at(g.fields.rep)
    return r ? [{ n: g.ordinal, rep: r }] : []
  })

  // Carrier -----------------------------------------------------------------------------
  const carrierId = s('carrierId')
  const carrierName = s('carrierName')
  let carrier: CanonicalCarrier | null = null
  if (carrierId || carrierName) {
    const prefix = s('carrierMcPrefix').toUpperCase()
    if (prefix === 'MX') warn('MC_PREFIX_MX')
    carrier = {
      id: carrierId,
      name: carrierName,
      refNo: s('carrierRefNo'),
      dispatcher: s('carrierDispatcher'),
      email: s('carrierEmail') || s('carrierEmail1') || s('carrierEmail2'),
      phone: s('carrierPhone'),
      dispatchPhone: s('carrierDispatchPhone'),
      phone24: s('carrier24HrPhone'),
      mcPrefix: prefix,
      mc: s('carrierMc').replace(/\D/g, ''),
      dot: s('carrierDot').replace(/\D/g, ''),
      scac: s('carrierScac'),
      safetyRating: s('carrierSafetyRating').toUpperCase(),
      driverName: s('driverName'),
      tractor: s('tractorNo'),
      caIntrastate: s('carrierCaIntrastate'),
      caIntrastateExp: d.carrierCaIntrastateExp,
      txPuc: s('carrierTxPuc'),
      txPucExp: d.carrierTxPucExp,
    }
  }

  // Freight -----------------------------------------------------------------------------
  const weightText = s('weight').replace(/,/g, '')
  let weight: number | null = null
  if (weightText) {
    if (/^\d+(\.\d+)?$/.test(weightText)) weight = Math.round(Number(weightText))
    else warn('BAD_WEIGHT')
  }
  const milesText = s('miles')
  const flag = (key: ScalarKey): boolean => s(key).toUpperCase() === 'Y'
  const count = (key: ScalarKey): number | null => {
    const t = s(key).replace(/,/g, '')
    return /^\d+$/.test(t) ? Number(t) : null
  }

  // Stops -------------------------------------------------------------------------------
  let stops: CanonicalRow['stops'] = []
  if (kind === 'LOAD') {
    const pickup: RawStop = {
      name: s('pickupName'),
      street: s('pickUpAddress'),
      city: s('pickupCity'),
      state: s('pickupState'),
      zip: s('pickupZip'),
      phone: '',
      contact: s('pickupContact'),
      ref: s('pickupRefNo'),
    }
    const consignee: RawStop = {
      name: s('consigneeName'),
      street: s('finalConsigneeAddress'),
      city: s('consigneeCity'),
      state: s('consigneeState'),
      zip: s('consigneeZip'),
      phone: '',
      contact: s('consigneeContact'),
      ref: s('consigneeRefNo'),
    }
    const blocks = layout.stops.map((g) => ({
      ordinal: g.ordinal,
      marker: at(g.fields.marker),
      name: at(g.fields.name),
      street: at(g.fields.address),
      city: at(g.fields.city),
      state: at(g.fields.state),
      zip: at(g.fields.zip),
      phone: at(g.fields.phone),
      contact: '',
      ref: at(g.fields.ref),
    }))
    const built = buildStops({
      pickup,
      consignee,
      blocks,
      shipDate: dates.ship,
      deliveryApptDate: dates.deliveryAppt,
      deliveryApptTime: dates.deliveryApptTime,
      mustDeliverDate: dates.mustDeliver,
      markerMap: profile.stopMarkerMap,
    })
    stops = built.stops
    warnings.push(...built.warnings)
  }

  if (kind === 'LOAD' && dates.invoice && moneyBlock.invoiceAmountCents === 0) warn('ZERO_INVOICE')
  const currency = s('currency').toUpperCase()
  if (currency !== '' && currency !== 'USD') warn('CURRENCY_NOT_USD', 'currency')

  return {
    rowNumber: opts.rowNumber,
    layoutId: layout.id,
    kind,
    pro,
    proKey: normalizePro(pro),
    typeOfShipment,
    statusRaw,
    statusKey: statusKeyOf(statusRaw),
    tonu: flag('tonu'),
    salesrepId: /^\d+$/.test(rep) ? rep.padStart(3, '0') : rep,
    referenceNo: s('referenceNo'),
    customerRefNo: s('customerRefNo'),
    containerNo: s('containerNo'),
    pickupRefNo: s('pickupRefNo'),
    consigneeRefNo: s('consigneeRefNo'),
    carrierRefNo: s('carrierRefNo'),
    additionalRefs: layout.additionalRefs.map((i) => at(i)).filter(Boolean),
    customer,
    billTo,
    dates,
    junkDates,
    stops,
    charges,
    accessorialPairs,
    carrier,
    money: moneyBlock,
    payments,
    projectedExpenses,
    paidExpenses,
    commissions,
    freight: {
      commodity: s('commodity'),
      weight,
      footage: s('footage'),
      miles: /^\d+$/.test(milesText) ? Number(milesText) : null,
      hazmat: flag('hazmat'),
      tempControl: flag('tempControl'),
      hot: flag('hot'),
      team: flag('team'),
      tarps: flag('tarps'),
      revenueType: s('revenueType').toUpperCase(),
      seal: s('seal'),
      tarpSize: s('tarpSize'),
      pltExchange: flag('pltExchange'),
      customsBond: flag('customsBond'),
      escort: flag('escort'),
      overSize: flag('overSize'),
      permit: flag('permit'),
      blind: flag('blind'),
      labor: flag('labor'),
      highRisk: flag('highRisk'),
      smartway: flag('smartway'),
      pltIn: count('pltIn'),
      pltOut: count('pltOut'),
    },
    staff: {
      enteredBy: s('enteredBy'),
      coveredBy: s('coveredBy'),
      createdBy: s('createdBy'),
      releaseBy: s('releaseBy'),
      billedBy: s('billedBy'),
      serviceRep: s('serviceRep'),
      assignedDispatcher: s('assignedDispatcher'),
      actualDispatcher: s('actualDispatcher'),
    },
    memoAmountText: kind === 'LOAD' ? null : s('invoiceAmount') || null,
    memoAmountCents: kind === 'LOAD' ? null : moneyBlock.invoiceAmountCents,
    memo:
      kind === 'LOAD'
        ? null
        : {
            referencePro: s('referenceNo'),
            referenceProKey: normalizePro(s('referenceNo')),
            description: at(layout.charges[0]?.fields.description),
            postedInfo: s('postedInfo'),
            signedAmountCents: moneyBlock.invoiceAmountCents,
            date: dates.invoice,
          },
    quoteNo: s('quoteNo'),
    manifest: s('manifest'),
    leadSource: s('leadSource'),
    currency,
    osd: flag('osd'),
    office: s('office'),
    officeCoveredBy: s('officeCoveredBy'),
    originRegion: s('originRegion'),
    destinationRegion: s('destinationRegion'),
    warnings,
    errors,
    raw: buildRawRow(cells, layout.headers),
  }
}
