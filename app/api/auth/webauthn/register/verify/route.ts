import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deriveRelyingParty } from "@/lib/webauthn/rp"
import { verifyRegistration, type RegistrationResponse } from "@/lib/webauthn/core"
import { consumeChallenge, saveCredential, credentialFingerprint } from "@/lib/webauthn-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"

/**
 * Finish passkey registration. Consumes the single-use challenge (rejecting
 * replay), re-derives the expected origin/rpId from THIS request, verifies the
 * attestation ceremony against the challenge binding, then stores the new
 * credential scoped to the session user + tenant.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const tenantId = session.tenantId
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const challengeId = String(body?.challengeId ?? "")
  const response = body?.response as RegistrationResponse | undefined
  const label = typeof body?.label === "string" ? body.label.slice(0, 120) : null
  if (!challengeId || !response) {
    return NextResponse.json({ error: "challengeId and response are required" }, { status: 400 })
  }

  const rp = deriveRelyingParty(request)
  if (!rp) return NextResponse.json({ error: "Unable to determine relying party origin" }, { status: 400 })

  // Single-use consumption: a second attempt with the same challenge id fails.
  const consumed = await consumeChallenge({ id: challengeId, tenantId, userId: session.userId, purpose: "register" })
  if (!consumed) {
    return NextResponse.json({ error: "Challenge expired or already used", code: "CHALLENGE_INVALID" }, { status: 400 })
  }

  // Verify against the origin/rpId the challenge was ISSUED for (stored on the
  // challenge), and require the current request to still resolve to the same
  // origin — a mismatch means the ceremony finished on a different origin.
  if (consumed.origin !== rp.origin || consumed.rpId !== rp.rpId) {
    return NextResponse.json({ error: "Origin mismatch", code: "ORIGIN_MISMATCH" }, { status: 400 })
  }

  const result = verifyRegistration(response, {
    challenge: consumed.challenge,
    origin: consumed.origin,
    rpId: consumed.rpId,
  })
  if (!result.ok) {
    await recordSecurityEvent({
      tenantId,
      category: "access_policy",
      action: "webauthn_register_failed",
      outcome: "blocked",
      actorUserId: session.userId,
      actorName: session.name,
      subjectEmail: session.email,
      detail: { failure: result.failure },
    })
    return NextResponse.json({ error: "Registration verification failed", code: result.failure }, { status: 400 })
  }

  const saved = await saveCredential({
    tenantId,
    userId: session.userId,
    credentialId: result.credentialId,
    publicKey: result.publicKey,
    signCount: result.signCount,
    transports: result.transports,
    label,
    backedUp: result.backedUp,
  })
  if (!saved.ok) {
    return NextResponse.json({ error: "This security key is already registered", code: "DUPLICATE_CREDENTIAL" }, { status: 409 })
  }

  await recordSecurityEvent({
    tenantId,
    category: "access_policy",
    action: "webauthn_registered",
    outcome: "created",
    actorUserId: session.userId,
    actorName: session.name,
    subjectEmail: session.email,
    detail: { credential: credentialFingerprint(result.credentialId), label, backedUp: result.backedUp },
  })

  return NextResponse.json({ ok: true })
}
