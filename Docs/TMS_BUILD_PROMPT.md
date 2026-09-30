# BCAT Ops → Full TMS: Build Prompt

> Paste everything below the line into Claude Code, opened in `/Users/adminoid/bcat-ops`.
> No screenshots needed: the "Reference: the Aljex load screen" section describes them.

---

## Mission

Turn **bcat-ops** (React 19 + TS + Vite + Tailwind/shadcn + Zustand, AWS Amplify Gen 2: AppSync/DynamoDB/Cognito/S3/Lambda, deploys on every push to `main`) into a complete trucking TMS that replaces Aljex for BCAT Logistics (brokerage), Ivan Cartage (asset carrier) and the Amazon DSP. By the end it should:

1. Build loads end to end: customer, stops, rates, carrier or own driver/truck, documents, check calls, tracking.
2. **Build loads automatically from a rate confirmation** (PDF/image) with a human review step.
3. **Match PODs** (and other paperwork) to the right shipment automatically.
4. Keep a **saved, de-duplicated Locations book** that every load, ratecon and POD resolves against.
5. Handle money: customer invoicing, **AR aging**, carrier pay (AP), **driver settlements**, commissions, and **factoring** through a factoring company.
6. Tag everything for reporting: **revenue division**, **sales rep**, **driver/carrier**, so P&L and settlements can be sliced any way.
7. Show locations on a map (trucks + stops) and lay the groundwork for a **driver mobile app**.

## Ground rules (read first, follow throughout)

- **Read before you build.** Start with `CONTEXT.md`, `Docs/ARCHITECTURE.md`, `Docs/WORKFLOWS.md`, `Docs/STYLE.md`, `amplify/data/resource.ts`, `src/lib/stops.ts`, `src/store/useAppStore.ts`, the Load form/grid, `src/features/directory/DirectoryPages.tsx`, `amplify/functions/ratecon-parser`, `src/features/factoring`, and the driver-pay pages. Summarize what exists before proposing anything.
- **Extend, don't replace.** `Load` already has a canonical `stops` JSON array with dual-written legacy mirrors (`pickup*`/`delivery*`), `Customer` and `Location` models, a `parseRateConfirm` Lambda, a factoring queue, box-truck + Amazon settlements, Motive truck locations, an appointments board, and audit logging. New work must keep all of these working. No field renames or deletions without a migration + backfill script under `scripts/` and my explicit OK.
- **Work on a branch.** `main` auto-deploys to production. One branch per phase (`feat/tms-phase-N-<name>`), small commits, and never push to `main` without asking me.
- **Plan mode first.** For each phase: produce a plan (schema diff, new pages/routes, Lambdas, migrations, risks, test plan), wait for my approval, then build.
- **Money is integer cents** everywhere new (the old `Load.rate` is whole dollars: convert at the boundary and document it). Never float math on money.
- **AI never commits money or overwrites data silently.** Every ratecon/POD extraction lands in a review screen with per-field confidence and source snippets; a person clicks "Create load" / "Attach". Log every AI decision to `AuditLog`.
- **Access control follows the existing pattern:** every new route gets a `page-<key>` Cognito group via `RequirePage`, and write-sensitive finance actions are `ADMIN`-only, enforced server-side (Lambda/custom mutation), not only hidden in the UI.
- **Quality gate per phase:** `npm run build`, `npm run lint`, `npm run test` all green; Vitest unit tests for every pure calculation (rates, FSC, profit, aging buckets, settlements, commission, factoring advance/reserve, POD matching score); render tests for new pages; preview in the browser and screenshot the key screens. Update `CONTEXT.md` routes table and add a `Docs/POST-DEPLOY-RUNBOOK.md` entry for any secret, migration, or manual step.
- **Ask me when blocked on a business decision** (listed in "Open questions" below) rather than guessing.

## Reference: the Aljex load screen (what we use today)

This is a written description of the single long load-detail page in Aljex, top to bottom, using a real brokered load as the example. It is the field spec; the next section turns it into requirements.

**Row 1, two side-by-side panels**
- *Historical Rates* (left): quick filters "Yesterday, Last Week, Last 30 Days, Last 90 Days, Last Quarter, Last Year", then a two-column table (Linehaul | Rate) with rows Mileage Rate, Linehaul Average, Linehaul Low, Linehaul Median, Linehaul High, Linehaul Volume, Linehaul Miles. Example shows all rates 0.00, volume 1, miles 200: stats for this lane from past loads.
- *Roles* (right): dropdowns Sales Representative (example "IVAN CARTAGE CO - 005"), Service Representative (blank), Dispatcher Assigned (blank), Dispatcher Actual ("delbao"), then text fields Tariff and Quote (blank).

