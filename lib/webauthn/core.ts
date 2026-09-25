/**
 * Pure WebAuthn ceremony verification (WebAuthn Level 2, §7.1 / §7.2).
 * ---------------------------------------------------------------------------
 * These functions take the raw client payloads plus the *expected* values a
 * challenge was bound to (challenge, origin, rpId) and decide whether a
 * registration or authentication ceremony is valid. They perform NO I/O:
 * challenge issuance / consumption / replay protection and credential storage
 * live in lib/webauthn-store.ts, and lockout in the login flow. Keeping the
 * cryptographic checks pure makes the phishing-resistance guarantees
 * unit-testable against crafted "cloned challenge / origin mismatch / unknown
 * device / counter regression" inputs.
 */
import { createHash } from "node:crypto"
import { cborDecodeFirst, type CborMap } from "./cbor"
import { coseToStoredKey, verifyCoseSignature, type StoredPublicKey } from "./cose"

export type WebAuthnFailure =
  | "malformed"
  | "type_mismatch"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "rpid_mismatch"
  | "user_not_present"
  | "unknown_credential"
  | "bad_signature"
  | "counter_regression"

export type RegistrationResult =
  | {
      ok: true
      credentialId: string // base64url
      publicKey: StoredPublicKey
      signCount: number
      transports: string[]
      backedUp: boolean
    }
  | { ok: false; failure: WebAuthnFailure }

export type AuthenticationResult =
  | { ok: true; newSignCount: number; userVerified: boolean; clonedSuspected: boolean }
  | { ok: false; failure: WebAuthnFailure }

/** Client-supplied payload from navigator.credentials.create(). */
export type RegistrationResponse = {
  id: string
  rawId: string // base64url
  clientDataJSON: string // base64url
  attestationObject: string // base64url
  transports?: string[]
}

/** Client-supplied payload from navigator.credentials.get(). */
export type AuthenticationResponse = {
  id: string
  rawId: string // base64url
  clientDataJSON: string // base64url
  authenticatorData: string // base64url
  signature: string // base64url
  userHandle?: string | null
}

export type ExpectedBinding = {
  challenge: string // base64url, exactly as issued
  origin: string
  rpId: string
}

function fromB64url(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"))
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest())
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type ClientData = { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean }

function parseClientData(clientDataJSON: string): ClientData | null {
  try {
    return JSON.parse(Buffer.from(fromB64url(clientDataJSON)).toString("utf8"))
  } catch {
    return null
  }
}

/**
 * Validate clientDataJSON against the values the challenge was bound to. This
 * is the phishing-resistance core: the browser reports the true origin it saw,
 * and the challenge is single-use and user/origin/tenant-scoped by the store,
 * so a cloned challenge replayed from an attacker origin fails here.
 */
function checkClientData(client: ClientData | null, expectedType: string, binding: ExpectedBinding): WebAuthnFailure | null {
  if (!client) return "malformed"
  if (client.type !== expectedType) return "type_mismatch"
  // Challenge comparison is on the exact base64url string the server issued.
  if (typeof client.challenge !== "string" || !timingSafeEqualStr(client.challenge, binding.challenge)) {
    return "challenge_mismatch"
  }
  if (client.origin !== binding.origin) return "origin_mismatch"
  return null
}

/** Parsed authenticatorData fields we rely on. */
export type AuthDataView = {
  rpIdHash: Uint8Array
  userPresent: boolean
  userVerified: boolean
  backupEligible: boolean
  backedUp: boolean
  signCount: number
  attestedCredentialData?: {
    credentialId: Uint8Array
    credentialPublicKey: CborMap
  }
}

/** Parse the fixed + optional layout of authenticatorData (WebAuthn §6.1). */
export function parseAuthenticatorData(authData: Uint8Array): AuthDataView | null {
  if (authData.length < 37) return null
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32]
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0)
  const view: AuthDataView = {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backedUp: (flags & 0x10) !== 0,
    signCount,
  }
  const hasAttestedData = (flags & 0x40) !== 0
  if (hasAttestedData) {
    if (authData.length < 55) return null
    // 16-byte AAGUID, then 2-byte credId length, then credId, then COSE key.
    const credIdLen = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0)
    const credIdStart = 55
    const credIdEnd = credIdStart + credIdLen
    if (authData.length < credIdEnd) return null
    const credentialId = authData.subarray(credIdStart, credIdEnd)
    let credentialPublicKey: CborMap
    try {
      credentialPublicKey = cborDecodeFirst(authData.subarray(credIdEnd)) as CborMap
    } catch {
      return null
    }
    view.attestedCredentialData = { credentialId, credentialPublicKey }
  }
  return view
}

