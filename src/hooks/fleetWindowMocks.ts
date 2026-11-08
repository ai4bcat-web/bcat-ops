// Stand-ins for the non-load data sources of the fleet P&L hooks, shared by the
// useFleetProfitability / useProfitReview window tests. Stable references on purpose:
// the hooks key their memos on them.
import { FIXTURE_DRIVERS } from './loadWindowFixture'

const equipment = [
  { id: 't1', unitNumber: '009', type: 'truck', active: true, fleetGroup: 'LOCAL', fuelCardNumbers: [] },
  { id: 't2', unitNumber: '010', type: 'truck', active: true, fleetGroup: 'LOCAL', fuelCardNumbers: [] },
]
const fuel = { transactions: [], loading: false, error: null, refresh: () => {} }
const exp = { records: [], recurring: [], allocations: [], expenseTypes: [], loading: false, error: null, refresh: () => {} }
const mileage = { rows: [], loading: false, error: null, refresh: () => {} }
const pay = { payPeriods: [], loading: false, error: null, refresh: () => {} }
const rangeByTruck = () => ({ t1: 100, t2: 100 })
const insurance = { rangeByTruck }
const drivers = { drivers: FIXTURE_DRIVERS }
const trucks = { equipment, trucks: equipment }
const fixedCosts = { contributionInRange: () => 0, eldInRange: () => 0 }

export const fleetWindowMocks = { fuel, exp, mileage, pay, insurance, drivers, trucks, fixedCosts }
