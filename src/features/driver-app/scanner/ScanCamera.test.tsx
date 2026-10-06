// @vitest-environment jsdom
/**
 * The camera's failure modes matter more than its happy path.
 *
 * A live viewfinder was tried in this app once before and gave drivers a black screen on
 * real phones: getUserMedia resolved, the element mounted, and no frame ever arrived — so
 * nothing threw, and the driver stared at black with a shutter under it. Every test here
 * is about making sure a driver always has a way out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ScanCamera } from './ScanCamera'

const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
const getUserMedia = vi.fn<() => Promise<MediaStream>>()

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  track.stop.mockClear()
  getUserMedia.mockReset().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, writable: true, value: { getUserMedia },
  })
  // jsdom has no media pipeline; play() rejects by default and videoWidth is always 0.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
})

afterEach(() => { vi.useRealTimers() })

describe('ScanCamera — getting a picture at all', () => {
  it('asks for the REAR camera, which is the one pointed at the paperwork', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints
    const video = constraints.video as MediaTrackConstraints
    expect(video.facingMode).toEqual({ ideal: 'environment' })
    expect(constraints.audio).toBe(false)
  })

  it('says so when the camera sends no picture, instead of showing black forever', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    vi.advanceTimersByTime(5200)
    expect(await screen.findByText(/sent no picture/i)).toBeInTheDocument()
    expect(screen.getByText(/Use Upload instead/i)).toBeInTheDocument()
  })

  it('releases the camera when it gives up, rather than leaving the light on', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    vi.advanceTimersByTime(5200)
    await screen.findByText(/sent no picture/i)
    expect(track.stop).toHaveBeenCalled()
  })

  it('explains a blocked camera as permission, not as breakage', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    getUserMedia.mockRejectedValue(denied)
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    expect(await screen.findByText(/camera is blocked/i)).toBeInTheDocument()
  })

  it('sends a device with no camera straight to Upload', async () => {
    const missing = Object.assign(new Error('none'), { name: 'NotFoundError' })
    getUserMedia.mockRejectedValue(missing)
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    expect(await screen.findByText(/No camera on this device/i)).toBeInTheDocument()
  })

  it('always leaves a way out of the error screen', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const onClose = vi.fn()
    render(<ScanCamera onCapture={vi.fn()} onClose={onClose} remaining={3} />)
    const back = await screen.findByRole('button', { name: /Back/i })
    back.click()
    expect(onClose).toHaveBeenCalled()
  })

  it('stops the camera when it unmounts', async () => {
    const { unmount } = render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    unmount()
    await waitFor(() => expect(track.stop).toHaveBeenCalled())
  })
})

describe('ScanCamera — the viewfinder', () => {
  it('tells the driver how many more pages they can add', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={4} />)
    expect(await screen.findByText(/4 more pages can be added/i)).toBeInTheDocument()
  })

  it('says Last page rather than "0 more"', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={0} />)
    expect(await screen.findByText(/Last page/i)).toBeInTheDocument()
  })

  it('keeps the shutter disabled until a frame has actually arrived', async () => {
    render(<ScanCamera onCapture={vi.fn()} onClose={vi.fn()} remaining={3} />)
    const shutter = await screen.findByRole('button', { name: /Take the photo/i })
    expect(shutter).toBeDisabled()
  })
})
