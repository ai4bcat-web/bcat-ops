// @vitest-environment jsdom
/**
 * The camera showed a black screen on a real phone while the stream was running fine.
 *
 * The effect that acquired the stream assigned it to the video ref immediately, but the
 * <video> element only renders once cameraState is 'live' — so at that moment the ref was
 * still null, the assignment was skipped, and the element mounted with no source. Nothing
 * threw and nothing logged; the driver just saw black.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CameraCapture } from './CameraCapture'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const getUserMedia = vi.fn()
const track = { stop: vi.fn() }
const fakeStream = { getTracks: () => [track] } as unknown as MediaStream

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
  // jsdom has no media pipeline; play() must exist and resolve.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
    writable: true,
  })
})
afterEach(() => vi.restoreAllMocks())

describe('CameraCapture', () => {
  it('attaches the stream to the video element that actually mounted', async () => {
    getUserMedia.mockResolvedValue(fakeStream)
    const { container } = render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const video = container.querySelector('video') as HTMLVideoElement & { srcObject?: MediaStream }
    // The whole bug: this was null, so the element rendered with no source.
    await waitFor(() => expect(video.srcObject).toBe(fakeStream))
  })

  it('asks for the rear camera', async () => {
    getUserMedia.mockResolvedValue(fakeStream)
    render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    expect(getUserMedia.mock.calls[0][0]).toEqual({ video: { facingMode: { ideal: 'environment' } } })
  })

  it('explains a denied permission instead of showing black', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Camera access denied')).toBeInTheDocument()
  })

  it('explains an unavailable camera instead of showing black', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('boom'), { name: 'NotReadableError' }))
    render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Camera not available')).toBeInTheDocument()
  })

  it('says so when the browser has no camera API at all', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('Camera not available')).toBeInTheDocument()
  })

  it('stops the camera when it unmounts, so the light goes out', async () => {
    getUserMedia.mockResolvedValue(fakeStream)
    const { unmount, container } = render(<CameraCapture initialPages={[]} onDone={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())

    unmount()
    expect(track.stop).toHaveBeenCalled()
  })
})
