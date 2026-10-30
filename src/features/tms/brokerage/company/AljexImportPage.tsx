/**
 * My Brokerage → Company → Import from Aljex.
 *
 * Bulk CSV import for Aljex exports: upload, map columns, dry-run preview,
 * then apply. Idempotent by file hash; owner/ADMIN only (CompanyTab is gated).
 */
import { useEffect, useMemo, useState } from 'react'
import { FileUp, Play, RefreshCw, Upload } from 'lucide-react'
import { uploadData } from 'aws-amplify/storage'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsSelect, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { applyAljexImport, listAljexImportJobs, previewAljexImport } from '@/lib/apiClient'
import type { AljexColumnTarget } from '@/lib/aljexImport'
import type { AljexImportCounts, AljexImportJob } from '@/types/tms'
import { ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'

const TARGET_FIELDS: { value: AljexColumnTarget; label: string }[] = [
  { value: 'pro', label: 'Pro #' },
  { value: 'po', label: 'PO / TMS ID' },
  { value: 'pickupNumber', label: 'PU #' },
  { value: 'customer', label: 'Customer' },
  { value: 'customerMc', label: 'Customer MC' },
  { value: 'originName', label: 'Origin name' },
  { value: 'originCity', label: 'Origin city' },
  { value: 'originState', label: 'Origin state' },
  { value: 'originZip', label: 'Origin zip' },
  { value: 'destinationName', label: 'Destination name' },
  { value: 'destinationCity', label: 'Destination city' },
  { value: 'destinationState', label: 'Destination state' },
  { value: 'destinationZip', label: 'Destination zip' },
  { value: 'pickupDate', label: 'Pickup date' },
  { value: 'deliveryDate', label: 'Delivery date' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'commodity', label: 'Commodity' },
  { value: 'weight', label: 'Weight' },
  { value: 'pieces', label: 'Pieces' },
  { value: 'miles', label: 'Miles' },
  { value: 'customerRate', label: 'Customer rate' },
  { value: 'carrierRate', label: 'Carrier rate' },
  { value: 'carrierName', label: 'Carrier name' },
  { value: 'carrierMc', label: 'Carrier MC' },
  { value: 'invoiceNumber', label: 'Invoice #' },
  { value: 'invoiceDate', label: 'Invoice date' },
  { value: 'invoicePaidDate', label: 'Invoice paid date' },
  { value: 'invoiceAmount', label: 'Invoice amount' },
  { value: 'carrierBillNumber', label: 'Carrier bill #' },
  { value: 'carrierBillAmount', label: 'Carrier bill amount' },
  { value: 'status', label: 'Status' },
]

const ALIASES: Record<string, AljexColumnTarget> = {
  'pro #': 'pro',
  'pro': 'pro',
  'pronumber': 'pro',
  'pro no': 'pro',
  'po #': 'po',
  'po': 'po',
  'tms id': 'po',
  'tmsid': 'po',
  'order #': 'po',
  'pu #': 'pickupNumber',
  'pickup #': 'pickupNumber',
  'punumber': 'pickupNumber',
  'customer': 'customer',
  'shipper': 'customer',
  'customer name': 'customer',
  'customer mc': 'customerMc',
  'shipper mc': 'customerMc',
  'cust mc': 'customerMc',
  'origin': 'originName',
  'shipper name': 'originName',
  'pickup name': 'originName',
  'origin city': 'originCity',
  'from city': 'originCity',
  'origin state': 'originState',
  'from state': 'originState',
  'origin zip': 'originZip',
  'from zip': 'originZip',
  'destination': 'destinationName',
  'consignee name': 'destinationName',
  'delivery name': 'destinationName',
  'destination city': 'destinationCity',
  'to city': 'destinationCity',
  'destination state': 'destinationState',
  'to state': 'destinationState',
  'destination zip': 'destinationZip',
  'to zip': 'destinationZip',
  'pickup date': 'pickupDate',
  'ship date': 'pickupDate',
  'pickup at': 'pickupDate',
  'delivery date': 'deliveryDate',
  'deliver by': 'deliveryDate',
  'delivery at': 'deliveryDate',
  'equipment': 'equipment',
  'equip type': 'equipment',
  'trailer type': 'equipment',
  'commodity': 'commodity',
  'description': 'commodity',
  'freight desc': 'commodity',
  'weight': 'weight',
  'weight lbs': 'weight',
  'total weight': 'weight',
  'pieces': 'pieces',
  'qty': 'pieces',
  'pallets': 'pieces',
  'miles': 'miles',
  'trip miles': 'miles',
  'distance': 'miles',
  'customer rate': 'customerRate',
  'revenue': 'customerRate',
  'sell rate': 'customerRate',
  'total rate': 'customerRate',
  'carrier rate': 'carrierRate',
  'cost': 'carrierRate',
  'buy rate': 'carrierRate',
  'pay rate': 'carrierRate',
  'carrier': 'carrierName',
  'carrier name': 'carrierName',
  'booked carrier': 'carrierName',
  'carrier mc': 'carrierMc',
  'carrier mc #': 'carrierMc',
  'invoice #': 'invoiceNumber',
  'invoice number': 'invoiceNumber',
  'ar invoice': 'invoiceNumber',
  'invoice date': 'invoiceDate',
  'invoiced at': 'invoiceDate',
  'paid date': 'invoicePaidDate',
  'paid at': 'invoicePaidDate',
  'payment date': 'invoicePaidDate',
  'invoice amount': 'invoiceAmount',
  'ar amount': 'invoiceAmount',
  'bill #': 'carrierBillNumber',
  'carrier bill #': 'carrierBillNumber',
  'ap invoice': 'carrierBillNumber',
  'bill amount': 'carrierBillAmount',
  'ap amount': 'carrierBillAmount',
  'status': 'status',
  'shipment status': 'status',
  'load status': 'status',
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
    } else {
      current += char
    }
  }
  values.push(current)
  return values
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = parseCsvLine(lines[0]).map((h) => h.trim())
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i])
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? ''
    })
    rows.push(row)
  }
  return { headers, rows }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function guessTarget(header: string): string {
  const norm = header.trim().toLowerCase()
  const direct = ALIASES[norm]
  if (direct) return direct
  for (const field of TARGET_FIELDS) {
    if (field.value.toLowerCase() === norm) return field.value
  }
  for (const field of TARGET_FIELDS) {
    if (norm.includes(field.label.toLowerCase()) || field.label.toLowerCase().includes(norm)) return field.value
  }
  for (const field of TARGET_FIELDS) {
    if (norm.includes(field.value.toLowerCase()) || field.value.toLowerCase().includes(norm)) return field.value
  }
  return ''
}

