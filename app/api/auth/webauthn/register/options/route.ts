import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deriveRelyingParty } from "@/lib/webauthn/rp"
import { issueChallenge, listCredentials } from "@/lib/webauthn-store"

/**
 * Begin passkey registration for the signed-in user. Issues a single-use
 * challenge bound to (user, tenant, origin, rpId) and returns the
 * PublicKeyCredentialCreationOptions the browser needs. Authenticated + tenant
 * scoped: the user id and tenant come from the verified session, never the body.
 */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const tenantId = session.tenantId
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const rp = deriveRelyingParty(request)
  if (!rp) return NextResponse.json({ error: "Unable to determine relying party origin" }, { status: 400 })

  const issued = await issueChallenge({
    tenantId,
    userId: session.userId,
    purpose: "register",
    origin: rp.origin,
    rpId: rp.rpId,
  })

  // Exclude already-registered credentials so the same authenticator cannot be
  // enrolled twice.
  const existing = await listCredentials(tenantId, session.userId)

  return NextResponse.json({
    challengeId: issued.id,
    publicKey: {
      challenge: issued.challenge,
      rp: { id: rp.rpId, name: "Muenot ERP" },
      user: {
        // A stable, non-PII user handle scoped to this tenant+user.
        id: Buffer.from(`${tenantId}:${session.userId}`).toString("base64url"),
        name: session.email,
        displayName: session.name || session.email,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
        { type: "public-key", alg: -8 }, // EdDSA
      ],
      timeout: 300000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      excludeCredentials: existing.map((c) => ({
        type: "public-key",
        id: c.credentialId,
        transports: c.transports,
      })),
    },
  })
}
