# MyCarrierPackets (MCP) integration

Source: https://mycarrierpackets.com/IntegrationGuide (public), plus the machine-readable
swagger https://api.mycarrierpackets.com/swagger/docs/v1. Fetched 2026-11-03. Both were
readable without a login. Everything not stated there is marked **[INFERENCE]**.

## What the guide says

- **Auth**: `POST https://api.mycarrierpackets.com/token`, `grant_type=password`, form-encoded
  `username` + `password` (the customer *integration* credentials, managed by an MCP admin at
  `mycarrierpackets.com/IntegrationTools`). Result: bearer token, sent as `Authorization: Bearer <token>`.
  `expires_in` is the standard OAuth field [INFERENCE: the guide does not state the lifetime; the
  adapter reads `expires_in`, caches until 60 s before it, else 5 min].
  A wrong password answers 400 `{"error":"invalid_grant"}` [INFERENCE: standard OWIN token endpoint].
- **Format**: JSON by default; `Accept: text/xml` for XML.
- **Every API call is a POST** with identifiers in the query string, token required.
- **Invite** (guide §1.1): `POST /api/v1/Carrier/EmailPacketInvitation?dotNumber=&docketNumber={MC|FF|MX}&carrierEmail=&username=`
  (`username` = the MCP user sending it, recommended; optional). Swagger adds optional
  `sendConfirmationEmail`, `notificationEmails`. `PreviewCarrier?DOTNumber=&docketNumber=` preloads approved
  emails, risk assessment and certificate data.
- **Completion / packet data** (§2): `POST /api/v1/Carrier/CompletedPackets?fromDate=&toDate=` (`YYYY-MM-DDTHH:MM:SS`)
  returns `[{DOTNumber, DocketNumber, LegalName, CompletedDate}]`; then
  `POST /api/v1/Carrier/GetCarrierData?DOTNumber=&Docket=` (swagger names the parameter `DocketNumber`; the adapter
  sends both) for the full record.
- **Monitoring** (Assure Advantage, §3): `MonitoredCarriers` (page size default 2500, max 5000, pagination in the
  `X-Pagination` response header), `MonitoredCarrierData` (default 250, max 500, pagination in the body),
  `CarriersChanges?fromDate=&toDate=&pageNumber=&pageSize=` (**call at no less than 4-minute intervals**),
  `RequestMonitoring` / `CancelMonitoring` (body: DOTNumber, DocketNumber and/or IntrastateNumber),
  `GetDocument?name=<blob>` for the COI / W9 / agreement images.
- **Rate limits**: the only published number is the 4-minute floor on `CarriersChanges`. No 429 behaviour is
  documented [INFERENCE: treat 429/502/503/504 as retryable with backoff].
- **Webhooks: none.** The guide has no webhook, no signature scheme, no header. Option 2.1.2 is the reverse
  (MCP calls a customer API, unsigned, shape unspecified). Completion is *polled*.
- **Status values**: the guide and swagger give **no enumeration**. `CarrierPacketStatus` is a free `string`;
  `RiskAssessmentDetails.OverallRating` and `ReviewState` are free strings.

## Response fields the adapter reads (swagger DTO names; casing is mixed so reads are case-insensitive)

| Need | Field |
| --- | --- |
| Identity | `DOTNumber`, `MCNumber` / `DocketNumber`, `LegalName` / `CompanyName` |
| Packet stage | `CarrierCustomerPacketStatuses[].CarrierPacketStatus`; `CarrierRating.HasCompletedPacket`; `OnCurrentCustomerAgreement`; `CarrierCustomerAgreements[].OnCurrentCustomerAgreement / IsActive / SignatureDate`; `AssureAdvantage[0].CarrierDetails.LatestInvitation.InvitationSentDate` |
| Risk | `RiskAssessmentDetails` (or under `AssureAdvantage[0].CarrierDetails`): `TotalPoints`, `OverallRating`, `ReviewState`; `RiskAssessment.Overall` |
| Safety / authority | `CarrierDetails.Safety.rating`; `CarrierDetails.Authority.commonAuthority / contractAuthority / brokerAuthority` |
| Insurance | `CertData.Certificates[].Coverages[]` or `CertData.Certificate[].Coverage[]`: `Type`, `ExpirationDate`, `CoverageLimit`, `CancellationDate` |

