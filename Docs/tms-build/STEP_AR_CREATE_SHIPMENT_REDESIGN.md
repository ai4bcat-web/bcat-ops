# Step AR — Create shipment: modern flow and layout (replaces the 12-accordion page)

Ryne, 2026-11-05: "Can you come up with a way to make the UI and UX flow better? It looks kind of
archaic. Would like to make it more modern and make everything fit better together."
Dev only. Builds on Step AH (field parity, Bill To block, miles auto-calc, intake prefill) and the
S1 kit. Keep every field, mapping, pipeline, validation rule and test fixture from AH; this step
changes the page's structure, order and visual rhythm, not the data model.

## Why it feels archaic
- Twelve accordions stacked in Aljex's order force the user to scroll a long column and open/close
  panels to see what they typed. Nothing on screen summarizes the load while it is being built.
- Section order follows Aljex's database layout (requirements first, customer third, rates eighth),
  not the way a rep thinks: who → where and when → what → money → who moves it.
- Seventeen boolean checkboxes, six-wide field grids with empty halves, and section headers in
  boxes read as a 2005 form. Edit-only concerns (check calls, documents, historical rates) sit in
  the create flow.

## Target layout (desktop ≥ 1280)

```
┌ Shipments / New shipment                         [Division ▾] [Truckload ▾]  Draft · PRO 14913 ┐
├──────────────────────────────────────────────┬────────────────────────────────────────────────┤
│ 1  CUSTOMER                                  │  SUMMARY (sticky)                              │
│    [Customer type-ahead……………]  Ref # [……]    │  Acme Foods · Net 30 · Factored                │
│    Contact ▾  Phone  Email 1  Email 2        │  Chicago, IL → Dallas, TX   912 mi · 2 days    │
│    ┌ Bill To (read-only) ───────────────┐    │  Dry van · 42,000 lb · Food grade              │
│    │ Terms · Factor · Billing e-mails    │    │  ────────────────────────────────────────      │
│    │ Credit limit · Available            │    │  Customer   $2,400.00                          │
│    └─────────────────────────────────────┘    │  Carrier    $1,900.00                          │
│                                              │  Net $500.00   Profit 20.8%  ●                 │
│ 2  ROUTE                                     │  ────────────────────────────────────────      │
│    ● Pickup   Acme DC, Chicago IL            │  Required  6 / 8                               │
│      Ready Nov 7 08:00–14:00 · Appt · Ref    │   ✓ Customer   ✓ Pickup   ✓ Ready              │
│      Contact · Hours · Note                  │   ✓ Equipment  ✓ Weight   ✓ Description        │
│    + Add pickup   + Add delivery             │   ○ Revenue type   ○ Consignee                 │
│    ● Delivery Kroger, Dallas TX              │  ────────────────────────────────────────      │
│      Must deliver Nov 9 · Appt · Ref         │  Sales rep ▾   Dispatcher ▾                    │
│                                              │                                                │
│ 3  FREIGHT                                   │  [ Save draft ]        [ Create shipment ]     │
│    Equipment ▾  Revenue type ▾  Weight  Pcs  │                                                │
│    Description……  Class ▾  Declared value    │                                                │
│    Requirements: [Hazmat] [Team] [Tarps] …   │                                                │
│    (chip toggles; Temp / Tarps / Pallets     │                                                │
│     reveal their sub-fields inline)          │                                                │
│                                              │                                                │
│ 4  RATES                                     │                                                │
│    Customer: Type ▾  LH rate  Total  FSC     │                                                │
│    Carrier:  Type ▾  LH rate  Total  Max     │                                                │
│    Accessorials  + line   (Carrier/Customer) │                                                │
│                                              │                                                │
│ 5  CARRIER  (collapsed card)                 │                                                │
│    "No carrier yet" · [Cover] [Assign…]      │                                                │
│    Ivan Cartage division: Driver/Truck picker│                                                │
│                                              │                                                │
│ More ▸  Instructions · References · Items ·  │                                                │
│         Notes · Documents · Rate history     │                                                │
└──────────────────────────────────────────────┴────────────────────────────────────────────────┘
```

### Header bar
- Breadcrumb, title (New shipment / Edit PRO 14913), **Division** and **Mode** pills (replace the
  Office / Mode / Revenue-division fields buried in Shipping Requirements; Revenue Type stays in
  Freight because it is a tag, not a division), status chip (Draft / Active …), PRO preview
  (next counter value, read-only; actual number minted on Create).

