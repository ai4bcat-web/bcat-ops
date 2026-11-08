import { CheckRow } from './settingsKit'

/** A wrapped checkbox set for a list of known string options. */
export function CheckGroup<T extends string>({
  name,
  options,
  label,
  selected,
  onToggle,
}: {
  name: string
  options: readonly T[]
  label: (value: T) => string
  selected: T[]
  onToggle: (value: T) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 16, rowGap: 8 }}>
      {options.map((option) => (
        <CheckRow
          key={`${name}-${option}`}
          label={label(option)}
          ariaLabel={label(option)}
          checked={selected.includes(option)}
          onChange={() => onToggle(option)}
        />
      ))}
    </div>
  )
}
