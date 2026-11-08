/**
 * The retired Load Tracking pages and where their old URLs land now. One table, read by
 * `App.tsx`, its test and the route registries, so a bookmark and a notification link can
 * never disagree about the landing.
 *
 * `/tms/tracking/links` is deliberately not here: it is still a page (off the sidebar).
 */
export const CHECK_CALLS_LANDING = '/tms/tracking?assignee=all&focus=checkcalls'
export const DOCS_LANDING = '/tms/tracking?assignee=all&focus=docs'

/** Where `pathname` (any case of the retired paths, trailing slash tolerated) now lands; `null` = not retired. */
export function legacyTrackingTarget(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '').toLowerCase()
  if (path === '/tms/check-calls' || path === '/check-calls') return CHECK_CALLS_LANDING
  if (path === '/documents' || path === '/tms/documents' || path.startsWith('/tms/documents/')) return DOCS_LANDING
  return null
}
