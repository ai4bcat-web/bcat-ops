/**
 * Step AB §5.3 — pure CRM backfill planner. Reads the customers we already have and
 * decides which `CrmAccount`, `CrmContact` and `CrmDomain` rows to create. Nothing here
 * overwrites: the apply step writes with `attribute_not_exists(id)`, so a manual claim or
 * an earlier run is never touched. `scripts/backfillCrm.mjs` mirrors this file (plain Node
 * cannot import TypeScript); `backfillCrm.test.mjs` pins the two together.
 */
import { domainOfAddress, isClaimableDomain, normalizeAddress, registrableDomain } from './domains'
import { ownerOf } from './owner'
import type { CrmContactSource, CrmDomainSource } from './types'

export interface BackfillCustomer {
  id: string
  contacts?: unknown
  billingEmail?: string | null
  contactEmail?: string | null
  website?: string | null
  accountOwnerIds?: readonly string[] | null
  defaultSalesRepId?: string | null
}

export interface BackfillExisting {
  accountIds: readonly string[]
  contactIds: readonly string[]
  domainIds: readonly string[]
}

export interface PlannedContact {
  id: string
  customerId: string
  name: string | null
  ownerId: string | null
  source: CrmContactSource
}

export interface PlannedDomain {
  id: string
  customerId: string | null
  source: CrmDomainSource
  conflict: boolean
  conflictCustomerIds: string[]
}

export interface BackfillPlan {
  accounts: string[]
  contacts: PlannedContact[]
  domains: PlannedDomain[]
  stats: {
    customers: number
    accountsToCreate: number
    contactsToCreate: number
    contactsSharedBetweenCustomers: number
    domainsToCreate: number
    domainsConflicted: number
    domainsSkippedIneligible: number
  }
}

/** `a@x.com, B <b@y.com>; c@z.com` → every valid address, lower-cased, in order. */
function addressesIn(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[;,\n]/)
    .map((part) => normalizeAddress(part))
    .filter(Boolean)
}

export function planCrmBackfill(customers: readonly BackfillCustomer[], existing: BackfillExisting): BackfillPlan {
  const haveAccount = new Set(existing.accountIds)
  const haveContact = new Set(existing.contactIds)
  const haveDomain = new Set(existing.domainIds)

  const contactOwners = new Map<string, { customers: Set<string>; name: string | null }>()
  const domainOwners = new Map<string, { customers: Set<string>; fromEmail: boolean }>()
  let skippedIneligible = 0

  const noteDomain = (domain: string, customerId: string, fromEmail: boolean) => {
    if (!domain) return
    if (!isClaimableDomain(domain)) {
      skippedIneligible += 1
      return
    }
    const entry = domainOwners.get(domain) ?? { customers: new Set<string>(), fromEmail: false }
    entry.customers.add(customerId)
    entry.fromEmail = entry.fromEmail || fromEmail
    domainOwners.set(domain, entry)
  }

  for (const customer of customers) {
    const emails: { email: string; name: string | null }[] = []
    if (Array.isArray(customer.contacts)) {
      for (const raw of customer.contacts as Record<string, unknown>[]) {
        const email = normalizeAddress(typeof raw?.email === 'string' ? raw.email : '')
        if (email) emails.push({ email, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null })
      }
    }
    for (const email of [...addressesIn(customer.billingEmail), ...addressesIn(customer.contactEmail)]) {
      emails.push({ email, name: null })
    }
    for (const { email, name } of emails) {
      const entry = contactOwners.get(email) ?? { customers: new Set<string>(), name: null }
      entry.customers.add(customer.id)
      entry.name = entry.name ?? name
      contactOwners.set(email, entry)
      noteDomain(registrableDomain(domainOfAddress(email)), customer.id, true)
    }
    if (customer.website) noteDomain(registrableDomain(customer.website), customer.id, false)
  }

  const ownerById = new Map(customers.map((c) => [c.id, ownerOf(c)]))
  const contacts: PlannedContact[] = []
  let shared = 0
  for (const [id, entry] of contactOwners) {
    if (entry.customers.size > 1) {
      shared += 1
      continue
    }
    if (haveContact.has(id)) continue
    const customerId = [...entry.customers][0]
    contacts.push({ id, customerId, name: entry.name, ownerId: ownerById.get(customerId) ?? null, source: 'BACKFILL' })
  }

  const domains: PlannedDomain[] = []
  for (const [id, entry] of domainOwners) {
    if (haveDomain.has(id)) continue
    const ids = [...entry.customers]
    const conflict = ids.length > 1
    domains.push({
      id,
      customerId: conflict ? null : ids[0],
      source: entry.fromEmail ? 'BACKFILL' : 'WEBSITE',
      conflict,
      conflictCustomerIds: conflict ? ids : [],
    })
  }

  const accounts = customers.filter((c) => !haveAccount.has(c.id)).map((c) => c.id)
  return {
    accounts,
    contacts,
    domains,
    stats: {
      customers: customers.length,
      accountsToCreate: accounts.length,
      contactsToCreate: contacts.length,
      contactsSharedBetweenCustomers: shared,
      domainsToCreate: domains.length,
      domainsConflicted: domains.filter((d) => d.conflict).length,
      domainsSkippedIneligible: skippedIneligible,
    },
  }
}
