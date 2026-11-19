/**
 * The Chase ACH file for the Selected tab (Accounts payable page, as the other AP actions).
 *
 * Preview first: every chosen bill is READY, BLOCKED (with the reason) or SKIPPED (not ACH). The screen only
 * ever sees last fours; the numbers stay in the Lambda and go into the downloaded file. Exporting marks the
 * ready bills "Exported to Chase" but posts nothing: Ryne uploads the file at chase.com, then records the
 * payments with the existing Record payment step. If the upload never happens, "Undo mark" clears it.
 */
import { useEffect, useState } from 'react'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import {
  clearChaseAchMark,
  exportChaseAch,
  previewChaseAch,
  type ChaseAchExport,
  type ChaseAchFormat,
  type ChaseAchPreview,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'

function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=us-ascii` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export function ChaseAchDialog({ billIds, onClose, onDone }: {
  billIds: string[]
  onClose: () => void
  /** The marks changed: reload the bills. */
  onDone: () => void
}) {
  const [effectiveDate, setEffectiveDate] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<ChaseAchPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState(false)
  const [format, setFormat] = useState<ChaseAchFormat>('NACHA')
  const [result, setResult] = useState<ChaseAchExport | null>(null)

  useEffect(() => {
    let live = true
    previewChaseAch({ billIds, ...(effectiveDate ? { effectiveDate } : {}) })
      .then((p) => { if (live) { setPreview(p); setError(null) } })
      .catch((e: unknown) => { if (live) setError(errorText(e, 'Could not build the preview')) })
    return () => { live = false }
  }, [billIds, effectiveDate])

  const exportNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await exportChaseAch({ billIds, ...(effectiveDate ? { effectiveDate } : {}), includeAlreadyExported: again, format })
      downloadText(out.fileName, out.fileText, format === 'CSV' ? 'text/csv' : 'text/plain')
      setResult({ ...out, fileText: '' })
      onDone()
    } catch (e) {
      setError(errorText(e, 'Could not export the file'))
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!result) return
    setBusy(true)
    try {
      await clearChaseAchMark({ billIds: result.exportedBillIds })
      setResult(null)
      onDone()
      onClose()
    } catch (e) {
      setError(errorText(e, 'Could not undo the mark'))
    } finally {
      setBusy(false)
    }
  }

  const canExport = Boolean(preview && preview.settingsReady && !preview.effectiveDateProblem && preview.readyCount > 0
    && (again || preview.readyCount > preview.alreadyExportedCount))

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Chase ACH file"
      description="Pays ACH carriers in one file you upload at chase.com. Nothing is sent to the bank from here and no payment is recorded: after Chase accepts the file, record each payment as usual."
      footer={
        result ? (
          <>
            <TmsButton variant="ghost" onClick={undo} disabled={busy}>Undo mark</TmsButton>
            <TmsButton variant="primary" onClick={onClose}>Done</TmsButton>
          </>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
            <TmsButton variant="primary" aria-label="Download Chase ACH file" onClick={exportNow} disabled={busy || !canExport}>
              {busy ? 'Building…' : preview ? `Download file (${again ? preview.readyCount : preview.readyCount - preview.alreadyExportedCount} · ${formatCents(preview.readyTotalCents)})` : 'Download file'}
            </TmsButton>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        {!preview && !error && <p className="tms-muted">Checking {billIds.length} bills…</p>}

        {result && (
          <div className="flex flex-col gap-2" data-testid="chase-ach-result">
            <p>
              Downloaded <strong>{result.fileName}</strong>: {result.entryCount} payment{result.entryCount === 1 ? '' : 's'}, {formatCents(result.totalCents)}, effective {result.effectiveDate}.
            </p>
            <p className="tms-muted text-xs">
              Upload it at Chase › ACH Payment Services › ACH file upload{result.fileName.endsWith('.csv') ? ' (CSV)' : ''}. The bills are marked "Exported to Chase"; they stay on Selected until you record the payments.
            </p>
            {result.notExported.length > 0 && (
              <p className="tms-muted text-xs">{result.notExported.length} bill{result.notExported.length === 1 ? ' was' : 's were'} not in the file; see the list on the Selected tab.</p>
            )}
          </div>
        )}

        {preview && !result && (
          <>
            {!preview.settingsReady && (
              <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }} data-testid="chase-ach-settings-problem">
                {preview.settingsProblem}
              </p>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <TmsField label="Effective date" htmlFor="chase-ach-date">
                <TmsInput id="chase-ach-date" type="date" value={effectiveDate ?? preview.effectiveDate} onChange={(e) => setEffectiveDate(e.target.value || undefined)} />
              </TmsField>
              <TmsField label="File format" htmlFor="chase-ach-format">
                <TmsSelect
                  id="chase-ach-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value === 'CSV' ? 'CSV' : 'NACHA')}
                  options={[{ value: 'NACHA', label: 'NACHA file (.ach)' }, { value: 'CSV', label: 'Chase CSV (.csv)' }]}
                />
              </TmsField>
              <span className="tms-muted text-xs">When the carriers are paid. At least one bank business day out.</span>
              {preview.alreadyExportedCount > 0 && (
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
                  Include {preview.alreadyExportedCount} already exported
                </label>
              )}
            </div>
            {format === 'CSV' && (
              <p className="tms-muted text-xs" data-testid="chase-csv-note">
                The CSV leaves the Chase pay-from account blank. BCAT never stores your account number: choose it when you upload at Chase, or type it into the "Chase Acct" column of the batch row.
              </p>
            )}
            {preview.effectiveDateProblem && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{preview.effectiveDateProblem}</p>}
            <p className="text-sm">
              <strong>{preview.readyCount}</strong> ready ({formatCents(preview.readyTotalCents)})
              {preview.blockedCount > 0 && <> · <strong>{preview.blockedCount}</strong> blocked</>}
              {preview.skippedCount > 0 && <> · <strong>{preview.skippedCount}</strong> not ACH or not selected</>}
            </p>
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              <table className="tms-table" data-testid="chase-ach-rows">
                <thead>
                  <tr><th>PRO</th><th>Pay to</th><th>Account</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.billId}>
                      <td>{row.pro || '—'}</td>
                      <td>{row.payeeName}{row.payeeKind === 'FACTOR' ? ' (factor)' : ''}</td>
                      <td>{row.last4 ? `••${row.last4}` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{formatCents(row.amountCents)}</td>
                      <td>
                        {row.status === 'READY' ? (
                          <>
                            <TmsBadge tone="green">Ready</TmsBadge>
                            {row.alreadyExportedAt && <> <TmsBadge tone="gray">exported {row.alreadyExportedAt.slice(0, 10)}</TmsBadge></>}
                            {row.warnings?.map((w) => <span key={w} className="tms-muted text-xs"> {w}</span>)}
                          </>
                        ) : (
                          <>
                            <TmsBadge tone={row.status === 'BLOCKED' ? 'red' : 'gray'}>{row.status === 'BLOCKED' ? 'Blocked' : 'Skipped'}</TmsBadge>
                            <span className="tms-muted text-xs"> {row.reason}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </TmsDialog>
  )
}
