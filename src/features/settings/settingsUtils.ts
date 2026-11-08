/** Keep only stored values this build understands — a newer deploy must not silently drop them. */
export function pick<T extends string>(stored: unknown, options: readonly T[]): T[] {
  if (!Array.isArray(stored)) return []
  return options.filter((option) => stored.includes(option))
}

/** Add or remove a value from a selected list. */
export function toggle<T extends string>(selected: T[], value: T): T[] {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
}
