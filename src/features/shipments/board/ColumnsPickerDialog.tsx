/**
 * The R2 Columns picker: every field the board can render, grouped by the record it
 * comes off, with a search box. Checking adds a column to the board; the chosen list
 * reorders by drag (the up/down buttons are the keyboard path), pins left, and sets a
 * width in pixels. Apply hands the board the new layout; Save as template hands the
 * same layout to the caller's `saveShipmentColumnTemplate` — columns, widths and pins
 * together, so a shared template reproduces the board exactly.
 *
 * Pinned columns always sort to the front of the applied order: a pin is a promise
 * about where the column sits, and silently leaving it mid-grid would break it.
 */
import { useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Pin, PinOff } from 'lucide-react'
import { TmsButton, TmsDialog, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { BoardCheckbox, BoardSectionTitle } from './parts'
import { BOARD_COLUMNS, BOARD_COLUMN_GROUPS, type BoardColumn } from '../shipmentViews'

export const COLUMN_WIDTH_MIN = 60
export const COLUMN_WIDTH_MAX = 600

/** What Apply and Save-as-template both hand back. */
export interface ColumnsPickerResult {
  /** Column keys in board order — pinned first, then the rest in the chosen order. */
  columns: string[]
  /** Effective pixel width per chosen column. */
  widths: Record<string, number>
  /** The chosen keys pinned to the front, in board order. */
  pinned: string[]
}

export interface ColumnsPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The board's current column keys, in order. */
  columns: string[]
  /** The board's current width overrides. */
  widths?: Record<string, number>
  /** The board's current pinned keys. */
  pinned?: string[]
  onApply: (next: ColumnsPickerResult) => void
  /** When absent, the dialog offers Apply only. */
  onSaveTemplate?: (next: ColumnsPickerResult & { name: string; shared: boolean }) => void
  /**
   * Offered only when the caller has a template selected that this user may remove;
   * a private template is its owner's alone and a shared one is the owner's or an
   * admin's, which is the caller's judgement, not the dialog's.
   */
  onDeleteTemplate?: () => void
}

const columnByKey: Record<string, BoardColumn> = Object.fromEntries(
  BOARD_COLUMNS.map((c) => [c.key, c]),
)

