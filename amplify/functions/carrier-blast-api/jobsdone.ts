/**
 * IAM-signed client for the JobsDone OS AppSync API.
 *
 * This lets the carrier-blast Lambda read the shared/dedicated client list so it
 * knows whether to hold back the per-mailbox reserve for the JobsDone engine.
 * Signing uses the Lambda's execution role (@aws_iam), so no long-lived tokens.
 */
import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { Sha256 } from '@aws-crypto/sha256-js'

const LIST_CLIENTS_QUERY = `query {
  listClients(limit: 50) {
    items {
      id
      name
      slug
      status
      instantlyMode
      instantlyMailboxes
    }
  }
}`

export type JobsDoneClient = {
  name: string
  status: string
  instantlyMode: string | null
  instantlyMailboxes: string[]
}

/**
 * Fetch JobsDone OS clients. Never throws — any error or timeout returns
 * `{ reachable: false, clients: [] }` so the capacity call degrades to the
 * static reserve instead of failing.
 */
export async function fetchJobsDoneClients(): Promise<{
  reachable: boolean
  clients: JobsDoneClient[]
}> {
  const endpoint = process.env.JOBSDONE_GRAPHQL_URL
  if (!endpoint) {
    console.error('[jobsdone] JOBSDONE_GRAPHQL_URL not configured')
    return { reachable: false, clients: [] }
  }

  const region = process.env.AWS_REGION ?? 'us-east-1'
  const url = new URL(endpoint)

  const signer = new SignatureV4({
    service: 'appsync',
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  })

  const request = new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: url.pathname,
    method: 'POST',
    body: JSON.stringify({ query: LIST_CLIENTS_QUERY }),
    headers: {
      host: url.hostname,
      'Content-Type': 'application/json',
    },
  })

  let signed
  try {
    signed = await signer.sign(request)
  } catch (err) {
    console.error('[jobsdone] signing error', err)
    return { reachable: false, clients: [] }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(endpoint, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const text = await res.text().catch(() => '')

    if (!res.ok) {
      console.error('[jobsdone] HTTP error', res.status, text)
      return { reachable: false, clients: [] }
    }

    let json: { data?: { listClients?: { items?: unknown[] } }; errors?: unknown[] } | null = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    if (!json || Array.isArray(json.errors)) {
      console.error('[jobsdone] GraphQL errors', json?.errors)
      return { reachable: false, clients: [] }
    }

    const items = json.data?.listClients?.items ?? []
    const clients: JobsDoneClient[] = items.map((item: unknown) => {
      const record = item as Record<string, unknown>
      return {
        name: String(record.name ?? ''),
        status: String(record.status ?? ''),
        instantlyMode: record.instantlyMode ? String(record.instantlyMode) : null,
        instantlyMailboxes: Array.isArray(record.instantlyMailboxes)
          ? record.instantlyMailboxes.map(String)
          : [],
      }
    })

    return { reachable: true, clients }
  } catch (err) {
    clearTimeout(timeout)
    console.error('[jobsdone] request error', err)
    return { reachable: false, clients: [] }
  }
}
