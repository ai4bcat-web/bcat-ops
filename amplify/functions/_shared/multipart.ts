/**
 * Build a multipart/form-data body as one finished Buffer.
 *
 * `fetch` will do this for you if you hand it a FormData — but it then STREAMS the body,
 * which means `Transfer-Encoding: chunked` and no `Content-Length`. That is legal HTTP and
 * plenty of servers hate it: a .NET multipart parser that reads a chunked body badly
 * produces a null reference, or a byte count that matches nothing anyone sent. Both are
 * what OTR returns for every document we have ever uploaded.
 *
 * A single Buffer gets a Content-Length and no chunking, with a boundary we choose and can
 * read back in a log. The bytes of each part are copied verbatim — no encoding step exists
 * here for a file to be mangled by.
 */
import { randomBytes } from 'node:crypto'

export interface MultipartField {
  name: string
  value: string
}

export interface MultipartFile {
  name: string
  fileName: string
  /** Omitted entirely when absent, which is what OTR's own curl example sends. */
  contentType?: string
  bytes: Uint8Array
}

export interface BuiltMultipart {
  body: Buffer
  contentType: string
  boundary: string
}

/** RFC 2388 quoting: a quote or a newline in a filename would end the header early. */
function quote(value: string): string {
  return value.replace(/["\r\n]/g, '_')
}

/**
 * Parts are emitted in the order given, because a streaming parser can care: one that
 * wants the invoice id before it starts consuming the file will not find it if the file
 * comes last.
 */
export function buildMultipart(parts: Array<MultipartField | MultipartFile>): BuiltMultipart {
  const boundary = `----BCATFormBoundary${randomBytes(12).toString('hex')}`
  const chunks: Buffer[] = []

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'))
    if ('bytes' in part) {
      let header = `Content-Disposition: form-data; name="${quote(part.name)}"; filename="${quote(part.fileName)}"\r\n`
      if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`
      chunks.push(Buffer.from(`${header}\r\n`, 'utf8'))
      // The file, byte for byte. Buffer.from on a view copies exactly its own window.
      chunks.push(Buffer.from(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength))
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${quote(part.name)}"\r\n\r\n${part.value}`,
          'utf8',
        ),
      )
    }
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  }
}
