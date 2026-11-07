#!/usr/bin/env node
/**
 * Give Jenny the two per-user billing grants (Step AW, AW-CDE-plan D.3 / E.2).
 *
 *   node scripts/grantJenny.mjs                              dry run (default): reads, prints the plan, writes nothing
 *   BCAT_STACK=rehearsal node scripts/grantJenny.mjs --apply performs it on that stack only
 *
 * Jenny = Jenny@bcatcorp.com. Her Cognito user is looked up by that e-mail in the TARGET stack's STAFF pool and
 * added to the Cognito groups `page-billingRelease` (Release to billing, Send invoice, factoring queue changes)
 * and `page-aljexSignoff` (reconciliation decisions and sign-off). Neither grant is held by any role: ADMIN and the
 * owner do not get them, so this script is how the first holder is made.
 *
 * FAILS LOUDLY (exit 2) when no staff user has that e-mail: nobody is ever created or invented. A group that does
 * not exist yet is created (the same `page-<key>` shape the Users page mints); a missing UserProfile is reported,
 * never created, because without `extraPages` on the profile the next Users-page save would strip the groups.
 *
 * Safety: --apply refuses unless BCAT_STACK is set explicitly to dev or rehearsal (production is not selectable
 * in lib/stackConfig.mjs) and the resolved pool is not the production pool. A dry run still needs a stack and only reads.
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { PRODUCTION, REGION, STACK, STACK_ENV } from './lib/stackConfig.mjs'

export const JENNY_EMAIL = 'Jenny@bcatcorp.com'
export const GRANT_KEYS = ['billingRelease', 'aljexSignoff']
export const GRANT_GROUPS = GRANT_KEYS.map((key) => `page-${key}`)

const emailOf = (user) => (user.Attributes ?? []).find((a) => a.Name === 'email')?.Value ?? ''

/** Staff users whose e-mail matches, case-insensitively (Cognito's own filter is case-sensitive). */
export function usersWithEmail(users, email) {
  const wanted = email.trim().toLowerCase()
  return users.filter((user) => emailOf(user).trim().toLowerCase() === wanted)
}

/**
 * Pure plan. `found` = staff users with the e-mail; `currentGroups` = that user's groups; `profile` = UserProfile row or null.
 * Returns { error } when the user is absent or ambiguous, else the writes still needed.
 */
export function planGrant({ found, currentGroups, profile }) {
  if (found.length === 0) return { error: `no staff Cognito user with e-mail ${JENNY_EMAIL} in this stack's staff pool; nothing was created` }
  if (found.length > 1) return { error: `${found.length} staff users share the e-mail ${JENNY_EMAIL}; refusing to guess which one` }
  const have = new Set(currentGroups)
  const profilePages = new Set(profile?.extraPages ?? [])
  return {
    username: found[0].Username,
    addGroups: GRANT_GROUPS.filter((group) => !have.has(group)),
    addExtraPages: profile ? GRANT_KEYS.filter((key) => !profilePages.has(key)) : [],
    profileMissing: profile == null,
  }
}

async function listAllUsers(cognito, poolId) {
  const users = []
  let token
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, PaginationToken: token }))
    users.push(...(page.Users ?? []))
    token = page.PaginationToken
  } while (token)
  return users
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: { apply: { type: 'boolean', default: false } } })
  if (values.apply && !env[STACK_ENV]) {
    throw new Error(`--apply needs ${STACK_ENV}=dev or ${STACK_ENV}=rehearsal set explicitly; it never defaults to a stack`)
  }
  if (STACK.staffPoolId === PRODUCTION.staffPoolId || STACK.tableSuffix === PRODUCTION.tableSuffix) {
    throw new Error('refusing: the resolved stack is production')
  }

  const cognito = new CognitoIdentityProviderClient({ region: REGION })
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))
  const profileTable = `UserProfile-${STACK.tableSuffix}`

  const found = usersWithEmail(await listAllUsers(cognito, STACK.staffPoolId), JENNY_EMAIL)
  let currentGroups = []
  if (found.length === 1) {
    const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: STACK.staffPoolId, Username: found[0].Username }))
    currentGroups = (groups.Groups ?? []).map((g) => g.GroupName)
  }
  let profile = null
  for (let key; ;) {
    const page = await ddb.send(new ScanCommand({ TableName: profileTable, ExclusiveStartKey: key }))
    profile = (page.Items ?? []).find((row) => String(row.email ?? '').trim().toLowerCase() === JENNY_EMAIL.toLowerCase()) ?? profile
    key = page.LastEvaluatedKey
    if (!key) break
  }

  const plan = planGrant({ found, currentGroups, profile })
  console.log(`stack: ${STACK.name} (staff pool ${STACK.staffPoolId}, ${profileTable})`)
  if (plan.error) {
    console.error(`FAILED: ${plan.error}`)
    process.exitCode = 2
    return plan
  }
  console.log(`user: ${plan.username}`)
  console.log(`groups to add: ${plan.addGroups.join(', ') || '(none, already granted)'}`)
  console.log(plan.profileMissing
    ? 'WARNING: no UserProfile row for that e-mail; groups are added but a Users-page save would strip them until the profile exists'
    : `UserProfile.extraPages to add: ${plan.addExtraPages.join(', ') || '(none)'}`)
  if (!values.apply) {
    console.log('dry run: nothing written (pass --apply with BCAT_STACK set to write)')
    return plan
  }

  for (const group of plan.addGroups) {
    try {
      await cognito.send(new CreateGroupCommand({ UserPoolId: STACK.staffPoolId, GroupName: group, Description: 'Per-user billing grant (Step AW)' }))
    } catch (err) {
      if (err?.name !== 'GroupExistsException') throw err
    }
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: STACK.staffPoolId, Username: plan.username, GroupName: group }))
  }
  if (plan.addExtraPages.length > 0 && profile) {
    await ddb.send(new UpdateCommand({
      TableName: profileTable,
      Key: { id: profile.id },
      UpdateExpression: 'SET extraPages = :pages, updatedAt = :now',
      ExpressionAttributeValues: { ':pages': [...new Set([...(profile.extraPages ?? []), ...plan.addExtraPages])], ':now': new Date().toISOString() },
    }))
  }
  console.log('applied')
  return plan
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
