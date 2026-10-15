/**
 * The phone's flash as a fill light for paperwork.
 *
 * A dock at 6 AM or a cab at night is where most unreadable PODs come from. Phones that
 * expose the torch through the camera track let a web page switch it on; those that do
 * not (every iPhone, today) simply never show the button.
 */
interface TorchTrack {
  getCapabilities?: () => MediaTrackCapabilities & { torch?: boolean }
  applyConstraints?: (c: MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }) => Promise<void>
}

export function torchSupported(track: MediaStreamTrack | null | undefined): boolean {
  try {
    const caps = (track as unknown as TorchTrack | null | undefined)?.getCapabilities?.()
    return caps?.torch === true
  } catch {
    return false
  }
}

/** Switch the torch; resolves false when the device refused. */
export async function setTorch(track: MediaStreamTrack | null | undefined, on: boolean): Promise<boolean> {
  const t = track as unknown as TorchTrack | null | undefined
  if (!t?.applyConstraints) return false
  try {
    await t.applyConstraints({ advanced: [{ torch: on }] })
    return true
  } catch {
    return false
  }
}
