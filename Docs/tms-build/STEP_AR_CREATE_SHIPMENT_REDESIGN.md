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

## Ryne's feedback 8 (2026-11-05 evening, screenshots aljex-create/35-37)
"These are redundant. Let's combine it into one in the freight section. Same with division and
revenue type."
- **Revenue Type renders twice** on the form (screenshots 36 and 37, two green selects with the
  same "Revenue division (ownership tag)" help text). Keep exactly one.
- **Division (header pill) and Revenue Type are the same thing** (the revenue division /
  ownership tag: Ivan Cartage, BCAT Logistics, Auto Shipping, Owner Operators). Collapse them into
  ONE required field named **Division** in the Freight card, placed first, before Shipment type.
  Remove the Division pill from the header strip and both Revenue Type selects. The single field
  writes both underlying values (division and the revenue tag) so the Shipments board tabs, Load
  Review, commissions and the rate-con logo keep reading what they read today.
- Shipment type's per-division default now keys off this field; changing Division re-applies the
  default only if the user has not picked a type by hand.
- Equipment stays its own field (not redundant with Division); it sits after Shipment type.
Freight card field order: Division · Shipment type · Equipment · Weight / Billable · Pieces ·
Footage · Description · Freight class · Declared value · Customer Ref · requirement chips.

## Ryne's feedback 9 (2026-11-05 evening)
"For tracking, let's make the tracking mode case by case instead of hard coded by customer. It
should be selected when a carrier is booked in either the carrier section of new shipment or in
the carrier sales page. You can merge tracking and carrier together into one section."

- **Tracking mode is chosen per load, at booking time**, not inherited from the customer. The
  customer's default (Step V / AJ) becomes a suggestion only: it pre-selects the control but the
  user confirms it when the carrier is booked.
- **Where it is chosen**: (a) the Carrier card of the create/edit form, and (b) the Cover /
  booking step on the Carrier Sales page (Step AM ladder, state where the carrier is assigned).
  Both use the same **TrackingModeControl**: Mode (Automated / Manual / None) and Method (SMS to
  driver, tracking link, Motive / ELD, carrier check calls, e-mail), check-call cadence, auto
  e-mail / text toggles for the customer (Step V settings), tracking assignee. Booking a carrier
  without confirming tracking mode leaves a "Tracking mode not set" amber chip on the load in
  the Shipments board and Load Tracking, and the rate con is not blocked.
- **Carrier and Tracking merge into one card** named **Carrier & Tracking** in the main column
  (where Carrier sat). Top half: the carrier block as specified (lookup card, Cover / Assign,
  carrier details, dispatcher, drivers, truck/trailer, origin, ETA, confirm timestamps, Send Rate
  Conf / Send Info; Ivan Cartage division shows the roster picker). Bottom half: the
  TrackingModeControl, then the high-level tracking read (status, method, assignee, last position,
  ETA, last / next check call, POD, "Open in Load Tracking"). Before a carrier is booked the
  bottom half shows "Tracking is chosen when the carrier is booked" with the suggested mode
  greyed. The separate Tracking card is removed.
- Main column order: Freight, Route, Rates, Rate history, Carrier & Tracking, More strip,
  Documents.
- Data: tracking mode / method / cadence are stored on the Load (they already exist from V / AJ
  for the per-load override); the customer-level default stays as the suggestion source. Load
  Tracking reads the per-load value first. Carrier Sales booking writes the same fields through
  the same Lambda action.

## Ryne's feedback 10 (2026-11-05 evening, screenshot aljex-create/38-freight-alignment.webp)
"Make sure the whole page is symmetrical. Some sections have text fields that don't fit. Remove
the things in parentheses if it will help."

Layout rules for EVERY card (enforce in one shared field-grid component, not per card):
- One 12-column grid per card, 16 px gutters; each field declares its span (2 / 3 / 4 / 6 / 12);
  every row sums to 12 so there is no ragged right edge and no empty half.
