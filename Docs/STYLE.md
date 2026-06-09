# BCAT Ops Style Guide

## Language
- TypeScript everywhere. No `any` in new files.
- Prefer composable components over large monoliths.

## Imports
- Use `@/` alias for src imports.
- Group imports: React, third party, local.
- Avoid deep relative paths like `../../../../`.

## Components
- Use shadcn/ui primitives when available.
- Reuse existing layout pieces in `src/components/layout`.
- Keep new components small; extract repeated UI into shared files.

## Tailwind
- Use utility classes for one-off styling.
- Use `class-variance-authority` and shared cn helpers for repeated variants.

## Testing
- Add tests for shared utility logic in `src/lib/*.test.ts`.
- Keep tests focused and deterministic.

## Git commits
- Use Conventional Commits.
- Keep scope aligned with feature folders where possible.
