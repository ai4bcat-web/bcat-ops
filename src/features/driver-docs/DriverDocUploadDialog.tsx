import { useState, useRef, useMemo } from 'react'
import { Upload, X, FileText, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import type { Driver } from '@/types'
import {
  staffUploadDriverDoc,
  DRIVER_DOC_ACCEPT,
  DRIVER_DOC_MAX_PAGES,
  driverDocValidationError,
  type SubmissionKind,
  type SubmissionWithDocs,
} from '@/lib/driverSubmissionsClient'

interface DriverDocUploadDialogProps {
  open: boolean
  onClose: () => void
  drivers: Driver[]
  preselectedDriver?: Driver | null
  preselectedKind?: SubmissionKind
  /**
   * The load this upload is for, when opened from one.
   *
   * Without it the dialog created a submission with no load and no PRO, and nothing
   * afterwards could find it again: the next upload for the same load started a second
   * submission, and the factoring queue got two POD documents for one shipment. With it,
   * the PRO is filled in, the load id travels with the pages, and a later batch joins
   * the first.
   */
  load?: { id: string; aljexId?: string | null } | null
  onSubmitted: (submission: SubmissionWithDocs) => void
  staffEmail: string
}

function activeDrivers(drivers: Driver[]): Driver[] {
  return drivers.filter((d) => d.active !== false)
}

export function DriverDocUploadDialog({
  open,
  onClose,
  drivers,
  preselectedDriver,
  preselectedKind,
  load,
  onSubmitted,
  staffEmail,
}: DriverDocUploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loadPro = (load?.aljexId ?? '').trim()
  const [selectedDriverId, setSelectedDriverId] = useState<string>(preselectedDriver?.id ?? '')
  const [kind, setKind] = useState<SubmissionKind>(preselectedKind ?? 'RATECON')
  const [referenceNumber, setReferenceNumber] = useState(loadPro)
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)

  const selectedDriver = useMemo(
    () => drivers.find((d) => d.id === selectedDriverId),
    [drivers, selectedDriverId],
  )

  const handleFiles = (next: FileList | null) => {
    if (!next) return
    setFiles((prev) => {
      const combined = [...prev, ...Array.from(next)]
      return combined.slice(0, DRIVER_DOC_MAX_PAGES)
    })
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const resetForm = () => {
    setSelectedDriverId(preselectedDriver?.id ?? '')
    setKind(preselectedKind ?? 'RATECON')
    setReferenceNumber(loadPro)
    setNote('')
    setFiles([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleClose = () => {
    if (!uploading) resetForm()
    onClose()
  }

  const handleSubmit = async () => {
    if (!selectedDriver) {
      toast.error('Choose a driver from the roster.')
      return
    }
    const error = driverDocValidationError(files)
    if (error) {
      toast.error(error)
      return
    }
    setUploading(true)
    try {
      const submission = await staffUploadDriverDoc({
        driver: { id: selectedDriver.id, name: selectedDriver.name, email: selectedDriver.email },
        kind,
        files,
        submittedByEmail: staffEmail,
        referenceNumber,
        note,
        loadId: load?.id,
      })
      toast.success(`${kind === 'RATECON' ? 'Rate confirmation' : 'POD'} uploaded for ${selectedDriver.name}`)
      onSubmitted(submission)
      handleClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const canSubmit = Boolean(selectedDriver && files.length > 0 && !uploading)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload driver document</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="driver">Driver</Label>
            <select
              id="driver"
              value={selectedDriverId}
              onChange={(e) => setSelectedDriverId(e.target.value)}
              disabled={uploading || !!preselectedDriver}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              <option value="">Select driver…</option>
              {activeDrivers(drivers).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Document kind</Label>
            <div className="flex gap-2">
              {(['RATECON', 'POD'] as SubmissionKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={uploading || (!!preselectedKind && preselectedKind !== k)}
                  onClick={() => setKind(k)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    kind === k
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background hover:bg-accent'
                  }`}
                >
                  {k === 'RATECON' ? 'Rate confirmation' : 'POD'}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reference">{load ? 'PRO #' : 'Reference # (optional)'}</Label>
            <Input
              id="reference"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Load / VRID / PRO #"
              disabled={uploading}
            />
            {load && (
              <p className="text-xs text-muted-foreground">
                Pages uploaded here join any POD already on this load, as one document.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note for the driver"
              rows={2}
              disabled={uploading}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Pages ({files.length}/{DRIVER_DOC_MAX_PAGES})</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept={DRIVER_DOC_ACCEPT}
              multiple
              disabled={uploading}
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              disabled={uploading || files.length >= DRIVER_DOC_MAX_PAGES}
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-input bg-background px-4 py-6 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              Choose images or PDFs
            </button>
            {files.length > 0 && (
              <div className="space-y-2">
                {files.map((file, i) => (
                  <div key={`${file.name}-${i}`} className="flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>
                    </div>
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={() => removeFile(i)}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {files.length >= DRIVER_DOC_MAX_PAGES && (
              <p className="flex items-center gap-1 text-xs text-amber-600">
                <AlertCircle className="h-3 w-3" /> Maximum {DRIVER_DOC_MAX_PAGES} pages reached.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
