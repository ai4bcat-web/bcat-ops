# Step AI — data exposure audit (decision D1)

Generated 2026-11-04T21:46:15Z by `node scripts/auditDataExposure.mjs --write` against the **dev** stack. Read-only: it signs in as a temporary identity that belongs to **no group** and lists each model, selecting only `__typename` — so this file holds readable yes/no and row counts, never a value. Counts are dev counts (capped at 25 pages of 1000 rows per model, a capped count prints "≥"); which models are readable is a property of the schema and is the same on `main`.

## What it means

**95 of 109 models are readable by any signed-in user straight from AppSync** (plus 10 that the schema declares readable but have no list query to probe) (145,847+ rows in total on dev). The dashboards feature filters what **its own** dashboards show to the viewer's customers (server-side, in the Lambda), but it cannot stop a hand-written GraphQL query such as `listShipments` / `listInvoices` / `listLaneRateSamples` / `listCustomers`: those return every row to any logged-in person, whatever their role or claims. "Showing only the customers you own or your team covers" is therefore a view rule, **not** an access boundary, until the model-level reads below are closed (decision D1, a separate costed step: replace `allow.authenticated().to(['read'])` with group rules and route every list through a Lambda).

## Per model

| Model | Readable by a user with no group | Rows (dev, count only) | Schema says |
|---|---|---|---|
| AuditLog | **yes** | ≥ 24,963 | authenticated: read+write; disabled: subscriptions |
| LoadCharge | **yes** | 19,343 | authenticated: read; disabled: subscriptions |
| ProClaim | **yes** | 10,904 | authenticated: read; disabled: delete/subscriptions |
| Load | **yes** | 10,903 | authenticated: read; disabled: delete |
| LoadFinancials | **yes** | 10,903 | authenticated: read; disabled: subscriptions |
| Order | **yes** | 10,903 | authenticated: read; disabled: subscriptions |
| Shipment | **yes** | 10,903 | authenticated: read; disabled: subscriptions/delete |
| LoadCarrier | **yes** | 8,680 | authenticated: read; disabled: subscriptions |
| Invoice | **yes** | 7,526 | authenticated: read; disabled: subscriptions |
| LegacyAljexRow | **yes** | ≥ 7,066 | authenticated: read; disabled: subscriptions/delete |
| Location | **yes** | 3,209 | authenticated: read; disabled: subscriptions |
| DispatchMessage | **yes** | 2,993 | authenticated: read; disabled: subscriptions |
| LoadCheckCall | **yes** | 2,835 | authenticated: read; disabled: subscriptions |
| ArPayment | **yes** | 2,432 | authenticated: read; disabled: subscriptions |
| IntakeItem | **yes** | 1,824 | authenticated: read+write; disabled: subscriptions |
| CarrierBill | **yes** | 1,612 | authenticated: read; disabled: subscriptions |
| ApPayment | **yes** | 1,082 | authenticated: read; disabled: subscriptions |
| LaneRateSample | **yes** | 931 | authenticated: read; disabled: subscriptions |
| FuelTransaction | **yes** | 880 | authenticated: read+write; disabled: subscriptions |
| AmazonTrip | **yes** | 768 | authenticated: read+write; disabled: subscriptions |
| Customer | **yes** | 744 | authenticated: read; disabled: subscriptions |
| ShipmentDocument | **yes** | 654 | authenticated: read; disabled: subscriptions |
| DriverSubmissionDoc | **yes** | 497 | authenticated: read+write; disabled: subscriptions |
| Carrier | **yes** | 417 | authenticated: read; disabled: subscriptions |
| ShipmentMessage | **yes** | 395 | authenticated: read; disabled: subscriptions |
| DriverSubmission | **yes** | 360 | authenticated: read+write; disabled: subscriptions |
| MaintenanceTask | **yes** | 187 | authenticated: read+write; disabled: subscriptions |
| MaintenanceInvoice | **yes** | 181 | authenticated: read+write; disabled: subscriptions |
| ComplianceDocument | **yes** | 180 | authenticated: read+write; disabled: subscriptions |
| FactoringItem | **yes** | 174 | authenticated: read+write; disabled: subscriptions |
| DemoRecord | **yes** | 123 | authenticated: read; disabled: subscriptions |
| BoxTruckTrip | **yes** | 116 | authenticated: read+write; disabled: subscriptions |
| Quote | **yes** | 108 | authenticated: read; disabled: subscriptions |
| TrackingLink | **yes** | 108 | authenticated: read; disabled: subscriptions |
| DashboardRollup | **yes** | 91 | authenticated: read; disabled: subscriptions/create/update/delete |
| CarrierDocument | **yes** | 74 | authenticated: read; disabled: subscriptions |
| TimeClockEntry | **yes** | 72 | authenticated: read+write; disabled: subscriptions |
| WorkflowRun | **yes** | 59 | authenticated: read; disabled: subscriptions/delete |
| ShipmentColumnTemplate | **yes** | 46 | authenticated: read; disabled: subscriptions |
| Integration | **yes** | 42 | authenticated: read; disabled: subscriptions/delete |
| ShipmentNotice | **yes** | 42 | authenticated: read; disabled: subscriptions |
| OnboardingTask | **yes** | 38 | authenticated: read+write; disabled: subscriptions |
| DriverAvailability | **yes** | 34 | authenticated: read+write |
| Commission | **yes** | 33 | authenticated: read; disabled: subscriptions |
| DriverPayDeduction | **yes** | 30 | authenticated: read+write; disabled: subscriptions |
| ShipmentView | **yes** | 28 | authenticated: read; disabled: subscriptions |
| RecurringExpense | **yes** | 27 | authenticated: read+write; disabled: subscriptions |
| TruckExpenseAllocation | **yes** | 27 | authenticated: read+write; disabled: subscriptions |
| ComplianceAlert | **yes** | 26 | authenticated: read+write; disabled: subscriptions |
| InsuranceLineItem | **yes** | 24 | authenticated: read+write; disabled: subscriptions |
| OwnershipRule | **yes** | 24 | authenticated: read; disabled: subscriptions |
| Equipment | **yes** | 22 | authenticated: read+write; disabled: subscriptions |
| OnboardingInvite | **yes** | 21 | authenticated: read+write; disabled: subscriptions |
| Driver | **yes** | 19 | authenticated: read+write; disabled: subscriptions |
| VendorPayable | **yes** | 16 | authenticated: read+write; disabled: subscriptions |
| UserProfile | **yes** | 14 | authenticated: read; disabled: subscriptions |
| OwnershipDivision | **yes** | 13 | authenticated: read; disabled: subscriptions |
| CarrierPaymentMethod | **yes** | 12 | authenticated: read; disabled: subscriptions |
| DispatchConversation | **yes** | 12 | authenticated: read; disabled: subscriptions |
| DriverPayPeriod | **yes** | 11 | authenticated: read+write; disabled: subscriptions |
| AmazonDispute | **yes** | 9 | authenticated: read+write; disabled: subscriptions |
| DriverPaySetting | **yes** | 9 | authenticated: read+write; disabled: subscriptions |
| ExpenseType | **yes** | 9 | authenticated: read+write; disabled: subscriptions |
| AmazonPayMaster | **yes** | 8 | authenticated: read+write; disabled: subscriptions |
| DriverLoadTime | **yes** | 7 | authenticated: read+write |
| DriverPayCredit | **yes** | 7 | authenticated: read+write; disabled: subscriptions |
| IntakeLoad | **yes** | 7 | authenticated: read; disabled: subscriptions/delete |
| ShipmentPosting | **yes** | 7 | authenticated: read; disabled: subscriptions |
| AljexImportJob | **yes** | 5 | authenticated: read; disabled: subscriptions/delete |
| EscalationRule | **yes** | 3 | authenticated: read+write; disabled: subscriptions |
| CashCheckIn | **yes** | 2 | no authenticated rule |
| CommissionPayPeriod | **yes** | 2 | authenticated: read; disabled: subscriptions |
| DocumentSignatureRequest | **yes** | 2 | authenticated: read+write; disabled: subscriptions |
| CarrierContact | **yes** | 1 | authenticated: read; disabled: subscriptions |
| CashSettings | **yes** | 1 | no authenticated rule |
| ComplianceSettings | **yes** | 1 | authenticated: read+write; disabled: subscriptions |
| DataExportJob | **yes** | 1 | authenticated: read; disabled: subscriptions/delete |
| DispatchSettings | **yes** | 1 | authenticated: read; disabled: subscriptions |
| DriverApplication | **yes** | 1 | authenticated: read+write; disabled: subscriptions |
| InsurancePeriod | **yes** | 1 | authenticated: read+write; disabled: subscriptions |
| SpotSettings | **yes** | 1 | authenticated: read; disabled: subscriptions/delete |
| TmsSettings | **yes** | 1 | authenticated: read; disabled: subscriptions |
| AljexCodeMap | **yes** | 0 | authenticated: read; disabled: subscriptions/delete |
| AljexMappingProfile | **yes** | 0 | authenticated: read; disabled: subscriptions/delete |
| ApInboxItem | **yes** | 0 | authenticated: read; disabled: subscriptions/create/update/delete |
| CashFlowInputs | **yes** | 0 | authenticated: read+write; disabled: subscriptions |
| CashFlowWeekLog | **yes** | 0 | authenticated: read+write; disabled: subscriptions |
| CrmAccount | **yes** | 0 | authenticated: read; disabled: subscriptions/create/update/delete |
| CrmActivity | no | — | groups: ADMIN; disabled: subscriptions/create/update/delete |
| CrmContact | **yes** | 0 | authenticated: read; disabled: subscriptions/create/update/delete |
| CrmDomain | **yes** | 0 | authenticated: read; disabled: subscriptions/create/update/delete |
| DirectoryMergeJob | **yes** | 0 | authenticated: read; disabled: subscriptions |
| EscalationEmailLog | **yes** | 0 | authenticated: read+write; disabled: subscriptions |
| ExpenseRecord | **yes** | 0 | authenticated: read+write; disabled: subscriptions |
| Feedback | **yes** | 0 | authenticated: read+write; disabled: subscriptions |
| GmailConnection | no | — | groups: ADMIN; disabled: subscriptions/create/update/delete |
| ImportJob | **yes** | 0 | authenticated: read; disabled: subscriptions/delete |
| PodDocument | no | — | authenticated: read+write; disabled: subscriptions |
| SpotRequest | no | — | groups: ADMIN; disabled: subscriptions/create/update/delete |
| CompanyPhone | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| Division | declared readable, not probed (no list query found in the schema) | — | authenticated: read; disabled: subscriptions |
| OnboardingTemplateConfig | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| PodSenderMapping | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| TruckConfig | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| TruckFaultCode | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| TruckLocation | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| TruckLocationHistory | declared readable, not probed (no list query found in the schema) | — | authenticated: read; disabled: subscriptions/create/update/delete |
| TruckMileage | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |
| TruckOdometerDay | declared readable, not probed (no list query found in the schema) | — | authenticated: read+write; disabled: subscriptions |

Readable (probed): 95 · refused: 4 · could not tell: 0 · declared readable but not probed: 10.

## Visibility coverage (what a rep would actually see through dashboards; counts and percentages only)

| Measure | Value |
|---|---|
| Customers with no owner, no default rep and no team (invisible to every non-viewAll user) | 94.4 % (702 of 744) |
| Customers with a team | 0.7 % (5 of 744) |
| Shipments picked up in the last 90 days with no salesRepId | 34.2 % (1,274 of 3,724) |
| Those shipments with no customerId (visible only through a direct rep field) | 0.5 % (17 of 3,724) |