## Our mapping (`src/lib/integrations/mcpAdapter.ts`)

`mcpStatus` vocabulary is unchanged: `NOT_INVITED | INVITED | IN_PROGRESS | PENDING_REVIEW | ACCEPTABLE | MODERATE | UNACCEPTABLE | UNACCEPTABLE_REVIEW`.
`mcpPacketStanding` in `src/lib/mcpPacket.ts` is untouched: only the last five count as a completed packet.

**Mismatch (documented, not hidden):** MCP has no such vocabulary. It is ours, derived **[INFERENCE]**:

1. *Completed?* any `CarrierPacketStatus` reading complete/submitted/received, or `HasCompletedPacket`, or a current
   customer agreement. Unrecognised text is never evidence of a packet.
2. Completed ⇒ status from the risk assessment: rating text `pass/acceptable/low/green` → `ACCEPTABLE`;
   `moderate/medium/yellow` → `MODERATE`; `unacceptable/fail/high/red` → `UNACCEPTABLE`; an unreadable rating →
   `PENDING_REVIEW` (completed, not approved). A pending/requested `ReviewState` makes a bad rating
   `UNACCEPTABLE_REVIEW` and anything else `PENDING_REVIEW`.
3. Not completed ⇒ `IN_PROGRESS` (in-progress/started/partial), else `INVITED` (invited/sent/pending, or a
   `LatestInvitation`), else `NOT_INVITED`.
4. A packet stage never moves backwards on a lookup (`applyMcpUpdate(mcp, existing)`); completed → completed
   changes always apply.
5. Written fields: `mcpStatus`, `mcpReviewStatus` (completed only), `mcpRiskScore`, `mcpPacketCompletedAt` (latest
   agreement `SignatureDate`), `safetyRating`, `authorityStatus`, `insurancePolicies` (CARGO / AUTO_LIABILITY,
   `CoverageLimit` read as dollars, `active` = not cancelled and not expired).
   `mcpReviewStatus` / `mcpPacketCompletedAt` are not in the Amplify `Carrier` model (they are raw DynamoDB
   attributes, as before this change).
6. MCP timestamps are zone-less; read as UTC [INFERENCE].

## Code

- `mcpAdapter.ts` — token (cache + expiry + 401 refresh), `validateMcpCredentials`, `lookupMcpCarrier`,
  `fetchMcpCarrierRaw` (GetCarrierData, fallback PreviewCarrier), `listMonitoredCarriers` (MonitoredCarriers, page size
  <= 5000, `X-Pagination` header), `listCarrierChanges` (CarriersChanges, <= 500), `listCompletedPackets`,
  `sendSetupPacket` (EmailPacketInvitation; needs a DOT), backoff (429/502/503/504, `Retry-After`, 1-2-4 s, 4 attempts).
- `mcpProfile.ts` — pure: body -> `McpProfile`, profile -> Carrier patch + `FieldChange`s, contacts, payment; MC -> DOT -> name matcher.
- `mcpPull.ts` — the engine: `runBackfillSlice`, `runChangesPoll`, `pullOneCarrier`, `applyProfileToCarrier`.
- `mcpBatchSync.ts` — only the LIVE gate (`mcpSyncRefusal`) and the CAS update (`mcpUpdateItem`).
- `amplify/functions/mcp-sync/handler.ts` — the one Lambda that reads MCP and writes carriers.
- Validate: registry `validateHow.liveCheck = 'MCP_TOKEN'` -> `_shared/integrationValidate.ts` -> `validateMcpCredentials`.
  Before this change MCP had no `liveCheck`, so Validate answered NO_VALIDATE_ENDPOINT.

