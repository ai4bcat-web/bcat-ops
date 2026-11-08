# AW: dormant pages while the schema stages deploy

Production receives the merged frontend at `BCAT_SCHEMA_STAGE=0` (see `AW_STAGED_DEPLOY.md`). Until stages 1, 2 and 3 deploy, their models are not in the AppSync schema, and a query on one is a GraphQL validation error. Ryne's rule: a page whose tables do not exist yet shows a clear empty state, never an error screen, and every production page keeps working exactly as today.

## How it works

- `src/lib/modelAvailability.ts`: `modelAvailable(name)` / `modelsAvailable(names)` read `data.model_introspection.models` from `amplify_outputs.json`, the same file `main.tsx` passes to `Amplify.configure`. No introspection in the file (placeholder, dev sandbox, tests) means everything is available.
- `src/lib/dormantPages.ts`: the page -> models table below (`DORMANT_PAGES`) and the paths each page lives at (`DORMANT_ROUTES`). Sidebar rows and lifecycle tabs resolve through it.
- `src/components/RequireModels.tsx`: `<RequireModels models area>` and `<DormantPage page="…">`. While any listed model is missing the children are never mounted (no query runs). `src/App.tsx`, `BrokeragePage.tsx` and `company/CompanyTab.tsx` wrap every route of the table.
- `src/lib/dormantPages.test.ts` fails if a route is not wrapped as the table says, if a stage is wrong against `amplify/data/stages.ts`, or if a new `/tms` route is neither wrapped nor listed as a live production-model route.

## Page -> models -> stage

| Key | Page (routes) | Models | Stage |
|---|---|---|---|
| dashboard | Company Dashboard (`/tms/dashboard`, `d/:id`, `new`, `d/:id/edit`) | Shipment, Order, LoadCarrier, LoadFinancials, Invoice, CarrierBill, DashboardRollup | 3 |
| shipments | Shipments board, new, edit, detail (`/tms/shipments`, `new`, `:id`, `:id/edit`) | Shipment, Order, LoadCarrier, LoadFinancials | 2 |
| intake | Intake board and review (`/tms/shipments/intake[/:id]`) | IntakeLoad, Shipment | 2 |
| carrierSales | Carrier Sales (`/tms/carrier-sales`) | Shipment, LoadCarrier, Quote, Carrier | 2 |
| tracking | Load Tracking, Customer links (`/tms/tracking[/links]`) | Shipment, LoadCarrier, TrackingLink, LoadCheckCall | 2 |
| loadReview | Load Review (`/tms/load-review`) | Shipment, Order, LoadFinancials | 2 |
| quotes | Quotes, Spot inbox, callback, new, detail (`/tms/rates/*`) | Quote | 2 |
| invoicingAr | Accounts Receivable, invoice detail (`/tms/invoicing[/invoices/:id]`) | Shipment, Order, Invoice, ArPayment | 3 |
| invoicingAp | Accounts Payable, bill detail (`/tms/invoicing/payable[/bills/:id]`) | Shipment, LoadCarrier, CarrierBill, ApPayment | 3 |
| carriers | Carrier list, Find and invite (`/tms/carriers`, `/find`) | Carrier, CarrierContact, CarrierPaymentMethod, CarrierDocument | 1 |
| carrierProfile | Carrier profile (`/tms/carriers/:id`) | the four above + LoadCarrier | 2 |
| billingSetup | Customers > Billing setup (`/tms/customers/billing-setup`) | Shipment, Order | 2 |
| workflows | Workflows and run trace (`/tms/workflows[/runs/:id]`) | WorkflowRun, Shipment, TrackingLink | 3 |
| commissions | Settings > Commissions | Commission, CommissionPayPeriod | 1 |
| reports | Settings > Reports | shipment core, Invoice, CarrierBill, Commission, LaneRateSample | 3 |
| divisions | Settings > Divisions & ownership | OwnershipDivision, OwnershipRule | 1 |
| integrations | Settings > Integrations | Integration | 1 |
| aiAgents | Settings > AI agents | WorkflowRun | 3 |
| spotQuoter | Settings > Spot quoter & e-mail | SpotSettings, GmailConnection, SpotRequest | 1 |
| demo | Settings > Demo | DemoRecord | 3 |
| dataImport | Settings > Company > Import | ImportJob | 3 |
| aljexImport | Settings > Company > Aljex import | AljexImportJob, AljexMappingProfile, LegacyAljexRow, AljexCodeMap | 3 |
| aljexReconciliation | Settings > Company > Data > Aljex reconciliation | AljexImportJob, LegacyAljexRow, AljexCodeMap | 3 |
| dataSafety | Settings > Company > Data & backups | DataExportJob | 3 |

