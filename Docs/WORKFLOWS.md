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