- Every field has exactly the same vertical rhythm: label (one line, 11 px caps, fixed height)
  → input (32 px) → nothing underneath. **No inline help text under inputs.** Help text moves to
  an ⓘ tooltip on the label (and `title` on the input). The only exception is the character
  counter on the three notes textareas, which gets a fixed-height row.
- Labels never wrap: shorten them instead ("Billable wt", "Declared value", "Customer ref").
- Drop parentheticals everywhere: option labels ("Truckload", not "Truckload (FTL)"; "Ocean FCL"
  stays since it is the name), labels ("Revenue type", help text gone), chip labels unchanged.
- Rows align across the card: inputs in the same row share one baseline; no field may be
  taller or offset because of a longer label or help text (the Revenue Type offset in the
  screenshot is exactly this).
- Chips wrap in a flex row with 8 px gaps; the Calculate / Disable mileage controls sit in one
  32 px toolbar row at the card foot, right-aligned.
- Cards share the same padding (16 px), title row (number circle + title, 40 px), and bottom
  margin (16 px). The rail uses the same label/input rhythm.
- Check at 1440 and 1280: no horizontal scroll, every row flush left and right, screenshot both
  into aljex-create/ after the change.
Freight card rows at 1440: [Division 3 · Shipment type 3 · Equipment 3 · Weight 3] /
[Billable wt 3 · Pieces 3 · Footage 3 · Freight class 3] / [Description 6 · Declared value 3 ·
Customer ref 3] / [Requirement chips 12] / [toolbar 12].

## Ryne's feedback 11 (2026-11-05 evening)
"In the customer strip, make sure to also include customer reference number (PO)."
The header strip gains a **Customer ref (PO)** text input right after the Customer type-ahead
(before the Bill To chip). It is the same value as Freight's Customer Ref field: show it in the
strip only and remove it from the Freight card (Freight rows become [Division 3 · Shipment type 3 ·
Equipment 3 · Weight 3] / [Billable wt 3 · Pieces 3 · Footage 3 · Freight class 3] /
[Description 9 · Declared value 3] / chips / toolbar). Required-ness follows the customer's
per-customer requirements (Step AP): when the customer requires a PO, the strip input turns green
and the rail checklist lists "Customer ref".

## Ryne's feedback 12 (2026-11-05 evening)
"In the same strip at the top where the customer is, can you put a timeline that shows a truck
with the checkpoint for where it is in delivery? On site, departed, in transit, on site at
delivery, delivered. Some little illustration line graph would be nice."

**Delivery timeline** in the header strip, right-aligned (takes the right third of the strip at
1440; wraps to a second strip row at 1280):
- Five checkpoints on one horizontal line, left to right: **On site** (at pickup) · **Departed**
  · **In transit** · **On site** (at delivery) · **Delivered**. Each checkpoint is a small dot with
  its label underneath; reached checkpoints and the line segment behind them are filled in the
  accent green, upcoming ones are grey.
- A small **truck icon** (inline SVG from the kit, ~20 px, facing right) sits on the line at the
  current checkpoint; between checkpoints it sits mid-segment (In transit shows it midway with a
  faint motion line). Hover on the truck shows the last position / time from tracking; hover on a
  reached checkpoint shows the timestamp and who recorded it.
- Multi-stop loads: the line still shows the five phases; "On site" / "Departed" refer to the
  current stop, and a "Stop 2 of 4" caption appears under the truck.
- Before the load is covered the line is all grey with the truck parked at the far left and the
  caption "Not dispatched"; on create (no row yet) it renders greyed with "Draft".
- Source: the stop-event timestamps already written by Load Tracking / check calls (arrived at
  pickup, departed, in transit position updates, arrived at delivery, delivered / POD). Phase
  derivation lives in one helper (`deliveryPhase.ts`) shared with the Shipments board, which
  gets the same mini timeline as an optional column.
- Exceptions: a late / exception flag from tracking turns the truck amber and shows the reason
  on hover. Voided loads show the line struck through.