function formatCounts(counts: AljexImportCounts | null | undefined): string {
  if (!counts) return 'No counts available'
  const parts: string[] = []
  if (counts.shipmentsCreated) parts.push(`${counts.shipmentsCreated} shipment${counts.shipmentsCreated === 1 ? '' : 's'} created`)
  if (counts.customersCreated) parts.push(`${counts.customersCreated} customer${counts.customersCreated === 1 ? '' : 's'} created`)
  if (counts.locationsCreated) parts.push(`${counts.locationsCreated} location${counts.locationsCreated === 1 ? '' : 's'} created`)
  if (counts.invoicesCreated) parts.push(`${counts.invoicesCreated} invoice${counts.invoicesCreated === 1 ? '' : 's'} created`)
  if (counts.billsCreated) parts.push(`${counts.billsCreated} bill${counts.billsCreated === 1 ? '' : 's'} created`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  if (counts.conflicts) parts.push(`${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}`)
  if (counts.errored) parts.push(`${counts.errored} error${counts.errored === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'Nothing changed'
}

type RowError = { row?: number; message: string }

function parseErrors(job: AljexImportJob | null): RowError[] {
  if (!job) return []
  if (job.note) {
    try {
      const parsed = JSON.parse(job.note)
      if (Array.isArray(parsed)) {
        return parsed.slice(0, 50).map((e) => ({ row: Number(e.row) || undefined, message: String(e.message ?? e) }))
      }
    } catch {
      // note is plain text — treat as a single error/summary.
    }
  }
  return job.note ? [{ message: job.note }] : []
}

export function AljexImportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [fileHash, setFileHash] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [jobs, setJobs] = useState<AljexImportJob[]>([])
  const [previewJob, setPreviewJob] = useState<AljexImportJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [parsing, setParsing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listAljexImportJobs()
      .then((jobRows) => {
        if (cancelled) return
        setJobs(jobRows)
      })
      .catch((err) => {
        if (cancelled) return
        setError(messageOf(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleFileSelect = async (selected: File | undefined) => {
    if (!selected) return
    setParsing(true)
    setError(null)
    setPreviewJob(null)
    try {
      const [text, hash] = await Promise.all([selected.text(), selected.arrayBuffer().then(sha256Hex)])
      const parsed = parseCsv(text)
      setFile(selected)
      setFileHash(hash)
      setHeaders(parsed.headers)
      setRows(parsed.rows)
      const initial: Record<string, string> = {}
      for (const h of parsed.headers) {
        initial[h] = guessTarget(h)
      }
      setMapping(initial)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setParsing(false)
    }
  }

  const handleUpload = async (): Promise<string> => {
    if (!file || !fileHash) throw new Error('No file selected.')
    const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'sheet.csv'
    const key = `imports/aljex/${fileHash}-${Date.now()}-${safeName}`
    await uploadData({ path: key, data: file, options: { contentType: file.type || 'text/csv' } }).result
    return key
  }

  const mappingToSend = useMemo(() => {
    return Object.fromEntries(Object.entries(mapping).filter(([, v]) => v))
  }, [mapping])

  const handlePreview = async () => {
    if (!fileHash || !file) { setError('Upload a file first.'); return }
    setPreviewing(true)
    setError(null)
    try {
      const s3Key = await handleUpload()
      const result = await previewAljexImport({
        s3Key,
        fileName: file.name,
        fileHash,
        mapping: mappingToSend,
      })
      setPreviewJob(result)
      setJobs((prev) => {
        const filtered = prev.filter((j) => j.id !== result.id)
        return [result, ...filtered]
      })
      toast.success('Preview ready')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPreviewing(false)
    }
  }

  const handleRun = async () => {
    if (!fileHash || !file || !previewJob) { setError('Run preview first.'); return }
    setRunning(true)
    setError(null)
    try {
      const s3Key = await handleUpload()
      const result = await applyAljexImport({
        s3Key,
        fileName: file.name,
        fileHash,
        mapping: mappingToSend,
      })
      setPreviewJob(result)
      setJobs((prev) => {
        const filtered = prev.filter((j) => j.id !== result.id)
        return [result, ...filtered]
      })
      toast.success('Import finished')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setRunning(false)
    }
  }

  const mappingRows = useMemo(() => headers.map((h) => ({ header: h, target: mapping[h] ?? '' })), [headers, mapping])

  const mappingColumns: Array<ColumnDef<{ header: string; target: string }>> = [
    { key: 'header', header: 'Sheet header', render: (row) => row.header },
    {
      key: 'target',
      header: 'Target field',
      render: (row) => (
        <TmsSelect
          value={row.target}
          onChange={(e) => setMapping((prev) => ({ ...prev, [row.header]: e.target.value }))}
          options={[{ value: '', label: '— ignore —' }, ...TARGET_FIELDS]}
        />
      ),
    },
  ]

  const statusTone = (status: AljexImportJob['status']) => {
    switch (status) {
      case 'APPLIED': return 'green'
      case 'FAILED': return 'red'
      case 'DRY_RUN': return 'turquoise'
      default: return 'gray'
    }
  }

  const jobColumns: Array<ColumnDef<AljexImportJob>> = [
    { key: 'status', header: 'Status', width: 100, render: (row) => <TmsBadge tone={statusTone(row.status)}>{row.status}</TmsBadge> },
    { key: 'fileName', header: 'File', render: (row) => row.fileName ?? '—' },
    { key: 'rowCount', header: 'Rows', width: 70, render: (row) => String(row.rowCount ?? '—') },
    { key: 'result', header: 'Result', render: (row) => formatCounts(row.counts) },
    { key: 'appliedAt', header: 'Applied', width: 160, render: (row) => row.appliedAt ? new Date(row.appliedAt).toLocaleString() : '—' },
  ]

  const errors = parseErrors(previewJob)

  if (loading) {
    return (
      <TmsCard>
        <Loading />
      </TmsCard>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SettingsCard
        icon={FileUp}
        title="Import from Aljex"
        description="Upload an Aljex export CSV, map its columns, preview the dry-run result, then run the import."
        actions={
          <TmsButton variant="primary" onClick={() => void handlePreview()} disabled={previewing || rows.length === 0}>
            <RefreshCw size={14} /> {previewing ? 'Previewing…' : 'Preview / dry-run'}
          </TmsButton>
        }
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>File</GroupLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <TmsButton size="sm" onClick={() => document.getElementById('aljex-import-file')?.click()} disabled={parsing}>
                <Upload size={14} /> {parsing ? 'Reading…' : 'Choose CSV'}
              </TmsButton>
              <span className="tms-muted">{file ? file.name : 'No file selected'}</span>
              <input
                id="aljex-import-file"
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => { void handleFileSelect(e.target.files?.[0]); e.target.value = '' }}
              />
            </div>
            {fileHash ? <p className="tms-field-hint">SHA-256: {fileHash.slice(0, 16)}…</p> : null}
          </Panel>

          {headers.length > 0 ? (
            <Panel>
              <GroupLabel>Column mapping</GroupLabel>
              <TmsTable
                columns={mappingColumns}
                rows={mappingRows}
                rowKey={(row) => row.header}
                empty={<span className="tms-muted">No columns found.</span>}
              />
              <p className="tms-field-hint">Select a target field for each sheet column, or leave it as “ignore”.</p>
            </Panel>
          ) : null}

          {rows.length > 0 ? (
            <Panel>
              <GroupLabel>First rows</GroupLabel>
              <div style={{ overflowX: 'auto' }}>
                <table className="tms-table">
                  <thead>
                    <tr>
                      {headers.map((h) => <th key={h}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 10).map((row, i) => (
                      <tr key={i}>
                        {headers.map((h) => <td key={h}>{row[h]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {previewJob ? (
            <Panel style={{ background: 'var(--tms-bg-elevated)' }}>
              <GroupLabel>Preview result · {previewJob.id}</GroupLabel>
              <p className="tms-field-hint">{formatCounts(previewJob.counts)}</p>
              {errors.length > 0 ? (
                <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: 8 }}>
                  {errors.map((e, i) => (
                    <p key={i} className="tms-field-error" style={{ margin: '0 0 4px' }}>
                      {e.row != null ? `Row ${e.row}: ` : ''}{e.message}
                    </p>
                  ))}
                </div>
              ) : null}
              <TmsButton
                variant="primary"
                onClick={() => void handleRun()}
                disabled={running || previewJob.status === 'FAILED'}
              >
                <Play size={14} /> {running ? 'Running…' : 'Run import'}
              </TmsButton>
            </Panel>
          ) : null}
        </Stack>
      </SettingsCard>

      <TmsCard title="Recent Aljex import jobs">
        <TmsTable
          columns={jobColumns}
          rows={jobs}
          rowKey={(row) => row.id}
          empty={<span className="tms-muted">No Aljex import jobs yet.</span>}
        />
      </TmsCard>
    </div>
  )
}

export default AljexImportPage
