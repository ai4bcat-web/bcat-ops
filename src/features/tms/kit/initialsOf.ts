/** "Ryne Sanchez" → "RS", "ryne@x.com" → "R", "" → "?". */
export function initialsOf(text: string): string {
  const cleaned = (text ?? '').trim()
  if (!cleaned) return '?'
  if (cleaned.includes('@')) return cleaned[0].toUpperCase()
  const words = cleaned.split(/\s+/).filter(Boolean)
  const letters = words.length === 1 ? [words[0][0]] : [words[0][0], words[words.length - 1][0]]
  return letters.join('').toUpperCase()
}
