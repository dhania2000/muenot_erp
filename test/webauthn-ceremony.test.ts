import { describe, expect, it } from "vitest"
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto"
import { verifyRegistration, verifyAuthentication } from "@/lib/webauthn/core"

/**
 * Spec21 (#35) — pure WebAuthn ceremony verification.
 *
 * These tests craft real ES256 ceremonies with node:crypto and then mutate one
 * field at a time to prove each phishing-resistance / anti-replay guarantee:
 * cloned challenge, origin mismatch, unknown device, counter regression (cloned
 * key), forged signature and absent user-presence. No DB or network is touched
 * — the store/replay/lockout layer is exercised in webauthn-store.test.ts.
 */

// --- minimal CBOR encoder (only the shapes WebAuthn produces) --------------
function encodeTypeAndArg(major: number, n: number): Buffer {
  const mt = major << 5
  if (n < 24) return Buffer.from([mt | n])
  if (n < 256) return Buffer.from([mt | 24, n])
  if (n < 65536) {
    const b = Buffer.alloc(3)
    b[0] = mt | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = mt | 26
  b.writeUInt32BE(n, 1)
  return b
}
const cInt = (n: number): Buffer => (n >= 0 ? encodeTypeAndArg(0, n) : encodeTypeAndArg(1, -1 - n))
const cBytes = (u: Buffer): Buffer => Buffer.concat([encodeTypeAndArg(2, u.length), u])
const cText = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8")
  return Buffer.concat([encodeTypeAndArg(3, b.length), b])
}
const cMap = (entries: [Buffer, Buffer][]): Buffer =>
  Buffer.concat([encodeTypeAndArg(5, entries.length), ...entries.flat()])

// --- ceremony builders ------------------------------------------------------
function sha256(b: Buffer): Buffer {
  return createHash("sha256").update(b).digest()
}

function coseKeyEC2(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" }) as { x: string; y: string }
  return cMap([
    [cInt(1), cInt(2)], // kty: EC2
    [cInt(3), cInt(-7)], // alg: ES256
    [cInt(-1), cInt(1)], // crv: P-256
    [cInt(-2), cBytes(Buffer.from(jwk.x, "base64url"))],
    [cInt(-3), cBytes(Buffer.from(jwk.y, "base64url"))],
  ])
}

function buildAuthData(opts: {
  rpId: string
  flags: number
  signCount: number
  credId?: Buffer
  coseKey?: Buffer
}): Buffer {
  const head = Buffer.alloc(37)
  sha256(Buffer.from(opts.rpId, "utf8")).copy(head, 0)
  head[32] = opts.flags
  head.writeUInt32BE(opts.signCount, 33)
  if (!(opts.flags & 0x40)) return head // no attested credential data
  const aaguid = Buffer.alloc(16)
  const credLen = Buffer.alloc(2)
  credLen.writeUInt16BE(opts.credId!.length, 0)
  return Buffer.concat([head, aaguid, credLen, opts.credId!, opts.coseKey!])
}

const b64url = (b: Buffer): string => b.toString("base64url")

function clientData(type: string, challenge: string, origin: string): string {
  return b64url(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })))
}

function signES256(priv: KeyObject, data: Buffer): Buffer {
  const s = createSign("SHA256")
  s.update(data)
  s.end()
  return s.sign({ key: priv, dsaEncoding: "der" })
}

const RP_ID = "erp.example.com"
const ORIGIN = "https://erp.example.com"

function newKeypair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" })
}

function makeRegistration(challenge: string, origin = ORIGIN, rpId = RP_ID) {
  const { publicKey, privateKey } = newKeypair()
  const credId = randomBytes(20)
  const authData = buildAuthData({
    rpId,
    flags: 0x45, // UP + UV + AT
    signCount: 0,
    credId,
    coseKey: coseKeyEC2(publicKey),
  })
  const attestationObject = b64url(
    cMap([
      [cText("fmt"), cText("none")],
      [cText("attStmt"), cMap([])],
      [cText("authData"), cBytes(authData)],
    ]),
  )
  const response = {
    id: b64url(credId),
    rawId: b64url(credId),
    clientDataJSON: clientData("webauthn.create", challenge, origin),
    attestationObject,
    transports: ["usb"],
  }
  return { response, privateKey, credId }
}

function makeAssertion(opts: {
  priv: KeyObject
  credId: Buffer
  challenge: string
  origin?: string
  rpId?: string
  signCount: number
  flags?: number
}) {
  const origin = opts.origin ?? ORIGIN
  const rpId = opts.rpId ?? RP_ID
  const authData = buildAuthData({ rpId, flags: opts.flags ?? 0x05, signCount: opts.signCount }) // UP + UV
  const cdj = clientData("webauthn.get", opts.challenge, origin)
  const signedData = Buffer.concat([authData, sha256(Buffer.from(cdj, "base64url"))])
  return {
    id: b64url(opts.credId),
    rawId: b64url(opts.credId),
    authenticatorData: b64url(authData),
    clientDataJSON: cdj,
    signature: b64url(signES256(opts.priv, signedData)),
  }
}

