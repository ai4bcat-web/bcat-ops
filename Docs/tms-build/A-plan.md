# Step A — Customer v2 (dev)

## Architecture and scope

Planned before implementation by Claude Fable (`reviewer` planning-only assignment). The harness has no registered `plan` agent; Main approved this same-model mapping. Reuse the existing read-only Customer/TmsSettings models and tmsDirectoryActions writer. No new model, dependency, driver contract, production change, or migration. All fields optional; existing records remain usable.

## Additive schema and shared contracts

Customer: status enum NEW/CONTACTED/QUALIFIED/QUOTED/NURTURING/PENDING/ACTIVE/DORMANT/CLOSED/BLOCKED; statusReason, statusChangedAt, statusChangedBy, replacementCustomerId; leadSource, industry, serviceTier, website; freeCreditRequired, creditUsageWarningBps, maxDaysLate; contacts, billToParties, requiredReferences, chargeCodeOverrides, defaultCharges, pricingDefaults, quotingDefaults (JSON); rateConTerms, teamKey, operatedById, accountOwnerIds; invoiceFrequency DAILY/TWICE_WEEKLY/WEEKLY/MONTHLY, gpSplitBps, visibilityPrefs {milestoneEmails,sharedTrackingLink,shipperPortal}. Existing creditLimitCents/creditHoldFlag, requiredDocsForInvoice, billing fields, defaultDivisionKey, defaultSalesRepId and aliases are reused.

JSON interfaces in src/types/tms.ts:
- CustomerContact: id/name; email/phone/title optional; types PRIMARY/BILLING/OPERATIONS/SALES/CLAIMS/OTHER[]; optional billToId; notifications APPT_SCHEDULED/LOADING/PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY/UNLOADING/DELIVERED/INVOICE_SENT[]; active.
- BillToParty: id/name; optional Address/email/phone/paymentTermsDays; isDefault.
- RequiredReference: code/optional label; level ORDER/HANDLING_UNIT/PACKAGE/STOP; display; countOnNewOrder 0–10.
- ChargeCalc: FLAT/PER_MILE/PER_CWT/PERCENT. ChargeCodeDef: code/label/calculatedBy, optional category/defaultAmountCents. Override: code/display with optional customerCode/label/calculatedBy/defaultAmountCents. DefaultCharge: code/amountCents/optional count.
- PricingDefaults: mode MARGIN/MARKUP/PROFIT; optional defaultBps/defaultProfitCents/minProfitCents/maxProfitCents/singleChargeCode. QuotingDefaults: optional defaultMode/hoursToQuote/notes.

TmsSettings: defaultCreditLimitCents, defaultFreeCreditRequired, defaultCreditUsageWarningBps, defaultMaxDaysLate, requireCustomerApproval, defaultRequiredDocs, defaultRequiredReferences, chargeCodes, rateConTerms. Money integer cents; percentages integer basis points. No artificial date cutoff that erases credit exposure.

## Lambda actions and safety

Extend UPSERT_CUSTOMER with bounded, element-validated JSON (≤100 entries), unique ids, at most one default bill-to, valid contact bill-to references, enum/range checks, and existing optimistic CAS. Credit-control changes require owner/ADMIN (unchanged echoes permitted). Creates default ACTIVE, or PENDING under org approval for non-admin; leads explicitly select a lead stage. Existing status cannot change via upsert. Active mirror derives from status (false for CLOSED/BLOCKED); legacy updates preserve current behavior.

Add SET_CUSTOMER_STATUS {id,expectedUpdatedAt,status,reason?,replacementCustomerId?}. Lead stages interconvert; activation honors approval; PENDING approval admin-only; BLOCKED requires reason; CLOSED only from lead; DORMANT is derived not manually selected. Reject self/invalid replacement, merged records, stale CAS. Reactivation bypasses archive-edit refusal. Existing ARCHIVE_CUSTOMER remains a compatible existing API. SAVE_SETTINGS extends existing admin-only validation/preservation.

## Credit math and client

customerCredit.ts resolves customer overrides then org defaults, computes cents exposure, available/usage/warning, credit hold, and three reasons: NO_CREDIT_LIMIT, CREDIT_LIMIT_REACHED, INVOICE_PAST_MAX_DAYS_LATE. Projected amount participates in credit checks. Match loads by customerId, or normalized name/alias only when id absent. Every unknown legacy exposure remains counted; appointment dates, assignment and readyToInvoice do not establish invoicing/payment. No legacy paid/invoiced state inferred. Late invoice evidence becomes available in F; show unknown rather than invented lateness.

Effective legacy customer status = ACTIVE unless active false; derive dormant after 90 days using creation and latest load evidence. Board groups lead stages / Active+Pending / Dormant+Closed+Blocked. Client follows existing JSON unwrap and pre-deployment field handling; typed setCustomerStatus and useDirectory wrapper; useCustomerOrders fetches actual matching loads without per-row repeated scans. Poll-based existing directory behavior retained.

## UI and ownership

Leads/Active/Inactive board, search/counts, add customer/lead, profile opening, activation/approval/deactivation/close-lead actions. Profile tabs Account profile, Contacts, Documents (required-document configuration), Shipping locations, Settings, Quoting, Order history. Editors cover all new fields, bill-to contacts, default charges/overrides, requirements, pricing/quoting, ownership and ratecon terms. Credit card shows customer versus org settings, exposure, warning/blocks; edits admin-only. Locations tab uses real directory links; Orders uses real loads. No placeholder quote/shipment creation (B/H implement those actions).

Exclusive parallel slices: S1 backend/schema (resource.ts Customer/TmsSettings, directory handler/test); S2 shared types/math/client/hooks (tms.ts, customerCredit.ts/test, apiClient directory sections, useDirectory, useCustomerOrders); S3 directory customer UI/components/render test. Lead integrates then validates/commits/deploys together; agents never push separately.

## Proof, rollout, decisions

Scoped tests: auth/credit changes, approval transitions/CAS, invalid nested JSON and reference integrity; credit precedence/zero limits/boundaries/projections/matching/no inferred invoicing; UI tabs/actions/admin credit gating. Lead runs typecheck → lint → test, Fable final review, fixes findings, commits on dev, waits for latest job to settle, pushes origin dev. Verify deployed schema, 98 copied customers, profile save/reload and status/credit behavior in authenticated dev browser before B. Log commit/deploy evidence. No backfill necessary.

Decision needed: dedicated plan role mapping (approved fallback continues); customer merge/hard-delete behavior needs a product decision, default retain inactive records and do not repoint historical loads. Legacy credit exposure is conservative pending recorded ledger evidence; no paid state guessed. Typed uploaded document storage ships in E; A Documents configures requirements.
