/**
 * Every Lambda handler must survive esbuild.
 *
 * Amplify bundles each handler with esbuild, which knows nothing about the `@/` path
 * alias that tsconfig and Vite provide. So a shared module under `src/` can typecheck,
 * lint, test and build perfectly and still fail the backend deploy — which is exactly
 * what happened: a single `import { getStops } from '@/lib/stops'` in a module the
 * driver API imports broke eight consecutive production deploys, and nothing in the
 * local toolchain noticed. `npm run typecheck` cannot catch it, because resolving that
 * alias is the one thing tsc does and esbuild does not.
 *
 * Type-only aliased imports happen to survive, since esbuild erases them. Relying on
 * that is a trap: the day someone adds a value import to the same file, the deploy
 * breaks again. So this test bundles for real rather than grepping for the alias.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const functionsDir = dirname(fileURLToPath(import.meta.url))

const handlers = readdirSync(functionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ name: e.name, entry: join(functionsDir, e.name, 'handler.ts') }))
  .filter((h) => existsSync(h.entry))

describe('every Lambda handler bundles', () => {
  it('finds the handlers to check', () => {
    // A rename that empties this list would make the suite pass by testing nothing.
    expect(handlers.length).toBeGreaterThan(10)
  })

  // Same flags Amplify uses, minus the ones that only affect output size.
  it.each(handlers)('$name', async ({ entry }) => {
    await expect(
      build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        logLevel: 'silent',
      }),
    ).resolves.toBeTruthy()
  }, 60_000)
})
