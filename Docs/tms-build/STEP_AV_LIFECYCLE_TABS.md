# Step AV — Brokerage as lifecycle tabs across the top: Quote · Build · View · Book · Track · Review

Ryne, 2026-11-06: "for bcat dev - let's move all the pieces of the brokerage to be tabs across the top
of the screen so the UI is a little different. We want to make this a clear flow of the life of a
shipment. Quote, Build (this will be the intake), View (this will be active shipments), Book (this will
be carrier sales), Track (This will be tracking), Review (this will be load review). Then leave another
page on the left side that is your active shipments (same as the view page)."

Dev only. Touches `src/lib/navSections.ts` (Brokerage section, lines ~120-150), `src/features/tms/TmsShell.tsx`
(the `tms-topbar` header, ~548-622), `src/features/tms/TmsLayout.tsx`, `src/features/tms/kit/TmsTabs.tsx`,
`src/App.tsx` routes under `/tms`, `useShellBadgeCounts.ts`.

## 1. The lifecycle strip (top of every TMS brokerage page)
A persistent tab strip rendered in the TMS top bar, under the business name, visible on every
`/tms/*` page a brokerage user can open. Six tabs, in this order and with these exact labels, each with a
one-word sub-caption in smaller muted text so new users learn the mapping:

| Tab | Caption | Route | Today's page |
|---|---|---|---|
| **Quote** | Spot quotes | `/tms/rates` (+ `/tms/rates/spot` when SHOW_RESERVED_AB) | Quotes |
| **Build** | Intake | `/tms/shipments/intake` (+ `/tms/shipments/new`, `/:id/edit`) | Intake review + create-shipment form |
| **View** | Active shipments | `/tms/shipments` (board, Active default; All / saved views stay as the board's own sub-tabs) | Shipments board |
| **Book** | Carrier sales | `/tms/carrier-sales` | Carrier Sales |
| **Track** | Tracking | `/tms/tracking` (+ `/tms/tracking/links`) | Load Tracking |
| **Review** | Load review | `/tms/load-review` | Load Review |

Rules:
- The strip reads as a flow: thin connector line / chevrons between tabs, the active tab filled, tabs
  to the left of the active one lightly tinted ("done"), tabs to the right plain. Keep the existing
  badge counts (quotesToReply, carrierSales, loadTracking, loadReview, plus an Intake count for Build)
  as small count badges on the tabs; they move off the sidebar.
- A tab is drawn only when the user may open the page behind it (same `pageKey` gates as the sidebar
  today); the routes stay guarded by `RequirePage`.
- Shipment detail `/tms/shipments/:id` lights **View**; `/tms/shipments/:id/edit` and `/tms/shipments/new`
  light **Build**; `/tms/shipments/intake/:intakeId` lights Build.
- Keyboard: Alt+1..6 jumps tabs (document in the Help popover if one exists). Tabs scroll
  horizontally on narrow widths; captions hide first.
- Nothing on the pages themselves changes beyond their h1s: the page h1 adopts the tab word plus the
  caption ("Build · Intake", "Book · Carrier sales") so URL, tab and page agree.

## 2. The left sidebar after the move
Brokerage section of `navSections.ts` keeps ONLY:
1. **Company Dashboard** (unchanged, top).
2. **Active shipments** → `/tms/shipments` (the same page as the View tab; Ryne: "leave another page on
   the left side that is your active shipments (same as the view page)"). Pinned by default.
3. Customers, Carriers, Locations (directories), Accounting (AR / AP / Vendors), Settings (`/tms/brokerage`)
   exactly as today.
Removed from the sidebar: Quotes, Shipments group (Intake / All children), Carrier Sales, Load Tracking,
Load Review. Their page keys and badge counts are reused by the strip. Assets (Ivan Cartage) sidebar
group and everything non-TMS are untouched. Update `navSections.test.ts` expectations and any pinned
defaults (`pinnedOf`).

## 3. Implementation notes
- Build the strip as `src/features/tms/LifecycleTabs.tsx` (reuse `TmsTabs` styling, add the connector
  look in `kit.css`), driven by a single `LIFECYCLE_TABS` table exported from `src/lib/lifecycleTabs.ts`
  with `{ key, label, caption, to, matches: string[], pageKey, badgeKey }`. `TmsShell` renders it in the
  top bar for `tms: true` routes that belong to the brokerage (not for Assets pages).
- Old bookmarks keep working: no route is renamed. Do not touch `/tms/brokerage/*` (settings tabs).
- Demo walkthrough: refresh the first screenshots in `Docs/tms-build/DEMO_WALKTHROUGH.md` that show the
  sidebar; the walkthrough text now narrates Quote → Build → View → Book → Track → Review.

## 4. Done when
- On dev, every brokerage page shows the six-tab strip with the right tab lit, badges present, and the
  sidebar shows Company Dashboard, Active shipments, directories, Accounting, Settings only.
- A user without `loadReview` sees five tabs; typing `/tms/load-review` is still refused.
- `navSections.test.ts`, a `lifecycleTabs.test.ts` (route → tab matching for every route in §1,
  including detail/edit/new/intake ids), and a `LifecycleTabs.test.tsx` (render, lit state, badges,
  permission hiding) pass; typecheck, lint 0 warnings, full test run, build green.
- BUILD_LOG entry "## Step AV deployed (job N)".

## Progress
- Paused 2026-11-06 at Ryne's request (prod batch first). Builder had written lifecycleTabs.ts/LifecycleTabs.tsx (+tests), navSections.ts sidebar trim, TmsShell/TmsLayout/kit.css wiring and six page h1 edits, all UNCOMMITTED and UNVERIFIED (no tsc/eslint/vitest run by me; builder was cancelled mid-run, so files may be mid-edit).
- To resume: run tsc/eslint/targeted vitest on those files, then the scripts/ sidebar-selector sweep, full gate, push dev, BUILD_LOG "Step AV deployed", DEMO_WALKTHROUGH screenshots. Leave scripts/ingestFuelReport.mjs alone; use explicit paths with git add.
