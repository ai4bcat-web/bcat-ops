// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { AljexImportJob, AljexStageSummary } from '@/types/tms'

const api = vi.hoisted(() => ({
  applyAljexImport: vi.fn(),
  cancelAljexImport: vi.fn(),
  getAljexImport: vi.fn(),
  getAljexProfile: vi.fn(),
  listAljexImports: vi.fn(),
  pauseAljexImport: vi.fn(),
  planAljexImport: vi.fn(),
  prepareAljexImport: vi.fn(),
  resumeAljexImport: vi.fn(),
  sampleAljexImport: vi.fn(),
  saveAljexProfile: vi.fn(),
  stageAljexImport: vi.fn(),
  getAljexReportLinks: vi.fn(),
  reconcileAljexImport: vi.fn(),
  seedProCounter: vi.fn(),
  syncImportedCarriers: vi.fn(),
  listIntegrations: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('./components/uploadFile', () => ({ putWithProgress: vi.fn().mockResolvedValue(undefined) }))

import { CUSTOMER_COLUMNS } from '@/lib/aljex/layouts/customers'
import { AljexImportPage } from './AljexImportPage'

const STAGE_OK: AljexStageSummary = {
  rows: 100, loads: 95, memos: 5, junkDates: 0, duplicatePros: 0, raggedRows: 0, parseErrors: 0,
  distinct: { status: [{ value: 'OPEN', count: 60 }, { value: 'DELIVERED', count: 40 }], typeOfShipment: [{ value: 'DEBT', count: 5 }] },
}
const STAGE_UNMAPPED: AljexStageSummary = {
  ...STAGE_OK,
  distinct: { ...STAGE_OK.distinct, status: [...(STAGE_OK.distinct.status ?? []), { value: 'MYSTERY', count: 3 }] },
}

const job = (over: Partial<AljexImportJob> = {}): AljexImportJob => ({
  id: 'aljexrun:1', kind: 'IMPORT', status: 'PLANNED', phase: 'PLAN', layoutId: 'aljex-full-486-v1', fileName: 'export.csv',
  createdBy: 'owner@example.invalid', startedAt: '2026-11-03T11:00:00Z', rowCount: 100, stage: STAGE_OK,
  plan: { classes: { CREATE: 90, ENRICH: 5, LINK: 0, AMBIGUOUS: 0, CONFLICT: 0 }, warnings: [] },
  ...over,
})

async function openJobAt(j: AljexImportJob, label: RegExp) {
  api.listAljexImports.mockResolvedValue([j])
  api.getAljexImport.mockResolvedValue(j)
  render(<AljexImportPage />)
  fireEvent.click(await screen.findByRole('button', { name: `Open ${j.id}` }))
  await waitFor(() => expect(api.getAljexImport).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: label }))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getAljexProfile.mockResolvedValue(null)
  api.listIntegrations.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('AljexImportPage — Apply gates', () => {
  it('keeps Apply disabled while a value in the file has no mapping, and says why', async () => {
    await openJobAt(job({ stage: STAGE_UNMAPPED }), /5\. Apply/)
    expect(screen.getByRole('button', { name: /Apply to rehearsal copy/ })).toBeDisabled()
    expect(screen.getByTestId('apply-block-reason')).toHaveTextContent(/unmapped value/)
  })

  it('enables Apply on a planned, fully mapped job with a rehearsal tag and sends the target', async () => {
    api.applyAljexImport.mockResolvedValue(job({ status: 'RUNNING', phase: 'CUSTOMER' }))
    await openJobAt(job(), /5\. Apply/)
    const apply = screen.getByRole('button', { name: /Apply to rehearsal copy/ })
    expect(apply).toBeDisabled() // no tag yet
    fireEvent.change(screen.getByLabelText('Rehearsal tag'), { target: { value: 'rh1103' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() => expect(api.applyAljexImport).toHaveBeenCalledTimes(1))
    expect(api.applyAljexImport.mock.calls[0][0]).toMatchObject({
      jobId: 'aljexrun:1', options: { target: 'REHEARSAL', targetTag: 'rh1103', expectedRows: 100 },
    })
  })

  it('LIVE needs the typed tag, and real data also needs the reconciled-rehearsal gate', async () => {
    await openJobAt(job({ rehearsalGate: { ok: false, reason: 'No RECONCILED rehearsal exists for this file.' } }), /5\. Apply/)
    fireEvent.change(screen.getByLabelText('Import target'), { target: { value: 'LIVE' } })
    const apply = screen.getByRole('button', { name: /Apply to LIVE/ })
    expect(apply).toBeDisabled()
    expect(screen.getByTestId('apply-block-reason')).toHaveTextContent(/live tag/i)
    fireEvent.change(screen.getByLabelText('Live tag'), { target: { value: 'GO-LIVE' } })
    expect(apply).toBeDisabled()
    expect(screen.getByTestId('apply-block-reason')).toHaveTextContent('No RECONCILED rehearsal exists for this file.')
    expect(within(screen.getByTestId('rehearsal-gate')).getByText('Rehearsal required')).toBeInTheDocument()
  })

  it('a synthetic LIVE run is allowed with just the tag', async () => {
    api.applyAljexImport.mockResolvedValue(job({ status: 'RUNNING' }))
    await openJobAt(job({ synthetic: true }), /5\. Apply/)
    fireEvent.change(screen.getByLabelText('Import target'), { target: { value: 'LIVE' } })
    fireEvent.change(screen.getByLabelText('Live tag'), { target: { value: 'ZZ-IMPORT-1k' } })
    const apply = screen.getByRole('button', { name: /Apply to LIVE/ })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() => expect(api.applyAljexImport).toHaveBeenCalled())
    expect(api.applyAljexImport.mock.calls[0][0].options).toMatchObject({ target: 'LIVE', liveTag: 'ZZ-IMPORT-1k', synthetic: true })
  })
})

describe('AljexImportPage — Profile and Plan gates', () => {
  it('lists the unmapped value in red, blocks Plan, and unblocks it once the value is mapped on the edited profile', async () => {
    await openJobAt(job({ status: 'READY', stage: STAGE_UNMAPPED, plan: null }), /2\. Profile/)
    const row = within(screen.getByTestId('profile-status-map')).getByText('MYSTERY').closest('tr')!
    expect(row).toHaveAttribute('data-unmapped', 'true')
    expect(screen.getByText(/1 unmapped value block the import/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue to Review' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Status MYSTERY treated as'), { target: { value: 'OPEN' } })
    expect(row).not.toHaveAttribute('data-unmapped')
    // Mapped but unsaved: still cannot move on.
    expect(screen.getByRole('button', { name: 'Continue to Review' })).toBeDisabled()
    expect(screen.getByTestId('profile-version')).toHaveTextContent('Unsaved changes')

    api.saveAljexProfile.mockImplementation(async (input) => ({ id: input.layoutId, fingerprint: 'f', headerCount: 486, version: 2, profile: input.profile, createdBy: 'a', updatedBy: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(screen.getByTestId('profile-version')).toHaveTextContent('Saved · version 2'))
    expect(api.saveAljexProfile.mock.calls[0][0].profile.statusMap.MYSTERY).toBeDefined()
    expect(screen.getByRole('button', { name: 'Continue to Review' })).toBeEnabled()
  })

  it('refuses to plan while the profile has unsaved changes', async () => {
    await openJobAt(job({ status: 'READY', plan: null }), /4\. Plan/)
    expect(screen.getByRole('button', { name: 'Plan' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '2. Profile' }))
    fireEvent.change(screen.getByLabelText('Own fleet carrier match'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: '4. Plan' }))
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDisabled()
    expect(screen.getByTestId('plan-block-reason')).toHaveTextContent('Save the profile first.')
  })
})

describe('AljexImportPage — Stalled', () => {
  it('shows a RUNNING job with an old heartbeat as Stalled and resumes it from the banner', async () => {
    const stalled = job({ status: 'RUNNING', phase: 'LOAD', heartbeatAt: '2020-01-01T00:00:00Z', plan: null })
    api.resumeAljexImport.mockResolvedValue({ ...stalled, heartbeatAt: new Date().toISOString() })
    api.listAljexImports.mockResolvedValue([stalled])
    api.getAljexImport.mockResolvedValue(stalled)
    render(<AljexImportPage />)

    const open = await screen.findByRole('button', { name: 'Open aljexrun:1' })
    expect(screen.getAllByText('Stalled').length).toBeGreaterThan(0)
    expect(open).toHaveTextContent('Resume…')
    fireEvent.click(open)

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/Stalled/)
    fireEvent.click(within(banner).getByRole('button', { name: /Resume/ }))
    await waitFor(() => expect(api.resumeAljexImport).toHaveBeenCalledWith('aljexrun:1'))
  })

  it('does not call a freshly beating RUNNING job stalled, and offers Pause instead', async () => {
    const live = job({ status: 'RUNNING', phase: 'LOAD', heartbeatAt: new Date().toISOString(), plan: null })
    api.listAljexImports.mockResolvedValue([live])
    api.getAljexImport.mockResolvedValue(live)
    render(<AljexImportPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open aljexrun:1' }))
    expect(await screen.findByRole('button', { name: /Pause/ })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AljexImportPage — sensitive columns', () => {
  async function pickCsv(header: string) {
    api.listAljexImports.mockResolvedValue([])
    render(<AljexImportPage />)
    const file = new File([`${header}\nrow\n`], 'carriers.csv', { type: 'text/csv' })
    fireEvent.change(await screen.findByLabelText('Aljex export file'), { target: { files: [file] } })
  }

  it('refuses to upload a file whose header still has Fed/SS #, Bank Account or Routing #, naming the columns', async () => {
    await pickCsv('"Vendor Name","Fed/SS #","Bank Account","Routing #","MC #"')
    expect(await screen.findByTestId('sensitive-refusal')).toHaveTextContent(/Fed\/SS #, Bank Account, Routing #/)
    expect(screen.getByRole('button', { name: /Upload and stage/ })).toBeDisabled()
    expect(api.prepareAljexImport).not.toHaveBeenCalled()
  })

  it('shows no refusal for a clean header', async () => {
    await pickCsv('"Vendor Name","MC #"')
    await screen.findByTestId('layout-detection')
    expect(screen.queryByTestId('sensitive-refusal')).toBeNull()
  })
})

describe('AljexImportPage — per-file kinds', () => {
  const header = (extra: string[] = []) => [...Object.values(CUSTOMER_COLUMNS), ...extra].map((h) => `"${h}"`).join(',')
  const pick = async (h: string) => {
    api.listAljexImports.mockResolvedValue([])
    render(<AljexImportPage />)
    fireEvent.change(await screen.findByLabelText('Aljex export file'), { target: { files: [new File([`${h}\nrow\n`], 'customers.csv', { type: 'text/csv' })] } })
  }

  it('refuses a customer list that still has the Web Password column', async () => {
    await pick(header(['Web Password']))
    expect(await screen.findByTestId('sensitive-refusal')).toHaveTextContent(/Web Password/)
    expect(screen.getByRole('button', { name: /Upload and stage/ })).toBeDisabled()
  })

  it('uploads a recognised customer list under its own layout and then offers the dry run and apply', async () => {
    const staged = job({ id: 'aljexrun:c1', status: 'READY', phase: 'STAGE', layoutId: 'aljex-customers-master-v1', fileName: 'customers.csv', rowCount: 1, stage: null, plan: null })
    api.prepareAljexImport.mockResolvedValue({ job: { ...staged, status: 'STAGING', phase: 'UPLOAD' }, uploadUrl: 'https://put', uploadKey: 'k' })
    api.stageAljexImport.mockResolvedValue(staged)
    await pick(header())
    expect(await screen.findByTestId('directory-layout')).toHaveTextContent(/Customer list recognised/)
    const upload = screen.getByRole('button', { name: /Upload and stage/ })
    expect(upload).toBeEnabled()
    fireEvent.click(upload)
    await waitFor(() => expect(api.stageAljexImport).toHaveBeenCalledWith('aljexrun:c1'))
    expect(api.prepareAljexImport.mock.calls[0][0]).toMatchObject({ layoutId: 'aljex-customers-master-v1', fileName: 'customers.csv' })
    expect(await screen.findByRole('button', { name: 'Dry run' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '2. Profile' })).toBeNull()
  })
})