**Row 2, "More Information"**: tabs Instructions (selected), Rate Confirmation Notes, Notes, Ref #'s, Items, Updates, Route. The Instructions tab has two text areas: "Special Instructions & Rate Confirmation Notes" (counter "420 characters remaining") and "Bill of Lading Notes" ("260 characters remaining"); both empty in the example.

**Row 3, "Rates"**
- Customer row: Rate Type dropdown (Flat Rate), Hours (0.0, greyed out for flat), LH Rate $500.00, Total LH $500.00, FSC % 0.00, FSC/Mile $0.00, SMR $0.00.
- Carrier row: Rate Type (Flat Rate), Hours 0.0, LH Rate $0.00, Total LH $0.00, Pay % 0.00 (greyed), Max Rate $0.00.
- Accessorial table: columns Release | Carrier | Accessorial | $ Carrier | $ Customer, with a blue "+" to add rows. Example row: carrier IVAN CARTAGE CO, Line Haul, $0.00 carrier, $500.00 customer. Totals USD $0.00 / $500.00.
- Green-bordered summary box: "Net $500.00 | Profit 100.00%" (carrier cost is 0 because our own truck, Ivan Cartage, is hauling it).

**Row 4, "Carrier Information"**
- Carrier (link) "IVAN CARTAGE CO", MC # 274623, DOT # 547328, SCAC blank; insurance dates Cargo, Liability, Gen. Liab all 8/20/2027; Safety Rating SATISFACTORY; Carrier Email and Carrier Phone; an "Uncover" button.
- Dispatcher / Phone / Email; Driver 1 + Cell + Email; Driver 2 + Cell + Email.
- Truck #, Trailer #, Seal (checkbox + field), Carrier Ref #; Origin City* and Origin State* dropdowns (where the truck is empty from), Empty Miles, PU ETA (date/time picker).
- Confirm Sent, Confirm Rec, Dispatched (example "09/22/2026 23:00 CDT").
- "Add Available Truck" checkbox; buttons "Send Rate Conf" and "Send Info".

**Row 5, "Picks & Stops"** (buttons "Insert Pick", "Insert Stop"): one line per stop with sequence, type, facility, city/state/zip, ref #, and appointment window. Example:
1. Pick: ARTEK, INC., FORT WAYNE, IN 46808-4514, Ref #8709A, 09/23/2026 08:00 - …
2. Delivery: FIBERTEQ LLC, DANVILLE, IL 61834-9400, Ref # (blank), 09/23/2026 16:00 - …