### Validate state machine (VALIDATE_INTEGRATION, the button)

| Situation | Call? | Row |
| --- | --- | --- |
| username or password blank | no | `mode STUB`, health `UNABLE_TO_VERIFY`, reason `NO_CREDENTIALS` |
| a value is `disabled-on-dev` | no | `STUB`, `UNABLE_TO_VERIFY`, `NEUTERED_ON_DEV` |
| token 200 | 1 | `mode LIVE`, status `CONNECTED`, health `OK` |
| token 400 / 401 / 403 | 1 | `INVALID_CREDENTIALS` ("MyCarrierPackets rejected the integration username or password.") |
| any other HTTP code (429, 5xx...) | 1, no retry | `UNABLE_TO_VERIFY`, `PROVIDER_UNREACHABLE`, `HTTP <code>` |
| timeout / network | 1 | `UNABLE_TO_VERIFY`, `PROVIDER_UNREACHABLE`, no secret in the text |

Validate never uses the cached token. MCP has no webhooks, so the `webhookSigningSecret` credential field is gone from the registry.
MCP is not in the dev stack's neutered secret list (`NEUTERED_SECRETS` in backend.ts), and the Lambdas have no VPC config,
so the credentials Ryne enters on dev are used as entered and `api.mycarrierpackets.com` is reachable.

## MyCarrierPackets is the source of truth for the carrier profile

### Field map (MCP -> BCAT). MCP wins over hand-typed values.

| MCP (GetCarrierData / CarrierDetails) | BCAT target | Notes |
| --- | --- | --- |
| `LegalName` / `CompanyName` / `Identity.legalName` | `Carrier.name`, `normalizedName` | recomputed with `tmsDirectory.normalizeName` (= `directoryKeys.carrierKey`) |
| `DBAName` | `Carrier.dbaName` | |
| `DOTNumber`, `MCNumber`/`DocketNumber` | `Carrier.dotNumber`; `mcNumber` only when blank | the row's own MC spelling is never rewritten |
| `Phone`, `Email`, `Website`, address fields | `Carrier.phone/email/website/address` | |
| `CarrierW9Forms[active].EIN` | `Carrier.einNumber` | SSN is never read. Masked (`***1234`) in the audit |
| `CarrierOperationalDetail.TotalPowerUnits` | `Carrier.powerUnits` | |
| `Authority.commonAuthority/contractAuthority/brokerAuthority`, `authGrantDate` | `authorityStatus` (ACTIVE/INACTIVE), `inFmcsa`, `authorityGrantedAt` | read by the booking gate (`AUTHORITY_INACTIVE`) |
| `Safety.rating`, `ratingDate` | `safetyRating`, `safetyRatingAt` | |
| `RiskAssessmentDetails.TotalPoints / OverallRating / ReviewState` | `mcpRiskScore`, `mcpReviewStatus`, `mcpStatus` | status vocabulary above; never moves backwards |
| packet statuses, agreements, `HasCompletedPacket` | `mcpStatus`, `mcpPacketCompletedAt` | only when the body carries packet data (`packetKnown`); a changes-feed item never touches `mcpStatus` |
| `CertData.Certificates[].Coverages[]` (Cargo / Auto Liability) | `insurancePolicies` CARGO / AUTO_LIABILITY: `limitCents`, `expiresAt`, `active`, `company`, `policyNumber` | upserted by type; other policy types untouched. Read by `effectiveCarrierStatus` + `evaluateCarrierBooking` |
| `CarrierDispatchers[]`, `ClaimsContact*`, `OwnerContact*`, `AfterHrsWkDaySupport*`, `OperationManagerName`, `Emails[]` (approved) | `CarrierContact` rows (types DISPATCH / CLAIMS / OWNER / AFTER_HOURS / MANAGER) | matched on e-mail, else name+phone; MCP's name/phone/e-mail win, types are unioned; first dispatcher becomes primary only if the carrier has none. `Carrier.dispatcherName/Email/Phone` are filled when blank, never overwritten |
| `CarrierBank` / `CarrierPaymentInfo` / `CarrierRemit` / `FactoringRemit` | `CarrierPaymentMethod` (`source 'MCP'`): `method` ACH if account+routing else CHECK; `recipientType` FACTOR when a factoring company is named; `bankName`, `accountName`, `accountLast4`, `routingLast4`, `payeeEmail`, `remitToAddress`, `factorName`, `factorAddress` | **full account / routing numbers are never stored**, only last four. The MCP row becomes `isPreferred`; a hand-typed method stays on file, no longer preferred. `bankDetailsKey` stays empty |

