// Data-layer hook: today returns store state; swap internals to hit an API later
import { useAppStore } from '@/store/useAppStore'

export function useDrivers() {
  const drivers = useAppStore((s) => s.drivers)
  const addDriver = useAppStore((s) => s.addDriver)
  const updateDriver = useAppStore((s) => s.updateDriver)
  const deleteDriver = useAppStore((s) => s.deleteDriver)
  return { drivers, addDriver, updateDriver, deleteDriver }
}
