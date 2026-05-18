import { useAppStore } from '@/store/useAppStore'

export function useTrucks() {
  const trucks      = useAppStore((s) => s.trucks)
  const addTruck    = useAppStore((s) => s.addTruck)
  const updateTruck = useAppStore((s) => s.updateTruck)
  const archiveTruck = useAppStore((s) => s.archiveTruck)
  return { trucks, addTruck, updateTruck, archiveTruck }
}
