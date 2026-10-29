export interface TmsFilterChipProps {
  /** The field phrase, e.g. "Customer is". Italic until it carries a value. */
  label: string
  value?: string | null
  onClick?: () => void
  title?: string
}

export function TmsFilterChip({ label, value, onClick, title }: TmsFilterChipProps) {
  const set = Boolean(value)
  return (
    <button
      type="button"
      className={`tms-chip${set ? ' tms-chip-set' : ''}`}
      onClick={onClick}
      title={title}
    >
      {set ? `${label} ${value}` : label}
    </button>
  )
}

export default TmsFilterChip