**Row 6, "Documents"**: Public / Private tabs; table Document | File Type | download icon | delete icon. Example files "TQL RC-38497550.pdf" (the customer's ratecon: TQL is the broker/customer) and "POD-14471.pdf". Upload button with a file chooser.

**Row 7, "Check Calls"**: entry form with Origin City, State, Date and Time, Temperature, Note, Message (dropdown, "On Time"), EDI Reason (dropdown, "NORMAL STATUS - NS"), "Add Check Call" button, plus Next Chk Call Date And Time and Next Chk Call Note. History table columns: City, State, Reason, Temperature, Note, Entered By, Message, Check Call Date/Time, Created At (empty in example).

**Row 8, "Descartes MacroPoint"** tracking panel: Carrier Name (IVAN CARTAGE CO), Carrier ID (300000128), Partner Status (Telematics, with refresh icon), Truck/Trailer* (required, highlighted red: "IVAN CARTAGE COMPANY Keep Truckin…", i.e. the ELD feed), Cell Backup, Track Start (date/time), Duration ("33 Hours (2 Days)"), Interval ("Select Tracking Interval"), Order Status, Last Update; buttons Create, Update, Stop.

**Row 9, footer link menus**
- Customer Forms: Bill of Lading, Invoice, Pick Up Confirmation, Delivery Confirmation, Check Call Report, Customer Confirmation.
- Carrier Forms: Carrier Confirmation, Pick Up Information, Consignee Information, Issue Advance, View Advances.
- Shipment Opts: Enter Bids, Smart Search, Commission, Add AP Note, Add Invoice Note.

**What the example tells us about the business:** TQL tendered the load to BCAT with a ratecon (the PDF), the load was covered by our own asset company Ivan Cartage, the POD came back as a PDF, and Aljex treats our own fleet as a "carrier". Our TMS should handle both cases (own driver/truck vs outside carrier) natively, and a ratecon like "TQL RC-38497550.pdf" should be enough to build this whole load automatically.

## The load record (requirements)

Everything below must be representable on a load. Group it the same way in the UI (collapsible sections), but make it faster than Aljex: keyboard-first, autosave, inline validation.

**Header / Roles**
- Load #, customer, customer ref / PO / pickup #, BOL #, status (Quote → Tendered → Booked → Dispatched → At Pickup → Loaded → In Transit → At Delivery → Delivered → POD Received → Invoiced → Paid; plus Cancelled / TONU), mode (FTL/LTL/Partial/Power-only/Box truck/Amazon), equipment type, weight, pieces, commodity, temp (reefer set point), hazmat flag.
- Roles: **Sales Rep**, **Service Rep**, **Dispatcher Assigned**, **Dispatcher Actual**, Tariff, Quote #.
- Tags: **Revenue Division** (e.g. BCAT Logistics / Ivan Cartage / Amazon DSP, configurable), free tags.

**Picks & Stops** (ordered, unlimited; this is the existing `stops[]`, extend it)
- Type (pick/drop), linked **Location** (id), stop ref #s, appointment type (Exact / Window / FCFS / Need appt, reuse `apptStatus.ts`), window start/end, actual arrive/depart, pieces/weight per stop, stop instructions.
- "Insert Pick" / "Insert Stop" anywhere in the list; drag to reorder.

**Rates**
- Customer side: rate type (Flat / Per mile / Hourly / Per cwt), hours, LH rate, total LH, **FSC %**, **FSC per mile**, SMR (spot market rate reference).
- Carrier side (brokered loads): rate type, hours, LH rate, total LH, **Pay %** (for %-of-revenue carriers), **Max Rate** (buy ceiling).
- **Accessorial lines**: code (Line Haul, FSC, Detention, Layover, Lumper, TONU, Stop-off, Driver assist, etc., configurable), $ carrier, $ customer, a `+` to add rows. Totals USD for both sides.
- **Net $ and Profit %** always visible (the green box). Warn if margin < a configurable floor or carrier cost > Max Rate.
- **Historical Rates** panel: for this lane (origin → destination, city/state and 3-digit zip fallback), our past customer and carrier rates for Yesterday / Last Week / 30 / 90 days / Last Quarter / Last Year: mileage rate, LH average, low, median, high, volume, miles. Computed from our own loads.

**Carrier / Asset assignment**
- Either **own asset** (driver 1, driver 2, truck, trailer from `Driver`/`Equipment`) or **outside carrier** (new `Carrier` model: name, MC, DOT, SCAC, cargo/liability/general-liability insurance expirations, safety rating, dispatcher name/phone/email, payment terms, remit-to, factoring company, W-9 + COI docs, do-not-use flag). Block dispatch to a carrier with expired insurance.
- Per-load carrier fields: carrier dispatcher, driver 1/2 name + cell + email, truck #, trailer #, seal #, carrier ref #, empty-from city/state, empty miles, PU ETA, Confirm Sent, Confirm Received, Dispatched timestamp.
- Actions: **Send Rate Conf** (generate our carrier rate confirmation PDF and email it), **Send Info** (driver/dispatch info to customer), "Uncover" (drop carrier, back to available).

**More Information tabs**
- Special Instructions & Rate Confirmation Notes (420 char limit), Bill of Lading Notes (260 char limit), internal Notes, **Ref #s** (typed list: PO, BOL, PU#, delivery #, SO, customer load #, etc.), **Items** (description, qty, weight, class, dims), **Updates** (status timeline), **Route** (map of stops + miles).

**Documents**
- Public / Private tabs, upload (drag-drop, paste), download, delete (ADMIN or uploader). Types: Customer Ratecon, Carrier Ratecon, BOL, POD, Lumper receipt, Scale ticket, Invoice, Other. Stored in S3 under the load. POD upload flips status to POD Received.

**Check Calls**
- City, state, date/time, temperature, note, message (On Time / Late / Arrived / Loaded / Delivered…), EDI reason code, entered by, next check call due + note. Overdue next-check-calls appear on a dispatcher worklist. Auto check calls from Motive location pings for our own trucks.

**Tracking** (MacroPoint-style panel)
- For own trucks: live Motive position + ETA to next stop. For carriers: a provider interface (MacroPoint / Trucker Tools / driver-app link) with status, start, duration, interval, last update. Build the interface + a manual/SMS-link fallback now; real provider integration later.

**Forms (generated PDFs)**
- Customer: Bill of Lading, Invoice, Pick Up Confirmation, Delivery Confirmation, Check Call Report, Customer Confirmation.
- Carrier: Carrier Confirmation (our ratecon), Pick Up Information, Consignee Information, Issue Advance, View Advances.
- Shipment options: Enter Bids, Smart Search (find carriers who ran this lane), Commission, Add AP Note, Add Invoice Note.

## Locations (make these rock solid)

Locations are the backbone. Extend the existing `Location` model:
- Full address (street, city, state, zip, country), **lat/lng** (geocode via Google Maps, already used by the dashboard map), timezone, facility type (shipper/receiver/both/yard/truck stop), hours, appointment rules (FCFS/appt, lead time), dock notes, lumper/detention notes, **appointment contact** (already exists), general contacts, linked customers (many-to-many, not one `customerName` string), aliases.
- **De-duplication:** normalize address + fuzzy name match + geocode distance (< ~150 m) before creating; when a ratecon or form yields a location, show "Matches existing: X (98%)" with choose/create. Merge tool that repoints all loads/stops.
- Every stop stores the `locationId` plus a snapshot of the address at booking time (so later edits to a Location don't rewrite history).
- Location page: map, all loads in/out, average dwell time (from arrive/depart), detention history, notes.

## Ratecon → Load (auto-build)

Extend `amplify/functions/ratecon-parser` (it currently only returns pickup/delivery appt times) into a full extractor, keeping the existing `parseRateConfirm` behavior working for the Appts board.

- Input: PDF or image from upload, drag-drop on the Loads page, or email intake (`IntakeItem` with `s3KeyPdfAttachments` already exists; add a dedicated ratecon inbox if useful).
- Output (JSON schema, structured outputs): broker/customer name + MC, customer load/ref #, all reference numbers, every stop in order (type, facility name, full address, appointment date/time/window or FCFS, stop ref #s, contact, instructions), commodity, weight, pieces, equipment, temp, hazmat, total rate and **line items** (linehaul, FSC, accessorials), payment terms, quick-pay terms, special instructions, broker contact (name/email/phone), and a per-field `confidence` + `sourceText` quote.
- Use the current Claude model the repo already uses for parsing (check `claude-api` skill for model id/params); large multi-page ratecons must fit inside the AppSync 30 s limit, so make extraction **async** (S3 upload → Lambda → writes a `RateconExtraction` record → UI subscribes/polls) instead of a synchronous resolver.
- Resolve entities: customer → `Customer` (fuzzy + MC), facilities → `Location` (dedupe rules above), duplicate check against existing loads by customer + customer ref #.
- **Review screen:** side-by-side PDF viewer and prefilled load form, low-confidence fields highlighted, "Create load" button. Attach the ratecon to the load's documents automatically. Track accuracy: store what the user changed vs what was extracted so we can measure and improve prompts per broker.
- Seed a test fixture set: I'll drop sample ratecons (TQL, Batory, etc.) into `tests/fixtures/ratecons/`; build an eval script that runs the extractor over them and reports field accuracy.

## POD → Shipment matching

- Input: PODs from upload, email intake, or the driver app (photos, multi-page scans).
- Extract: every reference number visible (BOL, PO, PU#, load #, pro #), shipper/consignee names + addresses, delivery date, signature present (y/n), receiver name, exceptions (OS&D, shortages, damage notes, seal numbers).
- Match: score candidate loads by reference-number hits (strongest), consignee Location match, delivery date proximity, driver/truck. Auto-attach only above a high threshold with a unique winner; otherwise put it in a **Document Matching queue** with the top 3 candidates and reasons. Exceptions (OS&D, missing signature) flag the load and notify the assigned rep.
- Attaching a POD moves the load to POD Received and makes it invoice-ready (feeds the existing `readyToInvoice`).

## Money

**Customer invoicing**
- Invoice from one or many loads (consolidated invoices per customer), line items from customer rate + accessorials, required-docs rule per customer (e.g. POD + BOL + lumper receipt must be attached before it can be invoiced), invoice PDF with our branding and remit-to (or the factor's remit-to for factored invoices), email to customer billing contact with docs attached, invoice notes.
- Credit memos, short-pays, write-offs, partial payments, payment application (check #, ACH, date).
- **AR Aging**: buckets Current / 1-30 / 31-60 / 61-90 / 90+ by customer, by division, by sales rep; DSO; drill-down; export CSV. Customer credit limit + warning when a new load pushes them over.

**Factoring** (build on `src/features/factoring`, which today only tracks PROs emailed to ivanfactoring@)
- `FactoringCompany` config (name, advance %, fee % / fee schedule by days, reserve %, recourse window, remit-to, submission method).
- Mark invoices "factor" → build a **schedule of accounts** (batch) with invoice PDFs + PODs, export/email it; record advance received, fees, reserve held, reserve released, chargebacks/recourse. Factored invoices show the factor's remit-to.
- Reconciliation view: per batch, expected vs received. Feed the Cash Check-in factoring scenario with real numbers.
- Keep the existing email-driven queue working and link its rows to invoices.

**Carrier pay (AP)**
- Carrier bill from the load's carrier side, required docs (carrier invoice + POD), quick-pay option with fee %, carrier's factoring company remit-to, advances (fuel/comchecks: "Issue Advance" / "View Advances") deducted from the bill, AP notes, AP aging. Integrate with the existing Vendor AP queue rather than a second queue if it fits.

**Driver settlements**
- Every load assigned to our own driver creates settlement lines using that driver's pay setup (per mile, % of revenue, flat per load, hourly, per stop; team split for driver 2). Reuse `DriverPaySetting`, credits/debits, deductions and statement PDFs from the box-truck and Amazon pay pages; don't fork the math.
- Settlements are driver-tagged per load so a driver's statement is exactly the sum of their tagged loads + credits/debits.

**Commissions**
- Sales rep commission rules (% of gross margin or revenue, per customer overrides, paid on invoiced vs paid), commission report per period.

**Reporting**
- Dashboards filterable by division, sales rep, dispatcher, customer, carrier, driver, lane, date range: revenue, carrier/driver cost, margin $ and %, loads, RPM/CPM, on-time %, AR aging, top lanes. Plug into the existing Finances and Fleet Profitability pages rather than duplicating them.

## Map & driver app

- Map page: all active loads with stops and live truck positions (reuse `TruckLocation` + `@vis.gl/react-google-maps`), color by status, click through to the load.
- Driver app (later phase, design now): mobile-first PWA inside this repo (route group `/driver`, Cognito driver accounts), showing assigned loads, stop details + navigation link, status buttons (arrived/loaded/departed/delivered) that write check calls, document/POD capture with camera (feeds POD matching), location pings while on a load, settlement statements. Build the API surface in earlier phases so the app is just a client.

## Phases (each = branch, plan, approval, build, tests, preview, PR)

0. **Discovery & design doc**: audit the current code, produce `Docs/TMS_DESIGN.md` with the target data model (new models: `Carrier`, `LoadCharge`, `CheckCall`, `LoadDocument`, `RateconExtraction`, `DocumentMatch`, `Invoice`, `InvoiceLine`, `Payment`, `FactoringCompany`, `FactoringBatch`, `CarrierBill`, `Advance`, `Division`, `CommissionRule`, etc.; extended `Load`/`Location`/`Customer`), GSIs needed for the list/aging queries, migration plan from current `Load` fields, and the Aljex cut-over plan (CSV import of historical loads for rate history). Stop for my review.
1. **Locations & Customers upgrade**: address fields, geocode, dedupe/merge, many-to-many customers, stop `locationId` + snapshot, backfill existing loads' stops to Locations.
2. **Load record v2**: all fields above, roles, tags, rates + accessorials + profit box, carrier model + assignment, references, items, notes limits, documents public/private, check calls, status timeline. Load grid gets filters by every tag/role/status.
3. **Ratecon auto-build**: async extractor, entity resolution, review screen, eval script.
4. **Invoicing + AR aging + payments**.
5. **Factoring** (companies, batches, reconciliation) + **carrier AP / advances / quick pay**.
6. **Driver settlements from loads + commissions + reporting**.
7. **POD matching** + Document Matching queue.
8. **Tracking + map + generated forms** (ratecon/BOL/confirmations).
9. **Driver PWA**.

## Open questions to ask me before the relevant phase

- Exact list of revenue divisions and sales reps; commission rules.
- Which factoring company (OTR Solutions today?) and its advance/fee/reserve terms; do we factor only Ivan Cartage invoices or BCAT Logistics too?
- Are we replacing Aljex entirely, and do you have an Aljex export for historical loads/lane rates?
- Driver pay methods by fleet (per mile vs % vs flat) for local/OTR drivers not already covered by box-truck/Amazon pay.
- Required documents per customer before invoicing; invoice numbering format; payment terms defaults.
- Tracking provider preference (MacroPoint vs Trucker Tools vs our own driver app only).
- Accounting export target (QuickBooks Online?) for invoices/bills/payments.

Start with Phase 0 now: read the code listed under Ground rules, then write `Docs/TMS_DESIGN.md` and stop for my review.
