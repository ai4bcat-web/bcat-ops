# MVMNT UI reference — what the TMS pages in BCAT Ops must look like

Captured from the live app (tms.mvmnt.io, Ryne's login) on 2026-10-28 with computed styles and
layout measurements. This is the look the TMS section adopts. Ryne's words: "I would prefer if
you took on the UI from MVMNT instead" of the existing BCAT Ops look. The existing BCAT Ops
pages keep their current look; only the TMS section follows this document.

## 1. Shell (every TMS page)

- **Dark theme, always.** App background `rgb(35,35,35)` (`gray-700`), sidebar `rgb(14,14,14)`
  (`gray-900`) with a `1px solid rgb(56,56,56)` right border, top bar `rgb(24,24,24)` (`gray-800`).
  Text `rgb(250,250,249)`; muted text `rgb(167,167,167)` (`gray-300`); borders `rgb(56,56,56)`.
- **Font:** Inter, 14px base (`font-family: Inter, sans-serif`). Page title (h1) 28px, weight 400.
- **Primary / accent:** yellow `hsl(51 95% 49%)` ≈ `#F4C50C`, foreground on it
  `hsl(26 83% 14%)` (dark brown). Primary button: yellow pill, dark text, 40px tall, radius 999.
  Links and active filter chips use the same yellow.
- **Radius:** `.4rem` (≈6px) on inputs/cards; 4px on secondary buttons; pills on primary actions.
- **Sidebar:** fixed, 175px wide, full height. Logo top-left (MVMNT wordmark), a collapse chevron
  on its right edge. One vertical list of items, 44px row pitch, 20px icon + label, no section
  headers; the active item has a yellow 3px left bar and a lighter (`gray-800`) row background.
  Bottom of the sidebar: four small icons (notifications with a red count badge, theme toggle,
  chat, account).
- **Top bar (38px):** page name on the left, then four square icon buttons (monitor, bolt
  quick-actions, help, history), a global search "Search anything (ctrl+k)" input
  (`rgb(56,56,56)` fill, `1px solid rgb(101,101,101)`, 40px tall), a "Chat" button and the user
  avatar circle (yellow, initial) on the right.
- **Main area:** starts at x=175, no max-width, padding handled per page (≈16px).

MVMNT sidebar order (their routes), which the TMS section mirrors one for one:

| Label | MVMNT route | BCAT Ops TMS route |
|---|---|---|
| Dashboard | /dashboard | /tms/dashboard |
| Shipments | /shipments | /tms/shipments |
| Rates | /quoting/shipper-quotes | /tms/rates |
| Invoicing | /accounts-receivable | /tms/invoicing |
| Carriers | /carriers | /tms/carriers |
| Factors | /carrier-factors | /tms/factors |
| Customers | /customer-management/customers | /tms/customers |
| Locations | /locations | /tms/locations |
| Vendors | /vendors | /tms/vendors |
| Workflows | /workflows | /tms/workflows |
| Academy (BETA tag) | /academy | /tms/academy |
| My Brokerage | /brokerage/settings | /tms/brokerage |

(Existing TMS pages built under other paths, e.g. `/ar`, `/ap`, `/quotes`, are re-homed under
these; keep redirects from the old paths.)

## 2. List pages (Shipments is the model)

Top to bottom:
1. **Title row:** h1 "Shipments" (28px/400), then view controls: eye icon + "Views" (italic),
   refresh, clear, save, magic icons; on the right the primary pill "+ Shipment", a document
   icon button and a "…" overflow button (dark 40px circles).
2. **Filter row:** a 40px "Search" input, a refresh icon, then filter chips as *italic* text
   ("Customer is", "Status is", "Pick Up on", "Delivery on", "Origin is", "Destination is") —
   a chip with a value is upright and reads like "AR Status is not Unbilled, Unpaid, Paid,
   Canceled"; a "13 Fields ▾" field-picker in yellow on the right; "+ Filter" in yellow below.
3. **Status quick-tabs** above the table on Shipments: Today's Open, Booked, Load, Disp,
   Unload, In Transit, Del — each with a count; plain text buttons, 40px, the active one white.
4. **Table:** header cells 12px, bold, UPPERCASE, `rgb(167,167,167)`, transparent background,
   4px 8px padding, 42px tall; body rows 14px with a `1px solid rgb(56,56,56)` bottom border;
   horizontal scroll for the 13 columns. Shipments columns: SHIPMENT ID, STATUS, REFERENCE,
   ORIGIN, DESTINATION, PICK UP, DELIVERY, STOPS, CUSTOMER REP, CUSTOMER, CARRIER, (+2).
5. **Empty state:** centered info icon, "No items found using these filters.", a muted second
   line, and a yellow "Click here to clear all filters" with a `C` key hint.
6. **Footer bar:** "Showing 0 – 0 of 0 items", page-size box (20), keyboard-shortcut hints on
   the right (F, ↓, ], Enter, Tab, Esc), a floating yellow chat bubble bottom-right.

