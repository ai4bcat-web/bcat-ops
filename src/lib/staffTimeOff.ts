/**
 * The office's time-off actions that must run on the server: approving or denying a driver's
 * request (which also puts an approved PTO day on the driver's clock), and adding a PTO day
 * directly. Same Function URL as the driver app, on routes that verify a STAFF session and
 * the Time Off page's own access rule.
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import { DRIVER_API_URL } from '@/features/driver-app/driverApi'

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!DRIVER_API_URL) throw new Error('The driver service is not configured.')
  const session = await fetchAuthSession()
  const token = session.tokens?.idToken?.toString()
  if (!token) throw new Error('You are signed out. Sign in again.')
  const res = await fetch(`${DRIVER_API_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export interface ReviewResult {
  status: 'APPROVED' | 'DENIED'
  reviewedBy?: string
  reviewedAt?: string
  reviewNote?: string | null
}

/** Approve or deny a PENDING request. Denying may carry a note the driver reads. */
export function reviewTimeOff(id: string, decision: 'APPROVE' | 'DENY', note?: string): Promise<ReviewResult> {
  return post('/staff/time-off/review', { id, decision, ...(note?.trim() ? { note: note.trim() } : {}) })
}

/** A PTO day entered by staff: approved at once, 480 minutes on the driver's clock. */
export function addStaffPtoDay(driverId: string, date: string, note?: string): Promise<{ id: string }> {
  return post('/staff/time-off/pto', { driverId, date, ...(note?.trim() ? { note: note.trim() } : {}) })
}
