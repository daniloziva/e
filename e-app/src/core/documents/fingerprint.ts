export interface Fingerprint {
  sha256: string
  sha8: string
  byteSize: number
}

/** Hash bytes. Pure given the bytes; the hashing primitive is injected by the caller. */
export function fingerprint(_bytes: Uint8Array, _sha256: (b: Uint8Array) => string): Fingerprint {
  throw new Error('not implemented')
}

/** Extension from a filename or mime type, lowercase, no dot. Unknown -> 'bin'. */
export function extensionFor(_filename: string, _mimeType: string): string {
  throw new Error('not implemented')
}