### Main column: five cards, in build order
1. **Customer** — type-ahead; choosing a customer fills Bill To (read-only block from AH), default
   equipment, standing requirements, sales rep, and the two billing e-mails. Two e-mail fields only.
2. **Route** — stops as a vertical timeline, one card per stop. Each card: Location type-ahead
   (fills address, hours, contact), appointment / ready window with date + time pickers, Ref #,
   note; "+ Add pickup / + Add delivery" between cards; drag handle to reorder; delete with undo.
   Lane header above the timeline: origin → destination, Customer miles / Truck miles (AH
   auto-calc, override on click), transit estimate. Maps onto the existing Stop rows; the Pick Up /
   Consignee / Picks & Stops sections of AH collapse into this one card.
3. **Freight** — Equipment, Revenue Type, Weight (+ billable), Pieces, Footage, Description,
   Freight Class, Declared Value, Customer Ref. **Requirements chip bar** replaces the checkbox
   grid: Hazmat, Team, Tarps, Liftgate, Inside, Temp control, Pallet exchange, Permits, FSMA,
   Oversized, Escorts, Seal, Blind, Customs bonded, OSD, Straps/Chains, No broker, Hot, Labor,
   High risk, Mass release, TONU. Selecting Temp control / Tarps / Pallet exchange reveals their
   sub-fields inline under the bar. "Calculate totals from picks" and "Disable mileage" become
   small toggles at the card foot.
4. **Rates** — two compact rows (Customer, Carrier) with Rate Type, Hours (per-hour only), LH Rate,
   Total LH, FSC % / FSC per mile, SMR; Pay % / Max Rate on the carrier row; accessorial lines
   with Release / Carrier / Accessorial / $Carrier / $Customer and "+ line". Net and Profit % move
   to the summary rail (live). Same LoadFinancials + LoadCharge mapping as AH.
5. **Carrier** — collapsed by default: "No carrier yet" with **Cover** (Step AM ladder) and
   **Assign** (directory type-ahead / Find & Invite). When set, expands to the AH carrier block
   (MC/DOT/SCAC, insurance read-only from MCP, dispatcher, drivers, truck/trailer, origin
   city/state, empty miles, PU ETA, Confirm Sent/Rec/Dispatched, Send Rate Conf / Send Info). For
   the Ivan Cartage division this card is the Step W driver + truck picker instead.

### "More" strip (secondary tabs under the fifth card, not accordions)
Instructions (Special Instructions & Rate Con Notes 420 chars, BOL notes 260), References,
Items, Notes, Documents (upload; Public / Private), Rate history (Step AE lane history: yesterday,
last week, 30/90 days, quarter, year; linehaul vs rate). Check Calls preview and Updates appear
only in edit mode (Load Tracking preview per AH feedback 5), never on create.

### Summary rail (sticky, right, 360 px)
- Customer line (name · terms · factored), lane line (origin → destination · miles · transit),
  freight line (equipment · weight · description).
- Money block: Customer total, Carrier total, **Net $ and Profit %** with a dot colored by the
  margin rule (green ≥ target, amber within 5 pts, red below).
- **Required checklist**: "6 / 8" with each required field as a row; clicking a row scrolls to and
  focuses the field. Required inputs keep AH's green border treatment; missing ones turn amber
  only after the user attempts Create.
- Roles: Sales rep, Service rep, Dispatcher assigned/actual, Tariff, Quote link (compact selects).
- Actions pinned at the rail foot: **Save draft** (always enabled, autosaves every 10 s to the
  existing draftStore) and **Create shipment** (enabled when required fields pass; on block, the
  rail checklist and inline errors show what is missing). Edit mode: Save / Discard.
- Below 1280 px the rail becomes a collapsible bottom sheet with the money line and actions.

### Smart entry
- Customer and Location type-aheads show the five most recently used first.
- Paste or Intake prefill (AH feedback 7) marks prefilled fields with a small "from e-mail" tag;
  clearing the tag accepts the value.
- Keyboard: Tab order top-to-bottom in the main column, then the rail; ⌘/Ctrl+Enter = Create,
  ⌘/Ctrl+S = Save draft, Esc closes any inline picker.

### Visual rules (S1 tokens)
- 8 px grid; inputs 32 px tall; labels 11 px caps muted above the input; card padding 16 px; card
  = 1 px border, 8 px radius, no header boxes; section number in a 20 px circle before the title.
- Field grids size to content (2, 3 or 4 columns) so no card has an empty half.
- One accent for primary action, neutral grays otherwise; status/margin via dot + text, no fills.
- Dense mode (Step AC) still applies: nothing wider than the viewport, no horizontal scroll.