## Ryne's feedback 13 (2026-11-05 evening)
"We can remove billable wt. We can remove customer miles and truck miles. It should just say miles
and it should calculate based on zip codes to and from and add all miles if there are multiple
picks and drops."
- **Billable weight** is removed from the form (field stays in the model for imported Aljex rows;
  not shown or editable). Freight rows: [Division 3 · Shipment type 3 · Equipment 3 · Weight 3] /
  [Pieces 3 · Footage 3 · Freight class 3 · Declared value 3] / [Description 12] / chips / toolbar.
- **Customer miles and Truck miles collapse into one field: Miles**, shown in the Route card's
  lane header (read-only display with a pencil to override). It is computed from the **zip codes
  of the stops in order**: pickup 1 → pickup 2 … → delivery n, each leg zip-to-zip, all legs
  **summed**. Legs use Distance Matrix when the server key answers, else the geocode / straight
  line × 1.2 estimate already in `milesEstimate.ts`; recomputes whenever a stop zip changes or
  stops are reordered / added / removed. An override sticks until the user clears it (then it
  recomputes). The single value writes both underlying miles fields (customer and truck) so
  per-mile rates, FSC per mile, margin and reports keep working. "Disable mileage" stays as the
  only toggle; "Calculate totals from picks" stays.
- Rates card: the per-mile rate type reads this Miles value; the summary rail shows it in the
  lane line.

## Ryne's feedback 14 (2026-11-05 evening)
"If a location does not exist, you should have the ability to add the location right from the
pickup or delivery area so you can save it for future."
- In every stop card's Location type-ahead, when there is no match the last row of the dropdown
  is **"+ Add '<typed text>' as a new location"** (also reachable with Enter on no match).
- Choosing it turns the stop card's address block into an inline **new-location form** (name,
  address, address 2, city, state, zip, country, contact, phone, e-mail, hours, appointment
  required yes/no, location type Shipper / Receiver / Both, notes) prefilled with whatever was
  typed; the zip auto-fills city / state from the geocoder; **Save location** writes a Location
  row through the existing directory create action, geocodes it, and selects it for the stop.
  **Use once** keeps the address on the stop without creating a directory row (for one-off
  addresses). Cancel returns to the type-ahead.
- A location saved this way is immediately available in other stop cards, the Locations page
  and future shipments; it carries `createdFrom: shipment <PRO or draft id>` for the audit.
- Duplicate guard: before saving, match on normalized name + zip and on address + zip; if one
  exists, offer "Use existing <name>" instead of creating a twin.
- The same inline add works in edit mode and in the Intake prefilled form (extracted stop
  addresses that match no location show the add row pre-selected).

## Ryne's feedback 15 (2026-11-05 evening)
"You should also be able to add multiple carriers onto a shipment and choose what accessorial each
carrier should be paid on. If there are multiple carriers on a shipment it should also create
multiple AP records."

- **Carrier & Tracking card holds a list of carriers** (LoadCarrier rows already exist; make
  them first-class). "+ Add carrier" appends another carrier block; each block has the full
  carrier section (lookup card, Cover / Assign, details, dispatcher, drivers, truck / trailer,
  origin, ETA, confirm timestamps, **Send Rate Conf** for that carrier only) plus the
  TrackingModeControl and tracking read for that carrier. Optional **Legs** on each carrier:
  which stops it covers (defaults to all; for transloads / multi-leg pick the stop range), so
  tracking and the delivery timeline know which carrier is moving the load at each phase. Ivan
  Cartage division: one of the "carriers" can be the own fleet (driver + truck), alongside
  brokered carriers for other legs.
- **Rates card**: one **Carrier rate row per carrier** (Rate Type, LH Rate, Total LH, Pay %, Max
  Rate), labelled with the carrier name. **Accessorial lines gain a "Paid to" column**: a select
  listing the carriers on the load plus "Not paid to a carrier" (customer-billed only), so each
  accessorial is assigned to exactly the carrier that earns it; "$Carrier" on the line is the
  amount paid to that carrier. A line can be billed to the customer and paid to a carrier, billed
  only, or paid only. Totals: Carrier total = sum over carriers; Net / Profit in the rail use it.
