/**
 * The Columns dialog every dense grid shares (Shipments Active / All, Load Tracking, Intake).
 * Left: every field the grid can show as one scrollable list, a sticky section per group, one
 * 36px row per field, filtered by the search box, with "Select all" per group. Right: the chosen
 * columns in order; each row has a drag handle (arrow keys move it too), the width in px, a pin
 * toggle and a remove button. Templates (when the caller offers them) sit along the bottom.
 *
 * A width is only part of the layout once the person set it: an untouched column keeps following
 * its header-measured default, so Apply and Save-as-template carry explicit widths only.
 * "Reset widths" drops every explicit width. Pinned columns sort to the front of the applied order:
 * a pin is a promise about where the column sits.
 */
import { useMemo, useRef, useState } from 'react'
import { GripVertical, Pin, PinOff, X } from 'lucide-react'
import { TmsButton, TmsDialog, TmsIconButton, TmsInput } from '@/features/tms/kit'
import { headerFont } from './columnMeasure'
import { clampWidth, defaultColumnWidth, MAX_USER_WIDTH, MIN_USER_WIDTH, type DenseColumn } from './denseGridModel'
import './columns-dialog.css'

export interface ColumnsDialogResult {
  /** Column keys in grid order: pinned first, then the rest in the chosen order. */
  columns: string[]
  /** The widths the person set, by column key. Columns absent here follow their default. */
  widths: Record<string, number>
  /** The chosen keys pinned to the front, in grid order. */
  pinned: string[]
}

export interface ColumnsDialogProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Every column the grid can show, in catalog order. Fixed (icon / action) columns are left
   * out; sections come from each def's `group`, in order of first appearance.
   */
  catalog: readonly DenseColumn<T>[]
  /** The grid's current column keys, in order. */
  columns: string[]
  /** The person's current explicit widths. */
  widths?: Record<string, number>
  /** The grid's current pinned keys. */
  pinned?: string[]
  onApply: (next: ColumnsDialogResult) => void
  /** When absent, the dialog offers Apply only. */
  onSaveTemplate?: (next: ColumnsDialogResult & { name: string; shared: boolean }) => void
  /** Offered only when the caller has a template selected that this user may remove. */
  onDeleteTemplate?: () => void
  /** Dialog title; defaults to "Columns". */
  title?: string
}

const DEFAULT_GROUP = 'Columns'

