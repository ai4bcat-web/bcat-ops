# BCAT OPS — Frontend Redesign Handoff

This doc takes your existing React 19 + Tailwind v4 + shadcn codebase and rebuilds the UI to match the redesign in **`BCAT OPS.html`** (see `src/page-*.jsx` for the React reference). Follow it page-by-page.

The mock is a single-file HTML prototype. The real implementation should stay in your stack. **Do not** change your existing data layer, hooks, store, types, or amplify config. **Only the UI.**

---

## 1. Global setup

### 1.1 Font
The mock uses **Geist** + **Geist Mono**. Your stack uses Inter. Either is fine — pick one and apply it globally.

If switching to Geist (recommended, more modern):
```html
<!-- index.html -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

```css
/* index.css */
body { font-family: "Geist", ui-sans-serif, system-ui, sans-serif; font-feature-settings: "ss01", "cv11"; }
.font-mono, .mono { font-family: "Geist Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
```

### 1.2 Design tokens — update `src/index.css`

Replace your `:root` block with this. The names match what you already use (`--ds-blue`, `--ds-bg`, etc.) — I've added missing tokens.

```css
:root {
  /* surfaces */
  --ds-bg: #f4f7fb;            /* page background — slightly warmer than your current #f8fafc */
  --ds-card: #ffffff;
  --ds-bg-2: #f1f4f9;          /* subtle elevation / table headers */
  --ds-bg-3: #e7ecf4;          /* hover / nav-not-active */

  /* borders */
  --ds-border: #e2e8f0;
  --ds-border-strong: rgba(15, 23, 42, 0.14);
  --ds-border-soft: #f1f5f9;

  /* text */
  --foreground: #0b1220;       /* near-black */
  --ds-muted: #4a5568;         /* secondary text */
  --muted-foreground: #6b7588; /* tertiary */
  --ds-muted-soft: #94a3b8;    /* placeholder / disabled */

  /* brand */
  --ds-blue: #1ea8f3;
  --ds-blue-dark: #0369a1;     /* active text on blue-bg */
  --ds-blue-bg: #e6f4fd;       /* soft blue panel */
  --primary: var(--ds-blue);

  /* status — pill TEXT colors (deeper hues for contrast on white) */
  --ds-green: #15803d;
  --ds-red: #b91c1c;
  --ds-amber: #b45309;
  --ds-violet: #6d28d9;

  /* status BACKGROUND colors (soft pastels for row fills + pills) */
  --ds-green-bg: #e7f7ec;
  --ds-red-bg: #fde8e8;
  --ds-amber-bg: #fef3e2;
  --ds-violet-bg: #efe7fd;

  /* shadows */
  --sh-sm: 0 1px 2px rgba(15,23,42,0.04), 0 1px 1px rgba(15,23,42,0.02);
  --sh-md: 0 1px 3px rgba(15,23,42,0.05), 0 4px 12px rgba(15,23,42,0.04);
  --sh-lg: 0 4px 12px rgba(15,23,42,0.06), 0 12px 32px rgba(15,23,42,0.05);
}
```

Also extend your Tailwind v4 theme so utilities pick these up (in `index.css` if you use `@theme inline`):

```css
@theme inline {
  --color-blue: var(--ds-blue);
  --color-blue-dark: var(--ds-blue-dark);
  --color-blue-bg: var(--ds-blue-bg);
  --color-success: var(--ds-green);
  --color-warning: var(--ds-amber);
  --color-danger: var(--ds-red);
  --color-success-bg: var(--ds-green-bg);
  --color-warning-bg: var(--ds-amber-bg);
  --color-danger-bg: var(--ds-red-bg);
}
```

### 1.3 Sidebar — `src/components/layout/NavBar.tsx`

**Change from dark #1a1a1a → white sidebar with blue active state.** This is the biggest visual lift.

- Background: `bg-white border-r border-slate-200/60`
- Active item: `bg-blue-bg text-blue-dark font-semibold` with a 3px blue accent bar at `left: -10px`
- Inactive: `text-slate-600 hover:bg-slate-100`
- Logo: gradient blue square with the road-arc B mark (see `src/app.jsx` lines 60-72 for SVG)
- Badge pills on nav items: `Loads` shows live count; `Intake` blue; `Tasks` amber; `Maintenance` red. Use:
  ```tsx
  <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded
                   bg-blue-bg text-blue-dark">{badge}</span>
  ```
- "Quick Add" primary button at the top below the logo
- User footer at the bottom with avatar + email + sign-out icon button

Full reference: `src/app.jsx` — Sidebar component, lines 50-150.

### 1.4 Top bar

64px tall, white, full-bleed. Layout:
1. Breadcrumb (left): `BCAT Ops › {pageLabel}` — pageLabel is bold
2. Global search (center, ~480px wide) with `⌘K` hint
3. Right cluster: **Live indicator pill** (green dot + "Live · 12s"), notifications bell with blue dot, settings icon

Reference: `src/app.jsx` — Topbar component, lines 160-200.

---

## 2. Component primitives to add

You already have shadcn primitives. Add these as new components or extend existing ones.

### 2.1 KPI card — `src/components/ui/kpi-card.tsx`

```tsx
import { ReactNode } from "react";

interface KpiProps {
  label: string;
  value: string | number;
  sublabel?: string;
  delta?: string;
  deltaDir?: "up" | "down" | "neutral";
  icon?: ReactNode;
  accent?: string; // hex color for the soft glow corner
  spark?: number[]; // sparkline data
  sparkColor?: string;
}

export function KpiCard({ label, value, sublabel, delta, deltaDir = "up", icon, accent, spark, sparkColor }: KpiProps) {
  // ...
}
```

Visual:
- White card, `rounded-xl border border-slate-200/60 shadow-sm px-6 py-5`
- Top row: eyebrow label (uppercase 11px) + icon box (30×30 rounded-lg `bg-slate-50`)
- Big number (30px font-semibold, tabular-nums, tracking-tight)
- Delta with ▲/▼ arrow, green/red color
- Bottom row: sublabel left, sparkline right (84×28 SVG with gradient fill)
- Optional `accent` corner glow: absolute positioned circle with blur

See `src/shared.jsx` lines 28-71 for the full markup.

### 2.2 Sparkline — `src/components/charts/sparkline.tsx`

84×28 SVG, linear gradient area fill, 1.6px stroke. See `src/shared.jsx` lines 74-100.

### 2.3 Status pill — extend `src/components/ui/badge.tsx`

```tsx
type Tone = "ok" | "warn" | "bad" | "blue" | "violet" | "neutral";

const toneClasses: Record<Tone, string> = {
  ok: "bg-green-50 text-green-700",
  warn: "bg-amber-50 text-amber-700",
  bad: "bg-red-50 text-red-700",
  blue: "bg-blue-50 text-blue-700",
  violet: "bg-violet-50 text-violet-700",
  neutral: "bg-slate-100 text-slate-600",
};
```

Add a `dot` prop (small filled circle prefix) and a `pulse` prop (animated, for "NEW" badges).

### 2.4 Sortable table primitives

Your shadcn `Table` is fine. Add these patterns:
- Header: `bg-slate-50/80 sticky top-0 z-10` with uppercase 11px font-medium tracking-wider labels
- Row hover: `hover:bg-slate-50/60`
- Status-fill rows (calendar):
  ```css
  .row-fill-ok td { background: var(--ds-green-bg); }
  .row-fill-blue td { background: var(--ds-blue-bg); }
  .row-fill-warn td { background: var(--ds-amber-bg); }
  ```
- Mono numeric cells: `font-mono tabular-nums`
- Tabular numbers right-aligned

### 2.5 Chart components (Recharts)

Recreate these three patterns. Configure Recharts with:
- `<CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" vertical={false}/>`
- `<XAxis tick={{ fill: "#6b7588", fontSize: 10.5, fontFamily: "Geist Mono" }} axisLine={false} tickLine={false}/>`
- `<YAxis tick={...} axisLine={false} tickLine={false}/>`
- Use `<Tooltip contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, boxShadow: "var(--sh-md)" }}/>`

**Patterns:**
1. **Line chart with gradient area** — monotone cubic, gradient fill from color@22% → transparent. See `src/shared.jsx` 103-200.
2. **Bar chart** — single color, linear gradient (100% → 50% opacity top to bottom), `rx={3}` rounded tops. See `src/shared.jsx` 220-260.
3. **Horizontal bar** — for "Loads per Driver". Use `<BarChart layout="vertical">`. Bars get a colored gradient + soft glow box-shadow. See `src/shared.jsx` 263-289.
4. **Donut** — SVG, two stacked circles with `strokeDasharray`, center label/value inside.

### 2.6 Right-side drawer — use shadcn `Sheet`

You already have `sheet.tsx`. Use it for:
- New Load form (currently `LoadDrawer.tsx` — restyle)
- Edit Driver form
- Fuel Upload (`FuelUploadModal` becomes a Sheet)
- Filter panels

Spacing: `p-6` outer, fields stacked in `flex flex-col gap-4`, footer with `mt-auto pt-5 border-t border-slate-200`.

---

## 3. Page-by-page rebuild

### 3.1 Dashboard (`src/features/dashboard/DashboardPage.tsx`)

Reference: `src/page-dashboard.jsx` in the mock.

Layout (top-down):
1. **Page header** — "Operations Dashboard" title (26px font-semibold tracking-tighter) + "Live snapshot · {date} · {time} CT" subtitle + right-side range chips (Today/This Week/This Month/Quarter/Custom — active = solid blue, inactive = white border) + Refresh button + primary "New Load" button.
2. **KPI row** (4 cards, gap-4): Total Loads · Needs Invoice · Appts to Book · Revenue This Month. Each with sparkline + delta + soft corner glow.
3. **Charts row** (`grid-cols-[1fr_1.4fr] gap-4`):
   - Left: **Loads per Driver** horizontal bar chart (top 6 drivers, color-coded by `driverColors.ts`).
   - Right: **Loads by Day** vertical bar chart (May 1–31, blue gradient bars).
4. **Mid row** (`grid-cols-[1.6fr_1fr_1fr] gap-4`):
   - Driver Performance table (sortable, sticky header, avatar + name + phone + total loads + RTI + avg/day + last load).
   - Load Status Mix donut (4 segments: Ready/In Progress/Unassigned/Split) + legend below.
   - On-Time Performance donut (92% blue arc) + 2 mini stats below.
5. **Bottom row** (`grid-cols-[1.2fr_1fr_1fr] gap-4`):
   - Fuel This Week card (big $10,669 + delta + 7-day sparkline + top 3 truck rows).
   - Open Tasks list (4 items from intake queue).
   - Profitability card (rev–cost per truck, 4 mini progress bars).

Wire from existing hooks:
- `useDashboardMetrics()` for KPI numbers
- `useFuelTransactions()` for the fuel mini chart
- `useIntakeItems()` for open tasks list
- `useLoads()` + `useDrivers()` for driver performance

### 3.2 Calendar (`src/features/calendar/CalendarPage.tsx`)

Reference: `src/page-calendar.jsx` — has 4 view sub-components.

Replace your existing FullCalendar setup with **4 tabs**:

#### a. **Planner (Kanban)** — `PlannerView.tsx`
- 5 columns, one per pickup day
- Today column gets a subtle blue gradient bg + blue border
- Each load = a card with: status border-left (3px), Pro# + RTI checkmark, shipper, origin→destination, driver avatar+name OR "Unassigned" warning, rate.
- Card backgrounds: `var(--ds-green-bg)` / `var(--ds-blue-bg)` / `var(--ds-amber-bg)` based on status.
- Hover: lifts (`translateY(-1px) + shadow-md`)
- Add-load button in each column header

#### b. **Week (table)** — `WeekTableView.tsx`
- Tabular layout, full-width rows filled by status color (Ready=green-bg, In Progress=blue-bg, Needs Appt=amber-bg)
- Day-separator rows have `bg-slate-50` (or `bg-blue-bg` for today)
- Columns: status-dot · Pro# · TMS · PU# · Shipper · Route · PU Appt · DE Appt · Driver · Rate · RTI

#### c. **2 Weeks** — `CompactWeekView.tsx`
- Heat-grid layout: drivers (rows) × days (columns)
- Each cell shows load count for that driver/day, color intensity scales with count
- Weekends are blank (transparent cells)
- Today's column gets a 1.5px blue border
- "Less ▢▢▢▣ More" legend in footer

#### d. **Scheduler** — `SchedulerView.tsx` (existing FullCalendar)
- Keep FullCalendar resource-timeline
- Apply new theme: white background, blue events on `var(--ds-blue-bg)` with 3px blue left border, status colors for ready/needs

Filter chips row (above the views): All / Ready to Invoice / Split Assignment / Unassigned / Needs Appt — same chip component as dashboard ranges.

### 3.3 Grid / Loads (`src/features/grid/GridPage.tsx`)

Reference: `src/page-loads.jsx`.

1. **4 KPI cards** with left-edge color accent (3px solid bar — blue/green/amber/violet):
   - Total Loads · Ready to Invoice · Unassigned · Split Loads
2. **Tab bar**: All / Ready to Invoice / Unassigned / Split Loads — each with count badge after the label
3. **Filter row**: search input + Columns dropdown + Group by day toggle
4. **Big table** (sticky header, zebra stripes, hover, sortable headers):
   - Checkbox · Pro# · TMS · PU# · Origin→Destination · PU Appt · DE Appt · Driver · Rate · Status (pill) · RTI

LoadDrawer (sheet) opens for create/edit:
- 2-col fields for Pro/TMS, Origin Name/City, Dest Name/City
- Pickup/Delivery time pickers with Exact/Range/FCFS sub-tabs
- PU Driver + DE Driver dropdowns (separately — your current `pickupDriverId` vs `deliveryDriverId`)
- "Mark as Ready to Invoice" checkbox
- Footer: Cancel + primary "Create Load"

### 3.4 Intake (`src/features/intake/IntakePage.tsx`)

Reference: `src/page-intake.jsx`.

1. **4 KPI cards** (icon + label + value): Active Queue · Built Today · Avg Build Time · Auto-Matched %
2. **Source toggle**: chip group between "Ivan Cartage" and "BCAT Logistics" with little colored dots; "Auto-poll every 30s" indicator on the right
3. **Active Queue card** containing a 4-column grid of tender cards:
   - Card has subject (truncated), age + assignee + Slack link, body preview (3-line clamp)
   - Footer: primary "Build Load" + "In Progress" + trash icon
   - "NEW" badge with pulse animation in the corner
4. **History table card** with source/status filter dropdowns, columns:
   - Received (mono date) · Source (pill) · Subject + thread under · Assignee (avatar+name) · Status (NEW/BUILT/DONE/ARCHIVED pills) · PRO# (if linked) · ext link icon

### 3.5 Tasks (`src/features/tasks/TasksPage.tsx`)

Reference: `src/page-tasks.jsx`.

Grouped by assignee — for each user (Dennis, Arcie, Ryne, Jason):
1. Header: avatar + name + count pill
2. Below: 4-col grid of task cards (same shape as intake cards)
3. Empty state: centered check icon + "All clear · no open tasks"

### 3.6 Drivers (`src/features/drivers/DriversPage.tsx`)

Reference: `src/page-drivers.jsx`.

1. **4 KPI cards**: Total · Active Drivers · Brokers/3PL · Inactive
2. **Tab bar**: All / Company / Brokers
3. **Table**: avatar (with green pulse if active) + name · phone · type pill · truck · status · CDL/Med/Drug/Hire dates · notes · edit/eye icons

DriverForm (sheet drawer):
- Photo + upload button
- Name + Phone fields
- **Type toggle**: 2-button tab group, Own Driver vs Broker/3PL
- **Calendar Color**: 10 swatches in a flex-wrap, ring around selected (use `driverColors.ts` COLOR_MAP)
- Notes textarea
- Divider + "Compliance & Profile" section: Email · CDL # · Driver Type dropdown · CDL Exp · Med Card Exp · Drug Test · Hire Date
- "Active driver" checkbox with sublabel inside a soft-bg card
- Footer: Delete (red, far left) · Cancel · Save Changes

### 3.7 Trucks / Fleet (`src/features/trucks/TrucksPage.tsx`)

Reference: `src/page-fleet.jsx`.

1. **5 KPI cards** with icon boxes: Total Units · Trucks · Trailers · Compliance Alerts · Open Tasks
2. **Tab bar**: All / Trucks / Trailers
3. **Wide table** (horizontal scroll):
   - Type pill · Unit # (mono bold) · Year · Make/Model · Plate · DOT Insp (red+alert icon if overdue) · IFTA Exp · IRP Exp · Insurance · Driver · Fleet Mgr · Open Tasks (pill, red if "high") · Repair Spend (right-aligned mono) · edit/trash icons

Pull from **seeded equipment in `useAppStore`** — don't fetch from API per your conventions.

### 3.8 Maintenance (`src/features/maintenance/MaintenancePage.tsx`)

Reference: `src/page-maintenance.jsx`.

1. **4 KPI cards with left-edge accents**: Open Tasks (blue) · Overdue (red, animated pulse dot) · Completed (green) · Invoice Total (violet)
2. **Tab bar**: Tasks (icon) / Invoice History (icon)
3. **Filter row**: search + Equipment dropdown + Time dropdown (Upcoming/Overdue/All) + Priority dropdown
4. **Table**: empty checkbox · task title + description below · equipment (mono) · due (red+alert if overdue) · priority pill (High=red, Med=amber, Low=neutral) · assignee avatar+name OR — · status pill · edit/trash icons

### 3.9 Expenses (`src/features/expenses/ExpensesPage.tsx`)

Reference: `src/page-expenses.jsx`.

**3 tabs**: Fuel / All Costs by Truck / Manage

#### Fuel tab
1. Range chips (Yesterday/This Week/etc.)
2. 5 KPI cards: Total Fuel Spend · Total Gallons · Avg $/Gallon · Fuel Transactions · Other Charges
3. **Weekly Fuel Spend by Truck** pivot table (truck rows × week columns, totals row at bottom with `bg-slate-50` and bold)
4. **Fuel Over Time** line chart — multi-series with one line per truck, gradient area fills, dot markers on hover

#### All Costs by Truck tab
Wide pivot table: trucks (rows) × cost categories (cols: Fuel/Insurance/Financing/Lease/Maintenance/Permits/Tolls/Other) + totals row + totals column. Cells with `$0` show "—" in muted color. Wire to `getExpensesByTruck()` from `expenseAllocation.ts`.

#### Manage tab (new `ExpenseManageView.tsx`)
Three stacked cards, each with "Add" button in header:
1. **Expense Types** table — Name · Category pill (FUEL/INSURANCE/etc., color-coded) · Entry Method (mono) · Records count · Status pill · edit/trash
2. **Truck Allocations** table — Name · Method pill (DIRECT/SPLIT_EVEN) · Trucks (chips list) · edit/trash
3. **Recurring Expenses** table — Type · Allocation · Monthly $ · Start · End · Status · edit/trash

**FuelUploadModal** → convert to a Sheet drawer triggered by the "Upload EFS Report" button:
- Drop-zone: dashed border, becomes blue when file selected
- Preview table after parse showing first 3 rows + "+N more"
- Footer: Cancel · primary "Import {N} transactions" (disabled until file picked)
- On submit: call your existing parser (`efsTransactionReport.ts`) + `createFuelTransaction()` for each row

### 3.10 Schedule (`src/features/schedule/SchedulePage.tsx`)

Reference: `src/page-schedules.jsx`.

For each driver with loads today, render a card:
- Header: avatar (lg) + name + type pill + load count, right-side actions (Call / Text / Copy)
- 2-column body:
  - **Left: timeline of stops** — vertical timeline with numbered circle markers, each stop shows Pickup pill + time + origin, Delivery pill + time + dest, load/PU# in footer
  - **Right: SMS preview** in a soft blue-tinted card — auto-generated dispatch text, with copy button
- "Copy All" + primary "Send All SMS" buttons at top of page

### 3.11 Audit Log (`src/features/audit/AuditPage.tsx`)

Reference: `src/page-audit.jsx`.

1. **4 KPI cards**: Total Events (7d) · Updates · Creates · Deletes
2. **Table**: Time (mono) · Action pill (Update=blue, Create=green, Delete=red) · Entity (icon + name) · ID (mono truncated) · User (avatar + email) · Changes count

### 3.12 Users (`src/features/users/UsersPage.tsx`)

Reference: `src/page-users.jsx`.

Admin-only.

1. **4 KPI cards**: Total Users · Active · Invite Pending · Disabled
2. **2-column layout**:
   - Left: **Invite New User** card — Email · Role dropdown · Permissions checkbox list · "Send Invite" primary button
   - Right: **All Users** card with table — User (avatar with green pulse if active + name + email) · Role pill · Status pill · Last Active · `⋯` menu

### 3.13 Login (`src/pages/LoginPage.tsx`)

Reference: `src/page-login.jsx`.

Standalone (no AppLayout). Centered card, gradient page background with two big blurred blobs (blue + violet).

**Two-column card**:
- **Left**: dark blue gradient (`linear-gradient(160deg, #0a1422 0%, #0f1e33 40%, #0b8fd9 110%)`) with subtle grid bg overlay. Contains BCAT OPS mark, headline ("Every load. Every driver. Every dollar."), description, and 3 stat rows (44 loads · 16 trucks · 92% on-time).
- **Right**: form. Welcome heading + subtitle. Email field (mail icon prefix). Password field (lock icon prefix + show/hide eye toggle, "Forgot?" link on right of label). "Keep me signed in" checkbox. Primary "Sign in →" button (full width, 14px font, 12px padding).
- Footer: small "Need access? Contact ryne@bcatcorp.com"

Handle three states from your existing `AuthContext`:
- `login` — default
- `newpw` — when Cognito returns NEW_PASSWORD_REQUIRED (your `completeNewPassword`)
- `reset` — forgot password flow

---

## 4. Behavior & wiring notes

These bind the redesign to your existing data layer:

| UI element | Hook / API |
|---|---|
| Dashboard KPIs | `useDashboardMetrics()` |
| Dashboard fuel mini-chart | `useFuelTransactions()` filtered to last 7 days |
| Loads table | `useLoads()` + `useAppStore` selectors |
| Calendar (all 4 views) | `useLoads()` + `useDrivers()` |
| Intake queue | `useIntakeItems()` |
| Tasks page | Same `useIntakeItems()` filtered to `IN_PROGRESS` |
| Drivers table | `useDrivers()` |
| Fleet table | `useAppStore(s => s.equipment)` (seeded, not API) |
| Maintenance | `useAppStore(s => s.maintenanceTasks)` |
| Expenses · Fuel | `useFuelTransactions()` |
| Expenses · All Costs | `getExpensesByTruck()` from `lib/expenseAllocation.ts` |
| Expenses · Manage | `useExpenseData()` — exposes types, allocations, recurring |
| Schedule | `useLoads()` grouped by `pickupDriverId` for today |
| Audit | `useAuditLog()` |
| Users | `listCognitoUsers()` via `apiClient.ts` |

Keep your existing CRUD entry points and optimistic update patterns intact.

---

## 5. Specifics you'll trip on

1. **Driver color swatches**: the mock uses inline hex colors. Replace with `COLOR_MAP[driver.colorKey]` from `lib/driverColors.ts`. The 10 swatches in the DriverForm correspond to `driver-1` through `driver-12` + `broker`.

2. **Status mapping**: the mock uses `ready` / `open` / `needs` / `unassigned`. Map to your actual fields:
   - `ready` → `load.readyToInvoice === true`
   - `unassigned` → no `pickupDriverId` AND no `deliveryDriverId`
   - `needs` → `load.deliveryAppt === null` AND has driver assigned (your "NEED appt" state)
   - `open` → everything else (driver assigned, in progress)

3. **PU/DE drivers**: the mock has a single `Driver` column for simplicity. In your real app, you have `pickupDriverId` + `deliveryDriverId`. When they're the same, show one avatar. When different, stack two small avatars overlapping (`-ml-2` on the second one).

4. **Money formatting**: Use `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)` — never the inline `"$" + n.toLocaleString()` from the mock.

5. **Equipment IDs**: never use the `#009`-style display name as a key — always use the stable `eq-mnmpi9jxwd12`-style ID from your store. The mock shows display names because there's no data layer.

6. **Sticky table headers**: every table that scrolls needs `<thead>` with `position: sticky; top: 0; z-index: 1; background: var(--ds-bg-2)`. Otherwise headers vanish on scroll.

7. **Recharts gotchas**:
   - Hide axis lines: `axisLine={false} tickLine={false}`
   - Mute grid: `<CartesianGrid stroke="rgba(15,23,42,0.05)" strokeDasharray="3 4" vertical={false}/>`
   - For multi-line "Fuel Over Time", use `monotone` curve type
   - Gradient area: `<defs><linearGradient><stop offset="0%" stopOpacity="0.22"/><stop offset="100%" stopOpacity="0"/></linearGradient></defs>` then `<Area fill="url(#id)"/>`

8. **Sonner toasts**: every CRUD action should fire `toast.success(...)` or `toast.error(...)`. Match your existing patterns.

9. **Animation**: skip entrance animations on page mount — they cause flashes during data loading. Hover/state-change transitions only.

10. **Accessibility**: every icon-only button needs `aria-label`. The mock uses `data-tip` for tooltips — replace with shadcn's `Tooltip` component.

---

## 6. Build order

Do it in this order so you can ship incrementally:

1. **Tokens + Sidebar + Topbar** — visible to every page, biggest visual impact
2. **Dashboard** — proof the design system works end-to-end
3. **Loads (Grid) + LoadDrawer** — the core daily-use page
4. **Calendar** with Planner view only — replace existing FullCalendar
5. **Drivers + Fleet + Maintenance** — fast wins, similar table patterns
6. **Expenses** — most complex, save for last
7. **Intake + Tasks + Schedule** — communication surfaces
8. **Audit + Users** — admin pages
9. **Login** — last; visual polish only, auth flow stays the same
10. Calendar Week / 2 Weeks / Scheduler — secondary views

---

## 7. Files in this handoff

- `BCAT OPS.html` — open this to see the live redesign
- `src/icons.jsx` — full icon set (replace with lucide-react in your build)
- `src/data.jsx` — sample mock data shapes (for reference only — use your real types)
- `src/shared.jsx` — KPI, Sparkline, LineChart, BarChart, HBarChart, Donut, Card, Drawer reference implementations
- `src/page-*.jsx` — one file per page, each ≈100-400 lines, copy the structure
- `src/app.jsx` — shell + sidebar + topbar reference

**Use the JSX as a structural reference, not as code to paste.** Reimplement in TSX with your existing components, hooks, and types.

---

## 8. Ship checklist

- [ ] All 13 pages render with the new visual system
- [ ] Sidebar is white with blue active state, not the old dark #1a1a1a
- [ ] Status colors are consistent everywhere (green=ready, blue=in-progress, amber=needs/unassigned, red=overdue/critical)
- [ ] All tables have sticky headers and hover states
- [ ] All forms moved to right-side Sheets (not modals)
- [ ] Calendar has at minimum Planner + Week + Scheduler views working
- [ ] Login page redesigned
- [ ] Toasts fire on every mutation
- [ ] No `console.log` statements
- [ ] `npm run typecheck` clean
- [ ] `npm run test` clean (allocation engine tests still pass)
- [ ] `npm run build` ships under your existing Amplify deploy

Ping me with screenshots when sections are done and I'll spot-check against the mock.
