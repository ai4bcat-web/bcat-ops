// Data-access layer for driver PWA submissions (DriverSubmission + DriverSubmissionDoc).
// Staff use this to upload rate confirmations and PODs on a driver's behalf through
// the regular staff Cognito session (AppSync + S3), producing the same DynamoDB rows
// and S3 key layout that the driver-app-api Lambda creates when a driver scans from
// the PWA.

import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl } from 'aws-amplify/storage'

const client = generateClient()

type GraphQLResult<T> = { data: T }
type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as GraphQLResult<T>
  return result.data
}

// ── Wire types ───────────────────────────────────────────────────────────────

export type SubmissionKind = 'RATECON' | 'POD'
export type SubmissionSource = 'PWA' | 'EMAIL' | 'STAFF'
export type SubmissionStatus = 'NEW' | 'NOTIFIED' | 'LINKED' | 'ARCHIVED'

export interface DriverSubmissionRecord {
  id: string
  driverId: string
  driverName: string
  status?: SubmissionStatus | null
  source?: SubmissionSource | null
  submittedByEmail?: string | null
  externalMessageId?: string | null
  loadId?: string | null
  referenceNumber?: string | null
  note?: string | null
  slackChannelId?: string | null
  slackMessageTs?: string | null
  emailMessageId?: string | null
  emailSubject?: string | null
  notifiedAt?: string | null
  createdAt: string
  updatedAt?: string | null
}

export interface DriverSubmissionDocRecord {
  id: string
  submissionId: string
  driverId: string
  kind: SubmissionKind
  s3Key: string
  fileName?: string | null
  contentType?: string | null
  byteSize?: number | null
  pageNumber?: number | null
  uploadedAt: string
  notifiedAt?: string | null
}

export interface SubmissionWithDocs extends DriverSubmissionRecord {
  docs: DriverSubmissionDocRecord[]
}

export interface StaffDriverInfo {
  id: string
  name: string
  email?: string | null
}

// ── Validation / accepted files ──────────────────────────────────────────────

export const DRIVER_DOC_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export const DRIVER_DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp'
export const DRIVER_DOC_MAX_BYTES = 15 * 1024 * 1024 // 15 MB
export const DRIVER_DOC_MAX_PAGES = 12

function extForFile(file: File): string {
  const type = file.type.toLowerCase()
  if (type === 'application/pdf') return 'pdf'
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg'
  const fromName = file.name.split('.').pop()?.toLowerCase()
  if (fromName === 'pdf') return 'pdf'
  if (fromName === 'png') return 'png'
  if (fromName === 'webp') return 'webp'
  if (fromName === 'jpg' || fromName === 'jpeg') return 'jpg'
  return 'jpg'
}

