/**
 * Client wrapper for the tms-directory-actions `GET_ROUTE_MILES` read. Kept beside the section
 * that uses it (apiClient.ts is append-closed for this step); same router mutation and AWSJSON
 * contract as `directoryAction` there.
 */
import { generateClient } from 'aws-amplify/data'
import { graphqlErrorText } from '@/lib/apiClient'
import type { RoutePointInput } from './milesEstimate'

export interface RouteMilesResult {
  miles: number | null
  source: 'google' | 'estimate' | null
  /** Set when the read itself failed (not when the route is merely unmeasurable). */
  error?: string
}

const client = generateClient()

/** Never rejects: a failed read comes back as `{ error }` so the form can say so and carry on. */
export async function getRouteMiles(stops: RoutePointInput[]): Promise<RouteMilesResult> {
  try {
    const r = await client.graphql({
      query: `mutation TmsDirectoryActions($action: String!, $input: AWSJSON!) { tmsDirectoryActions(action: $action, input: $input) }`,
      variables: { action: 'GET_ROUTE_MILES', input: JSON.stringify({ stops }) },
    }) as { data: { tmsDirectoryActions: unknown } }
    const raw = r.data.tmsDirectoryActions
    const v = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<RouteMilesResult> | null
    return { miles: typeof v?.miles === 'number' ? v.miles : null, source: v?.source ?? null }
  } catch (err) {
    return { miles: null, source: null, error: graphqlErrorText(err) || 'GET_ROUTE_MILES failed' }
  }
}
