/// <reference types="node" />
/**
 * Webhook signing. Node-only (`crypto`), so it lives apart from `notifications.ts`, which the
 * browser bundle imports for EVENT_CATALOG: a Node builtin in that module breaks the Vite dev
 * server ("Module crypto has been externalized for browser compatibility").
 */
import { createHmac } from 'crypto'

/** Sign a webhook payload using the repo's shared HMAC-SHA256 convention. */
export function signPayload(secret: string, body: string, timestamp: number | string): string {
  const ts = String(timestamp)
  const base = `v0:${ts}:${body}`
  const hmac = createHmac('sha256', secret).update(base).digest('hex')
  return `v0=${hmac}`
}
