/** `SIGNED v2`, `SENT v2`, or just the status before any version exists: what the load shows for its rate con. */
export function rateConStatusText(status: string | null | undefined, version: number | null | undefined): string {
  const label = (status ?? 'NOT_SENT').replace(/_/g, ' ').toUpperCase()
  return version ? `${label} v${version}` : label
}
