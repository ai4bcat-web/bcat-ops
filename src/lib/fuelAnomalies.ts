/**
 * Fuel anomaly detection — flags transactions where pricePerUnit exceeds
 * the fleet average by more than thresholdPct (default 15%).
 *
 * Mirrors the logic in scripts/detectFuelAnomalies.mjs so the dashboard
 * and Slack watchdog always agree.
 */
import type { FuelTransaction } from '@/lib/apiClient'

// Fuel types recognized as real fuel (matches driverFuel.ts FUEL_ITEM_TYPES)
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

export function isFuelTx(tx: Pick<FuelTransaction, 'itemCategory' | 'fuelType'>): boolean {
  const cat = (tx.itemCategory ?? '').trim()
  if (cat) return cat === 'FUEL'
  return FUEL_ITEM_TYPES.has((tx.fuelType ?? '').toUpperCase().trim())
}

function dedupKey(tx: FuelTransaction): string {
  return `${tx.transactionDate}|${tx.cardNumber}|${tx.fuelType}|${tx.amount}|${tx.quantity}`
}

function dedupTransactions(txs: FuelTransaction[]): FuelTransaction[] {
  const seen = new Set<string>()
  return txs.filter((tx) => {
    const key = dedupKey(tx)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface FleetAverage {
  fuelType: string
  avgPricePerGallon: number
  count: number
  totalGallons: number
}

export interface FuelAnomaly {
  id: string
  transactionDate: string
  truckUnit: string
  truckId?: string | null
  driver: string
  location: string
  fuelType: string
  pricePerGallon: number
  fleetAverage: number
  overpayPct: number
  overpayAmount: number
  gallons: number
  totalCost: number
}

export interface FuelAnomalyResult {
  fleetAverages: FleetAverage[]
  anomalies: FuelAnomaly[]
  totalTransactions: number
  totalFlagged: number
  thresholdPct: number
}

/**
 * Detect fuel price anomalies — transactions >thresholdPct above fleet average.
 * Defaults to 15% threshold and 30-day lookback.
 */
export function detectFuelAnomalies(
  transactions: FuelTransaction[],
  thresholdPct = 15,
): FuelAnomalyResult {
  const fuelTxs = dedupTransactions(transactions.filter(isFuelTx))

  // Group by fuel type
  const byType = new Map<string, FuelTransaction[]>()
  for (const tx of fuelTxs) {
    const ft = (tx.fuelType || 'UNKNOWN').toUpperCase().trim()
    if (!byType.has(ft)) byType.set(ft, [])
    byType.get(ft)!.push(tx)
  }

  // Fleet averages
  const fleetAverages: FleetAverage[] = []
  for (const [ft, group] of byType.entries()) {
    const prices = group.map((tx) => tx.pricePerUnit).filter((p) => p > 0)
    const avg =
      prices.length > 0
        ? prices.reduce((a, b) => a + b, 0) / prices.length
        : 0
    const totalGallons = group.reduce((s, tx) => s + (tx.quantity || 0), 0)
    fleetAverages.push({
      fuelType: ft,
      avgPricePerGallon: Math.round(avg * 10000) / 10000,
      count: group.length,
      totalGallons: Math.round(totalGallons * 100) / 100,
    })
  }

  const avgByType = new Map(fleetAverages.map((f) => [f.fuelType, f.avgPricePerGallon]))

  // Flag overpay transactions
  const anomalies: FuelAnomaly[] = []
  for (const tx of fuelTxs) {
    const ft = (tx.fuelType || 'UNKNOWN').toUpperCase().trim()
    const ppu = tx.pricePerUnit || 0
    const fleetAvg = avgByType.get(ft) ?? 0

    if (fleetAvg <= 0 || ppu <= 0) continue

    const overpayPct = ((ppu - fleetAvg) / fleetAvg) * 100
    if (overpayPct > thresholdPct) {
      const overpayAmount =
        Math.round((ppu - fleetAvg) * (tx.quantity || 0) * 100) / 100
      anomalies.push({
        id: tx.id,
        transactionDate: tx.transactionDate,
        truckUnit: tx.unitNumber ?? tx.cardNumber
          ? `TRK-${tx.cardNumber.replace(/\D/g, '').replace(/^0+/, '')}`
          : 'Unknown',
        truckId: tx.truckId,
        driver: tx.driverName ?? '',
        location: [tx.city, tx.state].filter(Boolean).join(', '),
        fuelType: ft,
        pricePerGallon: ppu,
        fleetAverage: Math.round(fleetAvg * 10000) / 10000,
        overpayPct: Math.round(overpayPct * 100) / 100,
        overpayAmount,
        gallons: tx.quantity || 0,
        totalCost: tx.amount || 0,
      })
    }
  }

  anomalies.sort((a, b) => b.overpayPct - a.overpayPct)

  return {
    fleetAverages: fleetAverages.sort((a, b) => a.fuelType.localeCompare(b.fuelType)),
    anomalies,
    totalTransactions: fuelTxs.length,
    totalFlagged: anomalies.length,
    thresholdPct,
  }
}