**Not done (state, not hidden):** W-9 / COI *documents*. `GetDocument` returns image bytes, which belong in S3 as `CarrierDocument` rows;
this change pulls the tax id and the coverage data, not the files. A required-document check (`MISSING_DOC:W9`) therefore still needs the
document uploaded or a follow-up that fetches `GetDocument`.

### Schema additions (additive)

`Carrier`: `mcpReviewStatus`, `mcpPacketCompletedAt`, `mcpSyncedAt`, `mcpSyncRunId` (these two last are the stamp `unmatched` is computed from).
`CarrierPaymentMethod`: `source` ('MCP' for rows MyCarrierPackets wrote). No other model changed.
The pull progress is a row `pull:MYCARRIERPACKETS` (`kind SYNC_STATE`) in the Integration table, excluded from the provider list.

### Audit shape (one `AuditLog` row per carrier MCP changed; nothing when nothing changed)

```json
{ "entityType": "CARRIER", "entityId": "<carrierId>", "action": "MCP_PULL" | "MCP_CREATE", "user": "mcp-sync",
  "changes": { "source": "MYCARRIERPACKETS", "runId": "...", "matchedBy": "MC|DOT|NAME|CREATED",
    "fields": { "phone": { "before": "000", "after": "555-0100", "kind": "OVERWROTE" },
                "einNumber": { "before": null, "after": "***6789", "kind": "FILLED" },
                "insurancePolicies": { "before": [...], "after": ["CARGO limit=10000000 exp=2027-01-01", ...], "kind": "OVERWROTE" } },
    "contacts": { "created": 2, "updated": 0 }, "payment": "CREATED|UPDATED|null" } }
```
No full bank numbers, no SSN, tax id masked, nothing beyond what the carrier row already holds.

### Backfill ("Pull all monitored carriers now")

1. The button (`MYCARRIERPACKETS_PULL_START`, owner/ADMIN, refuses unless the row is LIVE + health OK) invokes `mcp-sync` **asynchronously**
   (`kind PULL_ALL`); no MCP call happens inside the AppSync resolver. The page polls `MYCARRIERPACKETS_PULL_STATUS`.
2. The Lambda walks `MonitoredCarriers` (page size 250) and calls `GetCarrierData` for each entry (250 ms apart; ~230 s / 400 carriers per slice).
   A partial run keeps `cursor {page,index}`; "Resume pull" or the 30-minute schedule continues it. "Start over" begins a new run id.
   One slice at a time (a `lockUntil` on the state row); 429 stops the slice cleanly, 401/403 ends it as ERROR.