export function ColumnsPickerDialog({
  open,
  onOpenChange,
  columns,
  widths,
  pinned,
  onApply,
  onSaveTemplate,
  onDeleteTemplate,
}: ColumnsPickerDialogProps) {
  const [chosen, setChosen] = useState<string[]>(columns)
  const [widthMap, setWidthMap] = useState<Record<string, number>>({ ...(widths ?? {}) })
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([...(pinned ?? [])])
  const [query, setQuery] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [shared, setShared] = useState(false)
  const dragIndex = useRef<number | null>(null)

  // Rehydrate from the board on each open, without an effect: the dialog's working
  // copy is state the props seed, not state the props own.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setChosen([...columns])
      setWidthMap({ ...(widths ?? {}) })
      setPinnedKeys([...(pinned ?? [])])
      setQuery('')
      setTemplateName('')
      setShared(false)
      // `dragIndex` is set on drag start and cleared on drop; it is never read
      // across an open, so it does not need clearing during render.
    }
  }

  const catalog = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (col: BoardColumn) =>
      needle === '' || col.label.toLowerCase().includes(needle) || col.key.toLowerCase().includes(needle)
    return BOARD_COLUMN_GROUPS
      .map((group) => ({ group, columns: BOARD_COLUMNS.filter((c) => c.group === group && matches(c)) }))
      .filter((entry) => entry.columns.length > 0)
  }, [query])

  const toggleColumn = (key: string, checked: boolean) => {
    setChosen((cur) => (checked ? [...cur, key] : cur.filter((k) => k !== key)))
    if (!checked) setPinnedKeys((cur) => cur.filter((k) => k !== key))
  }

  const moveColumn = (from: number, to: number) => {
    setChosen((cur) => {
      if (from < 0 || from >= cur.length || to < 0 || to >= cur.length) return cur
      const next = [...cur]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  const togglePin = (key: string) => {
    setPinnedKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
  }

  const setWidth = (key: string, raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed)) return
    const clamped = Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, parsed))
    setWidthMap((cur) => ({ ...cur, [key]: clamped }))
  }

  const payload = (): ColumnsPickerResult => {
    const pinnedSet = new Set(pinnedKeys)
    const orderedPinned = chosen.filter((k) => pinnedSet.has(k))
    const rest = chosen.filter((k) => !pinnedSet.has(k))
    const effectiveWidths: Record<string, number> = {}
    for (const key of chosen) {
      effectiveWidths[key] = widthMap[key] ?? columnByKey[key]?.width ?? 140
    }
    return { columns: [...orderedPinned, ...rest], widths: effectiveWidths, pinned: orderedPinned }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Columns"
      description="Check the fields the board shows, then drag them into order, pin the ones that stay left and set their widths."
      className="tms-dialog-xl"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </TmsButton>
          <TmsButton
            variant="primary"
            disabled={chosen.length === 0}
            onClick={() => {
              onApply(payload())
              onOpenChange(false)
            }}
          >
            Apply
          </TmsButton>
        </>
      }
    >
      <div className="flex gap-4">
        <div className="flex w-1/2 flex-col gap-2">
          <TmsInput
            aria-label="Search columns"
            placeholder="Search columns"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="tms-board-column-list" style={{ maxHeight: 420 }}>
            {catalog.length === 0 ? <span className="tms-board-save-label">No columns match.</span> : null}
            {catalog.map(({ group, columns: groupColumns }) => (
              <div key={group}>
                <BoardSectionTitle>{group}</BoardSectionTitle>
                {groupColumns.map((col) => (
                  <BoardCheckbox
                    key={col.key}
                    id={`tms-cpk-${col.key}`}
                    label={col.label}
                    checked={chosen.includes(col.key)}
                    onChange={(checked) => toggleColumn(col.key, checked)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex w-1/2 flex-col gap-2">
          <BoardSectionTitle hint="Drag to reorder — pinned first on apply">
            Board columns
          </BoardSectionTitle>
          <div className="tms-board-column-list" style={{ maxHeight: 420 }}>
            {chosen.length === 0 ? (
              <span className="tms-board-save-label">Check columns on the left to add them.</span>
            ) : null}
            {chosen.map((key, index) => {
              const col = columnByKey[key]
              if (!col) return null
              const isPinned = pinnedKeys.includes(key)
              return (
                <div
                  key={key}
                  className="tms-board-column-row"
                  draggable
                  onDragStart={(e) => {
                    dragIndex.current = index
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = dragIndex.current
                    if (from != null && from !== index) moveColumn(from, index)
                    dragIndex.current = null
                  }}
                  onDragEnd={() => {
                    dragIndex.current = null
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1">
                    <GripVertical size={14} aria-hidden className="shrink-0 opacity-50" />
                    <span className="truncate text-sm">{col.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <input
                      type="number"
                      aria-label={`Width of ${col.label}`}
                      min={COLUMN_WIDTH_MIN}
                      max={COLUMN_WIDTH_MAX}
                      step={10}
                      className="w-16 rounded border border-[#333] bg-transparent px-1 py-0.5 text-right text-xs"
                      value={widthMap[key] ?? col.width ?? 140}
                      onChange={(e) => setWidth(key, e.target.value)}
                    />
                    <TmsIconButton
                      shape="plain"
                      aria-label={isPinned ? `Unpin ${col.label}` : `Pin ${col.label}`}
                      onClick={() => togglePin(key)}
                    >
                      {isPinned ? <Pin size={14} /> : <PinOff size={14} className="opacity-50" />}
                    </TmsIconButton>
                    <TmsIconButton
                      shape="plain"
                      aria-label={`Move ${col.label} up`}
                      disabled={index === 0}
                      onClick={() => moveColumn(index, index - 1)}
                    >
                      <ArrowUp size={14} />
                    </TmsIconButton>
                    <TmsIconButton
                      shape="plain"
                      aria-label={`Move ${col.label} down`}
                      disabled={index === chosen.length - 1}
                      onClick={() => moveColumn(index, index + 1)}
                    >
                      <ArrowDown size={14} />
                    </TmsIconButton>
                  </span>
                </div>
              )
            })}
          </div>

          {onSaveTemplate ? (
            <div className="flex items-center gap-2">
              <TmsInput
                aria-label="Template name"
                placeholder="Template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <BoardCheckbox
                id="tms-cpk-shared"
                label="Shared"
                checked={shared}
                onChange={setShared}
              />
              <TmsButton
                variant="secondary"
                disabled={!templateName.trim() || chosen.length === 0}
                onClick={() => {
                  onSaveTemplate({ ...payload(), name: templateName.trim(), shared })
                  onOpenChange(false)
                }}
              >
                Save as template
              </TmsButton>
            </div>
          ) : null}

          {onDeleteTemplate ? (
            <TmsButton variant="destructive" onClick={() => { onDeleteTemplate(); onOpenChange(false) }}>
              Delete template
            </TmsButton>
          ) : null}
        </div>
      </div>
    </TmsDialog>
  )
}

export default ColumnsPickerDialog
