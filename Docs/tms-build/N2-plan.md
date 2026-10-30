# Step N2 — MyCarrierPackets vetting + continuous sync plan

## Goal
Make MyCarrierPackets a first-class compliance integration:
- Connect wizard + Test/Validate button on the existing **My Brokerage → Integrations → MyCarrierPackets** page (registry already exists).
- **Send setup packet** from a carrier profile and from the Book carrier / carrier-offer flow (offer UI already exists; add profile button).
- **Continuous sync** (scheduled poll + signed webhook) updates each `Carrier` record with MCP status, review rating, safety/insurance flags and expiry dates.
- The **Book carrier gate** refuses a carrier whose MCP data shows a bad rating or lapsed/missing insurance; the carrier list shows why.
- **Stub mode** remains functional until Ryne supplies MCP username, password and webhook signing secret.

## Architecture decisions

1. **Adapter lives in `src/lib/integrations/mcpAdapter.ts`** following the existing `Adapter` interface (`connect`, `validate`, `sync`). It is imported by `tms-directory-actions` and by the setup-packet path in `tms-shipment-actions`. The shared module lets frontend tests and backend tests run the same logic.
2. **Sync writes Carrier records.** `tms-directory-actions` already owns the `Integration` table and has read access to Carrier via its env vars. A new action `SYNC_MYCARRIERPACKETS_CARRIER` fetches one carrier from MCP and writes the Carrier row.
3. **Scheduled sync** uses a new Lambda `mcp-sync` (or an EventBridge rule calling `tms-directory-actions`) that scans ACTIVE/PENDING/REVIEW carriers with `mcNumber` set, calls the MCP carrier endpoint, and upserts Carrier rows. We pick a dedicated Lambda to keep directory-actions from growing and because MCP sync may become long-running.
4. **Webhook handling** reuses `tracking-api`, which already receipts and verifies MCP webhooks. N2 extends it to: parse the `carrier.updated` event, look up Carrier by `mcNumber`, and call a shared `applyMcpUpdate` helper that writes the Carrier row through the AppSync `updateCarrier` mutation (so subscriptions and audit fire) or directly via DynamoDB SDK if that keeps idempotency simpler. Direct SDK write is preferred to avoid cross-Lambda calls; the Carrier table is already in `tracking-api`'s env from dispatch work.
5. **No new Carrier fields unless required.** Existing fields cover: `mcpStatus` (string), `safetyRating`, `insurancePolicies`, `status`, `statusReason`. If MCP returns a numeric risk score or `MyCarrierPacketReviewStatus`, we either encode it into `mcpStatus` or add `mcpRiskScore`/`mcpReviewStatus` fields. Additive only.
6. **Setup packet** is an MCP API call when live, stub when not. The existing `carrierOffers.ts` `setupPacketAdapter()` uses the `sync` capability; we add an explicit `sendSetupPacket` capability to the adapter or keep using `sync` with a payload that includes `email`/`carrierMc`. Decision: add `setupPacket` capability to MCP adapter only (not the generic type, via optional method) so the offer/profile code calls it directly.
7. **Book carrier gate** already reads `mcpStatus` in `src/features/shipments/workstations/coverage.ts`. N2 tightens it: treat MCP review statuses `UNACCEPTABLE`, `UNACCEPTABLE_REVIEW`, `MODERATE` (above risk threshold) and missing insurance as blockers. The threshold comes from the MCP integration settings `maxRiskAssessmentPoints`.

## API / data contract

### New backend actions
- `MYCARRIERPACKETS_SEND_SETUP_PACKET` in `tms-shipment-actions` (or reuse existing `SEND_SETUP_PACKET` which already calls adapter; just swap adapter implementation).
- `SYNC_MYCARRIERPACKETS_CARRIER` in `tms-directory-actions` (live or stub, single carrier by `mcNumber` or `carrierId`).
- `MYCARRIERPACKETS_SYNC_ALL` invoked by scheduled rule, returns counts.

### MCP shapes (documented, stubbed)
```ts
interface McpCarrier {
  mcNumber: string
  dotNumber?: string
  status: 'NOT_INVITED' | 'INVITED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'ACCEPTABLE' | 'MODERATE' | 'UNACCEPTABLE' | 'UNACCEPTABLE_REVIEW'
  reviewStatus?: 'ACCEPTABLE' | 'MODERATE' | 'UNACCEPTABLE' | 'UNACCEPTABLE_REVIEW'
  riskAssessmentPoints?: number
  safetyRating?: 'SATISFACTORY' | 'CONDITIONAL' | 'UNSATISFACTORY'
  insurance?: {
    cargo: { expiresAt: string; limitCents?: number; active: boolean }
    liability: { expiresAt: string; limitCents?: number; active: boolean }
  }
  packetCompletedAt?: string
}

interface McpSetupPacketInput {
  email: string
  carrierName?: string
  carrierMc?: string
}
```

### Carrier mapping
- `mcpStatus` = raw MCP `status` string.
- `safetyRating` = MCP `safetyRating` if present, else keep existing.
- `insurancePolicies` = merge MCP cargo/liability policies, preserving other existing policies.
- `statusReason` / `status` update only when MCP explicitly flags `UNACCEPTABLE` → set status `DO_NOT_USE` reason `OTHER`? Decision: do NOT auto-change directory status; only write compliance data. The book gate uses the data, not the directory status. This avoids accidental lockouts.

## Files expected to change

### Backend
- `src/lib/integrations/mcpAdapter.ts` (new)
- `src/lib/integrations/adapter.ts` (add `setupPacket?` optional method or keep separate)
- `src/lib/integrations/types.ts` (possibly add `setupPacket` capability or standalone function type)
- `amplify/functions/tms-directory-actions/integrations.ts` (add MCP validate/sync actions)
- `amplify/functions/tms-directory-actions/handler.ts` (action routing)
- `amplify/functions/tms-directory-actions/resource.ts` (grant Carrier write + add env)
- `amplify/functions/tms-shipment-actions/handler.ts` (wire MCP setup packet adapter)
- `amplify/functions/tracking-api/handler.ts` (process MCP webhook beyond receipt)
- `amplify/backend.ts` (EventBridge schedule for `mcp-sync` or rule on directory-actions; table grants)

### Frontend
- `src/features/carriers/components/CarrierProfile.tsx` (Send setup packet button)
- `src/lib/apiClient.ts` (add `sendCarrierSetupPacket` if needed, or reuse existing)
- `src/features/shipments/workstations/coverage.ts` (tighten MCP gate)
- `src/features/tms/integrations/providerExtras.tsx` (optional MCP-specific card: webhook toggles are already in settings)

### Tests / docs
- `src/lib/integrations/mcpAdapter.test.ts` (new)
- `amplify/functions/tracking-api/handler.test.ts` (extend MCP webhook tests)
- `src/features/shipments/workstations/coverage.test.ts` (extend gate tests)
- `Docs/tms-build/N2-plan.md` (this file)
- `Docs/tms-build/BUILD_LOG.md` (fold into final commit)

## Acceptance
- `npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p amplify/tsconfig.json` clean.
- `npx eslint .` 0 errors.
- `npm run test` passes.
- Dev verification: set MCP credentials in SSM (or leave missing to stay stub), run Validate → returns OK/UNABLE_TO_VERIFY honestly. Send setup packet from carrier profile or offer UI returns `{ sent: true, mode: 'STUB'| 'LIVE', ... }`. Trigger webhook or scheduled sync updates a Carrier's `mcpStatus`. Book carrier gate refuses carrier with `mcpStatus: 'UNACCEPTABLE'`.
