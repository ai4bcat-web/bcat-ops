# BCAT Ops Architecture

## Frontend
- React 19 SPA with Vite bundler.
- Auth via Cognito using `@aws-amplify/ui-react` in `src/context/AuthContext.tsx`.
- State via Zustand store in `src/store/useAppStore.ts`.
- GraphQL queries/mutations in `src/lib/apiClient.ts`.

## Route structure
- `/dashboard` — main operational metrics
- `/calendar` — FullCalendar resource timeline view
- `/loads` — legacy grid renamed to “Loads”
- `/drivers` — driver management and avatars
- `/trucks` — equipment/truck registry
- `/expenses` — expense tracking
- `/schedule` — driver schedule view
- `/audit-log` — audit trail viewer
- `/intake` — email intake queue
- `/tasks` — task/todo board
- `/users` — user management

## Feature layout rules
- Every page has a folder under `src/features/<name>/`.
- Each feature folder contains:
  - `XxxPage.tsx`
  - `XxxTable.tsx`
  - `XxxForm.tsx` if edits exist
  - `index.ts` if re-exports are needed
- Keep shared table/form pieces in corresponding `src/components/*` files.

## Data shape
- Core types: `src/types/*` (truck, expense, load, equipment).
- Zod validation: `src/lib/schemas.ts`.
- Date parsing: `src/lib/fuelDateUtils.ts` plus `date-fns`.

## Deployment
- Every push to `main` triggers Amplify.
- Build script: `npm run build` runs `tsc -b && vite build`.