- **Rate con per carrier** contains only that carrier's linehaul and its assigned accessorials;
  the e-mail thread / tracking address stay per shipment, the rate con document is per carrier.
- **AP: one carrier bill (AP record) per carrier** on release, each with its linehaul + assigned
  accessorials; Load Review shows the bills side by side and will not release while any carrier
  on the load lacks a rate; AP inbox sync (AG) matches invoices to the right bill by carrier +
  PRO; factoring / quick pay act per bill; AP aging and the accountant CSV list each bill.
- Reporting / commissions: margin is customer total minus the sum of carrier bills; Shipments
  board "Carrier" column shows "2 carriers" with hover list; existing single-carrier loads are
  simply a list of one, nothing migrates.

## Ryne's feedback 16 (2026-11-05 evening)
"There should be an area to generate a BOL once the shipment is saved."
- **Documents card gains a "Generate" row** at its top, enabled once the shipment exists (after
  Create / in edit mode): **Generate BOL** (first), plus the existing Rate Con and Send Info as
  secondary buttons so every generated document lives in one place.
- **BOL content**: division logo + legal name / address / phone, BOL number = PRO, date;
  Shipper (pickup location, address, contact, phone, ready / appt), Consignee (delivery location,
  same fields), Bill To (from the header strip); Customer ref (PO) and all References; carrier
  name, MC, driver, truck / trailer, seal; freight lines from Items (or one line from Description
  / Weight / Pieces / Freight class / Hazmat / Declared value when Items is empty); Bill of Lading
  Notes (260 chars) and Special Instructions; requirements chips as a line (Hazmat, Temp control
  with range, Tarps …); signature blocks for Shipper, Carrier / Driver, Consignee with date / time
  and "received in good order" piece count; multi-stop: one BOL per delivery stop (stop range in
  the title) or a master BOL listing all stops, chosen in the dialog.
- **Flow**: dialog previews the PDF (same renderer as the rate con), options: per-stop vs master,
  include rates No (default) / Yes, language note; **Generate** stores it as a ShipmentDocument
  (type BOL, Public), stamps the audit (actor, time) and ticks "BOL" in the required-for-release
  checklist; **Download** and **E-mail** (to pickup contact, carrier dispatcher, driver — recipient
  picker like the rate con, sent through the shipment's thread) from the same dialog.
  Regenerating creates a new version and keeps the old one listed as superseded.
- BOL is required for release only if the customer's requirements say so (AP per-customer
  requirements); otherwise it is optional and the checklist shows it as optional.

## Ryne's feedback 17 (2026-11-05 evening)
"Let's remove the typed name only from the create shipment."
Remove the **"Typed name only"** checkbox from the header strip's Customer control
(`CustomerCard.tsx`, `f-customer-useTyped`). A shipment's customer must be picked from the
directory; on no match the dropdown's last row is **"+ Add '<typed>' as a new customer"**, which
opens the existing Customer create dialog prefilled with the name and selects the new customer on
save (same pattern as the inline location add in feedback 14). The `useTyped` / `typedName` path
stays only for Intake-extracted rows that have not been matched yet, shown there as a "Customer
not matched" chip, never as a checkbox on the form.

## Ryne's feedback 18 (2026-11-05 evening)
"Let's move the rate history to display on the right side where the summary is."
The **Rate history** card leaves the main column and becomes a block in the **summary rail**,
placed directly under the money block (Customer / Carrier / Net / Profit) and above Activity.
Rail order: Summary header · Money · **Rate history** · Required · Activity · Roles · actions.
Compact form for the 360 px rail: lane line (origin → destination · equipment); "We ran it"
as a 5-row mini table (date · customer rate · carrier rate · margin %, hover = PRO + customer)
with a 30 / 90 / 1y average line under it; "DAT RateView" as one line each for spot and contract
(low · avg · high) or the `DAT not connected` badge; the AE suggested rate as the last line with a
"Use" link that fills the customer LH rate. "All lane history" link at the foot. Collapsible with
the state remembered per user like the cards. Main column order becomes: Freight, Route, Rates,
Carrier & Tracking, More strip, Documents.
