/** Whole-number shares that always sum to 100 (largest-remainder rounding). */
export function segmentShares(values: number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (total === 0) return clean.map(() => 0)
  const exact = clean.map((v) => (v / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, rem: x - floors[i] }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    if (clean[i] > 0) {
      floors[i] += 1
      left -= 1
    }
  }
  return floors
}