export function ColumnsDialog<T>({
  open,
  onOpenChange,
  catalog,
  columns,
  widths,
  pinned,
  onApply,
  onSaveTemplate,
  onDeleteTemplate,
  title = 'Columns',
}: ColumnsDialogProps<T>) {
  const [chosen, setChosen] = useState<string[]>(columns)
  const [widthMap, setWidthMap] = useState<Record<string, number>>({ ...(widths ?? {}) })
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([...(pinned ?? [])])
  const [query, setQuery] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [shared, setShared] = useState(false)
  const dragIndex = useRef<number | null>(null)

  // Rehydrate from the grid on each open, without an effect: the working copy is state the
  // props seed, not state the props own.
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
    }
  }

  const fields = useMemo(() => catalog.filter((c) => !c.fixed), [catalog])
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields])
  const chosenSet = new Set(chosen)

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const byGroup = new Map<string, { total: number; shown: DenseColumn<T>[] }>()
    for (const field of fields) {
      const group = field.group ?? DEFAULT_GROUP
      const entry = byGroup.get(group) ?? { total: 0, shown: [] }
      entry.total += 1
      if (needle === '' || field.header.toLowerCase().includes(needle) || field.key.toLowerCase().includes(needle)) {
        entry.shown.push(field)
      }
      byGroup.set(group, entry)
    }
    return [...byGroup.entries()]
      .map(([group, entry]) => ({ group, ...entry }))
      .filter((s) => s.shown.length > 0)
  }, [fields, query])

  const font = headerFont()
  const defaultWidthOf = (key: string): number => {
    const def = fieldByKey.get(key)
    return def ? defaultColumnWidth(def, font) : MIN_USER_WIDTH
  }

  const toggleColumn = (key: string, checked: boolean) => {
    setChosen((cur) => (checked ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((k) => k !== key)))
    if (!checked) setPinnedKeys((cur) => cur.filter((k) => k !== key))
  }

  const selectAllInGroup = (group: readonly DenseColumn<T>[]) => {
    setChosen((cur) => [...cur, ...group.map((f) => f.key).filter((k) => !cur.includes(k))])
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

  const typeWidth = (key: string, raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 0) return
    setWidthMap((cur) => ({ ...cur, [key]: parsed }))
  }

  const payload = (): ColumnsDialogResult => {
    const pinnedSet = new Set(pinnedKeys)
    const orderedPinned = chosen.filter((k) => pinnedSet.has(k))
    const rest = chosen.filter((k) => !pinnedSet.has(k))
    const out: Record<string, number> = {}
    for (const [key, px] of Object.entries(widthMap)) out[key] = clampWidth(px)
    return { columns: [...orderedPinned, ...rest], widths: out, pinned: orderedPinned }
  }

  const templatePayload = (): ColumnsDialogResult => {
    const base = payload()
    const widthsOfChosen: Record<string, number> = {}
    for (const key of base.columns) if (base.widths[key] != null) widthsOfChosen[key] = base.widths[key]
    return { ...base, widths: widthsOfChosen }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Check the fields to show, drag them into order, pin the ones that stay left and set their widths."
      className="tms-columns-dialog"
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
      <div className="tms-cd-panes">
        <section className="tms-cd-pane" aria-label="Available fields">
          <TmsInput
            aria-label="Search columns"
            placeholder="Search columns"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="tms-cd-list" data-testid="cd-available">
            {sections.length === 0 ? <span className="tms-cd-empty">No columns match.</span> : null}
            {sections.map(({ group, shown, total }) => {
              const picked = shown.filter((f) => chosenSet.has(f.key)).length
              return (
                <div key={group} className="tms-cd-section" role="group" aria-label={group}>
                  <div className="tms-cd-group">
                    <span className="tms-cd-group-name">{group}</span>
                    <span className="tms-cd-group-count">
                      {picked}/{shown.length === total ? total : `${shown.length} shown`}
                    </span>
                    <button
                      type="button"
                      className="tms-cd-link"
                      aria-label={`Select all in ${group}`}
                      disabled={picked === shown.length}
                      onClick={() => selectAllInGroup(shown)}
                    >
                      Select all
                    </button>
                  </div>
                  {shown.map((field) => (
                    <label key={field.key} className="tms-cd-field" htmlFor={`tms-cd-${field.key}`}>
                      <input
                        id={`tms-cd-${field.key}`}
                        type="checkbox"
                        checked={chosenSet.has(field.key)}
                        onChange={(e) => toggleColumn(field.key, e.target.checked)}
                      />
                      <span className="tms-cd-label">{field.header}</span>
                    </label>
                  ))}
                </div>
              )
            })}
          </div>
        </section>

        <section className="tms-cd-pane" aria-label="Chosen columns">
          <div className="tms-cd-head">
            <span className="tms-cd-title">Grid columns · {chosen.length}</span>
            <button
              type="button"
              className="tms-cd-link"
              disabled={Object.keys(widthMap).length === 0}
              onClick={() => setWidthMap({})}
            >
              Reset widths
            </button>
          </div>
          <div className="tms-cd-list" data-testid="cd-chosen">
            {chosen.length === 0 ? <span className="tms-cd-empty">Check columns on the left to add them.</span> : null}
            {chosen.map((key, index) => {
              const field = fieldByKey.get(key)
              if (!field) return null
              const isPinned = pinnedKeys.includes(key)
              return (
                <div
                  key={key}
                  className="tms-cd-row"
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
                  <button
                    type="button"
                    className="tms-cd-grip"
                    aria-label={`Reorder ${field.header}`}
                    title="Drag, or use the arrow keys"
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        moveColumn(index, index - 1)
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        moveColumn(index, index + 1)
                      }
                    }}
                  >
                    <GripVertical size={14} aria-hidden />
                  </button>
                  <span className="tms-cd-name">{field.header}</span>
                  <input
                    type="number"
                    aria-label={`Width of ${field.header}`}
                    min={MIN_USER_WIDTH}
                    max={MAX_USER_WIDTH}
                    step={10}
                    className="tms-cd-width"
                    value={widthMap[key] ?? defaultWidthOf(key)}
                    onChange={(e) => typeWidth(key, e.target.value)}
                    onBlur={() => setWidthMap((cur) => (cur[key] == null ? cur : { ...cur, [key]: clampWidth(cur[key]) }))}
                  />
                  <TmsIconButton
                    shape="plain"
                    aria-label={isPinned ? `Unpin ${field.header}` : `Pin ${field.header}`}
                    aria-pressed={isPinned}
                    onClick={() => togglePin(key)}
                  >
                    {isPinned ? <Pin size={14} /> : <PinOff size={14} className="opacity-50" />}
                  </TmsIconButton>
                  <TmsIconButton shape="plain" aria-label={`Remove ${field.header}`} onClick={() => toggleColumn(key, false)}>
                    <X size={14} />
                  </TmsIconButton>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {onSaveTemplate || onDeleteTemplate ? (
        <div className="tms-cd-templates">
          {onSaveTemplate ? (
            <>
              <TmsInput
                aria-label="Template name"
                placeholder="Template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <label className="tms-cd-shared" htmlFor="tms-cd-shared">
                <input id="tms-cd-shared" type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
                <span>Shared</span>
              </label>
              <TmsButton
                variant="secondary"
                disabled={!templateName.trim() || chosen.length === 0}
                onClick={() => {
                  onSaveTemplate({ ...templatePayload(), name: templateName.trim(), shared })
                  onOpenChange(false)
                }}
              >
                Save as template
              </TmsButton>
            </>
          ) : null}
          {onDeleteTemplate ? (
            <TmsButton
              variant="destructive"
              onClick={() => {
                onDeleteTemplate()
                onOpenChange(false)
              }}
            >
              Delete template
            </TmsButton>
          ) : null}
        </div>
      ) : null}
    </TmsDialog>
  )
}

export default ColumnsDialog
