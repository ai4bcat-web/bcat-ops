/**
 * Division logo for the rate-con PDF, as a data URL jsPDF can embed.
 *
 * Never throws: a missing, slow, oversized or non-image logo must degrade to the
 * text header, never fail a send. Only PNG and JPEG are accepted, and the format is
 * decided from the bytes — the stored content-type is not trusted.
 */
import { getUrl } from 'aws-amplify/storage'

const FETCH_TIMEOUT_MS = 5000
const MAX_LOGO_BYTES = 2 * 1024 * 1024

export async function fetchDivisionLogoDataUrl(logoKey: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const { url } = await getUrl({ path: logoKey, options: { expiresIn: 300 } })
    const res = await fetch(url.toString(), { signal: controller.signal })
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (!isPng && !isJpeg) return null
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return `data:image/${isPng ? 'png' : 'jpeg'};base64,${btoa(binary)}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
