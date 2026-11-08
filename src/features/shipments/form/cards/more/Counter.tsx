import './../moneyCards.css'

/** "N characters remaining" / "N over" under a length-limited note. */
export function Counter({ used, max, testId }: { used: number; max: number; testId: string }) {
  const left = max - used
  return (
    <span data-testid={testId} className="tms-card-counter" data-over={left < 0 ? 'true' : 'false'}>
      {left >= 0 ? `${left} characters remaining` : `${-left} over`}
    </span>
  )
}
