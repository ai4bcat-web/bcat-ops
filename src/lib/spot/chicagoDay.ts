/** The Chicago calendar day (`YYYY-MM-DD`) of an instant — the boundary of the per-rep daily model-call cap. */
export function chicagoDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}
