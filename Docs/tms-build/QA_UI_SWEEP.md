# QA UI sweep: Amplify dev job 174 (commit 423d4bc)

Dev only (`https://dev.d3dejqzs77khq6.amplifyapp.com`), headless Chrome at 1440x900 (1920x1080 where noted), throwaway `zz-qaui-*` / `zz-ac2-*` identities (all deleted, each proven gone). Counts, computed styles and aggregates only; no cell text, e-mails or tokens. Screenshots: `Docs/tms-build/screenshots/qa/` (AC2 board shots: `screenshots/ac2/`).

Harnesses (all re-runnable):
- `node scripts/devVerifyAC2.mjs` (existing): 114 pass, 0 fail, 4 skip (log: header filters, sort, sticky, popovers, Columns persist, density persist, fit @1440/@1920 for the six dense boards).
- `node scripts/qaUiSweep.mjs [--only=boards,drawer,nav,routes,dashboard,theme]` (new): 44 pass + the density fail below, 7 other (info).
- `node scripts/qaUiCreate.mjs` (new, read-only: never clicks Save or Create): create-shipment form.

"Owner" role: the owner e-mail cannot be minted, so the owner row is an ADMIN + page-tms user (same sidebar rules).

## Summary

| Result | Count |
|---|---|
| FAIL, fixed in tree (needs frontend deploy) | 2: row-action button forced 41px rows in both densities on Shipments (compact/comfortable identical, virtual spacer maths 30px vs 41px real); unmeasurable route showed no note |
| PARTIAL | 3: auto miles on real (non-geocoded) dev locations; "one page" create form is 4.8 screens when expanded (fits one screen collapsed); templates row only on Shipments |
| Everything else | PASS |

## 1. Dense boards (Shipments Active / All, Intake, Tracking, Customers, Carriers)

Reference screenshots read as images: board-filters-listbox-problem (side listbox filters, to be gone), shipments-sidebar-current (nested sub-menu, to be gone), shipments-list (MVMNT: top filter chips), aljex-active-shipments-board (Aljex: left filter panel, to be gone; dense colored rows, header filters wanted), columns-dialog-crowded (cramped inline checkboxes, to be the two-pane dialog), dashboard (chart grid).

