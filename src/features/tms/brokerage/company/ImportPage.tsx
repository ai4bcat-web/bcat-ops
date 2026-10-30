/**
 * My Brokerage → Company → Import.
 *
 * Spreadsheet import for directory entities: pick an entity, upload a sheet,
 * map columns, preview / dry-run, then run the import.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileUp, Play, RefreshCw, Upload } from 'lucide-react'
import { uploadData } from 'aws-amplify/storage'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsField, TmsSelect, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { listImportJobs, previewImport, runImport, type ImportEntity } from '@/lib/apiClient'
import type { ImportJob } from '@/types/tms'
import { ErrorText, GroupLabel, Loading, Panel, SettingsCard, Stack } from '@/features/settings/settingsKit'

const ENTITIES: ImportEntity[] = [
  'CUSTOMER',
  'LOCATION',
  'CARRIER',
  'CARRIER_FACTOR',
  'CHARGE_CODE',
  'PAYMENT_TERM',
  'VENDOR_CONTACT',
]

const ENTITY_LABELS: Record<ImportEntity, string> = {
  CUSTOMER: 'Customer',
  LOCATION: 'Location',
  CARRIER: 'Carrier',
  CARRIER_FACTOR: 'Carrier factor',
  CHARGE_CODE: 'Charge code',
  PAYMENT_TERM: 'Payment term',
  VENDOR_CONTACT: 'Vendor contact',
}

const TARGET_FIELDS: Record<ImportEntity, string[]> = {
  CUSTOMER: ['name', 'legalName', 'mcNumber', 'dotNumber', 'scac', 'status', 'billingEmail', 'billingPhone', 'creditLimitCents', 'termsDays', 'notes'],
  LOCATION: ['name', 'street', 'city', 'state', 'zip', 'country', 'lat', 'lng', 'phone', 'notes'],
  CARRIER: ['name', 'dba', 'mcNumber', 'dotNumber', 'scac', 'status', 'equipmentType', 'insuranceExpiry', 'notes'],
  CARRIER_FACTOR: ['name', 'remitToName', 'remitToEmail', 'remitToAddress', 'phone'],
  CHARGE_CODE: ['key', 'label', 'category', 'side', 'appliesTo', 'visibility'],
  PAYMENT_TERM: ['key', 'name', 'days', 'description', 'quickPayFeeBps', 'apOnly', 'doNotUse'],
  VENDOR_CONTACT: ['name', 'email', 'phone', 'vendorName', 'role'],
}

const ALIASES: Record<string, string> = {
  'mc#': 'mcNumber',
  'mc #': 'mcNumber',
  'mc': 'mcNumber',
  'dot#': 'dotNumber',
  'dot #': 'dotNumber',
  'dot': 'dotNumber',
  'company': 'name',
  'company name': 'name',
  'address': 'street',
  'postal': 'zip',
  'postal code': 'zip',
  'zip code': 'zip',
  'email': 'billingEmail',
  'phone': 'billingPhone',
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

function guessTarget(entity: ImportEntity, header: string): string {
  const norm = header.trim().toLowerCase()
  const direct = ALIASES[norm]
  if (direct && TARGET_FIELDS[entity].includes(direct)) return direct
  for (const field of TARGET_FIELDS[entity]) {
    if (field.toLowerCase() === norm) return field
  }
  for (const field of TARGET_FIELDS[entity]) {
    if (norm.includes(field.toLowerCase()) || field.toLowerCase().includes(norm)) return field
  }
  return ''
}

export function ImportPage() {
  const [entity, setEntity] = useState<ImportEntity>('CUSTOMER')
  const [file, setFile] = useState<File | null>(null)
  const [fileHash, setFileHash] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [previewJob, setPreviewJob] = useState<ImportJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [parsing, setParsing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listImportJobs()
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

  const targetOptions = useMemo(() => TARGET_FIELDS[entity].map((f) => ({ value: f, label: f })), [entity])

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
        initial[h] = guessTarget(entity, h)
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
    const key = `imports/${fileHash}-${Date.now()}-${safeName}`
    await uploadData({ path: key, data: file, options: { contentType: file.type || 'text/csv' } }).result
    return key
  }

  const mappingToSend = useMemo(() => {
    return Object.fromEntries(Object.entries(mapping).filter(([, v]) => v))
  }, [mapping])

  const handlePreview = async () => {
    if (!fileHash) { setError('Upload a file first.'); return }
    setPreviewing(true)
    setError(null)
    try {
      await handleUpload()
      const result = await previewImport({
        entity,
        fileName: file!.name,
        fileHash,
        mapping: mappingToSend,
        rows: rows.slice(0, 200),
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
    if (!previewJob) { setError('Run preview first.'); return }
    setRunning(true)
    setError(null)
    try {
      const result = await runImport({ jobId: previewJob.id, rows })
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

  const mappingRows = useMemo(() => {
    return headers.map((h) => ({ header: h, target: mapping[h] ?? '' }))
  }, [headers, mapping])

  const mappingColumns: Array<ColumnDef<{ header: string; target: string }>> = [
    { key: 'header', header: 'Sheet header', render: (row) => row.header },
    {
      key: 'target',
      header: 'Target field',
      render: (row) => (
        <TmsSelect
          value={row.target}
          onChange={(e) => setMapping((prev) => ({ ...prev, [row.header]: e.target.value }))}
          options={[{ value: '', label: '— ignore —' }, ...targetOptions]}
        />
      ),
    },
  ]

  const statusTone = (status: ImportJob['status']) => {
    switch (status) {
      case 'APPLIED': return 'green'
      case 'FAILED': return 'red'
      case 'DRY_RUN': return 'turquoise'
      case 'VALIDATED': return 'orange'
      default: return 'gray'
    }
  }

  const jobColumns: Array<ColumnDef<ImportJob>> = [
    { key: 'entity', header: 'Entity', width: 120, render: (row) => ENTITY_LABELS[row.entity] },
    { key: 'status', header: 'Status', width: 100, render: (row) => <TmsBadge tone={statusTone(row.status)}>{row.status}</TmsBadge> },
    { key: 'fileName', header: 'File', render: (row) => row.fileName ?? '—' },
    { key: 'rowCount', header: 'Rows', width: 70, render: (row) => String(row.rowCount ?? '—') },
    {
      key: 'counts',
      header: 'Result',
      render: (row) => {
        const c = row.counts
        if (!c) return '—'
        return `${c.created} created · ${c.updated} updated · ${c.skipped} skipped · ${c.errored} errors`
      },
    },
    { key: 'appliedAt', header: 'Applied', width: 160, render: (row) => row.appliedAt ? new Date(row.appliedAt).toLocaleString() : '—' },
  ]

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
        title="Import data"
        description="Upload a spreadsheet and map its columns to directory fields."
        actions={
          <TmsButton variant="primary" onClick={() => void handlePreview()} disabled={previewing || rows.length === 0}>
            <RefreshCw size={14} /> {previewing ? 'Previewing…' : 'Preview / dry-run'}
          </TmsButton>
        }
      >
        <Stack>
          {error ? <ErrorText>{error}</ErrorText> : null}

          <Panel>
            <GroupLabel>Entity</GroupLabel>
            <TmsField label="What are you importing?">
              <TmsSelect
                value={entity}
                onChange={(e) => {
                  setEntity(e.target.value as ImportEntity)
                  setFile(null)
                  setRows([])
                  setHeaders([])
                  setMapping({})
                  setPreviewJob(null)
                }}
                options={ENTITIES.map((e) => ({ value: e, label: ENTITY_LABELS[e] }))}
              />
            </TmsField>
          </Panel>

          <Panel>
            <GroupLabel>File</GroupLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <TmsButton size="sm" onClick={() => document.getElementById('import-file')?.click()} disabled={parsing}>
                <Upload size={14} /> {parsing ? 'Reading…' : 'Choose CSV'}
              </TmsButton>
              <span className="tms-muted">{file ? file.name : 'No file selected'}</span>
              <input
                id="import-file"
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
                    {rows.slice(0, 5).map((row, i) => (
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
              <p className="tms-field-hint">
                {previewJob.counts
                  ? `${previewJob.counts.created} created · ${previewJob.counts.updated} updated · ${previewJob.counts.skipped} skipped · ${previewJob.counts.errored} errors`
                  : `Status: ${previewJob.status}`}
              </p>
              <TmsButton
                variant="primary"
                onClick={() => void handleRun()}
                disabled={running}
              >
                <Play size={14} /> {running ? 'Running…' : 'Run import'}
              </TmsButton>
            </Panel>
          ) : null}
        </Stack>
      </SettingsCard>

      <TmsCard title="Recent import jobs">
        <TmsTable
          columns={jobColumns}
          rows={jobs}
          rowKey={(row) => row.id}
          empty={<span className="tms-muted">No import jobs yet.</span>}
        />
      </TmsCard>
    </div>
  )
}

export default ImportPage
