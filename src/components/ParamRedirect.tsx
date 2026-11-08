import { Navigate, useLocation, useParams } from 'react-router-dom'

/**
 * A legacy path redirected to its `/tms/*` home, carrying its route params, query and
 * hash across — a bookmarked `/ar/invoices/INV-12?tab=email` must land on the same
 * invoice, on the same tab.
 */
export function ParamRedirect({ to }: { to: string }) {
  const params = useParams()
  const { search, hash } = useLocation()
  const path = to
    .split('/')
    .map((segment) => (segment.startsWith(':') ? params[segment.slice(1)] ?? '' : segment))
    .join('/')
  return <Navigate to={`${path}${search}${hash}`} replace />
}
