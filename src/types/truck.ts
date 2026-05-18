export interface Truck {
  id: string
  number: string          // e.g. "530", "685"
  make: string
  model: string
  year: number
  plate: string
  vin: string
  active: boolean
  currentDriverId: string | null
  createdAt: string
  updatedAt: string
}