A page flips on at the stage of its last model. Not in the table (production models only, they keep rendering): Customers, Locations, Vendors, Factoring, Settings (general), Users, Audit, Company / Billing / Branding / Notifications / Account, Carrier Sales settings, and every non-`/tms` production page (Dispatch, Calendar, Driver info, Hours, Time off, Files, Fleet, Fuel, Maintenance, Insurance, Appts, Tasks, Reddit queue, Feedback, Compliance, Finances, ...).

## What a person sees

- A dormant page: the shell stays; the content is a calm empty state (`role="status"`): "<Area> turns on during the merge", "This area switches on when the merge finishes. Nothing is wrong and no data is lost. Existing pages keep working.", and a link "Back to Company Dashboard" (on the Company Dashboard itself the link is "Open the Dashboard", the production `/dashboard`).
- Sidebar rows and the six lifecycle steps (Quote, Build, View, Book, Track, Review, and the Active shipments row) are shown but disabled: `aria-disabled`, tooltip "Switches on during the merge", no navigation, no count badge, no Alt+number shortcut. The Accounting group row stays a header; its AR/AP children carry their own state.
- Landing: while the Company Dashboard is dormant, `/` and `/tms` land on the production Dashboard (`/dashboard`) instead of an empty state. A bookmarked `/loads` or `/loads/:id` (shipment lookup) lands on `/calendar` (production's `/loads` page was the loads grid, which no longer exists).

## Cross-cutting reads that degrade silently (no toast, no error)

- `apiClient` flags that already turned a failed read into an empty list are now seeded from the deployed schema, so the failing request is never sent: OwnershipDivision/Rule/ShipmentView, IntakeLoad, ShipmentColumnTemplate, LoadFinancials, ShipmentDocument/Notice, UserProfile, Invoice/ArPayment/Order (AR), CarrierBill/ApPayment/LoadCarrier (AP), Quote, Commission/CommissionPayPeriod.
- New early returns: `listIntegrations`, `listCompanyPhones` (Files page), `listCarrierDocuments` (Compliance page), `listCarriers`, `listCarriersByStatus`, `listShipmentsByNumber`, `listLoadCarriersByLoads`, `listApInboxItems`, the three `listLaneSamples*`, and `dashboardRollupClient` rows (the dashboards compute live).
- `useShipments` (the shell loads it on every page) returns the empty result with no request when the shipment core is missing; `useShellBadgeCounts` and `useNotifications` zero and stop reading intake, spot, quotes, AR, AP, check-call, document-review and Load Review / Carrier Sales counts; `useWorkflowExceptions` and `useSpotNewCount` likewise.

## How it flips on

Nothing to do by hand. Each stage's build regenerates `amplify_outputs.json`, whose `data.model_introspection.models` then lists that stage's models; the new bundle's `modelsAvailable` answers true, the empty states give way to the real pages, the sidebar rows and lifecycle steps enable themselves, and the seeded flags read the tables. Stage 1 enables Carriers (list/find), Divisions, Integrations, Commissions and Spot quoter settings; stage 2 the shipment lifecycle (Quote to Review), Carrier profile and Billing setup; stage 3 the Company Dashboard, AR/AP, Workflows, Reports, AI agents, Demo and the import/Aljex/data pages. A browser tab opened before the stage deployed picks it up through the existing update banner.
