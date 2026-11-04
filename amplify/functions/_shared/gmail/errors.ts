/** The refresh token is revoked or expired: the connection must be re-made by the rep. */
export class NeedsReconnect extends Error {
  constructor(message = 'Google no longer accepts this connection; reconnect Gmail.') {
    super(message)
    this.name = 'NeedsReconnect'
  }
}

/** A non-retryable (or retries-exhausted) Gmail / Google answer. Carries no message content. */
export class GmailApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GmailApiError'
    this.status = status
  }
}