Status badges use the `--badge-*` colours: blue `rgb(10,129,255)`, green `rgb(27,167,116)`,
orange `rgb(255,136,10)`, pink `rgb(255,10,252)`, purple `rgb(136,10,255)`, red
`rgb(237,90,118)`, turquoise `rgb(9,226,229)` — filled pill, dark text where the fill is light.

## 3. Dashboard (Ryne: "a dashboard view that matches the way the dashboard is set up in MVMNT")

- Title row: a swap icon, h1 "Dashboard", "Views" (eye icon, italic), refresh / clear / save /
  export icons; right side a yellow "17 charts ▾" picker (which charts are shown).
- Filter row, scrollable: refresh, a date-range chip "Pick Up this month 10/1 – 10/31", then
  "Mode is", "Status is", "Team is", "Customer is", "Carrier is", "Customer Rep is",
  "Origin Point within", "Destination Point within", "+ Filter".
- Body: a vertical stack of **chart cards**, each full width of the main area, ~410px tall,
  `rgb(24,24,24)` header strip with the chart title (14px/600) and a filter icon on the left and
  four icon buttons on the right (`#` number view, table view, expand, "…"); the chart body on
  the `gray-700` background. The 17 charts of the Classic view, in MVMNT's order, which the
  build reproduces one for one from the TMS data: Basic KPIs, Shipments, Revenue, Profit,
  Margin, Revenue by rep, Profit by rep, Margin by rep, Revenue by customer, Profit By Customer,
  Margin by customer, Margin by carrier, Profit by carrier, Shipments by status, Quotes by top 5
  customers, Top 10 customers, Top 10 carriers.
- A "Classic" view selector sits beside the title (saved dashboard views).

## 4. Detail / editor pages

Dark cards (`gray-800` header strip, `gray-700` body) with 14px labels in `gray-300` and values
in white; tabs as plain text with a yellow underline on the active tab; inputs 40px tall,
`rgb(56,56,56)` fill, `1px solid rgb(101,101,101)` border, 4px radius; selects the same.
Primary action top-right as a yellow pill, destructive actions in `--destructive`
`hsl(349 67% 39%)`.

## 5. Tokens to define once (`src/features/tms/theme.css`, scoped to `.tms-shell`)

```
--tms-bg:#232323; --tms-sidebar:#0e0e0e; --tms-topbar:#181818; --tms-card:#181818;
--tms-border:#383838; --tms-input:#383838; --tms-input-border:#656565;
--tms-text:#fafaf9; --tms-muted:#a7a7a7; --tms-primary:#f4c50c; --tms-on-primary:#42280a;
--tms-radius:.4rem; --tms-sidebar-w:175px; --tms-topbar-h:38px;
--tms-badge-blue:#0a81ff; --tms-badge-green:#1ba774; --tms-badge-orange:#ff880a;
--tms-badge-pink:#ff0afc; --tms-badge-purple:#880aff; --tms-badge-red:#ed5a76; --tms-badge-turquoise:#09e2e5;
```

Scope every rule to `.tms-shell` so the existing BCAT Ops pages are untouched.

## 6. Screens captured (for the vision model, if needed)

- Shipments list: `/var/folders/g0/2lrvdy4x3_12x2g9z0qpb8l00000gn/T/claude-chrome-screenshots-O5z0w4/screenshot-1793236052119-1.jpg`
- Dashboard: `/var/folders/g0/2lrvdy4x3_12x2g9z0qpb8l00000gn/T/claude-chrome-screenshots-O5z0w4/screenshot-1793236087219-2.jpg`