3. Match: MC (formatting-blind: `MC-0123` = `123`), then DOT, then a normalised name that exactly one carrier wears. An ambiguous name is not matched.
4. **Unmatched, MCP -> BCAT:** decision: **create them, as `PENDING`** (setting "Create carriers MyCarrierPackets monitors that we do not have",
   default on; off = list only). MCP supplies their compliance data, but `PENDING` cannot be booked until a person activates them, the same
   rule imported Aljex carriers follow. **Unmatched, BCAT -> MCP:** computed when the list ends (rows whose `mcpSyncRunId` is not this run's);
   count + first 200 shown on the page.
5. Idempotent: a second run over the same data writes nothing, audits nothing and counts everything `unchanged`; writes are `UpdateItem` guarded by the
   `updatedAt` that was read (re-read and retry once, then `conflicts`).
6. **Imported Aljex carriers** get their data from step 3 when they are in MCP's monitored list. A carrier that is not monitored is reported as
   "ours only"; `MYCARRIERPACKETS_SYNC_CARRIER {carrierId}` and the Aljex router's `IMPORT_BATCH` (below) pull such a carrier by its own MC/DOT.

### Ongoing

The schedule (`mcp-sync`, 30 min; disabled on dev by the stack guard) continues a partial backfill; once a backfill is DONE it polls `CarriersChanges`
(at most every 4 minutes, from `changesFrom` to now) and applies insurance / FMCSA / risk changes, then pulls the **full profile** of every
packet in `CompletedPackets` for the same window (a changes item has no packet, W-9 or payment). It never *starts* the first backfill.
On dev the same operation is the button.

Do the gates see it? `mcpPacketStanding` reads `mcpStatus`; `effectiveCarrierStatus` (carrier list status + `BOOK_CARRIER`) treats a carrier whose
cargo policies are all expired as INACTIVE; `evaluateCarrierBooking` reads `insurancePolicies` and `authorityStatus`. All of those are fields this
engine writes, so a lapse reported by CarriersChanges blocks booking as soon as the row is written. A lapse does **not** rewrite the stored
`status` or `mcpStatus` (the derived status does the blocking). A *completed packet* is still required for SEND_RATE_CON, as before.

### Invocations of `mcp-sync`

`PULL_ALL {startedBy, restart?}` (async) · `PULL_ONE {carrierId}` (sync) · `IMPORT_BATCH {carrierIds, maxLookups?, cursor?}` (sync, Aljex router;
returns `{ready, reason?, results:[{carrierId,result:'SYNCED'|'NO_PACKET'|'ERROR'}], cursor, done}`) · EventBridge. All refuse unless LIVE and are lookup-and-write only.
`IMPORT_BATCH` and `PULL_ONE` use the same full-profile pipeline and audit as the backfill.

### Webhook receiver

`/api/webhooks/mycarrierpackets` (tracking-api) was built for an assumed webhook. The guide defines none, so MCP does not use it; it was **not
changed** (it still rejects unsigned/tampered/stale deliveries with 401 under BCAT's own `x-bcat-signature` HMAC scheme, which is not an MCP scheme).
No MCP signature algorithm exists to implement, and the credential field and page card that advertised it are removed.

## Only verifiable with real credentials

Token lifetime / `expires_in`; the real `CarrierPacketStatus`, `OverallRating`, `ReviewState` strings; whether
`GetCarrierData` answers for a carrier MCP has never seen; the exact shape of `MonitoredCarriers` rows and of `CarriersChanges.CarrierList[].CarrierDetails` (adapter falls back to PreviewCarrier); the query
parameter name (`Docket` vs `DocketNumber`); `CoverageLimit` units; 429 behaviour.

## Find & Invite (Step AD)

Carriers > Find & Invite (`/tms/carriers/find`) reviews one carrier on MyCarrierPackets and invites it. Calls run in `tms-directory-actions` (`mcpFind.ts`); credentials are read there through the same Integration gate as the sync (`mcpFindGate`) and never leave the Lambda.

| Action | MCP call | Notes |
| --- | --- | --- |
| `MCP_PREVIEW_CARRIER` | `PreviewCarrier?DOTNumber=&docketNumber=` | profile, FMCSA status, risk, certificates, approved e-mails; works for a carrier that never touched MCP |
| `MCP_GET_CARRIER` | `GetCarrierData` | packet, contacts, equipment, lanes, monitoring (same body `mcp-sync` reads) |
| `MCP_SEND_INVITE` | `EmailPacketInvitation?dotNumber=&docketNumber=&carrierEmail=&username=<integration user>` | then Carrier row stamp, AuditLog, shipment-thread NOTE when launched from a load |
| `MCP_ADD_CARRIER` | (via `mcp-sync` `ADD_CARRIER`: GetCarrierData) | creates the PENDING row from MCP unless one matches; refused in STUB |

Not LIVE => STUB: a labelled fixture, no MCP call, no invitation, no row. The review card (`src/lib/integrations/mcpReview.ts`) is built by one mapper for live bodies and fixtures. MCP has no name search endpoint: a typed name searches our directory only. `username` is the integration user (guide spelling; swagger calls it `userName`). Live test: `node scripts/devVerifyAD.mjs --live` (MC 274623 only, one invitation to ai4bcat@gmail.com, results in `MCP_LIVE_TEST.md`).

Audit: `MCP_PREVIEW_CARRIER` / `MCP_GET_CARRIER` (INTEGRATION), `MCP_SEND_INVITE` (CARRIER, else INTEGRATION), `MCP_ADD_CARRIER` (CARRIER) carry identifiers, mode, HTTP status and response key names only. Additive Carrier fields: `mcpInvitedAt`, `mcpInvitedTo`, `mcpInvitedBy`.

## Cover flow and Carrier.status (Step AM)

- **Carrier.status is MyCarrierPackets' to drive** (`src/lib/integrations/mcpCarrierStatus.ts`, applied by every pull: backfill, changes poll, single pull, create). Packet complete (`PENDING_REVIEW | ACCEPTABLE | MODERATE | UNACCEPTABLE*` per `mcpPacketStanding`) with no lapse => `ACTIVE` (from PENDING / REVIEW, or from an INACTIVE that `mcp-sync` itself set). A lapse on an ACTIVE carrier => `INACTIVE` with the reason: `UNACCEPTABLE` review => `SAFETY_ISSUES`, authority `INACTIVE` => `INACTIVE_AUTHORITY`, all cargo policies expired => `EXPIRED_INSURANCE`. `DO_NOT_USE` and an INACTIVE a person set are never touched; a carrier with no MCP data (Aljex-imported) is left alone. The status change is in the `MCP_PULL` audit (`fields.status`). [INFERENCE: "monitored" = completed packet read from MCP; the guide has no per-carrier monitored flag on GetCarrierData.]
- **No manual setup-complete**: `SET_CARRIER_STATUS -> ACTIVE` is refused unless the packet is complete (or the row is Aljex-imported). `UPSERT_CARRIER` create is ADMIN-only, always PENDING, audited `manualDataFix`.
- `MCP_SEND_INVITE` gained `ensureCarrier: true`: after a LIVE invitation, `mcp-sync ADD_CARRIER` makes the PENDING row from MCP and stamps the invite on it; the reply carries `carrierId / carrierCreated / carrierError` (a failed row creation is reported, not thrown, so a retry cannot invite twice). STUB creates nothing.
- When MCP turns a carrier ACTIVE, `mcp-sync` advances its assignments waiting on setup to `ASSIGNED_SETUP_COMPLETE` (`mcpLadder.ts`; conditional write, audit `ASSIGNMENT_ADVANCED`, mirrors on Load + Shipment). `mcp-sync` gained UpdateItem on Load/Shipment/LoadCarrier and a Query on the LoadCarrier carrier index.
- **UI (Step AM)**: the Cover dialog (`src/features/carriers/cover/`) is the only assignment entry: directory hit by MC / DOT (ACTIVE assigns at once, no MCP call), otherwise `MCP_PREVIEW_CARRIER` + the AD review card and "Send setup packet via MyCarrierPackets" (e-mail picker: MCP-approved + typed; `MCP_SEND_INVITE` with `ensureCarrier`, then `COVER_CARRIER`). Find & Invite no longer has "Add to carriers"; its invite creates the Pending row. The carrier status dialog offers Active only once MCP reports the packet complete (Aljex-imported carriers excepted). The rate con panel and the ladder buttons wait for Carrier ACTIVE.
