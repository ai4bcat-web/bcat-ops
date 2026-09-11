import { useMemo, useRef, useState } from 'react'
import { Download, Plus, Trash2, RotateCcw, FileSpreadsheet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { useCarrierContacts } from '@/hooks/useCarrierBlast'
import {
  parseCarrierCsv,
  parseCarrierPaste,
  buildImportPreview,
  previewToContactInputs,
  type CsvRow,
} from './carrierCsv'
import { downloadCarrierContactsCsv } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import type { CarrierLane, CarrierContact } from '@/types'

interface LanePanelProps {
  lane: CarrierLane
}

function LanePanel({ lane }: LanePanelProps) {
  const { user } = useAuth()
  const { items, counts, loading, saving, refresh, importContacts, setStatus } = useCarrierContacts(lane)
  const [mode, setMode] = useState<'csv' | 'paste'>('csv')
  const [pasteText, setPasteText] = useState('')
  const [preview, setPreview] = useState<{ new: CsvRow[]; duplicates: CsvRow[]; invalid: CsvRow[] } | null>(null)
  const [search, setSearch] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((c) =>
      c.email.includes(q) ||
      (c.company ?? '').toLowerCase().includes(q) ||
      (c.firstName ?? '').toLowerCase().includes(q) ||
      (c.lastName ?? '').toLowerCase().includes(q)
    )
  }, [items, search])

  const handleFile = async (file: File) => {
    try {
      const text = await file.text()
      const rows = parseCarrierCsv(text)
      if (rows.length === 0) {
        toast.error('No valid rows found — make sure the file has an email column')
        return
      }
      setPreview(buildImportPreview(rows, items, lane))
      setMode('csv')
    } catch (err) {
      toast.error(`Couldn't read file: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const handlePastePreview = () => {
    const rows = parseCarrierPaste(pasteText)
    if (rows.length === 0) {
      toast.error('No emails found')
      return
    }
    setPreview(buildImportPreview(rows, items, lane))
  }

  const handleImport = async () => {
    if (!preview || preview.new.length === 0) return
    const source = mode === 'csv' ? 'csv-upload' : 'paste'
    const inputs = previewToContactInputs(preview.new, lane, source, user?.email ?? '')
    await importContacts(inputs)
    setPreview(null)
    setPasteText('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleExport = () => {
    const filename = `carriers-${lane.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`
    downloadCarrierContactsCsv(filename, items)
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>
            {lane === 'IL_IA' ? 'IL → IA' : 'IL → WI'}
          </h3>
          <p style={{ fontSize: 12, color: 'var(--ds-t3)', margin: '3px 0 0' }}>
            {counts.active} active · {counts.removed} removed · {counts.bounced} bounced · {counts.unsubscribed} unsubscribed
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download size={14} /> Export
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--ds-border)', paddingBottom: 8 }}>
        <button
          onClick={() => setMode('csv')}
          style={{
            fontSize: 12.5, fontWeight: 500, padding: '4px 10px', borderRadius: 6,
            border: 'none', background: mode === 'csv' ? 'var(--ds-blue-bg)' : 'transparent',
            color: mode === 'csv' ? 'var(--ds-blue-dark)' : 'var(--ds-t3)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Upload CSV
        </button>
        <button
          onClick={() => setMode('paste')}
          style={{
            fontSize: 12.5, fontWeight: 500, padding: '4px 10px', borderRadius: 6,
            border: 'none', background: mode === 'paste' ? 'var(--ds-blue-bg)' : 'transparent',
            color: mode === 'paste' ? 'var(--ds-blue-dark)' : 'var(--ds-t3)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Paste emails
        </button>
      </div>

      {mode === 'csv' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
            }}
            style={{ fontSize: 13, color: 'var(--ds-t2)' }}
          />
          <p style={{ fontSize: 11, color: 'var(--ds-t3)', margin: 0 }}>
            Columns: email (required), first_name, last_name, company. Header names are matched loosely.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="one@carrier.com, two@carrier.com; three@carrier.com"
            rows={4}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="outline" size="sm" onClick={handlePastePreview}>
              <FileSpreadsheet size={14} /> Preview
            </Button>
          </div>
        </div>
      )}

      {preview && (
        <div style={{ background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--ds-t2)' }}>
            <span style={{ color: 'var(--ds-green)' }}><strong>{preview.new.length}</strong> new</span>
            <span style={{ color: 'var(--ds-amber)' }}><strong>{preview.duplicates.length}</strong> duplicate</span>
            <span style={{ color: 'var(--ds-red)' }}><strong>{preview.invalid.length}</strong> invalid</span>
          </div>
          {preview.new.length > 0 && (
            <Button size="sm" onClick={handleImport} disabled={saving}>
              <Plus size={14} /> Import {preview.new.length} contact{preview.new.length === 1 ? '' : 's'}
            </Button>
          )}
          {preview.invalid.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--ds-red)' }}>
              Invalid: {preview.invalid.slice(0, 5).map((r) => r.email).join(', ')}{preview.invalid.length > 5 ? ` +${preview.invalid.length - 5} more` : ''}
            </div>
          )}
        </div>
      )}

      <Input
        placeholder="Search contacts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && items.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
          {search ? 'No contacts match your search.' : 'No contacts in this lane yet.'}
        </div>
      ) : (
        <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--ds-border)', borderRadius: 8 }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead style={{ width: 90 }}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((contact) => (
                <ContactRow key={contact.id} contact={contact} onSetStatus={setStatus} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function ContactRow({
  contact,
  onSetStatus,
}: {
  contact: CarrierContact
  onSetStatus: (id: string, status: CarrierContact['status']) => Promise<CarrierContact>
}) {
  const next = contact.status === 'removed' ? 'active' : 'removed'
  return (
    <TableRow>
      <TableCell style={{ fontSize: 12.5, color: 'var(--ds-t1)' }}>{contact.email}</TableCell>
      <TableCell style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>
        {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—'}
      </TableCell>
      <TableCell style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>{contact.company || '—'}</TableCell>
      <TableCell>
        <StatusBadge status={contact.status} />
      </TableCell>
      <TableCell>
        <button
          onClick={() => { void onSetStatus(contact.id, next) }}
          title={contact.status === 'removed' ? 'Restore contact' : 'Remove contact'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 8px',
            borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
            color: contact.status === 'removed' ? 'var(--ds-green)' : 'var(--ds-red)',
            fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {contact.status === 'removed' ? <RotateCcw size={12} /> : <Trash2 size={12} />}
          {contact.status === 'removed' ? 'Restore' : 'Remove'}
        </button>
      </TableCell>
    </TableRow>
  )
}

function StatusBadge({ status }: { status: CarrierContact['status'] }) {
  const color =
    status === 'active' ? { bg: 'var(--ds-green-bg)', text: 'var(--ds-green)' } :
    status === 'removed' ? { bg: 'var(--ds-bg-3)', text: 'var(--ds-t3)' } :
    status === 'bounced' ? { bg: 'var(--ds-red-bg)', text: 'var(--ds-red)' } :
    { bg: 'var(--ds-amber-bg)', text: 'var(--ds-amber)' }
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
      background: color.bg, color: color.text, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  )
}

export function ListsTab() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 20 }}>
      <LanePanel lane="IL_IA" />
      <LanePanel lane="IL_WI" />
    </div>
  )
}
