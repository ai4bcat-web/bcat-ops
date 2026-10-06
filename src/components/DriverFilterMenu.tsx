/**
 * Choose whose loads the calendar shows.
 *
 * Ivan's own drivers are dispatched from this board, so they are on by default.
 * Owner-operators bring their own work and are settled elsewhere; their loads are
 * usually noise here, so they start hidden and can be switched on, as a group or one at
 * a time, when someone needs to see them.
 *
 * The selection is remembered per browser. It is a working preference, not data, and a
 * dispatcher who hid the owner-operators should not have to hide them again after a
 * refresh. If storage is unavailable the default simply applies.
 */
import { useMemo } from 'react'
import { Users, Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { getColor } from '@/lib/driverColors'
import {
  driversInGroup,
  selectableDrivers,
  driverFilterSummary,
  DRIVER_GROUP_LABEL,
  type DriverGroup,
  type FilterableDriver,
} from '@/lib/driverFilter'

interface Props {
  drivers: FilterableDriver[]
  visibleDriverIds: Set<string>
  onChange: (ids: string[]) => void
}

const GROUPS: DriverGroup[] = ['IVAN', 'OWNER_OP']

/** A checkbox row. Not DropdownMenuItem: that closes the menu, and this is multi-select. */
function Row({
  label, checked, swatch, onToggle,
}: {
  label: string
  checked: boolean
  swatch?: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '6px 8px', borderRadius: 6, border: 'none', background: 'none',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
        color: 'var(--ds-t1)', textAlign: 'left',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 15, height: 15, borderRadius: 4, flexShrink: 0,
          border: `1px solid ${checked ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
          background: checked ? 'var(--ds-blue)' : 'transparent',
          color: '#fff',
        }}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      {swatch && (
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: swatch, flexShrink: 0 }} />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
}

export function DriverFilterMenu({ drivers, visibleDriverIds, onChange }: Props) {
  const all = useMemo(() => selectableDrivers(drivers), [drivers])
  const byGroup = useMemo(
    () => GROUPS.map((group) => ({ group, members: driversInGroup(drivers, group) })),
    [drivers],
  )
  const summary = driverFilterSummary(drivers, visibleDriverIds)

  const toggleDriver = (id: string) => {
    const next = new Set(visibleDriverIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  /** A group header toggles its whole group, on unless every member is already on. */
  const toggleGroup = (members: FilterableDriver[]) => {
    const allOn = members.length > 0 && members.every((d) => visibleDriverIds.has(d.id))
    const next = new Set(visibleDriverIds)
    for (const d of members) {
      if (allOn) next.delete(d.id)
      else next.add(d.id)
    }
    onChange([...next])
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Drivers shown: ${summary}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            height: 30, padding: '0 10px', borderRadius: 20,
            border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
            color: 'var(--ds-t2)', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          <Users size={12} />
          {summary}
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" style={{ width: 252, maxHeight: 420, overflowY: 'auto' }}>
        <div style={{ display: 'flex', gap: 6, padding: '4px 8px 6px' }}>
          <button
            type="button"
            onClick={() => onChange(all.map((d) => d.id))}
            style={quickBtn}
          >
            Show all
          </button>
          <button type="button" onClick={() => onChange([])} style={quickBtn}>
            Show none
          </button>
        </div>

        {byGroup.map(({ group, members }, i) => {
          if (members.length === 0) return null
          const allOn = members.every((d) => visibleDriverIds.has(d.id))
          return (
            <div key={group}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel style={{ padding: '2px 8px' }}>
                <Row
                  label={`${DRIVER_GROUP_LABEL[group]} (${members.length})`}
                  checked={allOn}
                  onToggle={() => toggleGroup(members)}
                />
              </DropdownMenuLabel>
              <div style={{ paddingLeft: 14 }}>
                {members.map((d) => (
                  <Row
                    key={d.id}
                    label={d.name}
                    checked={visibleDriverIds.has(d.id)}
                    swatch={getColor(d.colorKey).avatarBg}
                    onToggle={() => toggleDriver(d.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}

        {all.length === 0 && (
          <p style={{ margin: 0, padding: '8px 10px', fontSize: 12.5, color: 'var(--ds-t3)' }}>
            No active drivers to filter.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const quickBtn: React.CSSProperties = {
  flex: 1, height: 26, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11.5, fontWeight: 600, color: 'var(--ds-t2)',
  border: '1px solid var(--ds-border)', background: 'var(--ds-bg)',
}
