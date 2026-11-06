/**
 * The single source of Aljex wording for the shipment form (AH-plan §4, §10.1).
 *
 * `LABEL.<section>.<key>` = `{ text, help?, testId, required? }`. `text` is Aljex's label
 * verbatim; `help` names our underlying field where it differs. Sections render `text` as the
 * visible label and `labelFor(...)` as the control's `aria-label` (required ones end in
 * " (required)"). `TAB_ORDER` is the Aljex reading order the harness pins.
 */
import type { SectionKey } from './sectionProps'

export interface LabelDef {
  text: string
  help?: string
  testId: string
  required?: boolean
}

function def(section: string, key: string, text: string, extra: { help?: string; required?: boolean } = {}): LabelDef {
  return { text, testId: `f-${section}-${key}`, ...extra }
}

export const SECTION_TITLE: Record<SectionKey, string> = {
  shipping: 'Shipping Requirements',
  customer: 'Customer',
  pickup: 'Pick Up',
  consignee: 'Consignee',
  history: 'Historical Rates',
  roles: 'Roles',
  more: 'More Information',
  rates: 'Rates',
  carrier: 'Carrier Information',
  picks: 'Picks & Stops',
  documents: 'Documents',
  checkCalls: 'Check Calls',
}

/** DOM order of the sections = spec order 1…12 = Aljex's reading order. */
export const SECTION_ORDER: readonly SectionKey[] = [
  'shipping', 'customer', 'pickup', 'consignee', 'history', 'roles',
  'more', 'rates', 'carrier', 'picks', 'documents', 'checkCalls',
] as const

