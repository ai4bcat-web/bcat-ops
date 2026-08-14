/**
 * Browser download helpers.
 *
 * Why this exists: the obvious `<a href={url} download>` does NOT save the file when `url`
 * points at S3. The `download` attribute is ignored for cross-origin URLs, and our presigned
 * URLs live on `*.s3.amazonaws.com` while the app runs on ops.bcatcorp.com. The browser
 * therefore *navigates* to the URL instead of saving it — and for a PDF or image that means
 * the built-in viewer replaces the page you were working on.
 *
 * Fetching the bytes first and handing the browser a same-origin `blob:` URL keeps `download`
 * honored, so the file saves and the page stays exactly where it was.
 */

/** Hand a blob to the browser as a file save. Stays on the current page. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  // Firefox only fires the click if the anchor is in the document.
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking synchronously can cancel the save in Safari — give it a moment.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Fetch a remote file and save it without navigating.
 * Throws on a non-OK response so callers can surface a toast instead of failing silently.
 */
export async function downloadFromUrl(url: string, filename: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  saveBlob(await res.blob(), filename)
}
