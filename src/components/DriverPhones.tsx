import type { CSSProperties } from 'react'
import { prettyPhone } from '@/lib/dispatch'
import type { DriverPhones as Phones } from '@/lib/workPhone'

/**
 * Both numbers a driver can be reached on, with the truck's work phone first.
 *
 *   Work (truck 12): (312) 555-0100      truck has a phone
 *   Work (truck 12): none                truck has none (orange)
 *   Personal: (312) 555-0199
 *   no truck                             Personal only
 *
 * `compact` is the work line only (personal in the tooltip) for tight rows.
 */
export type DriverPhonesVariant = 'inline' | 'stacked' | 'compact'

const LINE: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }

function PhoneLink({ number }: { number: string }) {
  return <a href={`tel:${number}`} style={{ color: 'inherit' }}>{prettyPhone(number)}</a>
}

export function DriverPhones({ phones, variant }: { phones: Phones; variant: DriverPhonesVariant }) {
  const hasTruck = phones.truckId != null || phones.truckNumber != null
  const personal = phones.personal ?? phones.personalRaw
  const workLabel = `Work (truck ${phones.truckNumber ?? '?'}): `
  const link = variant !== 'compact'

  const work = hasTruck ? (
    <span
      data-testid="driver-phone-work"
      style={{ ...LINE, color: phones.work ? undefined : 'var(--tms-badge-orange)' }}
      title={phones.work?.label ?? undefined}
    >
      {workLabel}
      {phones.work ? (link ? <PhoneLink number={phones.work.number} /> : prettyPhone(phones.work.number)) : 'none'}
    </span>
  ) : null

  const personalLine = personal ? (
    <span data-testid="driver-phone-personal" style={LINE}>
      Personal: {link && phones.personal ? <PhoneLink number={phones.personal} /> : prettyPhone(personal)}
    </span>
  ) : null

  if (variant === 'compact') {
    const only = work ?? personalLine
    return only ? <span style={{ ...LINE, display: 'inline-block', maxWidth: '100%' }} title={personal ? `Personal: ${prettyPhone(personal)}` : undefined}>{only}</span> : null
  }
  if (variant === 'inline') {
    if (!work && !personalLine) return null
    return (
      <span style={{ ...LINE, display: 'inline-flex', gap: 6, maxWidth: '100%' }}>
        {work}
        {work && personalLine ? <span aria-hidden>·</span> : null}
        {personalLine}
      </span>
    )
  }
  if (!work && !personalLine) return null
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {work}
      {personalLine}
    </span>
  )
}