## Behaviour that must not change
- Required fields, Intake and Load Review gates, PRO numbering, CREATE_SHIPMENT + SAVE_ORDER_FORM
  + stops + charges in one action, draft save, edit reuses the page, Aljex wording on labels with
  our underlying name as help text, miles auto-calc and override, Bill To read-only block.
- Every AH test fixture and the AH5 test kit keep passing (update selectors, not behaviour).

## Done when
- New layout live on dev; Shipments board "Create shipment" and Intake "Create shipment" both open
  it; edit mode of an existing shipment uses it.
- Walkthrough screenshots of create (brokered) and create (Ivan Cartage with driver) at 1440 and
  1280 widths added to `Docs/tms-build/aljex-create/` and referenced in DEMO_WALKTHROUGH.md.
- BUILD_LOG entry "## Step AR deployed" with the deploy job number.

## Ryne's feedback 2 (2026-11-05, before the first cut was reviewed)
"On creating a shipment, can you make documents its own section. Can you make the bill to section
more clear with more details about the specific customer. Can you add a tracking section that pulls
details from the tracking page at a high level. Can you also add a historical section that pulls
what we recently ran a specific lane for and also what the DAT RateView rates are showing for that
lane. Should be another high level section."

Main column becomes **eight cards**, still in build order; the More strip keeps only
Instructions · References · Items · Notes.

1. Customer
2. **Bill To** — its own card directly under Customer, read-only, filled on customer select. Show,
   in a 3-column detail grid with labels: Bill-to name and billing address; payment terms (Net N)
   and credit limit / open AR / available credit (from Customer v2 + the Open AR rollup used on
   the Customers page); factoring status (Factored via OTR / Not factored) with the factor's
   notice-of-assignment flag; billing e-mails (both) and billing contact + phone; invoicing
   requirements (POD required, PO/ref required, per-customer required fields from Step AP);
   customer status ladder badge (ACTIVE / CREDIT HOLD / NEW) and a "credit hold" warning strip
   when the shipment's customer total would exceed available credit. Link "Open customer".
3. Route
4. Freight
5. Rates
6. **Rate history** — high-level card for the lane in the Route card (origin → destination
   metro/zone, Step AE lane matching), two side-by-side blocks:
   - **What we ran it for**: last 5 shipments on this lane (PRO, date, customer, equipment,
     customer rate, carrier rate, margin), plus averages for 30 / 90 days and last year; link
     "All lane history".
   - **DAT RateView**: spot and contract low / average / high for the lane and equipment, with
     the date DAT last refreshed. While the DAT service login is missing, the block renders the
     stub with a plain `DAT not connected` badge and a Settings → Integrations link, never a
     fake number.
   One line of "suggested rate" from the Step AE rate intelligence under the two blocks.
   Recomputes when stops or equipment change.
7. Carrier
8. **Tracking** — high-level read-only card pulled from the Load Tracking page for this load:
   status chip, tracking method / mode (SMS, link, Motive, carrier check calls) and assignee,
   last known position + time, ETA to next stop, last check call (time, city/state, note), next
   check call due, POD status; "Open in Load Tracking" link. On create, before the load exists,
   it shows the planned setup: the customer's default tracking mode and method, auto e-mail/text
   settings that will apply (Step V), and "Tracking starts when the load is covered". This card
   replaces the AH "Check Calls preview" item.
9. **Documents** — its own card (not in the More strip): upload drop zone, Public / Private tabs,
   list with type, name, uploaded by/when, preview; "Required for release" checklist (rate con,
   BOL/POD, carrier invoice) with ticks as documents arrive. Works on create (attach the tender
   or rate con before the shipment exists; held in the draft and written as ShipmentDocument on
   Create).

Summary rail unchanged. Required-field, mapping and fixture rules unchanged.

## Ryne's feedback 3 (2026-11-05 evening, screenshot aljex-create/32-more-strip-feedback.webp)
"Let's move the instructions and this piece to be right below carrier."
The More strip (Instructions · References · Items · Notes tabs, with the Special Instructions &
Rate Confirmation Notes, Rate Confirmation Notes and Bill of Lading Notes textareas) moves from the
bottom of the page to directly under the **Carrier** card, before Tracking. New main-column order:
Customer, Bill To, Route, Freight, Rates, Rate history, Carrier, **More strip**, Tracking, Documents.
Nothing else changes.

