/**
 * The sync stamp mcp-sync leaves on the `Integration` row `MYCARRIERPACKETS`, so the
 * Compliance and Platform-health pages can say when MyCarrierPackets last synced.
 *
 * A run that synced nothing (no credentials, no carriers, every carrier failed) must not
 * look like a successful sync — `heartbeatUpdate` returns null and the handler writes nothing.
 */
export interface HeartbeatInputResult {
  ok: boolean
}

export interface HeartbeatUpdate {
  lastCheckAt: string
  lastOkAt: string
  healthDetail: string
}

export const MCP_INTEGRATION_ID = 'MYCARRIERPACKETS'

export function heartbeatUpdate(results: readonly HeartbeatInputResult[], now: string): HeartbeatUpdate | null {
  if (results.length === 0) return null
  const ok = results.filter((r) => r.ok).length
  if (ok === 0) return null
  return { lastCheckAt: now, lastOkAt: now, healthDetail: `Synced ${ok}/${results.length} carriers` }
}
