import { toast } from 'sonner'
import { uploadRateConfirm, parseRateConfirm } from './apiClient'
import { getStops, updateStop } from './stops'
import { fromDateInput, fromDateTimeInput } from './date'
import type { Load, Stop } from '@/types'

/**
 * The ONE document a non-Batory shipment needs: the rate confirmation (PDF or
 * screenshot). Uploading it stores the file on the load, reads the pickup/delivery
 * appointment times out of it with Claude, writes them onto the stops, and — because
 * non-Batory confirmation IS the ratecon — the appts show CONFIRMED.
 *
 * Shared by the Loads drawer and the Appts page chip so both do byte-identical work.
 */
export async function uploadRateconAndApply(
  load: Load,
  file: File | Blob,
  updateLoad: (id: string, patch: Partial<Load>) => Promise<unknown>,
): Promise<boolean> {
  let key: string
  try {
    key = await uploadRateConfirm(load.id, file as File)
    await updateLoad(load.id, { rateConfirmKey: key } as Partial<Load>)
    toast.success('Rate confirmation uploaded')
  } catch {
    toast.error('Upload failed')
    return false
  }
  try {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split('base64,')[1] ?? '')
      r.onerror = reject
      r.readAsDataURL(file)
    })
    toast.info('Reading appointment times from the ratecon…')
    const { appts, error } = await parseRateConfirm({ fileBase64: b64, mediaType: file.type || 'application/pdf' })
    if (!appts) { if (error) toast.error(`Ratecon read failed: ${error}`); return true }
    let stops = getStops(load)
    const apply = (kind: 'pickup' | 'delivery', a: { date: string | null; time: string | null; timeEnd: string | null }) => {
      const stop = kind === 'pickup' ? stops.find((s) => s.type === 'pickup') : [...stops].reverse().find((s) => s.type === 'delivery')
      if (!stop || !a.date) return null
      const iso = a.time ? fromDateTimeInput(`${a.date}T${a.time}`) : fromDateInput(a.date)
      const patch: Partial<Stop> = { appt: iso, apptType: a.timeEnd ? 'range' : a.time ? 'exact' : 'fcfs' }
      if (a.timeEnd) patch.apptEnd = fromDateTimeInput(`${a.date}T${a.timeEnd}`)
      stops = updateStop({ ...load, stops } as Load, stop.id, patch)
      return `${kind} ${a.date}${a.time ? ` ${a.time}` : ''}`
    }
    const applied = [apply('pickup', appts.pickup), apply('delivery', appts.delivery)].filter(Boolean)
    if (applied.length) {
      await updateLoad(load.id, { stops })
      toast.success(`Appointments set from ratecon — ${applied.join(', ')} · CONFIRMED`)
    } else {
      toast('Ratecon read, but no appointment date/time found in it — set the times by hand.')
    }
  } catch (err) {
    toast.error(`Couldn't read the ratecon: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  return true
}
