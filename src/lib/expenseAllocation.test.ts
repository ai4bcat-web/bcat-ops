import { describe, it, expect } from 'vitest'
import { getExpensesByTruck } from './expenseAllocation'
import type { AllocationRecord, ExpenseTypeRecord, ExpenseRecordInput, FuelTxInput } from './expenseAllocation'

// ── Stable test IDs ───────────────────────────────────────────────────────────

const TRUCK_009 = 'eq-mnmpi9jxwd12'
const TRUCK_299 = 'eq-mnevxuyoxpd8'
const TRUCK_530 = 'eq-mnevuhxgs5jf'
const TRUCK_685 = 'eq-mnevvq8q6tcx'
const TRUCK_780 = 'eq-mnevwst30vwt'
const ALL_TRUCKS = [TRUCK_009, TRUCK_299, TRUCK_530, TRUCK_685, TRUCK_780]

const TYPE_INSURANCE    = 'type-insurance'
const TYPE_FUEL         = 'type-fuel'
const TYPE_MAINTENANCE  = 'type-maintenance'
const TYPE_FINANCING    = 'type-financing'

const ALLOC_INSURANCE   = 'alloc-insurance-all'
const ALLOC_FINANCED    = 'alloc-financing-530-685'   // only 2 trucks

const expenseTypes: ExpenseTypeRecord[] = [
  { id: TYPE_INSURANCE,   category: 'INSURANCE'   },
  { id: TYPE_FUEL,        category: 'FUEL'         },
  { id: TYPE_MAINTENANCE, category: 'MAINTENANCE'  },
  { id: TYPE_FINANCING,   category: 'FINANCING'    },
]

const allocations: AllocationRecord[] = [
  { id: ALLOC_INSURANCE, expenseTypeId: TYPE_INSURANCE,  allocationMethod: 'SPLIT_EVEN', truckIds: ALL_TRUCKS       },
  { id: ALLOC_FINANCED,  expenseTypeId: TYPE_FINANCING,  allocationMethod: 'SPLIT_EVEN', truckIds: [TRUCK_530, TRUCK_685] },
]

const MAY = { start: '2026-05-01', end: '2026-05-31' }
const APR = { start: '2026-04-01', end: '2026-04-30' }

// ── Insurance split ───────────────────────────────────────────────────────────

describe('SPLIT_EVEN — insurance across 5 trucks', () => {
  const records: ExpenseRecordInput[] = [
    { expenseTypeId: TYPE_INSURANCE, allocationId: ALLOC_INSURANCE, amount: 1200, periodMonth: '2026-05', transactionDate: null, directTruckId: null },
  ]

  it('gives each truck exactly $240', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    for (const id of ALL_TRUCKS) {
      expect(res[id]?.insurance).toBeCloseTo(240, 2)
      expect(res[id]?.total).toBeCloseTo(240, 2)
    }
  })

  it('truck count: exactly 5 trucks in result', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(5)
  })
})

// ── Fuel direct ───────────────────────────────────────────────────────────────

describe('DIRECT — fuel from FuelTransaction', () => {
  const fuelTxs: FuelTxInput[] = [
    { truckId: TRUCK_685, transactionDate: '2026-05-19', amount: 597.92, itemCategory: 'FUEL' },
    { truckId: TRUCK_780, transactionDate: '2026-05-19', amount: 642.44, itemCategory: 'FUEL' },
    { truckId: TRUCK_530, transactionDate: '2026-05-19', amount: 356.40, itemCategory: 'FUEL' },
    { truckId: TRUCK_530, transactionDate: '2026-05-19', amount: 2.00,   itemCategory: 'SCALE' },  // should be excluded
  ]

  it('attributes fuel to individual trucks', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, [], [], expenseTypes)
    expect(res[TRUCK_685]?.fuel).toBeCloseTo(597.92, 2)
    expect(res[TRUCK_780]?.fuel).toBeCloseTo(642.44, 2)
  })

  it('does not include non-FUEL itemCategory in fuel total', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, [], [], expenseTypes)
    expect(res[TRUCK_530]?.fuel).toBeCloseTo(356.40, 2)   // only the ULSD, not the $2 scale fee
    expect(res[TRUCK_530]?.total).toBeCloseTo(356.40, 2)
  })

  it('trucks with no fuel transactions are absent from result', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, [], [], expenseTypes)
    expect(res[TRUCK_009]).toBeUndefined()
    expect(res[TRUCK_299]).toBeUndefined()
  })
})

// ── DIRECT repair ─────────────────────────────────────────────────────────────

describe('DIRECT — repair via ExpenseRecord.directTruckId', () => {
  const records: ExpenseRecordInput[] = [
    { expenseTypeId: TYPE_MAINTENANCE, allocationId: null, amount: 850, periodMonth: null, transactionDate: '2026-05-15', directTruckId: TRUCK_530 },
  ]

  it('attributes full amount to the specified truck', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(res[TRUCK_530]?.maintenance).toBeCloseTo(850, 2)
    expect(res[TRUCK_530]?.total).toBeCloseTo(850, 2)
  })

  it('no other trucks receive the repair cost', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    for (const id of ALL_TRUCKS.filter((t) => t !== TRUCK_530)) {
      expect(res[id]).toBeUndefined()
    }
  })
})

// ── Combined scenario ─────────────────────────────────────────────────────────

