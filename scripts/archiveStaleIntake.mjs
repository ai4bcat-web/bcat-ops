#!/usr/bin/env node
/**
 * Archive IntakeItem records that have a null or unrecognised status value.
 * These are Gmail-era records that pre-date the current enum and cause partial
 * GraphQL errors on listIntakeItems.
 *
 * Usage:
 *   BCAT_EMAIL=you@bcatcorp.com BCAT_PASSWORD=YourPass node scripts/archiveStaleIntake.mjs
 *
 * Add --dry-run to print what would be changed without writing anything.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { Amplify } from 'aws-amplify'
import { signIn, fetchAuthSession } from 'aws-amplify/auth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN   = process.argv.includes('--dry-run')

const outputs     = JSON.parse(readFileSync(resolve(__dirname, '../amplify_outputs.json'), 'utf8'))
const APPSYNC_URL = outputs.data.url
Amplify.configure(outputs)

const VALID_STATUSES = new Set(['NEW', 'IN_PROGRESS', 'BUILT', 'DONE', 'ARCHIVED'])

async function gql(query, variables, idToken) {
  const res = await fetch(APPSYNC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

const LIST_QUERY = `
  query ListIntakeItems($nextToken: String) {
    listIntakeItems(limit: 200, nextToken: $nextToken) {
      items { id status subject receivedAt }
      nextToken
    }
  }
`

const UPDATE_MUTATION = `
  mutation UpdateIntakeItem($input: UpdateIntakeItemInput!) {
    updateIntakeItem(input: $input) { id status }
  }
`

async function main() {
  const email    = process.env.BCAT_EMAIL
  const password = process.env.BCAT_PASSWORD

  if (!email || !password) {
    console.error('Usage: BCAT_EMAIL=... BCAT_PASSWORD=... node scripts/archiveStaleIntake.mjs [--dry-run]')
    process.exit(1)
  }

  console.log(`Authenticating as ${email}…`)
  await signIn({ username: email, password })
  const session  = await fetchAuthSession()
  const idToken  = session.tokens?.idToken?.toString()
  if (!idToken) { console.error('No ID token after sign-in'); process.exit(1) }
  console.log('Authenticated.\n')
  if (DRY_RUN) console.log('DRY RUN — no changes will be written.\n')

  // Page through all items, tolerating partial errors by reading from the error's .data
  let nextToken = undefined
  const stale   = []

  do {
    const raw = await gql(LIST_QUERY, { nextToken: nextToken ?? null }, idToken)

    // AppSync returns partial results: invalid-enum items appear with status: null in data
    // alongside an errors array. Using raw fetch (not the Amplify SDK) lets us read both.
    const items = raw.data?.listIntakeItems?.items ?? []
    for (const item of items) {
      if (item && !VALID_STATUSES.has(item.status)) {
        stale.push(item)
      }
    }

    if (raw.errors?.length) {
      console.warn(`  [page] ${raw.errors.length} partial error(s) on this page — some items may have null status above`)
    }

    nextToken = raw.data?.listIntakeItems?.nextToken ?? null
  } while (nextToken)

  if (stale.length === 0) {
    console.log('No stale records found. Nothing to do.')
    return
  }

  console.log(`Found ${stale.length} stale record(s):\n`)
  for (const item of stale) {
    console.log(`  id=${item.id}  status=${JSON.stringify(item.status)}  subject=${item.subject}  received=${item.receivedAt}`)
  }
  console.log()

  if (DRY_RUN) {
    console.log('Dry run complete — would archive the records listed above.')
    return
  }

  let updated = 0, failed = 0
  for (const item of stale) {
    const result = await gql(UPDATE_MUTATION, { input: { id: item.id, status: 'ARCHIVED' } }, idToken)
    if (result.errors) {
      console.error(`  FAIL  id=${item.id}: ${result.errors[0].message}`)
      failed++
    } else {
      console.log(`  OK    id=${item.id} → ARCHIVED`)
      updated++
    }
  }

  console.log(`\nDone: ${updated} archived, ${failed} failed.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
