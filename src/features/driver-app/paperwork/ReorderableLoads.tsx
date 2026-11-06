/**
 * The day's open loads as blocks the driver can put in the order they are running them:
 * drag the handle, or tap the Up / Down buttons (the fallback for a thumb that will not
 * drag). Reordering is per LOAD — a load's own stops stay in route order inside its block.
 */
import type { ReactNode } from 'react'
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react'

export interface LoadBlock { id: string; label: string }

function SortableBlock({ block, index, count, onMove, children }: {
  block: LoadBlock
  index: number
  count: number
  onMove: (from: number, to: number) => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: block.id })
  const btn = 'flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground disabled:opacity-30'
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`flex flex-col gap-2 ${isDragging ? 'opacity-80' : ''}`}
    >
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag load ${block.label} to reorder`}
          className="flex h-9 w-9 shrink-0 cursor-grab items-center justify-center rounded-md border border-border bg-card text-muted-foreground active:cursor-grabbing"
          style={{ touchAction: 'none' }}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">Load {block.label}</span>
        <button type="button" className={btn} disabled={index === 0} onClick={() => onMove(index, index - 1)} aria-label={`Move load ${block.label} up`}>
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className={btn} disabled={index === count - 1} onClick={() => onMove(index, index + 1)} aria-label={`Move load ${block.label} down`}>
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {children}
    </li>
  )
}

export function ReorderableLoads({ blocks, render, onReorder }: {
  /** The open loads, in the order shown. */
  blocks: LoadBlock[]
  /** The cards of one load. */
  render: (id: string) => ReactNode
  /** The load ids in their new order. */
  onReorder: (ids: string[]) => void
}) {
  // Touch needs a short press so a scroll is not read as a drag; the handle also sets
  // touch-action: none, so a deliberate drag on it never scrolls the page.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = blocks.map((b) => b.id)
  const move = (from: number, to: number) => onReorder(arrayMove(ids, from, to))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {blocks.map((b, i) => (
          <SortableBlock key={b.id} block={b} index={i} count={blocks.length} onMove={move}>
            {render(b.id)}
          </SortableBlock>
        ))}
      </SortableContext>
    </DndContext>
  )
}
