# BCAT Ops Workflows

## How pages consume data
- Pages load data via custom hooks in `src/hooks/*`.
- Hooks call `src/lib/apiClient.ts`, which talks to the AppSync endpoint in `amplify_outputs.json`.
- Auth state flows from `AuthProvider` -> hooks -> pages.

## UI interaction conventions
- Forms use `react-hook-form` + `@hookform/resolvers` + Zod.
- Toasts use `sonner`.
- Tables use `@tanstack/react-table`.
- Calendar uses FullCalendar v6 with `resource-timeline` plugin.
- Modals use shadcn dialog/popover primitives.

## State decisions
- Local UI state: React state inside the page/component.
- Shared view state: Zustand in `src/store/useAppStore.ts`.
- Server-backed data: fetched from hooks when a page loads.
- Do not lift transient UI state into global stores unless reused by multiple pages.

## Failure behavior
- Auth errors redirect to `/login`.
- Data loading errors show a toast and render an empty state.
- Calendar errors preserve the last loaded date range.

## Acceptable change styles
- Add a feature in-place if it fits an existing folder.
- Add new files/folders only when the new domain is clearly separate.

## Amazon mileage expenses
- In Amazon Driver Pay settings, add an expense or select an existing revision and choose Change, then Mileage calculation. Enter cost per mile, miles for the weekly expense, and an effective date. Apply the draft, then Save settings.
- Amount is calculated from cost per mile × entered miles and rounded once to cents; sub-cent per-mile rates are retained. These are entered miles, not an ELD feed or automatic trip-mile total.
- Both inputs are saved on each expense revision in the existing fixedExpenses JSON. Reopening a revision restores its calculation; changes retain previous amounts and formulas. Partial periods still prorate by calendar day.
- Mileage controls are enabled for Amazon settings only; box-truck fixed-amount entry is unchanged.
- A fixed-expense mileage line is an ordinary expense: an after-expenses driver bears only their pay % of it. Lease mileage and IFTA the driver owes in full go on the weekly settlement as a **Debit** (reason Lease mileage / IFTA fuel tax): enter miles and cost per mile, the amount is computed and comes off the check at 100% after the split, and it applies only to the selected week. The miles and rate are stored on the debit and printed on the statement.
