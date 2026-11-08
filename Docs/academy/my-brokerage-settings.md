---
title: My Brokerage Settings
slug: my-brokerage-settings
type: REFERENCE
category: Account
productAreas: [TMS, Account]
related: [divisions-and-ownership, users-roles-and-teams, integrations]
---

# My Brokerage Settings

The **My Brokerage** section is where the owner or an ADMIN configures the company profile, billing entities, branding, notification defaults, data imports, and integration credentials. Dispatchers and other roles do not see these pages.

## Where to find it

- Open **My Brokerage** from the main navigation.
- The **Settings** tab is always visible to anyone who can open My Brokerage and contains the global defaults and operational rules.
- The **Company** tab is owner/ADMIN-only and contains the six inner pages described below.

## Company tab

The Company tab stores the public identity and back-office details used on invoices, rate confirmations, and customer portals.

### Company page

- Edit the primary billing entity: legal name, tax ID (EIN), invoice prefix, MC/DOT number, and the logo that appears on customer-facing documents.
- The first division marked **primary** is used as the default remit-to and company block. If no division is primary, the first division is promoted automatically.
- Uploads go to the protected `brandLogos*` storage prefixes.

### Billing page

- Manage one or more billing entities (divisions) and their remit-to addresses, billing/payables contacts, and per-country payment instructions.
- Set the org-level **Payment terms** table: the default term days, discount days, and discount basis points.
- The footer preview on the right shows exactly how the remit block will read on invoices.

### Branding page

- Choose brand accent colour and light/dark/system theme.
- Upload square and wide logos and a document header.
- Edit the e-mail signature block used on rate confirmations and carrier offer e-mails.

### Notifications page

- Configure the default notification subscriptions and webhook endpoints for the brokerage.
- Rotate webhook secrets safely: the stored secret lives in Parameter Store and only the last four characters are shown.

### Import page

- Preview and run directory imports for Customers, Locations, Carriers, Carrier factors, Charge codes, Payment terms, and Vendor contacts.
- Each import creates an `ImportJob` record so you can review what was created, updated, or skipped.

### Account page

- View account-level identifiers and the AWS/Amplify stack info used by support.

## Settings tab cards

- **TMS defaults** — margin target/floor, credit controls, accessorial codes, invoice number format, required load fields, and the default check-call plan.
- **Customer settings** — portal defaults, customer tags, and the status mask a customer sees in the portal.
- **Carrier booking settings** — bookable carrier statuses, required carrier documents, required booking fields, rate-con signing fields, default carrier terms, and insurance warning days.
- **Carrier documents** — rate-confirmation and carrier-agreement templates and their required documents/signing fields.
- **Consolidation rules** — advisory rules that flag when multiple loads can be combined on one invoice.
- **Charge codes** — the brokerage's charge catalogue, including visibility (internal, customer, carrier) used by overrides.
- **Users, Roles, Teams, Commissions** — unchanged from earlier steps; see [Users, Roles and Teams](users-roles-and-teams.md) and [Commissions](commissions.md).

## Rules

- These settings are org-wide. A change here applies to every load, invoice, and portal view unless a customer or load-level override exists.
- Division and company settings are additive: new fields introduced here do not delete existing divisions.
- All saves run through `tmsDirectoryActions` and validate on the Lambda before writing.
