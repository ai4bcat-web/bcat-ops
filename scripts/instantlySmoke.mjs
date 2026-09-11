#!/usr/bin/env node
/**
 * scripts/instantlySmoke.mjs
 *
 * Quick smoke test against the Instantly.ai /api/v2/accounts endpoint.
 * Lists every sending account and prints the total daily capacity.
 *
 * Usage:
 *   INSTANTLY_API_KEY=xxx node scripts/instantlySmoke.mjs
 */

const API_KEY = process.env.INSTANTLY_API_KEY
if (!API_KEY) {
  console.error('Error: INSTANTLY_API_KEY is not set.')
  process.exit(1)
}

const BASE_URL = 'https://api.instantly.ai'

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })

  if (res.status === 401) {
    console.error('Error: Instantly rejected the API key (401 Unauthorized).')
    console.error('Check that INSTANTLY_API_KEY is valid and active.')
    process.exit(1)
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instantly ${res.status} ${path}: ${text}`)
  }

  return res.json()
}

async function listAllAccounts() {
  const accounts = []
  let startingAfter = undefined
  do {
    const params = new URLSearchParams({ limit: '100' })
    if (startingAfter) params.set('starting_after', startingAfter)
    const data = await fetchJson(`/api/v2/accounts?${params.toString()}`)
    accounts.push(...(data.items ?? []))
    startingAfter = data.next_starting_after
  } while (startingAfter)
  return accounts
}

function accountOk(account) {
  return account.status === 1 && account.warmup_status === 1 && account.setup_pending === false
}

async function main() {
  const accounts = await listAllAccounts()

  const rows = accounts.map((a) => ({
    email: a.email,
    status: a.status,
    warmup: a.warmup_status,
    daily_limit: a.daily_limit ?? 0,
    warmup_score: a.stat_warmup_score ?? 0,
    ok: accountOk(a),
  }))

  console.log(`Found ${accounts.length} Instantly account(s)\n`)
  console.table(rows)

  const totalDailyCapacity = rows
    .filter((r) => r.ok)
    .reduce((sum, r) => sum + (r.daily_limit || 0), 0)

  console.log(`\nTotal daily capacity across OK accounts: ${totalDailyCapacity}`)
}

main().catch((err) => {
  console.error('Smoke test failed:', err.message)
  process.exit(1)
})
