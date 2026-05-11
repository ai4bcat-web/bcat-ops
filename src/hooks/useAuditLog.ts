// Data-layer hook: read-only; no mutations exposed
import { useAppStore } from '@/store/useAppStore'

export function useAuditLog() {
  const entries = useAppStore((s) => s.auditLog)
  return { entries }
}
