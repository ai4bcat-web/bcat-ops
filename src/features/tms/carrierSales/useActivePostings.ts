import { listActivePostings } from '@/lib/apiClient'
import { usePolled } from './usePolled'

/** Every POSTED board posting (one Query), for the Offers load picker. */
export function useActivePostings() {
  return usePolled(listActivePostings)
}
