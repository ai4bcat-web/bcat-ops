#!/usr/bin/env node
/**
 * Writes src/lib/mergeSurface.snapshot.json: what production (origin/main) exposes that the dev
 * tree must keep after the merge. src/lib/mergeSurface.test.ts compares the working tree to it.
 *
 *   node scripts/snapshotMergeSurface.mjs [--ref=origin/main]
 *
 * Reads git objects only (`git show` / `git grep`), once. Never touches the working tree, AWS,
 * or any data. Re-run only when production's surface legitimately changes (a new main commit),
 * review the diff, commit it.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ref = (process.argv.find((a) => a.startsWith('--ref=')) ?? '--ref=origin/main').slice(6)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const show = (file) => git('show', `${ref}:${file}`)

// ── navItems: `to` + pageKey per row, plus the off-nav grants ──────────────────
const navText = show('src/lib/navItems.ts')
const navItems = []
for (const line of navText.split('\n')) {
  const to = line.match(/\bto:\s*'([^']+)'/)?.[1]
  const pageKey = line.match(/\bpageKey:\s*'([^']+)'/)?.[1]
  const label = line.match(/\blabel:\s*'([^']+)'/)?.[1]
  if (to && pageKey) navItems.push({ to, label: label ?? '', pageKey })
}
const offNav = navText.match(/OFF_NAV_PERMISSION_PAGES[^=]*=\s*\[([\s\S]*?)\n\]/)
const offNavKeys = offNav ? [...offNav[1].matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]) : []

// ── App.tsx: every route path ─────────────────────────────────────────────────
const routes = [...new Set([...show('src/App.tsx').matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]))].sort()

// ── apiClient: every value export main's own code imports ─────────────────────
const apiText = show('src/lib/apiClient.ts')
const exported = new Set()
for (const m of apiText.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class|enum)\s+(\w+)/gm)) exported.add(m[1])
const importers = git('grep', '-l', '-E', "lib/apiClient'|from '\\./apiClient'", ref, '--', 'src')
  .split('\n').map((l) => l.trim().replace(`${ref}:`, '')).filter((f) => f && !/\.(test|spec)\.tsx?$/.test(f) && f !== 'src/lib/apiClient.ts')
const apiClientUse = {}
for (const file of importers) {
  const text = show(file)
  for (const m of text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*'[^']*apiClient'/g)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const name = spec.split(/\s+as\s+/)[0].trim()
      if (!exported.has(name)) continue
      ;(apiClientUse[name] ??= []).push(file)
    }
  }
}
for (const name of Object.keys(apiClientUse)) apiClientUse[name].sort()

// ── backend.ts: which env vars each Lambda gets ───────────────────────────────
const backendEnv = {}
for (const m of show('amplify/backend.ts').matchAll(/([\w.]+)(?:\s+as\s+\w+\))?\.addEnvironment\(\s*['"]([A-Z0-9_]+)['"]/g)) {
  const target = m[1].replace(/^backend\./, '').replace(/\.resources\.lambda$/, '')
  ;(backendEnv[target] ??= []).push(m[2])
}
for (const t of Object.keys(backendEnv)) backendEnv[t] = [...new Set(backendEnv[t])].sort()

const snapshot = {
  ref,
  commit: git('rev-parse', ref).trim(),
  navItems,
  offNavKeys,
  routes,
  apiClientUse: Object.fromEntries(Object.entries(apiClientUse).sort(([a], [b]) => a.localeCompare(b))),
  backendEnv: Object.fromEntries(Object.entries(backendEnv).sort(([a], [b]) => a.localeCompare(b))),
}
writeFileSync(join(root, 'src/lib/mergeSurface.snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n')
console.log(`snapshot of ${ref} @ ${snapshot.commit.slice(0, 8)}: ${navItems.length} nav items, ${routes.length} routes, ${Object.keys(apiClientUse).length} apiClient exports used, ${Object.keys(backendEnv).length} Lambdas with env wiring`)
