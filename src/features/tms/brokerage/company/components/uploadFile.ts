/**
 * PUT a file to a presigned URL with upload progress (fetch cannot report upload progress).
 * The body is the browser's File, streamed by the browser; nothing is read into JS memory.
 */
export function putWithProgress(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  // Executor form: `Promise.withResolvers` is ES2024 and the app's lib target is ES2023.
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'text/csv')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve() } else reject(new Error(`Upload failed (HTTP ${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('Upload failed (network error).'))
    xhr.onabort = () => reject(new Error('Upload canceled.'))
    xhr.send(file)
  })
}
