# Step AH — Create shipment: Aljex field parity, our UI and backend

Ryne, 2026-11-04. Dev only. Reference screenshots: `Docs/tms-build/aljex-create/23..27.webp`.

## Bug first
The **Create shipment** button on the Shipments board opens the admin utility "Mint a Shipment for a
load that does not have one" (screenshot 23). That utility belongs under Settings > Data, not the
Create button. The button must open the real create-shipment form below.

## Form: same sections and fields as Aljex's New Truckload Shipment, rendered in our kit
Keep our data model and Lambdas (CREATE_SHIPMENT, SAVE_ORDER_FORM, stops, charges, LoadCarrier,
check calls, documents); add fields only where we have no home for them (store extras on the order
form JSON and promote later). Collapsible sections in this order:

1. **Shipping Requirements** — Mode (Truckload default; LTL/Air/Ocean), Equipment*, Revenue Type*
   (= rev division / tag), Office, Customer Miles, Truck Miles, Footage, Pieces, Weight*, Billable
   Weight, "Calculate totals from picks", Disable Mileage, Freight Class, Description*, Declared
   Value, Liftgate, Inside; Temp Control (type F/C, min, max, pre-cool); Pallet Exchange (in/out);
   Tarps (size); flags: Permits, FSMA, Oversized, Hazmat, Escorts, Seal, Blind, Customs Bonded, OSD,
   Straps/Chains, No Broker, Team, Hot, Labor, High Risk, Mass Release, TONU.
2. **Customer** — Name* (type-ahead to Customer directory), Address, City, State, Zip, Country,
   Contact, Phone, Hours, up to 6 e-mails, Ref #. Bill-to defaults from the customer.
3. **Pick Up** — Name* (Location type-ahead), Address, Address 2, City, State, Zip, Country, Contact,
   Phone, Hours, Email, Ref #, Ready* (date+time), Appt, Note.
4. **Consignee** — same as Pick Up minus Ready; Must Deliver, Appt, Note.
5. **Historical Rates** — our lane history for the lane (reuse Step AE lane-matching): Yesterday,
   Last Week, Last 30/90 Days, Last Quarter, Last Year; Linehaul vs Rate.
6. **Roles** — Sales Representative, Service Representative, Dispatcher Assigned, Dispatcher Actual,
   Tariff, Quote (link to a Quote row).
7. **More Information** tabs — Instructions (Special Instructions & Rate Confirmation Notes, 420 chars;
   Bill of Lading Notes, 260 chars), Rate Confirmation Notes, Notes, Ref #'s, Items, Updates, Route.
8. **Rates** — Customer row: Rate Type (Flat/Per mile/Per hour/Per cwt), Hours, LH Rate, Total LH,
   FSC %, FSC/Mile, SMR. Carrier row: Rate Type, Hours, LH Rate, Total LH, Pay %, Max Rate.
   Accessorial lines: Release, Carrier, Accessorial, $Carrier, $Customer, add line. Totals USD;
   **Net $ | Profit %** box. Maps onto LoadFinancials + LoadCharge.
9. **Carrier Information** — Carrier (directory type-ahead + "Find & invite" from Step AD), MC#,
   DOT#, SCAC, Cargo, Liability, Gen Liab, Safety Rating (read-only from MCP), Carrier Email, Carrier
   Phone, **Cover** button; Dispatcher (phone, email); Driver 1 and Driver 2 (cell, email) — for Ivan
   Cartage these are the roster picker from Step W; Truck #, Trailer #, Seal, Carrier Ref #; Origin
   City*/State*, Empty Miles, PU ETA; Confirm Sent, Confirm Rec, Dispatched (timestamps); Add
   Available Truck; **Send Rate Conf**, **Send Info** (existing actions).
10. **Picks & Stops** — ordered list, Insert Pick / Insert Stop (multi-stop; maps to Stop rows).
11. **Documents** — Public / Private tabs, upload (existing ShipmentDocument).
12. **Check Calls** — Origin City, State, Date and Time, Temperature, Note, Message (On Time, …),
    EDI Reason (NORMAL STATUS - NS, …), Next Check Call date/time + note; table of calls
    (existing LoadCheckCall).

## Behaviour
- Required fields are the red ones in Aljex (Equipment, Revenue Type, Weight, Description, Customer,
  Pick Up name, Ready, Carrier origin city/state when a carrier is set). Our Intake/Load Review gates
  still apply before Active / billing.
- Save as draft at any point; "Create" runs CREATE_SHIPMENT + SAVE_ORDER_FORM + stops + charges in one
  action; editing an existing shipment reuses the same form (shipment detail "Edit").
- Field names on screen match Aljex wording so the team is not retrained; help text shows our
  underlying name where it differs.
- Dense layout per Step AC: full width, compact inputs, sections collapsible, keyboard tab order
  matches Aljex's.

## Ryne's feedback on the first dev cut (2026-11-04, screenshot aljex-create/30-dev-first-cut-feedback.png)
1. Required fields: highlight the input (green border/background) instead of an asterisk.
2. Miles: auto-calculate Customer Miles and Truck Miles from the stop addresses (Google Distance Matrix when
   the server key exists, else the existing geocode/estimate path); user can override.
3. Customer section: only TWO e-mail fields, not six.
4. New **Bill To** block directly under Customer in the same section, READ-ONLY, filled when a customer is
   chosen: payment terms, factor / no factor (factoring status), billing e-mails, credit limit (+ available).
5. Check Calls section becomes a read-only PREVIEW of the Load Tracking view for this load (summary strip +
   last check calls + link "Open in Load Tracking"), not a separate entry form.
6. Overall: more concise, better flow, fits on one page — collapsible sections, dense inputs, logical tab order,
   no dead space (see the empty right half of Shipping Requirements in the screenshot).
7. Intake -> Create shipment: from an Intake row, "Create shipment" opens this form PRE-FILLED with everything
   extracted from the e-mail thread / rate confirmation for that load (customer, stops, dates, equipment, weight,
   commodity, refs, rate); extracted fields are marked so the reviewer sees what came from the e-mail.
