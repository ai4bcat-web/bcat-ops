import { relativeTime } from '@/lib/auditActivity'

export function saveStateText(dirty: boolean, savedAt: string | null, nowMs: number): string {
  if (dirty) return 'Unsaved changes'
  if (!savedAt) return 'Not saved yet'
  const rel = relativeTime(savedAt, nowMs)
  return rel ? `Last saved ${rel}` : 'Saved'
}
