import { useAppStore } from '@/store/useAppStore'

export function useTrucks() {
  const equipment             = useAppStore((s) => s.equipment)
  const maintenanceTasks      = useAppStore((s) => s.maintenanceTasks)
  const maintenanceInvoices   = useAppStore((s) => s.maintenanceInvoices)
  const addEquipment          = useAppStore((s) => s.addEquipment)
  const updateEquipment       = useAppStore((s) => s.updateEquipment)
  const deleteEquipment       = useAppStore((s) => s.deleteEquipment)
  const addMaintenanceTask    = useAppStore((s) => s.addMaintenanceTask)
  const updateMaintenanceTask = useAppStore((s) => s.updateMaintenanceTask)
  const deleteMaintenanceTask = useAppStore((s) => s.deleteMaintenanceTask)
  const addMaintenanceInvoice    = useAppStore((s) => s.addMaintenanceInvoice)
  const updateMaintenanceInvoice = useAppStore((s) => s.updateMaintenanceInvoice)
  const deleteMaintenanceInvoice = useAppStore((s) => s.deleteMaintenanceInvoice)

  const trucks = equipment.filter((e) => e.type === 'truck')

  return {
    equipment, trucks, maintenanceTasks, maintenanceInvoices,
    addEquipment, updateEquipment, deleteEquipment,
    addMaintenanceTask, updateMaintenanceTask, deleteMaintenanceTask,
    addMaintenanceInvoice, updateMaintenanceInvoice, deleteMaintenanceInvoice,
  }
}