## Ryne's feedback 4 (2026-11-05 evening, screenshot aljex-create/33-roles-remove-fields.png)
"Let's remove these fields": **Dispatcher Actual**, **Tariff** and **Quote** come off the summary
rail's Roles block. Roles keeps Sales Representative, Service Representative and Dispatcher
Assigned only. Keep the underlying fields in the model and mapping (quote-to-shipment conversion
still links the Quote row on its own path; dispatcher-actual keeps being stamped by tracking);
they are simply no longer shown or editable on the create/edit form.

## Ryne's feedback 5 (2026-11-05 evening, screenshot aljex-create/34-rail-activity-feedback.png)
"Let's also show a summary of the audit log, who entered what (agent or user's name) and what they
did and what stage the shipment is in."

New **Activity** block in the summary rail, between the Required checklist and Roles:
- **Stage** line at the top: a chip with the shipment's current stage and a compact stepper
  (Draft → Intake review → Active → Covered → In transit → Delivered → Load Review → Billed →
  Paid; Voided shown as a red chip). On create before the row exists: `Draft — not created yet`.
  Stage comes from the same status ladder the Shipments board and Load Review use.
- **Recent activity**: the last 8 AuditLog entries for this shipment (and its Load / Intake item),
  newest first, one line each: relative time · **actor** · action · detail. Actor is the user's
  display name for a person, or `AI agent · <agent name>` (Intake extractor, Tracking agent, Rate
  con AI, AP inbox sync …) for an automation, or `System` for scheduled jobs. Action is plain
  language ("set customer rate $2,400", "covered with Ivan Cartage", "uploaded POD", "extracted
  12 fields from e-mail"). Field-level edits that AH already records (who changed what, old → new)
  show the field name and new value; hover shows old value.
- Fields prefilled from an Intake e-mail appear here as the extractor's entries, so the reviewer
  sees what the agent entered versus what a person typed; this complements the "from e-mail" tags
  on the fields.
- "Full history" link opens the shipment's audit page (existing AuditLog view) filtered to this
  shipment.
- Edit mode shows live data; the block refreshes after each save. Reads go through the existing
  AuditLog GSI by entity id, no new table.

## Ryne's feedback 6 (2026-11-05 evening)
"Let's move freight section to be above the route section." Main-column order becomes:
Customer, Bill To, **Freight**, **Route**, Rates, Rate history, Carrier, More strip, Tracking,
Documents. Tab order follows. Nothing else changes.

## Ryne's feedback 7 (2026-11-05 evening)
"Let's put the customer and bill to in the strip at the top where division is and let's move the
freight section to be right below it. Also move the shipment type to be in the freight section
and add a lot more shipment types."

**Header strip** (full width, sticky with the page title) now holds, left to right:
Division pill · **Customer** type-ahead (same behaviour as the old Customer card: fills defaults,
rep, requirements, e-mails) · **Bill To** summary chip: bill-to name · terms · Factored / Not
factored · available credit, coloured amber on credit hold · a "Details" chevron that drops the
full Bill To panel (everything from feedback 2: address, credit limit / open AR / available,
billing e-mails + contact, invoicing requirements, status badge, credit-hold warning) under the
strip, collapsed by default · status chip · PRO preview. The Customer card and the Bill To card
leave the main column. Customer contact / phone / two e-mails / Ref # move into the dropped-down
Bill To panel as a "Customer contact" column.

The **Mode** pill leaves the header: it becomes **Shipment type** as the first field of the
Freight card.

**Main column order**: Freight, Route, Rates, Rate history, Carrier, More strip, Tracking,
Documents.

**Shipment type** select (Freight card, required, default per division — Truckload for BCAT
Logistics and Ivan Cartage, Auto transport for Auto Shipping, Power only for Owner Operators):
Truckload (FTL) · LTL · Partial / Volume · Expedited · Hot shot · Team · Power only · Drayage ·
Intermodal (rail) · Rail carload · Air freight · Ocean FCL · Ocean LCL · Auto transport (open) ·
Auto transport (enclosed) · Heavy haul / Oversize · Flatbed specialized · Refrigerated / Reefer ·
Hazmat · Final mile · Dedicated · Cross-border (Mexico) · Cross-border (Canada) · Courier / Parcel ·
Other. Types are a constant list in `constants.ts` so more can be added; the Shipments board
filter, Intake extractor and the quote → shipment path read the same list. Picking a type sets a
sensible default equipment and requirement chips (Reefer → temp control on; Hazmat → hazmat chip;
Auto transport → equipment Auto carrier, pieces = vehicle count) which the user can change.
