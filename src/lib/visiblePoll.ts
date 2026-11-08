/**
 * `setInterval` that does nothing while the tab is hidden (PERF R7) and catches up with one
 * run as soon as it is shown again if at least one tick was skipped. Returns the stopper.
 */
export function startVisiblePoll(run: () => void, intervalMs: number): () => void {
  let missed = false
  const tick = () => {
    if (document.visibilityState === 'hidden') {
      missed = true
      return
    }
    run()
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && missed) {
      missed = false
      run()
    }
  }
  const id = setInterval(tick, intervalMs)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(id)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
