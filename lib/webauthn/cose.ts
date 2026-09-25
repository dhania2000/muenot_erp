/**
 * COSE (RFC 8152) public-key handling for WebAuthn.
 * ---------------------------------------------------------------------------
 * An authenticator returns its credential public key as a COSE_Key map inside
 * the attestation authData. We only need to (a) re-serialize that key so it can
 * be stored and later reloaded, and (b) verify an assertion signature with it.
 *
 * The supported algorithms are the ones platform/roaming authenticators use in
 * practice: ES256 (ECDSA P-256, alg -7), RS256 (RSASSA-PKCS1 SHA-256, alg
 * -257) and EdDSA (Ed25519, alg -8). Everything is converted into a Node
 * KeyObject via JWK, so signature verification uses the audited node:crypto
 * primitives rather than any hand-rolled maths.
 */
import { createPublicKey, createVerify, verify as edVerify, type KeyObject } from "node:crypto"
import type { CborMap, CborValue } from "./cbor"

// COSE key-type (kty) and algorithm (alg) label constants.
const COSE_KTY = 1
const COSE_ALG = 3
const COSE_CRV = -1
const COSE_EC2_X = -2
const COSE_EC2_Y = -3
const COSE_RSA_N = -1
const COSE_RSA_E = -2
const COSE_OKP_X = -2

const KTY_OKP = 1
const KTY_EC2 = 2
const KTY_RSA = 3

export const COSE_ALG_ES256 = -7
export const COSE_ALG_EDDSA = -8
export const COSE_ALG_RS256 = -257

/** A COSE public key normalized to a stable JSON shape for DB storage. */
export type StoredPublicKey = {
  alg: number
  jwk: Record<string, string>
}

function toNum(v: CborValue | undefined): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  throw new Error("COSE: expected numeric label")
}

function toBytes(v: CborValue | undefined): Uint8Array {
  if (v instanceof Uint8Array) return v
  throw new Error("COSE: expected byte string")
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/**
 * Convert a decoded COSE_Key map into a JWK plus the declared algorithm. Throws
 * on an unsupported key type / curve so an unknown authenticator fails closed.
 */
export function coseToStoredKey(cose: CborMap): StoredPublicKey {
  const kty = toNum(cose.get(COSE_KTY))
  const alg = toNum(cose.get(COSE_ALG))

  if (kty === KTY_EC2) {
    const crv = toNum(cose.get(COSE_CRV))
    if (crv !== 1) throw new Error(`COSE: unsupported EC curve ${crv}`)
    return {
      alg,
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: b64url(toBytes(cose.get(COSE_EC2_X))),
        y: b64url(toBytes(cose.get(COSE_EC2_Y))),
      },
    }
  }

  if (kty === KTY_RSA) {
    return {
      alg,
      jwk: {
        kty: "RSA",
        n: b64url(toBytes(cose.get(COSE_RSA_N))),
        e: b64url(toBytes(cose.get(COSE_RSA_E))),
      },
    }
  }

  if (kty === KTY_OKP) {
    const crv = toNum(cose.get(COSE_CRV))
    if (crv !== 6) throw new Error(`COSE: unsupported OKP curve ${crv}`)
    return {
      alg,
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: b64url(toBytes(cose.get(COSE_OKP_X))),
      },
    }
  }

  throw new Error(`COSE: unsupported key type ${kty}`)
}

function loadKey(stored: StoredPublicKey): KeyObject {
  return createPublicKey({ key: stored.jwk as any, format: "jwk" })
}

/**
 * Convert a raw ECDSA (r||s) signature — which some authenticators emit — into
 * DER, the encoding node:crypto expects. WebAuthn ES256 signatures are already
 * DER-encoded in practice, so this is only used as a fallback; we detect the
 * encoding by its leading SEQUENCE tag.
 */
function ensureDerEcdsaSignature(sig: Uint8Array): Uint8Array {
  if (sig[0] === 0x30) return sig // already DER
  if (sig.length !== 64) return sig
  const r = sig.subarray(0, 32)
  const s = sig.subarray(32, 64)
  const encodeInt = (b: Uint8Array): number[] => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let bytes = Array.from(b.subarray(i))
    if (bytes[0] & 0x80) bytes = [0x00, ...bytes]
    return [0x02, bytes.length, ...bytes]
  }
  const body = [...encodeInt(r), ...encodeInt(s)]
  return new Uint8Array([0x30, body.length, ...body])
}

/**
 * Verify a WebAuthn assertion signature over `signedData` using the stored
 * credential public key. Returns false (never throws) on any malformed input so
 * the caller can treat every failure uniformly as a rejected assertion.
 */
export function verifyCoseSignature(
  stored: StoredPublicKey,
  signedData: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const key = loadKey(stored)
    if (stored.alg === COSE_ALG_ES256) {
      const verifier = createVerify("sha256")
      verifier.update(signedData)
      verifier.end()
      return verifier.verify({ key, dsaEncoding: "der" }, ensureDerEcdsaSignature(signature))
    }
    if (stored.alg === COSE_ALG_RS256) {
      const verifier = createVerify("sha256")
      verifier.update(signedData)
      verifier.end()
      return verifier.verify(key, signature)
    }
    if (stored.alg === COSE_ALG_EDDSA) {
      // Ed25519 verifies the message directly (no pre-hash).
      return edVerify(null, signedData, key, signature)
    }
    return false
  } catch {
    return false
  }
}