describe("Spec21 WebAuthn registration ceremony", () => {
  it("accepts a well-formed ES256 registration bound to the challenge", () => {
    const challenge = b64url(randomBytes(32))
    const { response } = makeRegistration(challenge)
    const result = verifyRegistration(response, { challenge, origin: ORIGIN, rpId: RP_ID })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.publicKey.alg).toBe(-7)
      expect(result.signCount).toBe(0)
    }
  })

  it("rejects a cloned/replayed challenge (clientData challenge != bound)", () => {
    const issued = b64url(randomBytes(32))
    const attackerChallenge = b64url(randomBytes(32))
    const { response } = makeRegistration(attackerChallenge)
    const result = verifyRegistration(response, { challenge: issued, origin: ORIGIN, rpId: RP_ID })
    expect(result).toEqual({ ok: false, failure: "challenge_mismatch" })
  })

  it("rejects an origin mismatch (ceremony finished on attacker origin)", () => {
    const challenge = b64url(randomBytes(32))
    const { response } = makeRegistration(challenge, "https://phish.example.net")
    const result = verifyRegistration(response, { challenge, origin: ORIGIN, rpId: RP_ID })
    expect(result).toEqual({ ok: false, failure: "origin_mismatch" })
  })

  it("rejects an rpId mismatch", () => {
    const challenge = b64url(randomBytes(32))
    const { response } = makeRegistration(challenge, ORIGIN, "evil.example.net")
    const result = verifyRegistration(response, { challenge, origin: ORIGIN, rpId: RP_ID })
    expect(result).toEqual({ ok: false, failure: "rpid_mismatch" })
  })
})

describe("Spec21 WebAuthn authentication ceremony", () => {
  function enroll() {
    const challenge = b64url(randomBytes(32))
    const { response, privateKey, credId } = makeRegistration(challenge)
    const reg = verifyRegistration(response, { challenge, origin: ORIGIN, rpId: RP_ID })
    if (!reg.ok) throw new Error("fixture registration failed")
    return { privateKey, credId, publicKey: reg.publicKey }
  }

  it("accepts a valid assertion and returns the advanced counter", () => {
    const { privateKey, credId, publicKey } = enroll()
    const challenge = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: privateKey, credId, challenge, signCount: 7 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newSignCount).toBe(7)
      expect(result.userVerified).toBe(true)
    }
  })

  it("rejects an unknown device (credential not resolved for user/tenant)", () => {
    const { privateKey, credId } = enroll()
    const challenge = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: privateKey, credId, challenge, signCount: 1 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, null)
    expect(result).toEqual({ ok: false, failure: "unknown_credential" })
  })

  it("rejects a cloned challenge on authentication", () => {
    const { privateKey, credId, publicKey } = enroll()
    const bound = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: privateKey, credId, challenge: b64url(randomBytes(32)), signCount: 1 })
    const result = verifyAuthentication(assertion, { challenge: bound, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 0 })
    expect(result).toEqual({ ok: false, failure: "challenge_mismatch" })
  })

  it("rejects an origin mismatch on authentication", () => {
    const { privateKey, credId, publicKey } = enroll()
    const challenge = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: privateKey, credId, challenge, origin: "https://phish.example.net", signCount: 1 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 0 })
    expect(result).toEqual({ ok: false, failure: "origin_mismatch" })
  })

  it("rejects a cloned key via signature-counter regression", () => {
    const { privateKey, credId, publicKey } = enroll()
    const challenge = b64url(randomBytes(32))
    // A cloned authenticator presents a counter <= the one we last stored.
    const assertion = makeAssertion({ priv: privateKey, credId, challenge, signCount: 4 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 9 })
    expect(result).toEqual({ ok: false, failure: "counter_regression" })
  })

  it("rejects a forged signature (verified with a different key)", () => {
    const { credId, publicKey } = enroll()
    const attacker = newKeypair()
    const challenge = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: attacker.privateKey, credId, challenge, signCount: 5 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 0 })
    expect(result).toEqual({ ok: false, failure: "bad_signature" })
  })

  it("rejects when user-presence flag is absent", () => {
    const { privateKey, credId, publicKey } = enroll()
    const challenge = b64url(randomBytes(32))
    const assertion = makeAssertion({ priv: privateKey, credId, challenge, signCount: 5, flags: 0x00 })
    const result = verifyAuthentication(assertion, { challenge, origin: ORIGIN, rpId: RP_ID }, { publicKey, signCount: 0 })
    expect(result).toEqual({ ok: false, failure: "user_not_present" })
  })
})