export const LABEL = {
  shipping: {
    shipmentType: def('shipping', 'shipmentType', 'Shipment type'),
    equipmentType: def('shipping', 'equipmentType', 'Equipment', { required: true }),
    revDivision: def('shipping', 'revDivision', 'Revenue Type', { required: true, help: 'Revenue division (ownership tag)' }),
    office: def('shipping', 'office', 'Office', { help: 'Follows the Sales Representative’s team' }),
    customerMiles: def('shipping', 'customerMiles', 'Customer Miles', { help: 'Load miles — every per-mile charge multiplies this' }),
    truckMiles: def('shipping', 'truckMiles', 'Truck Miles'),
    footage: def('shipping', 'footage', 'Footage'),
    pieces: def('shipping', 'pieces', 'Pieces'),
    weightLbs: def('shipping', 'weightLbs', 'Weight', { required: true }),
    billableWeightLbs: def('shipping', 'billableWeightLbs', 'Billable Weight'),
    calculateTotals: def('shipping', 'calculateTotals', 'Calculate Totals from Picks'),
    disableMileage: def('shipping', 'disableMileage', 'Disable Mileage'),
    freightClass: def('shipping', 'freightClass', 'Freight Class'),
    description: def('shipping', 'description', 'Description', { required: true, help: 'Commodity' }),
    declaredValue: def('shipping', 'declaredValue', 'Declared Value'),
    liftgate: def('shipping', 'liftgate', 'Liftgate'),
    inside: def('shipping', 'inside', 'Inside'),
    tempControl: def('shipping', 'tempControl', 'Temp Control'),
    tempType: def('shipping', 'tempType', 'Temp Type'),
    tempMin: def('shipping', 'tempMin', 'Min Temp'),
    tempMax: def('shipping', 'tempMax', 'Max Temp'),
    tempPreCool: def('shipping', 'tempPreCool', 'PreCool'),
    palletExchange: def('shipping', 'palletExchange', 'Pallet Exchange'),
    palletsIn: def('shipping', 'palletsIn', 'Pallets In'),
    palletsOut: def('shipping', 'palletsOut', 'Pallets Out'),
    tarps: def('shipping', 'tarps', 'Tarps'),
    tarpSize: def('shipping', 'tarpSize', 'Tarp Size'),
  },
  flags: {
    permits: def('shipping', 'flag-permits', 'Permits'),
    fsma: def('shipping', 'flag-fsma', 'FSMA'),
    oversized: def('shipping', 'flag-oversized', 'Oversized'),
    hazmat: def('shipping', 'flag-hazmat', 'Hazmat'),
    escorts: def('shipping', 'flag-escorts', 'Escorts'),
    seal: def('shipping', 'flag-seal', 'Seal', { help: 'A requirement, not a seal number — the number is Carrier › Seal' }),
    blind: def('shipping', 'flag-blind', 'Blind'),
    customsBonded: def('shipping', 'flag-customsBonded', 'Customs Bonded'),
    osd: def('shipping', 'flag-osd', 'OSD'),
    strapsChains: def('shipping', 'flag-strapsChains', 'Straps/Chains'),
    noBroker: def('shipping', 'flag-noBroker', 'No Broker'),
    team: def('shipping', 'flag-team', 'Team'),
    hot: def('shipping', 'flag-hot', 'Hot'),
    labor: def('shipping', 'flag-labor', 'Labor'),
    highRisk: def('shipping', 'flag-highRisk', 'High Risk'),
    massRelease: def('shipping', 'flag-massRelease', 'Mass Release', { help: 'A marker only; it never bypasses the release gate' }),
    tonu: def('shipping', 'flag-tonu', 'TONU', { help: 'Set via Carrier › TONU once a carrier is booked' }),
  },
  customer: {
    name: def('customer', 'name', 'Name', { required: true }),
    address: def('customer', 'address', 'Address'),
    city: def('customer', 'city', 'City'),
    state: def('customer', 'state', 'State'),
    zip: def('customer', 'zip', 'Zip'),
    country: def('customer', 'country', 'Country'),
    contact: def('customer', 'contact', 'Contact'),
    phone: def('customer', 'phone', 'Phone'),
    hours: def('customer', 'hours', 'Hours'),
    email: (n: number) => def('customer', `email-${n}`, `Email ${n}`),
    refNo: def('customer', 'refNo', 'Ref #', { help: 'PO reference' }),
    billTo: def('customer', 'billTo', 'Bill to'),
  },
  stop: {
    name: def('stop', 'name', 'Name'),
    address1: def('stop', 'address1', 'Address'),
    address2: def('stop', 'address2', 'Address 2'),
    city: def('stop', 'city', 'City'),
    state: def('stop', 'state', 'State'),
    zip: def('stop', 'zip', 'Zip'),
    country: def('stop', 'country', 'Country'),
    contact: def('stop', 'contact', 'Contact'),
    phone: def('stop', 'phone', 'Phone'),
    hours: def('stop', 'hours', 'Hours'),
    email: def('stop', 'email', 'Email'),
    refNo: def('stop', 'refNo', 'Ref #'),
    ready: def('stop', 'ready', 'Ready'),
    appt: def('stop', 'appt', 'Appt'),
    mustDeliver: def('stop', 'mustDeliver', 'Must Deliver'),
    note: def('stop', 'note', 'Note'),
    pieces: def('stop', 'pieces', 'Pieces'),
    weightLbs: def('stop', 'weightLbs', 'Weight'),
  },
  pickup: {
    name: def('pickup', 'name', 'Name', { required: true }),
    ready: def('pickup', 'ready', 'Ready', { required: true }),
  },
  history: {
    yesterday: def('history', 'yesterday', 'Yesterday'),
    lastWeek: def('history', 'lastWeek', 'Last Week'),
    last30: def('history', 'last30', 'Last 30 Days'),
    last90: def('history', 'last90', 'Last 90 Days'),
    lastQuarter: def('history', 'lastQuarter', 'Last Quarter'),
    lastYear: def('history', 'lastYear', 'Last Year'),
    linehaul: def('history', 'linehaul', 'Linehaul'),
    rate: def('history', 'rate', 'Rate'),
  },
  roles: {
    salesRepId: def('roles', 'salesRepId', 'Sales Representative'),
    serviceRepId: def('roles', 'serviceRepId', 'Service Representative'),
    dispatcherAssignedId: def('roles', 'dispatcherAssignedId', 'Dispatcher Assigned'),
    dispatcherActual: def('roles', 'dispatcherActual', 'Dispatcher Actual', { help: 'Who last moved the load' }),
    tariff: def('roles', 'tariff', 'Tariff'),
    quoteId: def('roles', 'quoteId', 'Quote'),
  },
  more: {
    specialInstructions: def('more', 'specialInstructions', 'Special Instructions & Rate Confirmation Notes'),
    bolNotes: def('more', 'bolNotes', 'Bill of Lading Notes'),
    rateConNotes: def('more', 'rateConNotes', 'Rate Confirmation Notes'),
    notes: def('more', 'notes', 'Notes'),
    references: def('more', 'references', "Ref #'s"),
    items: def('more', 'items', 'Items'),
    updates: def('more', 'updates', 'Updates'),
    route: def('more', 'route', 'Route'),
  },
  rates: {
    customerRateType: def('rates', 'customerRateType', 'Customer Rate Type', { help: 'Rate Type' }),
    customerHours: def('rates', 'customerHours', 'Customer Hours', { help: 'Hours' }),
    customerLhRate: def('rates', 'customerLhRate', 'Customer LH Rate', { help: 'LH Rate' }),
    customerTotalLh: def('rates', 'customerTotalLh', 'Customer Total LH', { help: 'Total LH' }),
    fscPercent: def('rates', 'fscPercent', 'FSC %'),
    fscPerMile: def('rates', 'fscPerMile', 'FSC/Mile'),
    smr: def('rates', 'smr', 'SMR', { help: 'Informational; excluded from totals' }),
    carrierRateType: def('rates', 'carrierRateType', 'Carrier Rate Type', { help: 'Rate Type' }),
    carrierHours: def('rates', 'carrierHours', 'Carrier Hours', { help: 'Hours' }),
    carrierLhRate: def('rates', 'carrierLhRate', 'Carrier LH Rate', { help: 'LH Rate' }),
    carrierTotalLh: def('rates', 'carrierTotalLh', 'Carrier Total LH', { help: 'Total LH' }),
    payPct: def('rates', 'payPct', 'Pay %'),
    maxRate: def('rates', 'maxRate', 'Max Rate'),
    release: def('rates', 'release', 'Release'),
    lineCarrier: def('rates', 'lineCarrier', 'Carrier'),
    lineAccessorial: def('rates', 'lineAccessorial', 'Accessorial'),
    lineCarrierAmount: def('rates', 'lineCarrierAmount', '$Carrier'),
    lineCustomerAmount: def('rates', 'lineCustomerAmount', '$Customer'),
    addLine: def('rates', 'addLine', '+'),
    totalUsd: def('rates', 'totalUsd', 'Totals USD'),
    netProfit: def('rates', 'netProfit', 'Net $ | Profit %'),
  },
  carrier: {
    carrier: def('carrier', 'carrier', 'Carrier'),
    mc: def('carrier', 'mc', 'MC #'),
    dot: def('carrier', 'dot', 'DOT #'),
    scac: def('carrier', 'scac', 'SCAC'),
    cargo: def('carrier', 'cargo', 'Cargo'),
    liability: def('carrier', 'liability', 'Liability'),
    genLiability: def('carrier', 'genLiability', 'Gen. Liab'),
    safetyRating: def('carrier', 'safetyRating', 'Safety Rating'),
    email: def('carrier', 'email', 'Carrier Email'),
    phone: def('carrier', 'phone', 'Carrier Phone'),
    cover: def('carrier', 'cover', 'Cover'),
    dispatcher: def('carrier', 'dispatcher', 'Dispatcher'),
    dispatcherPhone: def('carrier', 'dispatcherPhone', 'Dispatcher Phone', { help: 'Phone' }),
    dispatcherEmail: def('carrier', 'dispatcherEmail', 'Dispatcher Email', { help: 'Email' }),
    driver1: def('carrier', 'driver1', 'Driver 1'),
    driver1Cell: def('carrier', 'driver1Cell', 'Driver 1 Cell', { help: 'Cell' }),
    driver1Email: def('carrier', 'driver1Email', 'Driver 1 Email', { help: 'Email' }),
    driver2: def('carrier', 'driver2', 'Driver 2'),
    driver2Cell: def('carrier', 'driver2Cell', 'Driver 2 Cell', { help: 'Cell' }),
    driver2Email: def('carrier', 'driver2Email', 'Driver 2 Email', { help: 'Email' }),
    truckNo: def('carrier', 'truckNo', 'Truck #'),
    trailerNo: def('carrier', 'trailerNo', 'Trailer #'),
    seal: def('carrier', 'seal', 'Seal'),
    carrierRef: def('carrier', 'carrierRef', 'Carrier Ref #'),
    originCity: def('carrier', 'originCity', 'Origin City', { required: true }),
    originState: def('carrier', 'originState', 'Origin State', { required: true }),
    emptyMiles: def('carrier', 'emptyMiles', 'Empty Miles'),
    puEta: def('carrier', 'puEta', 'PU ETA'),
    confirmSent: def('carrier', 'confirmSent', 'Confirm Sent'),
    confirmRec: def('carrier', 'confirmRec', 'Confirm Rec'),
    dispatched: def('carrier', 'dispatched', 'Dispatched'),
    sendRateConf: def('carrier', 'sendRateConf', 'Send Rate Conf'),
    sendInfo: def('carrier', 'sendInfo', 'Send Info'),
  },
  picks: {
    insertPick: def('picks', 'insertPick', 'Insert Pick'),
    insertStop: def('picks', 'insertStop', 'Insert Stop'),
  },
  documents: {
    public: def('documents', 'public', 'Public'),
    private: def('documents', 'private', 'Private'),
    upload: def('documents', 'upload', 'Upload'),
    fileType: def('documents', 'fileType', 'File Type'),
  },
  checkCalls: {
    city: def('checkCalls', 'city', 'Origin City'),
    state: def('checkCalls', 'state', 'State'),
    at: def('checkCalls', 'at', 'Date and Time'),
    temperature: def('checkCalls', 'temperature', 'Temperature'),
    note: def('checkCalls', 'note', 'Note'),
    message: def('checkCalls', 'message', 'Message'),
    ediReason: def('checkCalls', 'ediReason', 'EDI Reason'),
    nextAt: def('checkCalls', 'nextAt', 'Next Chk Call Date And Time'),
    nextNote: def('checkCalls', 'nextNote', 'Next Chk Call Note'),
    add: def('checkCalls', 'add', 'Add Check Call'),
  },
} as const

