// Driver-app login help for staff: look up a driver's app account and reset its password.
// Both go through the manageUsers Lambda, which acts on the DRIVER pool only and lets the
// owner or an ADMIN in (everything else there stays owner-only).
import { generateClient } from 'aws-amplify/data'

const client = generateClient()

type GqlOptions = Parameters<typeof client.graphql>[0]

export interface DriverLoginInfo {
  exists: boolean
  email: string
  /** Cognito status: CONFIRMED, UNCONFIRMED, RESET_REQUIRED, FORCE_CHANGE_PASSWORD … */
  status?: string
  enabled?: boolean
  emailVerified?: boolean
}

export type DriverResetMethod = 'code' | 'temporary'

const QUERY = `query ManageUsers($action: String!, $input: String) { manageUsers(action: $action, input: $input) }`

async function manageUsers(action: string, input: Record<string, unknown>): Promise<unknown> {
  const result = (await client.graphql({
    query: QUERY,
    variables: { action, input: JSON.stringify(input) },
  } as unknown as GqlOptions)) as { data: { manageUsers: unknown } }
  const value = result.data.manageUsers
  return typeof value === 'string' ? JSON.parse(value) as unknown : value
}

export async function getDriverLogin(email: string): Promise<DriverLoginInfo> {
  return await manageUsers('driverLogin', { email }) as DriverLoginInfo
}

/** `password` only for `temporary`; it goes to Cognito and nowhere else. */
export async function resetDriverPassword(email: string, method: DriverResetMethod, password?: string): Promise<void> {
  await manageUsers('resetDriverPassword', method === 'temporary' ? { email, method, password } : { email, method })
}

/** Mirrors the driver pool's policy (amplify/backend.ts): 8+ characters, a lowercase letter, a number. */
export function driverPasswordProblem(password: string): string | null {
  if (password.length < 8) return 'At least 8 characters.'
  if (!/[a-z]/.test(password)) return 'Needs a lowercase letter.'
  if (!/[0-9]/.test(password)) return 'Needs a number.'
  if (/\s/.test(password)) return 'No spaces.'
  return null
}

/** What the admin sees about the account before resetting. */
export function driverLoginStatusText(info: DriverLoginInfo | null): string {
  if (!info) return 'Checking the app account…'
  if (!info.exists) return 'No app account yet — send a sign-in invite instead.'
  if (info.enabled === false) return 'App login is disabled.'
  const verified = info.emailVerified ? 'email verified' : 'email not verified'
  switch (info.status) {
    case 'CONFIRMED': return `Active app account (${verified}).`
    case 'UNCONFIRMED': return `Signed up but never confirmed the email code (${verified}).`
    case 'RESET_REQUIRED': return `A password reset is already pending (${verified}).`
    case 'FORCE_CHANGE_PASSWORD': return `Has a temporary password and must choose a new one at sign-in (${verified}).`
    default: return `App account status ${info.status ?? 'unknown'} (${verified}).`
  }
}
