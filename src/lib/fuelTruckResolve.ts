/**
 * Fuel transactions carry `truckId` only when the EFS card was mapped on an Equipment
 * record at import time. Cards mapped later leave older rows with no truck, and the
 * expense engine drops those rows — so fuel silently goes missing from the P&L.
 * Resolve the truck from the card number at read time instead.
 */

export interface CardMappedEquipment {
  id: string
  fuelCardNumbers?: string[] | null
}

export interface FuelTxLike {
  truckId?: string | null
  cardNumber?: string | null
}

export function cardToTruckMap(equipment: CardMappedEquipment[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of equipment) {
    for (const card of e.fuelCardNumbers ?? []) {
      if (card) map.set(String(card), e.id)
    }
  }
  return map
}

/** The transaction's truck: its own `truckId`, else the truck whose fuel card it was bought on. */
export function resolveFuelTruckId(tx: FuelTxLike, cards: Map<string, string>): string | null {
  if (tx.truckId) return tx.truckId
  if (tx.cardNumber) return cards.get(String(tx.cardNumber)) ?? null
  return null
}

export function withResolvedTruckIds<T extends FuelTxLike>(txs: T[], equipment: CardMappedEquipment[]): T[] {
  const cards = cardToTruckMap(equipment)
  if (cards.size === 0) return txs
  return txs.map((tx) => {
    if (tx.truckId) return tx
    const truckId = resolveFuelTruckId(tx, cards)
    return truckId ? { ...tx, truckId } : tx
  })
}
