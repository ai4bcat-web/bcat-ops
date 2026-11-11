export const MAX_DUPLICATE_COPIES = 20

/** The copies count the box holds, or null while it is not a whole number from 1 to 20. */
export function parseCopies(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= 1 && n <= MAX_DUPLICATE_COPIES ? n : null
}

