/**
 * Minimal CBOR (RFC 8949) decoder — just enough of the spec to parse the two
 * structures WebAuthn produces: the attestation object (a map) and the COSE
 * public key (a map of integer keys). Implemented from scratch (like lib/mfa.ts)
 * so security keys need no third-party dependency and the parser stays
 * auditable.
 *
 * Only the major types WebAuthn uses are supported: unsigned/negative ints,
 * byte strings, text strings, arrays and maps. Anything else throws, which is
 * the correct fail-closed behaviour for untrusted authenticator input.
 */

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | CborValue[]
  | CborMap
  | boolean
  | null

export type CborMap = Map<CborValue, CborValue>

type Cursor = { view: DataView; bytes: Uint8Array; offset: number }

function readArgument(cur: Cursor, info: number): number {
  if (info < 24) return info
  if (info === 24) {
    const v = cur.view.getUint8(cur.offset)
    cur.offset += 1
    return v
  }
  if (info === 25) {
    const v = cur.view.getUint16(cur.offset)
    cur.offset += 2
    return v
  }
  if (info === 26) {
    const v = cur.view.getUint32(cur.offset)
    cur.offset += 4
    return v
  }
  if (info === 27) {
    const hi = cur.view.getUint32(cur.offset)
    const lo = cur.view.getUint32(cur.offset + 4)
    cur.offset += 8
    const v = hi * 2 ** 32 + lo
    if (!Number.isSafeInteger(v)) {
      throw new Error("CBOR: 64-bit integer exceeds safe range")
    }
    return v
  }
  throw new Error(`CBOR: unsupported additional info ${info}`)
}

function decodeItem(cur: Cursor): CborValue {
  if (cur.offset >= cur.bytes.length) throw new Error("CBOR: unexpected end of input")
  const initial = cur.view.getUint8(cur.offset)
  cur.offset += 1
  const majorType = initial >> 5
  const info = initial & 0x1f

  switch (majorType) {
    case 0: // unsigned integer
      return readArgument(cur, info)
    case 1: // negative integer
      return -1 - readArgument(cur, info)
    case 2: {
      // byte string
      const len = readArgument(cur, info)
      const slice = cur.bytes.subarray(cur.offset, cur.offset + len)
      if (slice.length !== len) throw new Error("CBOR: truncated byte string")
      cur.offset += len
      return new Uint8Array(slice)
    }
    case 3: {
      // text string
      const len = readArgument(cur, info)
      const slice = cur.bytes.subarray(cur.offset, cur.offset + len)
      if (slice.length !== len) throw new Error("CBOR: truncated text string")
      cur.offset += len
      return new TextDecoder().decode(slice)
    }
    case 4: {
      // array
      const len = readArgument(cur, info)
      const arr: CborValue[] = []
      for (let i = 0; i < len; i++) arr.push(decodeItem(cur))
      return arr
    }
    case 5: {
      // map
      const len = readArgument(cur, info)
      const map: CborMap = new Map()
      for (let i = 0; i < len; i++) {
        const key = decodeItem(cur)
        const value = decodeItem(cur)
        map.set(key, value)
      }
      return map
    }
    case 7: {
      // simple / float — only the boolean and null simple values are needed.
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      throw new Error(`CBOR: unsupported simple value ${info}`)
    }
    default:
      throw new Error(`CBOR: unsupported major type ${majorType}`)
  }
}

/** Decode a single top-level CBOR item. Trailing bytes are ignored (the
 * attestation object's authData carries its own explicit length). */
export function cborDecodeFirst(input: Uint8Array): CborValue {
  const cur: Cursor = {
    view: new DataView(input.buffer, input.byteOffset, input.byteLength),
    bytes: input,
    offset: 0,
  }
  return decodeItem(cur)
}
