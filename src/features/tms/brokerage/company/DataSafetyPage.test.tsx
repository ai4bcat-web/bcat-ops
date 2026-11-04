// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { DataExportJob, DataStatus } from '@/types/tms'

const api = vi.hoisted(() => ({
  exportNow: vi.fn(),
  getCsvExport: vi.fn(),
  getCsvExportLinks: vi.fn(),
  getDataStatus: vi.fn(),
  listExports: vi.fn(),
  startCsvExport: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

import { DataSafetyPage } from './DataSafetyPage'

const STATUS: DataStatus = {
  bucketName: 'bucket', tableCount: 95, pitrEnabledCount: 93, pitrDisabled: ['Alpha', 'Beta'],
  earliestRestorableTime: '2026-11-02T00:00:00Z', latestNightly: null, nightlyEnabled: true,
  s3SyncCommand: 'aws s3 sync s3://bucket/exports ./bcat-exports',
}
const JOB: DataExportJob = { id: 'csv-1', kind: 'CSV_ALL', status: 'RUNNING', scope: 'TMS', tables: [{ table: 'Customer', status: 'COMPLETED', rows: 12, pii: true }, { table: 'Load', status: 'RUNNING' }] }

beforeEach(() => {
  vi.clearAllMocks()
  api.getDataStatus.mockResolvedValue(STATUS)
  api.listExports.mockResolvedValue({ jobs: [] })
})

const start = () => screen.getByRole('button', { name: /Start CSV export/ })

describe('DataSafetyPage', () => {
  it('shows PITR coverage and the sync command', async () => {
    render(<DataSafetyPage />)
    expect(await screen.findByTestId('backup-status')).toHaveTextContent('93 of 95 tables')
    expect(screen.getByTestId('s3-sync')).toHaveTextContent('aws s3 sync')
    expect(screen.getByText(/Without recovery: Alpha, Beta/)).toBeInTheDocument()
  })

  it('will not start a CSV export until the personal-data acknowledgement is ticked', async () => {
    api.startCsvExport.mockResolvedValue({ job: JOB })
    render(<DataSafetyPage />)
    await screen.findByTestId('backup-status')
    expect(start()).toBeDisabled()
    expect(screen.getByTestId('csv-block-reason')).toHaveTextContent(/personal data/)
    fireEvent.click(screen.getByLabelText('Acknowledge personal data'))
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() => expect(api.startCsvExport).toHaveBeenCalledTimes(1))
    expect(api.startCsvExport.mock.calls[0][0]).toEqual({ scope: 'TMS', acknowledgePii: true })
    expect(await screen.findByTestId('export-progress')).toHaveTextContent('1 of 2 tables')
  })

  it('exporting ALL tables also needs the typed phrase, exactly', async () => {
    api.startCsvExport.mockResolvedValue({ job: { ...JOB, scope: 'ALL' } })
    render(<DataSafetyPage />)
    await screen.findByTestId('backup-status')
    fireEvent.change(screen.getByLabelText('Export scope'), { target: { value: 'ALL' } })
    fireEvent.click(screen.getByLabelText('Acknowledge personal data'))
    expect(start()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm export all'), { target: { value: 'export all' } })
    expect(start()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Confirm export all'), { target: { value: 'EXPORT ALL' } })
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() => expect(api.startCsvExport).toHaveBeenCalled())
    expect(api.startCsvExport.mock.calls[0][0]).toEqual({ scope: 'ALL', acknowledgePii: true, confirmText: 'EXPORT ALL' })
  })

  it('shows the server refusal verbatim', async () => {
    api.startCsvExport.mockRejectedValue(new Error('Owner or ADMIN only.'))
    render(<DataSafetyPage />)
    await screen.findByTestId('backup-status')
    fireEvent.click(screen.getByLabelText('Acknowledge personal data'))
    fireEvent.click(start())
    expect(await screen.findByText('Owner or ADMIN only.')).toBeInTheDocument()
  })

  it('offers download links for a finished export and a manifest', async () => {
    const done: DataExportJob = { ...JOB, status: 'COMPLETED' }
    api.listExports.mockResolvedValue({ jobs: [done] })
    api.getCsvExportLinks.mockResolvedValue({
      jobId: 'csv-1', expiresInSeconds: 900, manifestUrl: 'https://s3.example.invalid/manifest',
      files: [{ name: 'Customer-0001.csv', key: 'k', url: 'https://s3.example.invalid/c', bytes: 2048, pii: true }],
    })
    render(<DataSafetyPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open export csv-1' }))
    expect(await screen.findByText('Customer-0001.csv')).toHaveAttribute('href', 'https://s3.example.invalid/c')
    expect(screen.getByText('Download manifest')).toBeInTheDocument()
    expect(screen.getByText('Links expire in 15 minutes.')).toBeInTheDocument()
  })
})
