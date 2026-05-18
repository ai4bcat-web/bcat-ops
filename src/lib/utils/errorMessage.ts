/**
 * Extracts a human-readable string from any thrown value.
 * Handles: Error instances, GraphQL error objects ({ errors: [...] }),
 * Amplify error shapes ({ message }), plain strings, and unknowns.
 */
export function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>
    // @aws-amplify/data GraphQL errors: { errors: [{ message }] }
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      const msgs = (e.errors as { message?: unknown }[])
        .map((x) => (typeof x.message === 'string' ? x.message : null))
        .filter(Boolean)
      if (msgs.length > 0) return msgs.join('; ')
    }
    if (typeof e.message === 'string') return e.message
    if (typeof e.error === 'string') return e.error
    try {
      return JSON.stringify(error)
    } catch {
      return 'Unserializable error'
    }
  }
  return String(error)
}
