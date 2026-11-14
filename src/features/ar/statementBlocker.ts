import type { AgingStatementResult } from '@/lib/apiClient'

/** Why a previewed aging statement can't go, or null when it can. */
export function statementBlocker(preview: AgingStatementResult | null, error: string | null): string | null {
  if (error) return error
  if (!preview) return null
  if (preview.to.length === 0) return 'Missing invoice e-mail'
  if (preview.statement.rows === 0) return 'Nothing open'
  return null
}