function contentTypeForFile(file: File): string {
  if (file.type) return file.type
  const ext = extForFile(file)
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

export function isDriverDocFile(file: File): boolean {
  const accepted = (DRIVER_DOC_MIME_TYPES as readonly string[]).includes(file.type)
  const acceptedExt = /\.(pdf|jpe?g|png|webp)$/i.test(file.name)
  return (accepted || acceptedExt) && file.size > 0 && file.size <= DRIVER_DOC_MAX_BYTES
}

export function driverDocValidationError(files: File[]): string | null {
  if (files.length === 0) return 'Select at least one page.'
  if (files.length > DRIVER_DOC_MAX_PAGES) return `At most ${DRIVER_DOC_MAX_PAGES} pages per upload.`
  for (const file of files) {
    if (!isDriverDocFile(file)) {
      return `${file.name} is not an accepted image/PDF or exceeds ${DRIVER_DOC_MAX_BYTES / 1024 / 1024} MB.`
    }
  }
  return null
}

// ── Field selection sets ──────────────────────────────────────────────────────

const SUBMISSION_FIELDS = `
  id driverId driverName status source submittedByEmail externalMessageId loadId
  referenceNumber note slackChannelId slackMessageTs emailMessageId emailSubject
  notifiedAt createdAt updatedAt
`

const DOC_FIELDS = `
  id submissionId driverId kind s3Key fileName contentType byteSize pageNumber uploadedAt notifiedAt
`

// ── Queries ───────────────────────────────────────────────────────────────────

export async function listDriverSubmissions(limit = 1000): Promise<SubmissionWithDocs[]> {
  const result = await gql<{ listDriverSubmissions: { items: DriverSubmissionRecord[]; nextToken?: string | null } }>(
    `query ListDriverSubmissions($limit: Int) {
      listDriverSubmissions(limit: $limit) {
        items { ${SUBMISSION_FIELDS} }
        nextToken
      }
    }`,
    { limit },
  )
  const submissions = result.listDriverSubmissions.items
  return attachDocs(submissions, limit)
}

export async function listDriverSubmissionsByDriver(driverId: string, limit = 1000): Promise<SubmissionWithDocs[]> {
  const result = await gql<{ listDriverSubmissions: { items: DriverSubmissionRecord[]; nextToken?: string | null } }>(
    `query ListDriverSubmissionsByDriver($filter: ModelDriverSubmissionFilterInput, $limit: Int) {
      listDriverSubmissions(filter: $filter, limit: $limit) {
        items { ${SUBMISSION_FIELDS} }
        nextToken
      }
    }`,
    { filter: { driverId: { eq: driverId } }, limit },
  )
  const submissions = result.listDriverSubmissions.items
  return attachDocs(submissions, limit)
}

async function attachDocs(
  submissions: DriverSubmissionRecord[],
  limit: number,
): Promise<SubmissionWithDocs[]> {
  if (submissions.length === 0) return []
  const ids = submissions.map((s) => s.id)
  const allDocs: DriverSubmissionDocRecord[] = []
  for (const submissionId of ids) {
    const docsResult = await gql<{ listDriverSubmissionDocs: { items: DriverSubmissionDocRecord[] } }>(
      `query ListDriverSubmissionDocs($filter: ModelDriverSubmissionDocFilterInput, $limit: Int) {
        listDriverSubmissionDocs(filter: $filter, limit: $limit) {
          items { ${DOC_FIELDS} }
        }
      }`,
      { filter: { submissionId: { eq: submissionId } }, limit },
    )
    allDocs.push(...docsResult.listDriverSubmissionDocs.items)
  }
  const docsBySubmission = new Map<string, DriverSubmissionDocRecord[]>()
  for (const doc of allDocs) {
    const list = docsBySubmission.get(doc.submissionId) ?? []
    list.push(doc)
    docsBySubmission.set(doc.submissionId, list)
  }
  return submissions.map((s) => ({
    ...s,
    docs: docsBySubmission.get(s.id) ?? [],
  }))
}

// ── Find an existing submission to attach a POD ───────────────────────────────

/**
 * Return the submission a new POD should attach to, or null when a fresh submission
 * should be created. Preference order:
 *  1. Same driver + matching referenceNumber (case-insensitive, trimmed).
 *  2. Most recent submission for the driver that already has RATECON docs and no POD docs.
 */
export function pickSubmissionForPod(
  submissions: SubmissionWithDocs[],
  referenceNumber?: string,
): DriverSubmissionRecord | null {
  const sorted = [...submissions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const ref = referenceNumber?.trim()
  if (ref) {
    const match = sorted.find((s) => (s.referenceNumber?.trim() ?? '').toLowerCase() === ref.toLowerCase())
    if (match) return match
  }
  const withRatecon = sorted.find((s) => {
    const kinds = new Set(s.docs.map((d) => d.kind))
    return kinds.has('RATECON') && !kinds.has('POD')
  })
  return withRatecon ?? null
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createDriverSubmission(
  input: Omit<DriverSubmissionRecord, 'id' | 'updatedAt'>,
): Promise<DriverSubmissionRecord> {
  const result = await gql<{ createDriverSubmission: DriverSubmissionRecord }>(
    `mutation CreateDriverSubmission($input: CreateDriverSubmissionInput!) {
      createDriverSubmission(input: $input) { ${SUBMISSION_FIELDS} }
    }`,
    { input },
  )
  return result.createDriverSubmission
}

async function createDriverSubmissionDoc(
  input: Omit<DriverSubmissionDocRecord, 'id' | 'notifiedAt'>,
): Promise<DriverSubmissionDocRecord> {
  const result = await gql<{ createDriverSubmissionDoc: DriverSubmissionDocRecord }>(
    `mutation CreateDriverSubmissionDoc($input: CreateDriverSubmissionDocInput!) {
      createDriverSubmissionDoc(input: $input) { ${DOC_FIELDS} }
    }`,
    { input },
  )
  return result.createDriverSubmissionDoc
}

function driverDocKey(driverId: string, submissionId: string, kind: SubmissionKind, pageNumber: number, ext: string): string {
  return `driver-docs/${driverId}/${submissionId}/${kind}/${Date.now()}-${pageNumber}.${ext}`
}

async function uploadDriverDocFile(key: string, file: File): Promise<void> {
  await uploadData({
    path: key,
    data: file,
    options: { contentType: contentTypeForFile(file) },
  }).result
}

export interface StaffUploadDriverDocInput {
  driver: StaffDriverInfo
  kind: SubmissionKind
  files: File[]
  submittedByEmail: string
  referenceNumber?: string
  note?: string
  loadId?: string
}

/**
 * Upload a RATECON or POD on a driver's behalf. For PODs, attaches to an existing
 * driver submission when one matches (same driver + referenceNumber, or a submission
 * that already has a RATECON but no POD). Otherwise creates a new submission.
 */
export async function staffUploadDriverDoc(input: StaffUploadDriverDocInput): Promise<SubmissionWithDocs> {
  const error = driverDocValidationError(input.files)
  if (error) throw new Error(error)

  const now = new Date().toISOString()

  if (input.kind === 'POD') {
    const candidates = await listDriverSubmissionsByDriver(input.driver.id)
    const existing = pickSubmissionForPod(candidates, input.referenceNumber)
    if (existing) {
      return staffAddPodToSubmission(existing.id, input)
    }
  }

  const submission = await createDriverSubmission({
    driverId: input.driver.id,
    driverName: input.driver.name,
    status: 'NEW',
    source: 'STAFF',
    submittedByEmail: input.submittedByEmail,
    loadId: input.loadId ?? null,
    referenceNumber: input.referenceNumber?.trim() || null,
    note: input.note?.trim() || null,
    createdAt: now,
  })

  const docs: DriverSubmissionDocRecord[] = []
  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i]
    const pageNumber = i + 1
    const key = driverDocKey(input.driver.id, submission.id, input.kind, pageNumber, extForFile(file))
    await uploadDriverDocFile(key, file)
    const doc = await createDriverSubmissionDoc({
      submissionId: submission.id,
      driverId: input.driver.id,
      kind: input.kind,
      s3Key: key,
      fileName: file.name,
      contentType: contentTypeForFile(file),
      byteSize: file.size,
      pageNumber,
      uploadedAt: now,
    })
    docs.push(doc)
  }

  return { ...submission, docs }
}

/**
 * Add POD pages to an existing driver submission. Used by the staff upload flow when
 * a driver already has a matching RATECON submission.
 */
export async function staffAddPodToSubmission(
  submissionId: string,
  input: Omit<StaffUploadDriverDocInput, 'kind' | 'referenceNumber' | 'note' | 'loadId'>,
): Promise<SubmissionWithDocs> {
  const error = driverDocValidationError(input.files)
  if (error) throw new Error(error)

  const now = new Date().toISOString()
  const existing = await gql<{ getDriverSubmission: DriverSubmissionRecord | null }>(
    `query GetDriverSubmission($id: ID!) {
      getDriverSubmission(id: $id) { ${SUBMISSION_FIELDS} }
    }`,
    { id: submissionId },
  )
  if (!existing.getDriverSubmission) {
    throw new Error('Submission not found')
  }
  const submission = existing.getDriverSubmission

  const docs: DriverSubmissionDocRecord[] = []
  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i]
    const pageNumber = i + 1
    const key = driverDocKey(input.driver.id, submission.id, 'POD', pageNumber, extForFile(file))
    await uploadDriverDocFile(key, file)
    const doc = await createDriverSubmissionDoc({
      submissionId: submission.id,
      driverId: input.driver.id,
      kind: 'POD',
      s3Key: key,
      fileName: file.name,
      contentType: contentTypeForFile(file),
      byteSize: file.size,
      pageNumber,
      uploadedAt: now,
    })
    docs.push(doc)
  }

  return { ...submission, docs }
}

// ── Signed URLs ───────────────────────────────────────────────────────────────

export async function getDriverDocUrl(s3Key: string): Promise<string> {
  const result = await getUrl({ path: s3Key, options: { expiresIn: 3600 } })
  return result.url.toString()
}
