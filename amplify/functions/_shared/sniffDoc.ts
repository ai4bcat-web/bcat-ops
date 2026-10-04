/**
 * What a document actually IS, read from its first bytes.
 *
 * The extension on an S3 key and the Content-Type recorded beside it are both hearsay: a
 * scan saved as `.pdf` may be a JPEG, and a POD we name `POD-14538.pdf` on the way out may
 * not be a PDF at all. OTR's reader takes us at our word and then reports a corrupt file,
 * so the name and the declared type have to come from the bytes themselves.
 */
export interface DocFormat {
  ext: 'pdf' | 'jpg' | 'png'
  mime: string
}

export function sniffDoc(bytes: Uint8Array): DocFormat | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { ext: 'pdf', mime: 'application/pdf' } // %PDF
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return { ext: 'png', mime: 'image/png' }
  }
  return null
}

/** Force a filename's extension to match what the bytes really are. */
export function withExt(fileName: string, ext: string): string {
  return `${fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${ext}`
}
