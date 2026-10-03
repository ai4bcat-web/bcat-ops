/*
 * Classifying a failed token refresh.
 *
 * A driver's access token lives one hour, so opening the PWA the next day ALWAYS
 * requires a refresh call over the network. Treating every failure of that call
 * as "signed out" is what made drivers re-enter their password on each launch:
 * one dropped request in a cab discarded a refresh token still good for 60 days.
 *
 * Only the names below mean Cognito will never honour this refresh token again.
 * Everything else — no signal, DNS not up yet when iOS relaunches the PWA, a 5xx
 * or throttle, a request aborted because the webview was backgrounded mid-flight
 * — is transient and must be retried with the session left intact.
 */
const TOKEN_REJECTED_ERRORS = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'UserDisabledException',
  'PasswordResetRequiredException',
  'ResourceNotFoundException',
  'InvalidParameterException',
])

function errorName(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  const e = err as { name?: string; __type?: string }
  // `__type` can arrive as `com.amazonaws.cognitoidp#NotAuthorizedException`.
  const raw = e.name || e.__type || ''
  return raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw
}

/** True only when the refresh token itself is dead — the one case worth signing out for. */
export function isTokenRejection(err: unknown): boolean {
  return TOKEN_REJECTED_ERRORS.has(errorName(err))
}
