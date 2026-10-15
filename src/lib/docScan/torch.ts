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

/** Mean brightness 0–255 of a viewfinder frame, from every fourth pixel — enough to judge the light. */
export function frameBrightness(rgba: Uint8ClampedArray | Uint8Array): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < rgba.length; i += 16) {
    sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    n++
  }
  return n ? sum / n : 0
}

/** Below this the torch comes on by itself; above AUTO_TORCH_OFF it goes off. The gap stops flicker. */
export const AUTO_TORCH_ON = 60
export const AUTO_TORCH_OFF = 110

/** What auto mode wants the torch to be, given the light and what it is now. */
export function autoTorchWants(brightness: number, torchOn: boolean): boolean {
  if (brightness < AUTO_TORCH_ON) return true
  if (brightness > AUTO_TORCH_OFF) return false
  return torchOn
}

export type TorchMode = 'auto' | 'on' | 'off'
export const nextTorchMode = (m: TorchMode): TorchMode => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto')
