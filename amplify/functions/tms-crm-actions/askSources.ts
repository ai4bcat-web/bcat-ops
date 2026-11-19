/**
 * Ask BCAT data tools — the extra RAW reads behind `query_data` and `fleet_pnl`. Read-only
 * (Scan / Query on tables this Lambda already has IAM read on). Nothing here is
 * viewer-filtered: askData.ts decides who may use which dataset, and filters row-level data
 * through the same visibility predicate the dashboards use.
 *
 * The tables read here are small (a few thousand rows at most, see askData.ts SCAN_CAP), so a
 * projected Scan per question is cheap; the one big table, LaneRateSample, is read by its month
 * index like the dashboards do.
 */
import { pages } from '../_shared/ddbReads'
import { scanAll, type Db, type Row } from '../_shared/crmStore'

export interface AskSource {
  /** Every delivered, priced load of a month (LaneRateSample by `sampleMonth`). */
  samples(month: string): Promise<Row[]>
  carrierBills(): Promise<Row[]>
  vendorPayables(): Promise<Row[]>
  maintenanceInvoices(): Promise<Row[]>
  fuelTransactions(): Promise<Row[]>
  drivers(): Promise<Row[]>
  equipment(): Promise<Row[]>
  payPeriods(): Promise<Row[]>
  payCredits(): Promise<Row[]>
  payDeductions(): Promise<Row[]>
  paySettings(): Promise<Row[]>
  recurringExpenses(): Promise<Row[]>
  expenseRecords(): Promise<Row[]>
  expenseTypes(): Promise<Row[]>
  expenseAllocations(): Promise<Row[]>
  truckMileageDays(): Promise<Row[]>
  insurancePeriods(): Promise<Row[]>
  insuranceItems(): Promise<Row[]>
  /** Loads whose delivery appointment falls in [from, to] (YYYY-MM-DD, inclusive), voided and deleted ones left out. */
  loadsDeliveredBetween(from: string, to: string): Promise<Row[]>
}

const SAMPLE_FIELDS = [
  'shipmentId', 'shipmentNumber', 'date', 'excluded', 'revenueCents', 'costCents', 'profitCents', 'miles', 'customerId',
  'customerName', 'carrierName', 'assignmentKind', 'equipmentType', 'revDivision', 'revSubdivision', 'salesRepId',
  'customerRepId', 'mode', 'loadStatus', 'rateType',
]

const names = (fields: string[]): Record<string, string> => Object.fromEntries(fields.map((f) => [`#${f}`, f]))
const projection = (fields: string[]): string => fields.map((f) => `#${f}`).join(', ')

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

/** A Scan of one small table with a projection (attribute names always aliased: many are reserved words). */
function scan(db: Db, tableEnv: string, fields: string[], extra: { filter?: string; values?: Record<string, unknown>; names?: Record<string, string> } = {}): Promise<Row[]> {
  return scanAll<Row>(db, {
    TableName: env(tableEnv),
    ProjectionExpression: projection(fields),
    ExpressionAttributeNames: { ...names(fields), ...(extra.names ?? {}) },
    ...(extra.filter ? { FilterExpression: extra.filter, ExpressionAttributeValues: extra.values } : {}),
  })
}

