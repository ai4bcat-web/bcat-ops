/** A row is active on an exact hit or on any deeper path under it. */
export function isPathActive(activePath: string, to: string): boolean {
  if (activePath === to) return true
  return activePath.startsWith(to.endsWith('/') ? to : `${to}/`)
}
