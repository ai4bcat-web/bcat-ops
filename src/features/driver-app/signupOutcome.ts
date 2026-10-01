/**
 * What setting a password should do, when the account may or may not already exist.
 *
 * A driver who taps the invite link, enters their email and picks a password should end
 * up signed in. Whether Cognito already has a user for that address is an internal
 * detail, and "User already exists" is a dead end for someone who has done nothing
 * wrong — they were invited, and often the account exists because an earlier attempt got
 * part way through.
 *
 * The one thing that must NOT happen is setting a password on an existing account just
 * because the caller knew the email address. That is account takeover. So an existing
 * account is routed through a verification code sent to that address, which proves the
 * person asking owns the mailbox. The driver sees the same two screens either way:
 * choose a password, then enter the code from your email.
 *
 * Pure: the mapping from a Cognito error to the next step, with no AWS calls, so the
 * cases can be tested without a pool.
 */

export type SignupStep =
  /** New account: confirm the sign-up with the emailed code. */
  | 'CONFIRM_SIGNUP'
  /** Account existed: set its password with the emailed reset code. */
  | 'CONFIRM_RESET'

/**
 * The Cognito error name, wherever it is hiding.
 *
 * Depth is capped: an error whose `cause` points back at itself is rare but real, and
 * recursing into it would blow the stack on the one path that is already handling a
 * failure.
 */
export function errorName(err: unknown, depth = 0): string {
  if (!err || typeof err !== 'object' || depth > 5) return ''
  const e = err as { name?: string; __type?: string; cause?: unknown }
  const direct = e.name ?? e.__type ?? ''
  // The auth context rethrows as a plain Error and keeps the original on `cause`, so a
  // generic 'Error' name means the real one is a level down.
  if (direct && direct !== 'Error') return direct
  return e.cause ? errorName(e.cause, depth + 1) : direct
}

/** True when sign-up failed only because the address already has an account. */
export function isAlreadyRegistered(err: unknown): boolean {
  return errorName(err) === 'UsernameExistsException'
}

/**
 * True when a password reset cannot start because the account has no verified email —
 * the shape of someone who signed up earlier and never entered their code. They need the
 * sign-up confirmation resent, not a reset.
 */
export function needsSignupConfirmInstead(err: unknown): boolean {
  const name = errorName(err)
  return name === 'InvalidParameterException' || name === 'UserNotConfirmedException'
}

/** Who the code comes from, so a driver can search for it or find it in spam. */
export const CODE_SENDER = 'Ivan Cartage'

/** What to tell the driver once a code is on its way. */
export function codeSentMessage(step: SignupStep, email: string): string {
  return step === 'CONFIRM_RESET'
    ? `You already have an account, so we sent a code to ${email} to confirm it is you. Enter it below and your new password is set.`
    : `We sent a code to ${email}. Enter it below to finish setting up your sign-in.`
}

/**
 * The second line, about finding it.
 *
 * A code that a spam filter ate is indistinguishable from one that was never sent, and a
 * driver staring at an empty inbox has no way to tell which happened. Naming the sender
 * and the junk folder turns a dead end into something they can act on.
 */
export function codeNotArrivedHint(): string {
  return `It can take a minute. If it does not appear, check your spam or junk folder for a message from ${CODE_SENDER}.`
}