describe('combined: insurance + fuel + direct repair', () => {
  const fuelTxs: FuelTxInput[] = [
    { truckId: TRUCK_685, transactionDate: '2026-05-19', amount: 597.92, itemCategory: 'FUEL' },
    { truckId: TRUCK_780, transactionDate: '2026-05-19', amount: 642.44, itemCategory: 'FUEL' },
  ]
  const records: ExpenseRecordInput[] = [
    { expenseTypeId: TYPE_INSURANCE,   allocationId: ALLOC_INSURANCE, amount: 1200, periodMonth: '2026-05', transactionDate: null, directTruckId: null  },
    { expenseTypeId: TYPE_MAINTENANCE, allocationId: null,            amount: 850,  periodMonth: null, transactionDate: '2026-05-15',   directTruckId: TRUCK_530 },
  ]

  it('009 — insurance share only', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, records, allocations, expenseTypes)
    expect(res[TRUCK_009]?.insurance).toBeCloseTo(240, 2)
    expect(res[TRUCK_009]?.fuel).toBe(0)
    expect(res[TRUCK_009]?.total).toBeCloseTo(240, 2)
  })

  it('530 — insurance share + repair', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, records, allocations, expenseTypes)
    expect(res[TRUCK_530]?.insurance).toBeCloseTo(240, 2)
    expect(res[TRUCK_530]?.maintenance).toBeCloseTo(850, 2)
    expect(res[TRUCK_530]?.total).toBeCloseTo(1090, 2)
  })

  it('685 — insurance share + fuel', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, records, allocations, expenseTypes)
    expect(res[TRUCK_685]?.insurance).toBeCloseTo(240, 2)
    expect(res[TRUCK_685]?.fuel).toBeCloseTo(597.92, 2)
    expect(res[TRUCK_685]?.total).toBeCloseTo(837.92, 2)
  })

  it('780 — insurance share + fuel', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, records, allocations, expenseTypes)
    expect(res[TRUCK_780]?.insurance).toBeCloseTo(240, 2)
    expect(res[TRUCK_780]?.fuel).toBeCloseTo(642.44, 2)
    expect(res[TRUCK_780]?.total).toBeCloseTo(882.44, 2)
  })
})

// ── Partial allocation — financing for 2 trucks ───────────────────────────────

describe('SPLIT_EVEN — financing for subset of trucks', () => {
  const records: ExpenseRecordInput[] = [
    { expenseTypeId: TYPE_FINANCING, allocationId: ALLOC_FINANCED, amount: 3000, periodMonth: '2026-05', transactionDate: null, directTruckId: null },
  ]

  it('only the 2 financed trucks get a share', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(res[TRUCK_530]?.financing).toBeCloseTo(1500, 2)
    expect(res[TRUCK_685]?.financing).toBeCloseTo(1500, 2)
    expect(res[TRUCK_009]).toBeUndefined()
    expect(res[TRUCK_299]).toBeUndefined()
    expect(res[TRUCK_780]).toBeUndefined()
  })
})

// ── Date range filtering ──────────────────────────────────────────────────────

describe('date range filtering', () => {
  it('excludes periodMonth records outside the selected range', () => {
    const records: ExpenseRecordInput[] = [
      { expenseTypeId: TYPE_INSURANCE, allocationId: ALLOC_INSURANCE, amount: 1200, periodMonth: '2026-04', transactionDate: null, directTruckId: null },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(0)
  })

  it('excludes fuel transactions outside the date range', () => {
    const fuelTxs: FuelTxInput[] = [
      { truckId: TRUCK_685, transactionDate: '2026-04-30', amount: 500, itemCategory: 'FUEL' },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, [], [], [])
    expect(Object.keys(res)).toHaveLength(0)
  })

  it('excludes transactionDate records outside range', () => {
    const records: ExpenseRecordInput[] = [
      { expenseTypeId: TYPE_MAINTENANCE, allocationId: null, amount: 800, periodMonth: null, transactionDate: '2026-04-28', directTruckId: TRUCK_530 },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(0)
  })

  it('includes April records when querying April', () => {
    const records: ExpenseRecordInput[] = [
      { expenseTypeId: TYPE_INSURANCE, allocationId: ALLOC_INSURANCE, amount: 1200, periodMonth: '2026-04', transactionDate: null, directTruckId: null },
    ]
    const res = getExpensesByTruck(APR.start, APR.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(5)
    for (const id of ALL_TRUCKS) {
      expect(res[id]?.insurance).toBeCloseTo(240, 2)
    }
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('returns empty object when no data', () => {
    const res = getExpensesByTruck(MAY.start, MAY.end, [], [], [], [])
    expect(res).toEqual({})
  })

  it('ignores expense record with no allocationId and no directTruckId', () => {
    const records: ExpenseRecordInput[] = [
      { expenseTypeId: TYPE_INSURANCE, allocationId: null, amount: 1200, periodMonth: '2026-05', transactionDate: null, directTruckId: null },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(0)
  })

  it('ignores expense record with unknown expenseTypeId', () => {
    const records: ExpenseRecordInput[] = [
      { expenseTypeId: 'type-unknown', allocationId: ALLOC_INSURANCE, amount: 500, periodMonth: '2026-05', transactionDate: null, directTruckId: null },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, [], records, allocations, expenseTypes)
    expect(Object.keys(res)).toHaveLength(0)
  })

  it('ignores fuel transactions with null truckId', () => {
    const fuelTxs: FuelTxInput[] = [
      { truckId: null, transactionDate: '2026-05-19', amount: 500, itemCategory: 'FUEL' },
    ]
    const res = getExpensesByTruck(MAY.start, MAY.end, fuelTxs, [], [], [])
    expect(Object.keys(res)).toHaveLength(0)
  })
})
