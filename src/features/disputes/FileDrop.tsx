import { FileText, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fileContentType } from '@/lib/disputeFiles'

interface FileDropProps {
  id: string
  label: string
  hint: string
  accept: string
  multiple?: boolean
  disabled?: boolean
  files: File[]
  onFiles: (files: File[]) => void
  onRemove: (index: number) => void
  browseLabel: string
}

export function FileDrop({
  id,
  label,
  hint,
  accept,
  multiple = false,
  disabled = false,
  files,
  onFiles,
  onRemove,
  browseLabel,
}: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const take = (list: FileList | null) => {
    const picked = Array.from(list ?? [])
    if (picked.length) onFiles(multiple ? picked : picked.slice(0, 1))
  }

  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--ds-t1)', marginBottom: 4 }}>
        <Upload size={16} /> {label}
      </label>
      <p className="text-xs" style={{ color: 'var(--ds-t3)', marginBottom: 8 }}>
        {hint}
      </p>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (!disabled) take(e.dataTransfer.files)
        }}
        className="flex flex-col items-center justify-center gap-2 rounded-lg text-center"
        style={{
          border: `2px dashed ${dragging ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 20,
          paddingBottom: 20,
          background: dragging ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'border-color 120ms, background 120ms',
        }}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => {
            take(e.target.files)
            e.target.value = '' // allow re-picking the same file after Remove
          }}
          onClick={(e) => e.stopPropagation()}
          className="sr-only"
        />
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: 'var(--ds-blue-bg)', color: 'var(--ds-blue-dark)' }}
        >
          <Upload size={18} />
        </div>
        <span
          className="inline-flex items-center rounded-md text-sm font-semibold"
          style={{ background: 'var(--ds-blue)', color: '#fff', pointerEvents: 'none', paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 8 }}
        >
          {browseLabel}
        </span>
        <span className="text-xs" style={{ color: 'var(--ds-t3)' }}>
          {disabled ? 'Maximum reached' : 'or drag and drop here'}
        </span>
      </div>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
          {files.map((file, i) => (
            <li
              key={`${file.name}-${file.size}-${i}`}
              className="flex items-center gap-2 rounded-md border text-xs"
              style={{ borderColor: 'var(--ds-border)', background: 'var(--ds-surface)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}
            >
              <PhotoPreview file={file} />
              <span className="max-w-[160px] truncate">{file.name}</span>
              <span className="font-mono" style={{ color: 'var(--ds-t3)' }}>
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="rounded font-medium"
                style={{ background: 'var(--ds-red-bg)', color: 'var(--ds-red)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 }}
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PhotoPreview({ file }: { file: File }) {
  // Browsers can't decode every image type we accept (HEIC on Chrome/Firefox); fall back to an icon.
  const [url, setUrl] = useState<string | null>(() =>
    fileContentType(file).startsWith('image/') ? URL.createObjectURL(file) : null,
  )
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  if (!url) return <FileText size={14} style={{ color: 'var(--ds-t3)' }} />
  return (
    <img
      src={url}
      alt="Photo preview"
      width={32}
      height={32}
      className="rounded object-cover"
      onError={() => setUrl(null)}
    />
  )
}

export type { FileDropProps }
