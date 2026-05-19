export type EquipmentType = 'truck' | 'trailer'
export type Ownership = 'owned' | 'leased' | 'rented' | 'financed'
export type TaskPriority = 'high' | 'med' | 'low'
export type TaskStatus = 'upcoming' | 'complete'

export interface Equipment {
  id: string
  type: EquipmentType
  unitNumber: string
  nickname?: string
  vin?: string
  plate?: string
  make: string
  model: string
  year?: number
  mileage?: number
  ownership: Ownership
  insured: boolean
  active: boolean
  dotInspectionDate?: string        // YYYY-MM-DD
  iftaExpirationDate?: string
  irpExpirationDate?: string
  insuranceExpirationDate?: string
  bobtailInsuranceDate?: string
  assignedDriverId?: string | null
  fleetManagerAssignee?: string     // 'jason' | 'ryne' | ''
  onTollwayAccount: boolean
  fuelCardNumbers?: string[]    // EFS card # prefixes, e.g. ["00007"]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface MaintenanceTask {
  id: string
  equipmentId: string
  title: string
  dueDate?: string                  // YYYY-MM-DD
  priority: TaskPriority
  status: TaskStatus
  notes?: string
  autoDot: boolean
  assignee?: string
  createdAt: string
  updatedAt: string
}

export interface MaintenanceInvoice {
  id: string
  equipmentId: string
  date?: string                     // YYYY-MM-DD
  vendor?: string
  description?: string
  amount: number                    // cents
  invoiceNumber?: string
  paymentMethod?: string
  paymentDate?: string
  assignee?: string
  createdAt: string
  updatedAt: string
}