/**
 * Verify a registration ceremony. We validate clientData binding, the RP ID
 * hash and user-presence, then extract the credential id + public key. We do
 * NOT verify attestation statements (self / none / packed): attestation proves
 * authenticator *provenance*, which this ERP does not gate on, whereas the
 * phishing-resistance and anti-replay guarantees come entirely from the
 * challenge binding + signature checks that we DO enforce.
 */
export function verifyRegistration(response: RegistrationResponse, binding: ExpectedBinding): RegistrationResult {
  const clientFailure = checkClientData(parseClientData(response.clientDataJSON), "webauthn.create", binding)
  if (clientFailure) return { ok: false, failure: clientFailure }

  let attestation: CborMap
  try {
    attestation = cborDecodeFirst(fromB64url(response.attestationObject)) as CborMap
  } catch {
    return { ok: false, failure: "malformed" }
  }
  const authDataRaw = attestation.get("authData")
  if (!(authDataRaw instanceof Uint8Array)) return { ok: false, failure: "malformed" }
  const authData = parseAuthenticatorData(authDataRaw)
  if (!authData || !authData.attestedCredentialData) return { ok: false, failure: "malformed" }

  const expectedRpIdHash = sha256(new TextEncoder().encode(binding.rpId))
  if (!buffersEqual(authData.rpIdHash, expectedRpIdHash)) return { ok: false, failure: "rpid_mismatch" }
  if (!authData.userPresent) return { ok: false, failure: "user_not_present" }

  let publicKey: StoredPublicKey
  try {
    publicKey = coseToStoredKey(authData.attestedCredentialData.credentialPublicKey)
  } catch {
    return { ok: false, failure: "malformed" }
  }

  return {
    ok: true,
    credentialId: Buffer.from(authData.attestedCredentialData.credentialId).toString("base64url"),
    publicKey,
    signCount: authData.signCount,
    transports: Array.isArray(response.transports) ? response.transports.filter((t) => typeof t === "string").slice(0, 8) : [],
    backedUp: authData.backedUp,
  }
}

export type StoredCredentialForAuth = {
  publicKey: StoredPublicKey
  signCount: number
}

/**
 * Verify an authentication ceremony against ONE stored credential. The caller
 * has already looked the credential up by rawId (scoped to the user+tenant),
 * so an `unknown_credential` here means the id did not resolve.
 *
 * Anti-clone: authenticators maintain a monotonic signature counter. If the new
 * counter is not greater than the stored one (and both are non-zero), the same
 * credential is being used from two authenticators — the hallmark of a cloned
 * key — and we reject. A counter that stays 0 is allowed (some platform
 * authenticators never implement it).
 */
export function verifyAuthentication(
  response: AuthenticationResponse,
  binding: ExpectedBinding,
  credential: StoredCredentialForAuth | null,
): AuthenticationResult {
  const clientFailure = checkClientData(parseClientData(response.clientDataJSON), "webauthn.get", binding)
  if (clientFailure) return { ok: false, failure: clientFailure }

  if (!credential) return { ok: false, failure: "unknown_credential" }

  const authDataRaw = fromB64url(response.authenticatorData)
  const authData = parseAuthenticatorData(authDataRaw)
  if (!authData) return { ok: false, failure: "malformed" }

  const expectedRpIdHash = sha256(new TextEncoder().encode(binding.rpId))
  if (!buffersEqual(authData.rpIdHash, expectedRpIdHash)) return { ok: false, failure: "rpid_mismatch" }
  if (!authData.userPresent) return { ok: false, failure: "user_not_present" }

  // Signed data is authenticatorData || SHA-256(clientDataJSON).
  const clientHash = sha256(fromB64url(response.clientDataJSON))
  const signedData = new Uint8Array(authDataRaw.length + clientHash.length)
  signedData.set(authDataRaw, 0)
  signedData.set(clientHash, authDataRaw.length)

  if (!verifyCoseSignature(credential.publicKey, signedData, fromB64url(response.signature))) {
    return { ok: false, failure: "bad_signature" }
  }

  const newCount = authData.signCount
  const oldCount = credential.signCount
  let clonedSuspected = false
  if (newCount === 0 && oldCount === 0) {
    // Authenticator does not implement a counter; nothing to compare.
  } else if (newCount <= oldCount) {
    clonedSuspected = true
    return { ok: false, failure: "counter_regression" }
  }

  return { ok: true, newSignCount: newCount, userVerified: authData.userVerified, clonedSuspected }
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
