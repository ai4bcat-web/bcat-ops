export type EquipmentType = 'truck' | 'trailer'
export type Ownership = 'owned' | 'leased' | 'rented' | 'financed'
export type EldSource = 'motive' | 'manual' | 'blueink'
export type OwnershipType = 'COMPANY' | 'OWNER_OPERATOR'
export type FleetGroup = 'LOCAL' | 'AMAZON'
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
  eldSource?: EldSource         // 'motive' (auto-sync) | 'manual' (own ELD); default motive
  eldSerialNumber?: string      // own-ELD device serial (manual trucks)
  fleetGroup?: FleetGroup | null // LOCAL (Ivan) | AMAZON — source of truth for profitability grouping
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
  completedDate?: string | null     // YYYY-MM-DD — stamped when marked complete, cleared on reopen
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
  source?: string | null            // 'EMAIL' (repairs@ pipeline) | 'MANUAL'
  createdAt: string
  updatedAt: string
}
