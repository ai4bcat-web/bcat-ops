// Data-layer hook: today returns store state; swap internals to hit an API later
import { useAppStore } from '@/store/useAppStore'

export function useLoads() {
  const loads = useAppStore((s) => s.loads)
  const addLoad = useAppStore((s) => s.addLoad)
  const updateLoad = useAppStore((s) => s.updateLoad)
  const deleteLoad = useAppStore((s) => s.deleteLoad)
  return { loads, addLoad, updateLoad, deleteLoad }
}