export function askSource(db: Db): AskSource {
  return {
    samples: (month) =>
      pages(db, {
        TableName: env('LANE_RATE_SAMPLE_TABLE_NAME'),
        IndexName: 'laneRateSamplesBySampleMonthAndDate',
        KeyConditionExpression: '#m = :m',
        ProjectionExpression: projection(SAMPLE_FIELDS),
        ExpressionAttributeNames: { ...names(SAMPLE_FIELDS), '#m': 'sampleMonth' },
        ExpressionAttributeValues: { ':m': month },
      }),

    carrierBills: () =>
      scan(db, 'CARRIER_BILL_TABLE_NAME', [
        'id', 'shipmentNumber', 'carrierName', 'payeeKind', 'divisionKey', 'status', 'billDate', 'dueAt', 'grossCents', 'netCents',
        'billedCents', 'paidCents', 'creditedCents', 'balanceCents', 'quickPay', 'quickPayFeeCents', 'paidAt', 'archivedAt', 'voidedAt',
      ]),
    vendorPayables: () =>
      scan(db, 'VENDOR_PAYABLE_TABLE_NAME', ['id', 'status', 'source', 'vendor', 'amount', 'invoiceDate', 'dueDate', 'receivedAt', 'payAsap', 'paymentMethod', 'paymentDate', 'paidAt']),
    maintenanceInvoices: () =>
      scan(db, 'MAINTENANCE_INVOICE_TABLE_NAME', ['id', 'equipmentId', 'date', 'vendor', 'amount', 'status', 'source', 'createdAt']),
    fuelTransactions: () =>
      scan(db, 'FUEL_TRANSACTION_TABLE_NAME', ['id', 'transactionDate', 'cardNumber', 'truckId', 'unitNumber', 'driverName', 'itemCategory', 'fuelType', 'quantity', 'amount']),
    drivers: () => scan(db, 'DRIVER_TABLE_NAME', ['id', 'name', 'active', 'type', 'fleetGroup', 'assignedTruckId']),
    equipment: () => scan(db, 'EQUIPMENT_TABLE_NAME', ['id', 'type', 'unitNumber', 'fleetGroup', 'active', 'inactiveSince', 'fuelCardNumbers']),
    payPeriods: () => scan(db, 'DRIVER_PAY_PERIOD_TABLE_NAME', ['id', 'driverId', 'periodStart', 'periodEnd', 'grossPay', 'source']),
    payCredits: () => scan(db, 'DRIVER_PAY_CREDIT_TABLE_NAME', ['id', 'driverId', 'periodStart', 'kind', 'reasonCode', 'label', 'amount', 'date', 'approvalStatus']),
    payDeductions: () => scan(db, 'DRIVER_PAY_DEDUCTION_TABLE_NAME', ['id', 'driverId', 'periodStart', 'label', 'amount', 'date']),
    paySettings: () => scan(db, 'DRIVER_PAY_SETTING_TABLE_NAME', ['id', 'driverId', 'payGroup', 'active']),
    recurringExpenses: () =>
      scan(db, 'RECURRING_EXPENSE_TABLE_NAME', ['id', 'expenseTypeId', 'allocationId', 'monthlyAmount', 'startMonth', 'endMonth', 'active']),
    expenseRecords: () =>
      scan(db, 'EXPENSE_RECORD_TABLE_NAME', ['id', 'expenseTypeId', 'allocationId', 'amount', 'periodMonth', 'transactionDate', 'directTruckId']),
    expenseTypes: () => scan(db, 'EXPENSE_TYPE_TABLE_NAME', ['id', 'name', 'category']),
    expenseAllocations: () => scan(db, 'TRUCK_EXPENSE_ALLOCATION_TABLE_NAME', ['id', 'expenseTypeId', 'allocationMethod', 'truckIds']),
    truckMileageDays: () =>
      scan(db, 'TRUCK_MILEAGE_TABLE_NAME', ['truckId', 'periodStart', 'periodType', 'miles'], {
        filter: '#periodType = :day',
        values: { ':day': 'DAY' },
      }),
    insurancePeriods: () => scan(db, 'INSURANCE_PERIOD_TABLE_NAME', ['id', 'label', 'isCurrent']),
    insuranceItems: () => scan(db, 'INSURANCE_LINE_ITEM_TABLE_NAME', ['id', 'periodId', 'kind', 'equipmentId', 'annualCents']),

    loadsDeliveredBetween: (from, to) =>
      scan(db, 'LOAD_TABLE_NAME', ['id', 'truckId', 'deliveryDriverId', 'rate', 'deliveryAppt', 'voidedAt', 'deletedAt'], {
        // Voided / soft-deleted loads never count (a stored explicit NULL counts as not set).
        filter:
          '#deliveryAppt BETWEEN :from AND :to AND (attribute_not_exists(#voidedAt) OR attribute_type(#voidedAt, :nul)) AND (attribute_not_exists(#deletedAt) OR attribute_type(#deletedAt, :nul))',
        values: { ':from': from, ':to': `${to}~`, ':nul': 'NULL' },
      }),
  }
}