| Requirement (source) | How verified | Result on job 174 |
|---|---|---|
| No side filter panels on Shipments/Tracking/Intake/Customers/Carriers (board-filters-listbox-problem, aljex board) | AC2 `no side filter panel` (no filter `aside`, no `.tms-filter-panel`) on all 6 boards; screenshots ac2/*-1440.png | PASS 6/6 (filters are header funnels + top chips only) |
| Icon-rail sidebar on list pages (shipments-sidebar-current) | AC2 `sidebar icon rail`: `.tms-is-collapsed`, `.tms-dense`, width | PASS 6/6, rail 76px. Note: Intake DETAIL page and Dashboard use the full sidebar (not list pages) |
| Per-column header filters: type-ahead, multi-select + Select all + Clear, date range, numeric range | AC2 filter-text / filter-multi / filter-select-all-clear / filter-date / filter-number per board | PASS (text, multi, select-all/clear, date all pass where the default columns carry that kind). SKIP: numeric filter on Shipments (no numeric default column; Customers Open AR numeric filter proven in AC2 customers step and unit tests); multi-select on Customers (no multi default column) |
| Click-to-sort | AC2 `sort`: aria-sort ascending -> descending, first rows differ | PASS 6/6 |
| Sticky header + first column | AC2 computed style `position: sticky`, left held while scrolled sideways, header holds at top | PASS 6/6 (`headerTop 0px`, `heldLeft 30 == heldCellLeft 30`) |
| Two-pane Columns dialog (columns-dialog-crowded) | qaUiSweep: panes, search, groups, dialog box | PASS 6/6: 2 panes, 1100x868 dialog inside the 1440x900 window; 188 fields in 7 groups on Shipments |
| 36px rows | qaUiSweep: heights of every `.tms-cd-field` and chosen `.tms-cd-row` | PASS 6/6: all exactly 36px |
| Sticky group headers | qaUiSweep: computed `position: sticky`; scrolled list pins the next group header at top 0 | PASS 5/5 where the list scrolls (Intake has 3 short groups, no scroll: INFO) |
| Search | typed "st": Shipments 188 -> 51, Tracking 17 -> 4, Customers 28 -> 9, Carriers 24 -> 3, Intake 7 -> 1 | PASS |
| Select all in group | `button[aria-label^="Select all in"]` count | PASS 7/7/3/3/6/7 (one per group) |
| Drag handle / width / pin / remove | `.tms-cd-grip` (draggable row + arrow keys), `input.tms-cd-width`, Pin, Remove on the first chosen row | PASS 6/6. AC2 `columns apply`: reorder and width of +40px applied and survive a reload (6/6) |
| Reset widths | button present in the chosen pane | PASS 6/6 |
| Templates row | `.tms-cd-templates` + "Template name" input | PASS on Shipments Active/All (the board with server templates). INFO: Intake/Tracking/Customers/Carriers dialogs have no templates row (no template backend for them); confirm with Ryne if wanted |
| Header-measured default widths >= 72px, persisted per user per board | computed `th` widths; stored in localStorage key `tms:grid:<board>:<email>:v1` | PASS: min width 91 / 91 / 102 / 79 / 85 / 83 px; 0 truncated headers; widths persist across reload (AC2). Note: persistence is per browser (localStorage), not per account across devices (design in `useDenseGridPrefs`) |
| Density toggle | AC2 persists across reload (PASS 6/6). qaUiSweep measured row height | **FAIL then FIXED**: Shipments rows were 41px in BOTH compact and comfortable (a row-action `.tms-icon-btn` is `--tms-control-h` = 40px tall and set the row height; compact is meant to be 30px, comfortable 40px). Customers/Carriers/Tracking were correct (30px). Fix: `src/features/tms/grid/dense-grid.css` constrains `td.tms-dg-fixed .tms-icon-btn` to 24px. **Needs frontend deploy**; re-run `node scripts/qaUiSweep.mjs --only=boards` (expect compact 30 < comfortable 40 on Shipments) |
| Collapsible KPI strip | `Summary` button toggles `#tms-dg-kpi` closed -> open -> closed | PASS 6/6 (7/7/3/7/4/3 KPIs) |
| 100 rows virtualised | Customers: footer "Showing 100 of 625", 32 rows mounted; Shipments: "Records shown 100 of 172" + Get next 100, 31 rows mounted of the 100 (spacer row carries the rest) | PASS (Intake 1 row and Tracking 5 rows and Carriers 34 are below the page size: INFO) |
| Default columns fit 1440 without horizontal scroll (counts) | AC2 + qaUiSweep (`scrollWidth <= clientWidth`) | PASS 6/6 at 1440 and 1920: Shipments Active 9/9, Shipments All 9/9, Intake 8/8, Tracking 10/10, Customers 9/9, Carriers 9/9 columns in view; page itself never overflows |
| Popovers do not clip on the last columns | AC2: last 3 filters per board: inside the window, close on outside click, Escape, sideways scroll; page unmoved | PASS 6/6 |
| Page exceptions | AC2 collector | PASS 0 |

Observation (not a defect): on Shipments at 1440 the nine default columns end at about 1160px, leaving about 270px of empty grid area on the right (no horizontal scroll, as required).

## 2. Tracking drawer (tracking-drawer-feedback.png)

Reference read as image: popover-based prefs hiding fields, tall header, one-column map, cramped. Verified at 1440x900 with the demo shipment (PRO 99669): `scripts/qaUiSweep.mjs --only=drawer`; screenshots `tracking-drawer-1440x900.png`, `tracking-drawer-map-collapsed.png`.

| Requirement | Result |
|---|---|
| Inline prefs row, no popover | PASS: Mode / Method / Driver SMS to are three inline selects + Save/Reset + "In force" text in one 24px row; no "Tracking: ..." popover trigger (a first run of my probe flagged the map options button as a popover trigger; probe narrowed, not a product defect) |
| One-row header | PASS: title bar 37px (PRO + customer, Manage links, open-full-page, close). The summary strip under it (driver, ETA, next check call, carrier, tracking prefs) is 88px / 3 lines: INFO, fits |
| Map panel collapsible | PASS: "Hide map" (149px map) -> "Show map" (0px) |
| Two-pane conversations, independent scroll | PASS: SMS and E-mail panes 504px each, both `overflow-y: auto`. The demo threads are short (scrollHeight == clientHeight), so overflow itself was not exercised, only the scroll container contract |
| Last 5 check calls | PASS: exactly 5 rows in Recent check calls |
| Everything above the fold at 900px | PASS: check calls end at 892px of 900; drawer body scrollHeight 847 == clientHeight 847 |
| ONE "Load Tracking" nav row, no children (tracking-submenus-remove.png) | PASS at 3 roles, see section 4 |

## 3. Create shipment (STEP_AH, aljex-create, 7 feedback items)

Verified read-only (form never saved) by `node scripts/qaUiCreate.mjs`; screenshots `create-*.png`, `intake-*.png`. The AH harness (`devVerifyAH.mjs`, 26/0 on jobs 172-173 per BUILD_LOG) covers the saved paths; not re-run here (QAFlows owns create flows).

| Requirement | How verified | Result on job 174 |
|---|---|---|
| "Create shipment" opens the form, not the mint utility (STEP_AH "Bug first") | Click on the board button | PASS: lands on `/tms/shipments/new`, no "Mint a shipment" text, `.tms-ship-form` present |
| 1. Required = green, no asterisks | computed style of `.tms-field-req` inputs | PASS: 7/7 required controls green (border rgb(21,128,61), background rgb(232,247,239)) vs optional rgb(213,219,216)/white; 0 labels end in an asterisk. Required set matches STEP_AH: Equipment, Revenue Type, Weight, Description, Customer Name, Pick Up Name plus one more control (presumably Ready, [INFERENCE]); Consignee Name stays plain white in the screenshot |
| 2. Auto Customer / Truck Miles | picked two real dev locations (name type-ahead) | **PARTIAL**: with real imported locations (no lat/lng) and no working server Maps key on dev, GET_ROUTE_MILES returns null and nothing was filled. The geocoded ZZ route case passes in AH17 (`Chicago to Dallas` 500-1300 miles, override sticks). Fixed the silent null: the form now shows "Could not measure the route — type the miles" (`ShippingRequirementsSection.tsx`, test updated, 17/17 pass). Needs frontend deploy. Gap needing a decision: real locations without coordinates cannot be measured offline; either geocode on save or provide the server Maps key |
| 3. Only TWO customer e-mails | count of `f-customer-email-*` | PASS: 2 |
| 4. Bill To block under Customer, read-only | pick an existing customer; block rows and editable controls | PASS: terms, factoring, emails, limit, available all present; 0 editable controls; inside the Customer section |
| 5. Check Calls = read-only preview of Load Tracking | edit page of an existing shipment | PASS: `tracking-strip` present, "Open in Load Tracking" -> `/tms/tracking?shipment=<id>`, 0 inputs, 5 call rows |
| 6. One-page layout, tab order, no dead space | section heights, columns, tab walk | PARTIAL: Customer / Pick Up / Consignee sit three-up, no horizontal overflow; all sections collapsed fit exactly one screen (806/806px); expanded the form is 3,882px = 4.8 screens at 1440x900 (Carrier 1,095px, Pick Up/Consignee 898px each are tall). Tab walk from Mode goes Equipment > Revenue Type > Office > Customer Miles > Truck Miles > Footage > Pieces > Weight > Billable > Calculate > Disable Mileage > Freight Class > Description > Declared Value (column-major, as in `labels.ts`). The right half of Shipping Requirements is now used (flag columns, temp/pallet/tarp boxes) |
| 7. Intake -> Create shipment pre-filled, extracted fields marked | Intake list row button, then the opened form | PASS: `intake-create-shipment` on the OPEN row; form shows the "Pre-filled from the e-mail / rate confirmation (8 fields)" banner and "from e-mail" chips on Equipment, Revenue Type, Customer, Pick Up city/state, Consignee city/state, Sales rep (18 inputs filled). Pickup/Consignee Name stay empty because the demo tender carries no location names |

Side observation: returning to `/tms/shipments/new` several times in one session stacks one "unsaved draft" banner per earlier visit (two banners above the form pushed the form 120px down). Cosmetic; not changed.

## 4. Navigation (STEP_AA) and redirects (AA_ROUTE_INVENTORY)

`qaUiSweep --only=nav,routes`; screenshots `nav-*.png`.

| Requirement | Result |
|---|---|
| Top level order Company Dashboard, Quotes, Shipments (Active/All/Intake), Carrier Sales, Load Tracking, Load Review, Customers, Carriers, Locations, Accounting (AR, AP, Vendors, Factoring), Settings | PASS for the owner/admin role: exact label order and children |
| ONE Load Tracking row, no children, no live-load list (tracking-submenus-remove.png) | PASS at 3 roles: owner/admin (1 row, depth 0, 1 tracking link in the sidebar, 0 children, no caret), page-loads-only user (landing `/tms/shipments`; pinned rows Shipments, Carrier Sales, Load Tracking), viewer with page-tms (landing `/tms/dashboard`; full pinned set) |
| Feedback link for every user | PASS at all 3 roles (`a[href="/feedback"]` in the rail footer) |
| 26 old URLs (spot check asked: 20) land on pathname + search inside the shell with content, no "No page access", no page exception | PASS 26/26: `/ /tms /loads /grid /shipments /customers /carriers /locations /quotes /rates /tms/rates/lanes /check-calls /tms/check-calls /documents /tms/documents/review /tms/tracking/links /tms/dispatch /ar /ap /vendor-ap /settings /users /reports /feedback /tms/shipments/view/all-shipments /tms/shipments?list=all` (lane rates -> `/tms/rates`; check-calls and documents -> `/tms/tracking?assignee=all&focus=checkcalls|docs`; `/tms/tracking/links` stays an off-nav page) |

## 5. Dashboards, dark theme, phone

| Requirement | How verified | Result |
|---|---|---|
| Company Dashboard KPIs < 3 s cold | 3 fresh-profile loads: time from navigation to four money values + "N shipments" with no skeleton | PASS: 2,388 / 2,182 / 1,661 ms (median 2,182 ms). The earlier BUILD_LOG note (median 3.4 s on job 171) is superseded by these |
| "as of" label | `data-testid=dash-asof` | PASS ("as of hh:mm AM"; footnote "KPIs as of ...; the charts below are live") |
| New dashboard button only with the create claim | admin, page-tms, page-tms + `claim-DASHBOARDS_CREATE` | PASS: shown, hidden, shown |
| Dark theme, 6 pages at 1440 | Dashboard, Shipments, Tracking, Customers, Shipments/new, Accounting: `data-tms-theme=dark`, dark surface, page overflow | PASS 6/6 |
| Phone 390x844, light and dark, same 6 pages | `documentElement.scrollWidth <= innerWidth` | PASS 6/6 light, 6/6 dark: no horizontal page overflow (grids scroll inside their own container). Shots `theme-*-390-*.png`. INFO: on a phone the Shipments toolbar (chips, Columns, density, Summary) takes about 440px before the first row |

## Fixes applied in the tree (not committed, not deployed)

| File | Change | Test |
|---|---|---|
| `src/features/tms/grid/dense-grid.css` | row-action `.tms-icon-btn` inside `td.tms-dg-fixed` is 24x24 so it cannot set the row height (Shipments compact/comfortable were both 41px) | CSS only; live proof is `qaUiSweep --only=boards` density check after deploy |
| `src/features/shipments/form/sections/ShippingRequirementsSection.tsx` + `.test.tsx` | an unmeasurable route (`miles === null`) now shows "Could not measure the route — type the miles" like a service error | vitest 17/17 |
| `scripts/qaUiSweep.mjs`, `scripts/qaUiCreate.mjs` | new harnesses | self-run |

## Deploy list (lead)

1. Frontend deploy of the two source changes above (no backend, `backend.ts`/`resource.ts` untouched, no template measure needed).
2. After the deploy: `node scripts/qaUiSweep.mjs --only=boards` (density row heights) and `node scripts/qaUiCreate.mjs` (miles note); the Shipments "81 rows" figure my first AC2 count printed came from the 41px row height; the board truly mounts 100 rows.

## Open questions for Ryne / lead

- Real dev locations have no coordinates and dev has no usable server Maps key: Customer/Truck Miles only auto-fill for geocoded stops. Prod must have the Distance Matrix key (SSM) or locations must be geocoded for the feature to work on real data.
- Templates row exists on Shipments only.
