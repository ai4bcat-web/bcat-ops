# BCAT Ops Developer Orientation

This file is the single source of truth for engineers onboarding to the `bcat-ops` repo.

## Repo overview
- **Live app:** https://operations.bcatcorp.com
- **Stack:** React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui + Zustand + FullCalendar
- **Deploy target:** AWS Amplify on `main`
- **Backend:** AppSync GraphQL API + Cognito auth + S3 bucket for confirmations
- **Locally:** `npm run dev` starts Vite on http://localhost:5173

## Where to start
1. Read `Docs/ARCHITECTURE.md` for the overall system map.
2. Check feature folders under `src/features/` — each domain is self contained.
3. Read `Docs/WORKFLOWS.md` before editing data flows or UI interactions.
4. Read `Docs/STYLE.md` before changing UI.

## Project standards
- All UI lives in `src/features/*` or `src/components/*`.
- Reusable hooks live in `src/hooks/*`.
- Shared business logic lives in `src/lib/*`.
- Feature-local utilities live next to the feature.
- Follow the existing folder conventions; do not add new top-level folders without approval.
- Keep TypeScript strict; do not widen types to make errors go away.
- Tests live alongside source when feature-specific; unit tests live in `src/lib/*.test.ts`.
- Do not modify `amplify_outputs.json` manually.

## Run the app
```bash
cd /Users/adminoid/bcat-ops
npm install
cp .env.example .env
npm run dev
```

## Safety reminders
- `amplify_outputs.json` is injected by the sandbox/deploy. Never edit it.
- Secrets are stored in Amplify and loaded via `.env` at runtime locally.
- Do not paste secrets into issues, PRs, docs, or chat.
