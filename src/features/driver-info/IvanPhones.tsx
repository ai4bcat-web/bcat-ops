import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Smartphone } from 'lucide-react'
import { useDrivers } from '@/hooks/useDrivers'
import { graphqlErrorText, listCompanyPhones, updateCompanyPhone, type CompanyPhone } from '@/lib/apiClient'
import { phoneAssignmentWrites, phoneOf } from '@/lib/companyPhones'

const TH: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '8px 14px', borderBottom: '1px solid var(--tms-border)', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { fontSize: 13, color: 'var(--tms-text)', padding: '9px 14px', borderBottom: '1px solid var(--tms-border)', whiteSpace: 'nowrap' }
const INPUT: React.CSSProperties = { height: 30, borderRadius: 6, border: '1px solid var(--tms-border)', padding: '0 8px', fontSize: 13, background: 'var(--tms-card)', color: 'var(--tms-text)', fontFamily: 'inherit' }

const telHref = (n: string) => `tel:${n.replace(/[^\d+]/g, '')}`

function Num({ value }: { value?: string | null }) {
  if (!value?.trim()) return <span style={{ color: 'var(--tms-muted)' }}>—</span>
  return <a href={telHref(value)} style={{ color: 'var(--tms-text)', textDecoration: 'none', fontVariantNumeric: 'tabular-nums' }}>{value}</a>
}

/**
 * Ivan's local drivers with both their numbers: their own phone, and the company phone
 * they carry. The company number belongs to the device (Ivan Cartage #1, #2, ...), so
 * handing a phone to someone else carries its number with it.
 */
export function IvanPhones() {
  const { drivers } = useDrivers()
  const [phones, setPhones] = useState<CompanyPhone[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    listCompanyPhones().then(setPhones).catch((err) => {
      console.warn('[ivan-phones] could not load company phones', err)
      setPhones([])
    })
  }, [])
  useEffect(load, [load])

  const locals = useMemo(
    () => drivers.filter((d) => d.fleetGroup === 'LOCAL' && d.active !== false && d.type !== 'broker').sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  )
  const nameOf = useMemo(() => new Map(drivers.map((d) => [d.id, d.name])), [drivers])

  const assign = async (driverId: string, label: string | null) => {
    if (!phones) return
    const writes = phoneAssignmentWrites(phones, driverId, label)
    if (writes.length === 0) return
    setBusy(true)
    try {
      for (const w of writes) await updateCompanyPhone(w)
      setPhones(phones.map((p) => {
        const w = writes.find((x) => x.label === p.label)
        return w ? { ...p, assignedDriverId: w.assignedDriverId } : p
      }))
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not assign the phone')
      load()
    } finally {
      setBusy(false)
    }
  }

  const saveNumber = async (label: string, number: string) => {
    const current = phones?.find((p) => p.label === label)
    if (!current || (current.number ?? '') === number.trim()) return
    try {
      await updateCompanyPhone({ label, number: number.trim() || null })
      setPhones((ps) => ps?.map((p) => (p.label === label ? { ...p, number: number.trim() || null } : p)) ?? ps)
      toast.success(`${label} number saved`)
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not save the number')
    }
  }

  return (
    <div style={{ border: '1px solid var(--tms-border)', borderRadius: 12, background: 'var(--tms-card)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>
          <Smartphone size={15} style={{ color: 'var(--tms-muted)' }} /> Ivan local driver phones
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--tms-muted)' }}>Their own number and the company phone they carry</span>
      </div>

      {/* Same shape as the fleet card above: the table on the left, a fixed side panel on the right, so the two cards line up. */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup><col style={{ width: '27%' }} /><col style={{ width: '24%' }} /><col style={{ width: '29%' }} /><col style={{ width: '20%' }} /></colgroup>
          <thead>
            <tr><th style={TH}>Driver</th><th style={TH}>Personal phone</th><th style={TH}>Company phone</th><th style={TH}>Company number</th></tr>
          </thead>
          <tbody>
            {locals.map((d) => {
              const mine = phones ? phoneOf(phones, d.id) : null
              return (
                <tr key={d.id}>
                  <td style={{ ...TD, fontWeight: 600 }}>{d.name}</td>
                  <td style={TD}><Num value={d.phone} /></td>
                  <td style={TD}>
                    <select aria-label={`Company phone for ${d.name}`} disabled={!phones || busy} value={mine?.label ?? ''} onChange={(e) => assign(d.id, e.target.value || null)} style={INPUT}>
                      <option value="">No company phone</option>
                      {(phones ?? []).map((p) => (
                        <option key={p.label} value={p.label}>
                          {p.label}{p.assignedDriverId && p.assignedDriverId !== d.id ? ` (with ${nameOf.get(p.assignedDriverId) ?? 'someone'})` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={TD}><Num value={mine?.number} /></td>
                </tr>
              )
            })}
            {locals.length === 0 && <tr><td colSpan={4} style={{ ...TD, textAlign: 'center', color: 'var(--tms-muted)' }}>No active local drivers.</td></tr>}
          </tbody>
        </table>
      </div>

      <aside style={{ flex: '0 0 250px', borderLeft: '1px solid var(--tms-border)', background: 'var(--tms-bg)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Company phones">
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Company phones</div>
        {(phones ?? []).map((p) => (
          <label key={p.label} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            <span style={{ fontWeight: 600, color: 'var(--tms-text)' }}>{p.label}</span>
            <input aria-label={`${p.label} number`} defaultValue={p.number ?? ''} placeholder="(000) 000-0000" onBlur={(e) => saveNumber(p.label, e.target.value)} style={{ ...INPUT, width: '100%' }} />
            <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>{p.assignedDriverId ? nameOf.get(p.assignedDriverId) ?? 'Assigned' : 'In the office'}</span>
          </label>
        ))}
        {phones && phones.length === 0 ? <span style={{ fontSize: 12, color: 'var(--tms-muted)' }}>No company phones set up yet.</span> : null}
      </aside>
      </div>
    </div>
  )
}