/** The control's accessible name: the Aljex label, with " (required)" on the red ones. */
export function labelFor(def: LabelDef): string {
  return def.required ? `${def.text} (required)` : def.text
}

/**
 * Aljex's Shipping Requirements flag grid: two columns, left column first. The array is
 * the Tab order (left column top to bottom, then the right column).
 */
export const FLAG_COLUMNS = {
  left: ['permits', 'fsma', 'oversized', 'hazmat', 'escorts', 'seal', 'blind', 'customsBonded', 'osd'],
  right: ['strapsChains', 'noBroker', 'team', 'hot', 'labor', 'highRisk', 'massRelease', 'tonu'],
} as const

/** Shipping Requirements field order (Tab order), key = `LABEL.shipping` / `LABEL.flags` key. */
export const SHIPPING_TAB_ORDER = [
  'shipmentType', 'equipmentType', 'revDivision', 'office', 'customerMiles', 'truckMiles',
  'footage', 'pieces', 'weightLbs', 'billableWeightLbs', 'calculateTotals', 'disableMileage',
  'freightClass', 'description', 'declaredValue', 'liftgate', 'inside',
  'tempControl', 'tempType', 'tempMin', 'tempMax', 'tempPreCool',
  'palletExchange', 'palletsIn', 'palletsOut', 'tarps', 'tarpSize',
] as const
