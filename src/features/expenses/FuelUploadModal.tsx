import { useState, useCallback, useRef } from 'react'
import { Upload, X, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { parseEfsTransactionReport, fuelTxDedupKey } from '@/lib/parsers/efsTransactionReport'
import type { ItemCategory } from '@/lib/parsers/efsTransactionReport'
import { createFuelTransaction, checkFuelTxExists, cleanupDuplicateFuelTransactions } from '@/lib/apiClient'
import type { FuelTransaction } from '@/lib/apiClient'
import type { Equipment } from '@/types/equipment'

interface Props {
  trucks: Equipment[]
  onImported: (added: FuelTransaction[]) => void
  onChanged?: () => void   // refetch after a non-import change (duplicate cleanup)
  onClose: () => void
}

interface PreviewRow {
  key: string
  cardNumber: string
  truckLabel: string
  truckId: string | null
  unmapped: boolean
  transactionDate: string
  invoiceNumber: string
  locationName: string
  city: string
  state: string
  fuelType: string
  itemCategory: ItemCategory
  quantity: number
  pricePerUnit: number
  amount: number
  fees: number
  driverName: string
  unitNumber: string
  odometer: number | null
  sourceLineNumber: number
}

function resolveTruck(cardNumber: string, trucks: Equipment[]): Equipment | undefined {
  return trucks.find(
    (t) => t.type === 'truck' && (t.fuelCardNumbers ?? []).includes(cardNumber),
  )
}

function fmtMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

export function FuelUploadModal({ trucks, onImported, onChanged, onClose }: Props) {
  const [step, setStep] = useState<'select' | 'preview' | 'importing' | 'done'>('select')
  const [dragOver, setDragOver] = useState(false)
  const [preview, setPreview] = useState<PreviewRow[]>([])
  const [duplicateCount, setDuplicateCount] = useState(0)
  const [unmappedCards, setUnmappedCards] = useState<string[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [importProgress, setImportProgress] = useState(0)
  const [cleaning, setCleaning] = useState(false)
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null)
  const fileRef = useRef<File | null>(null)

  const runCleanup = useCallback(async () => {
    if (!window.confirm('Scan all fuel transactions and delete duplicate fills (same date, card, fuel type, amount and gallons)? The original of each is kept. This can\'t be undone.')) return
    setCleaning(true); setCleanupMsg(null)
    try {
      const { removed, kept } = await cleanupDuplicateFuelTransactions()
      setCleanupMsg(removed === 0 ? `No duplicates found — ${kept} transactions are all unique.` : `Removed ${removed} duplicate${removed === 1 ? '' : 's'}; ${kept} unique transactions kept.`)
      if (removed > 0) onChanged?.()
    } catch (err) {
      setCleanupMsg(`Cleanup failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally { setCleaning(false) }
  }, [onChanged])

  const processFile = useCallback(async (file: File) => {
    setParseError(null)
    setFileName(file.name)
    fileRef.current = file
    const text = await file.text()
    try {
      const { transactions } = parseEfsTransactionReport(text)

      const rows: PreviewRow[] = transactions.map((tx) => {
        const truck = resolveTruck(tx.cardNumber, trucks)
        return {
          key:             fuelTxDedupKey(tx),
          cardNumber:      tx.cardNumber,
          truckLabel:      truck ? `#${truck.unitNumber}` : `Card ${tx.cardNumber}`,
          truckId:         truck?.id ?? null,
          unmapped:        !truck,
          transactionDate: tx.transactionDate,
          invoiceNumber:   tx.invoiceNumber,
          locationName:    tx.locationName,
          city:            tx.city,
          state:           tx.state,
          fuelType:        tx.fuelType,
          itemCategory:    tx.itemCategory,
          quantity:        tx.quantity,
          pricePerUnit:    tx.pricePerUnit,
          amount:          tx.amount,
          fees:            tx.fees,
          driverName:      tx.driverName,
          unitNumber:      tx.unitNumber,
          odometer:        tx.odometer,
          sourceLineNumber: tx.sourceLineNumber,
        }
      })

      // Check for duplicates against the DB (batch check)
      let dupes = 0
      const checked: PreviewRow[] = []
      for (const row of rows) {
        const exists = await checkFuelTxExists(
          row.transactionDate, row.cardNumber, row.fuelType, row.amount, row.quantity,
        )
        if (exists) { dupes++; continue }
        checked.push(row)
      }

      setDuplicateCount(dupes)
      setPreview(checked)
      setUnmappedCards([...new Set(checked.filter((r) => r.unmapped).map((r) => r.cardNumber))])
      setStep('preview')
    } catch (err) {
      if (err && typeof err === 'object' && 'errors' in err) {
        const gqlErr = (err as { errors: { message: string }[] }).errors
        setParseError(gqlErr?.[0]?.message ?? JSON.stringify(err))
      } else {
        setParseError(err instanceof Error ? err.message : JSON.stringify(err))
      }
    }
  }, [trucks])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [processFile])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }, [processFile])

  const handleConfirm = useCallback(async () => {
    if (!fileRef.current) return
    setStep('importing')
    const text = await fileRef.current.text()
    const { transactions } = parseEfsTransactionReport(text)

    const added: FuelTransaction[] = []
    let skipped = 0

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i]
      const row = preview.find((r) => r.key === fuelTxDedupKey(tx))
      if (!row) { skipped++; continue }

      try {
        const created = await createFuelTransaction({
          transactionDate: tx.transactionDate,
          cardNumber:      tx.cardNumber,
          invoiceNumber:   tx.invoiceNumber || undefined,
          unitNumber:      tx.unitNumber || undefined,
          truckId:         row.truckId || undefined,
          driverName:      tx.driverName || undefined,
          odometer:        tx.odometer ?? undefined,
          locationName:    tx.locationName || undefined,
          city:            tx.city || undefined,
          state:           tx.state || undefined,
          fees:            tx.fees,
          fuelType:        tx.fuelType,
          itemCategory:    tx.itemCategory,
          pricePerUnit:    tx.pricePerUnit,
          quantity:        tx.quantity,
          amount:          tx.amount,
          currency:        tx.currency || 'USD',
          sourceFile:      fileRef.current?.name,
          importedAt:      new Date().toISOString(),
        })
        added.push(created)
      } catch (err) {
        console.error('[FuelUpload] failed to insert tx', tx.invoiceNumber, err)
      }
      setImportProgress(Math.round(((i + 1) / transactions.length) * 100))
    }

    const unmappedSet = [...new Set(added.filter((t) => !t.truckId).map((t) => t.cardNumber))]
    toast.success(
      `Imported ${added.length} fuel transaction${added.length !== 1 ? 's' : ''}`,
      {
        description: [
          duplicateCount > 0 && `${duplicateCount + skipped} duplicates skipped`,
          unmappedSet.length > 0 && `${unmappedSet.length} unmapped card(s): ${unmappedSet.join(', ')}`,
        ].filter(Boolean).join(' · ') || undefined,
      },
    )

    onImported(added)
    setStep('done')
  }, [preview, duplicateCount, onImported])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 shrink-0">
          <h2 className="text-base font-semibold">Import EFS Fuel Report</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* Step: select */}
          {step === 'select' && (
            <div className="p-6">
              <label
                className={cn(
                  'flex flex-col items-center justify-center gap-4 p-12 rounded-xl border-2 border-dashed transition-colors cursor-pointer',
                  dragOver ? 'border-primary bg-sky-50' : 'border-slate-200 hover:border-slate-300',
                )}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <Upload className="size-8 text-muted-foreground" />
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">Drop EFS Transaction Report here</p>
                  <p className="text-xs text-muted-foreground mt-1">or click to browse (.txt)</p>
                </div>
                <input type="file" accept=".txt" className="sr-only" onChange={handleFileInput} />
              </label>
              {parseError && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex gap-2">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  <pre className="whitespace-pre-wrap font-sans">{parseError}</pre>
                </div>
              )}

              {/* Maintenance: one-click duplicate cleanup */}
              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  Already imported the same report twice? Remove duplicate fills.
                  {cleanupMsg && <span className="block mt-1 text-foreground font-medium">{cleanupMsg}</span>}
                </div>
                <button
                  onClick={runCleanup}
                  disabled={cleaning}
                  className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  {cleaning ? <Loader2 className="size-3.5 animate-spin" /> : <AlertTriangle className="size-3.5" />}
                  {cleaning ? 'Cleaning…' : 'Remove duplicates'}
                </button>
              </div>
            </div>
          )}

          {/* Step: preview */}
          {step === 'preview' && (
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm text-foreground font-medium">{fileName}</span>
                <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5 font-medium">
                  {preview.length} new
                </span>
                {duplicateCount > 0 && (
                  <span className="text-xs bg-slate-100 text-slate-600 border border-slate-200 rounded-full px-2 py-0.5 font-medium">
                    {duplicateCount} duplicate{duplicateCount !== 1 ? 's' : ''} skipped
                  </span>
                )}
                {unmappedCards.length > 0 && (
                  <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5 font-medium flex items-center gap-1">
                    <AlertTriangle className="size-3" />
                    Unmapped: {unmappedCards.join(', ')}
                  </span>
                )}
              </div>

              {preview.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  All transactions in this file already exist — nothing to import.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        {['Truck', 'Date', 'Invoice', 'Location', 'Type', 'Gal', '$/gal', 'Fees', 'Total'].map((h) => (
                          <th key={h} className="text-left px-4 py-2.5 font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row) => (
                        <tr key={row.key} className={cn('border-t border-slate-100', row.unmapped && 'bg-amber-50/50')}>
                          <td className="px-4 py-2.5 font-medium whitespace-nowrap">
                            {row.unmapped
                              ? <span className="text-amber-600">{row.truckLabel}</span>
                              : row.truckLabel}
                          </td>
                          <td className="px-4 py-2.5 font-mono whitespace-nowrap">{row.transactionDate}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{row.invoiceNumber}</td>
                          <td className="px-4 py-2.5 max-w-[160px] truncate">{row.locationName}, {row.city}</td>
                          <td className="px-4 py-2.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded font-medium',
                              row.fuelType === 'ULSD' ? 'bg-sky-50 text-sky-700' : 'bg-violet-50 text-violet-700',
                            )}>
                              {row.fuelType}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-right">{row.quantity.toFixed(2)}</td>
                          <td className="px-4 py-2.5 tabular-nums text-right">{fmtMoney(row.pricePerUnit)}</td>
                          <td className="px-4 py-2.5 tabular-nums text-right">
                            {row.fees > 0 ? fmtMoney(row.fees) : <span className="text-muted-foreground/40">—</span>}
                          </td>
                          <td className="px-4 py-2.5 tabular-nums text-right font-medium">{fmtMoney(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Step: importing */}
          {step === 'importing' && (
            <div className="p-12 flex flex-col items-center gap-4">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="text-sm text-foreground font-medium">Importing transactions…</p>
              <div className="w-64 h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{importProgress}%</p>
            </div>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div className="p-12 flex flex-col items-center gap-3">
              <CheckCircle2 className="size-10 text-emerald-500" />
              <p className="text-sm font-medium text-foreground">Import complete</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100 shrink-0">
          <Button variant="outline" onClick={onClose}>
            {step === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {step === 'preview' && preview.length > 0 && (
            <Button onClick={handleConfirm}>
              Import {preview.length} transaction{preview.length !== 1 ? 's' : ''}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
